import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { redis } from "../libs/redis.js";
import { createUploader } from "../utils/multer.js";

// Image Upload Imports
import { MINIO_BUCKET_NAME } from "../utils/minioClient.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";
const chatPhotoUploader = createUploader(10); // 10MB limit

const router = Router();

// ==========================================
// 1. GET ALL CHAT SESSIONS (Universal Inbox)
// GET /api/chats/sessions?userId=xyz
// ==========================================
router.get("/sessions", verifyAuth, async (req, res) => {
  // Use user ID from auth middleware for security, or fallback to query param if needed
  const userId = req.user?.id || req.query.userId;

  if (!userId) {
    return res.status(400).json({ message: "userId required" });
  }

  try {
    // 1. Fetch the list of online user IDs from Redis
    const onlineUsers = await redis.smembers("online_users");

    const sessions = await prisma.chatSession.findMany({
      where: {
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
      include: {
        user1: {
          select: {
            id: true,
            name: true,
            image: true, // 🚨 FIX: Changed from profile_picture to image
            role: true,
            updatedAt: true, // 🚨 FIX: Changed to camelCase updatedAt
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            image: true, // 🚨 FIX: Changed from profile_picture to image
            role: true,
            updatedAt: true, // 🚨 FIX: Changed to camelCase updatedAt
          },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            messages: {
              where: { isRead: false, senderId: { not: userId } },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    // 2. Efficiently fetch "Last Seen" for all potential partners from Redis
    const partnerIds = sessions.map((s) =>
      s.user1Id === userId ? s.user2Id : s.user1Id,
    );

    const lastSeenKeys = partnerIds.map((id) => `last_seen:${id}`);
    const lastSeenValues =
      lastSeenKeys.length > 0 ? await redis.mget(lastSeenKeys) : [];

    // Create a map for quick lookup: { "userId": "timestamp" }
    const lastSeenMap = {};
    partnerIds.forEach((id, index) => {
      lastSeenMap[id] = lastSeenValues[index];
    });

    const formattedSessions = sessions.map((session) => {
      const partner =
        session.user1Id === userId ? session.user2 : session.user1;
      const lastMessage = session.messages[0];
      const isOnline = onlineUsers.includes(partner.id.toString());

      // Use Redis timestamp, or fallback to DB updatedAt
      const lastSeen = isOnline
        ? null
        : lastSeenMap[partner.id] || partner.updatedAt.toISOString();

      return {
        // Standardized DTO payload
        id: session.id,
        partnerId: partner.id,
        partnerName: partner.name,
        partnerRole: partner.role,
        partnerImage: partner.image, // 🚨 FIX: Map to new image property

        lastMessage: lastMessage
          ? lastMessage.text || "📷 Фотография"
          : "Нет сообщений",
        lastMessageTime: lastMessage
          ? lastMessage.createdAt.toISOString()
          : session.createdAt.toISOString(),
        unreadCount: session._count.messages,

        isOnline: isOnline,
        lastSeen: lastSeen,
      };
    });

    res.status(200).json(formattedSessions);
  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ message: "Failed to fetch chat sessions" });
  }
});

// ==========================================
// 2. GET CHAT HISTORY BETWEEN TWO USERS
// GET /api/chats/history?userId2=abc&cursor=xyz
// ==========================================
router.get("/history", verifyAuth, async (req, res) => {
  const userId1 = req.user?.id; // Current authenticated user
  const { userId2, cursor, limit = "20" } = req.query;
  const takeLimit = parseInt(limit);

  if (!userId1 || !userId2) {
    return res.status(400).json({ message: "userId1 and userId2 required" });
  }

  try {
    const [user1Id, user2Id] = [userId1, userId2].sort();

    const session = await prisma.chatSession.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
    });

    if (!session) return res.status(200).json([]);

    const messages = await prisma.chatMessage.findMany({
      where: { chatSessionId: session.id },
      take: takeLimit,
      skip: cursor && cursor !== "" ? 1 : 0,
      cursor: cursor && cursor !== "" ? { id: cursor } : undefined,
      orderBy: { createdAt: "desc" }, // Fetch newest first for pagination
      include: {
        replyTo: {
          select: { id: true, text: true, imageUrl: true, senderId: true },
        },
      },
    });

    // IMPORTANT: React Query/Frontend expects chronological order
    // Reverse the array so the oldest message in the batch is at index 0
    res.status(200).json(messages.reverse());
  } catch (error) {
    console.error("Error fetching chat history:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ==========================================
// 3. GET TOTAL UNREAD COUNT (For Navbar Badge)
// GET /api/chats/unread-count
// ==========================================
router.get("/unread-count", verifyAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const unreadCount = await prisma.chatMessage.count({
      where: {
        session: {
          OR: [{ user1Id: userId }, { user2Id: userId }],
        },
        senderId: { not: userId },
        isRead: false,
      },
    });

    res.status(200).json({ totalUnread: unreadCount });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ message: "Error fetching unread count" });
  }
});

// ==========================================
// 4. MARK MESSAGES AS READ (REST API Fallback)
// PATCH /api/chats/mark-read
// ==========================================
router.patch("/mark-read", verifyAuth, async (req, res) => {
  const currentUserId = req.user.id;
  const { partnerId } = req.body;

  if (!partnerId) {
    return res.status(400).json({ message: "partnerId is required" });
  }

  try {
    const [user1Id, user2Id] = [currentUserId, partnerId].sort();

    const session = await prisma.chatSession.findUnique({
      where: { user1Id_user2Id: { user1Id, user2Id } },
    });

    if (!session) return res.status(404).json({ message: "Session not found" });

    await prisma.chatMessage.updateMany({
      where: {
        chatSessionId: session.id,
        senderId: partnerId, // The person who sent the messages
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error("Error marking read:", error);
    res.status(500).json({ message: "Failed to mark chat as read" });
  }
});

// ==========================================
// 5. UPLOAD CHAT IMAGE TO MINIO
// POST /api/chats/upload
// ==========================================
router.post(
  "/upload",
  verifyAuth,
  chatPhotoUploader.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No valid image uploaded." });
      }

      // 1. Utilize the unified optimizeAndUpload pipeline
      // 1200px is great for chat images (maintains detail while compressing heavily via WebP)
      const fullUrl = await optimizeAndUpload(
        req.file,
        "chats", // baseFolder
        req.user.id, // dynamicId
        1200, // width
      );

      console.log(fullUrl);
      if (!fullUrl) {
        throw new Error("Image processing returned null");
      }

      // 2. Extract the file key from the URL just in case the frontend needs it for deletion
      const fileName = fullUrl.split(`${MINIO_BUCKET_NAME}/`)[1];
      console.log(fileName);

      res.status(200).json({
        success: true,
        url: fullUrl,
        fileName: fileName,
      });
    } catch (error) {
      console.error("Upload route error:", error);
      res
        .status(500)
        .json({ message: "Internal server error during image upload." });
    }
  },
);

// ==========================================
// 6. GET ONLINE USERS
// GET /api/chats/online
// ==========================================
router.get("/online", async (req, res) => {
  try {
    const onlineUsers = await redis.smembers("online_users");
    res.json(onlineUsers);
  } catch (error) {
    res.json([]);
  }
});

// ==========================================
// 7. CREATE OR GET CHAT (Helper for initiating new chats)
// POST /api/chats/init
// ==========================================
router.post("/init", verifyAuth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { partnerId } = req.body;

    if (!partnerId)
      return res.status(400).json({ message: "partnerId required" });
    if (currentUserId === partnerId)
      return res.status(400).json({ message: "Cannot chat with yourself" });

    const [user1Id, user2Id] = [currentUserId, partnerId].sort();

    const session = await prisma.chatSession.upsert({
      where: { user1Id_user2Id: { user1Id, user2Id } },
      update: {}, // Just fetch it if it exists
      create: { user1Id, user2Id, status: "OPEN" },
    });

    res.status(200).json({ chatId: session.id, partnerId });
  } catch (error) {
    console.error("Init chat error:", error);
    res.status(500).json({ message: "Failed to init chat" });
  }
});

export default router;
