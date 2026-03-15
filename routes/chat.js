import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { publishEvent } from "../middleware/redis.js";

const router = Router();

// ==========================================
// 1. GET TOTAL UNREAD COUNT (For Navbar Badge)
// GET /api/chats/unread-count
// ==========================================
router.get("/unread-count", verifyAuth, async (req, res) => {
  try {
    const count = await prisma.message.count({
      where: {
        chat: {
          participants: { some: { id: req.user.id } },
        },
        senderId: { not: req.user.id },
        isRead: false,
      },
    });
    res.status(200).json({ count });
  } catch (error) {
    console.error("Unread Count Error:", error);
    res.status(500).json({ message: "Error fetching unread count" });
  }
});

// ==========================================
// 2. GET INBOX (Chat List with logic)
// GET /api/chats
// ==========================================
router.get("/", verifyAuth, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const chats = await prisma.chat.findMany({
      where: {
        participants: { some: { id: currentUserId } },
      },
      include: {
        participants: {
          select: { id: true, name: true, profile_picture: true, role: true },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            messages: {
              where: {
                isRead: false,
                senderId: { not: currentUserId },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const formattedChats = chats.map((chat) => ({
      ...chat,
      unreadCount: chat._count.messages,
    }));

    res.status(200).json(formattedChats);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch inbox" });
  }
});

// ==========================================
// 3. CREATE OR GET CHAT
// POST /api/chats
// ==========================================
router.post("/", verifyAuth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { participantId } = req.body;

    if (!participantId)
      return res.status(400).json({ message: "Participant ID required" });

    // Prevent chatting with yourself
    if (currentUserId === participantId) {
      return res.status(400).json({ message: "Cannot chat with yourself" });
    }

    let chat = await prisma.chat.findFirst({
      where: {
        AND: [
          { participants: { some: { id: currentUserId } } },
          { participants: { some: { id: participantId } } },
        ],
      },
      include: {
        participants: {
          select: { id: true, name: true, profile_picture: true },
        },
      },
    });

    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          participants: {
            connect: [{ id: currentUserId }, { id: participantId }],
          },
        },
        include: {
          participants: {
            select: { id: true, name: true, profile_picture: true },
          },
        },
      });
    }

    res.status(200).json(chat);
  } catch (error) {
    res.status(500).json({ message: "Failed to init chat" });
  }
});

// ==========================================
// 4. GET CHAT MESSAGES
// GET /api/chats/:chatId/messages
// ==========================================
router.get("/:chatId/messages", verifyAuth, async (req, res) => {
  try {
    const { chatId } = req.params;

    // SECURITY CHECK: Ensure user is a participant of this chat
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, participants: { some: { id: req.user.id } } },
    });
    if (!chat) return res.status(403).json({ message: "Access denied" });

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
      include: { sender: { select: { id: true, name: true } } },
    });
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ message: "Error loading messages" });
  }
});

// ==========================================
// 5. SEND MESSAGE & TRIGGER REDIS
// POST /api/chats/:chatId/messages
// ==========================================
router.post("/:chatId/messages", verifyAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { content } = req.body;
    const senderId = req.user.id;

    // SECURITY CHECK: Verify chat exists AND user is in it, while getting participants
    const chatExists = await prisma.chat.findFirst({
      where: { id: chatId, participants: { some: { id: senderId } } },
      include: { participants: true },
    });

    if (!chatExists)
      return res
        .status(403)
        .json({ message: "Access denied or chat not found" });

    const newMessage = await prisma.message.create({
      data: { content, chatId, senderId },
      include: {
        sender: { select: { id: true, name: true, profile_picture: true } },
      },
    });

    // Update chat timestamp to bubble it to the top of the inbox
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // Publish event
    const receiver = chatExists.participants.find((p) => p.id !== senderId);
    if (receiver) {
      await publishEvent("NEW_MESSAGE", {
        message: newMessage,
        chatId: chatId,
        receiverId: receiver.id,
      });
    }

    res.status(201).json(newMessage);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error sending message" });
  }
});

// ==========================================
// 6. MARK AS READ
// PATCH /api/chats/:chatId/read
// ==========================================
router.patch("/:chatId/read", verifyAuth, async (req, res) => {
  try {
    const { chatId } = req.params;

    // SECURITY CHECK: Ensure user is a participant of this chat
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, participants: { some: { id: req.user.id } } },
    });
    if (!chat) return res.status(403).json({ message: "Access denied" });

    await prisma.message.updateMany({
      where: {
        chatId: chatId,
        senderId: { not: req.user.id },
        isRead: false,
      },
      data: { isRead: true },
    });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Error updating read status" });
  }
});

export default router;
