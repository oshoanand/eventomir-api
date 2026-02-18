import prisma from "../libs/prisma.js";
import { redis } from "../middleware/redis.js";
const CHANNELS = { EVENTS: "app_events_stream" };

// --- 1. Create or Get Existing Chat ---
export const createOrGetChat = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ message: "Target user ID is required" });
    }

    // 1. Try to find an existing chat between these two users
    // This query looks for a chat where BOTH users are participants
    const existingChat = await prisma.chat.findFirst({
      where: {
        AND: [
          { participants: { some: { id: currentUserId } } },
          { participants: { some: { id: targetUserId } } },
        ],
      },
      include: {
        participants: {
          select: {
            id: true,
            name: true,
            profile_picture: true,
            role: true,
            email: true,
          },
        },
      },
    });

    if (existingChat) {
      return res.json(existingChat);
    }

    // 2. If no chat exists, create a new one
    const newChat = await prisma.chat.create({
      data: {
        participants: {
          connect: [{ id: currentUserId }, { id: targetUserId }],
        },
      },
      include: {
        participants: {
          select: {
            id: true,
            name: true,
            profile_picture: true,
            role: true,
            email: true,
          },
        },
      },
    });

    res.status(201).json(newChat);
  } catch (error) {
    console.error("Create Chat Error:", error);
    res.status(500).json({ message: "Failed to create chat" });
  }
};

// --- 2. Get All Chats for Current User ---
export const getUserChats = async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const chats = await prisma.chat.findMany({
      where: {
        participants: {
          some: { id: currentUserId },
        },
      },
      include: {
        participants: {
          select: { id: true, name: true, profile_picture: true, role: true },
        },
        // Include the last message for the preview in the sidebar
        messages: {
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    // Format the response for cleaner frontend consumption
    const formattedChats = chats.map((chat) => {
      // Find the "other" participant to display their name/avatar
      const otherParticipant = chat.participants.find(
        (p) => p.id !== currentUserId,
      );
      const lastMessage = chat.messages[0];

      return {
        id: chat.id,
        name: otherParticipant?.name || "Unknown User",
        profile_picture: otherParticipant?.profile_picture,
        role: otherParticipant?.role,
        lastMessage: lastMessage ? lastMessage.content : "No messages yet",
        lastMessageTime: lastMessage ? lastMessage.createdAt : chat.createdAt,
        participants: chat.participants,
      };
    });

    res.json(formattedChats);
  } catch (error) {
    console.error("Get Chats Error:", error);
    res.status(500).json({ message: "Failed to fetch chats" });
  }
};

// --- 3. Get Messages for a Specific Chat ---
export const getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const currentUserId = req.user.id;

    // Security check: Ensure user is a participant
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    const isParticipant = chat?.participants.some(
      (p) => p.id === currentUserId,
    );
    if (!isParticipant && req.user.role !== "admin") {
      // Admins can spy/monitor
      return res.status(403).json({ message: "Access denied" });
    }

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" }, // Oldest first
      include: {
        sender: {
          select: { id: true, name: true, profile_picture: true },
        },
      },
    });

    res.json(messages);
  } catch (error) {
    console.error("Get Messages Error:", error);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
};

// --- 4. Send Message ---
export const sendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { content } = req.body;
    const senderId = req.user.id;

    if (!content) {
      return res.status(400).json({ message: "Content cannot be empty" });
    }

    // 1. Save Message to Database
    const newMessage = await prisma.message.create({
      data: {
        content,
        chatId,
        senderId,
      },
      include: {
        sender: { select: { id: true, name: true, profile_picture: true } },
        chat: { include: { participants: true } }, // Include participants to know who to notify
      },
    });

    // 2. Update Chat's "updatedAt" (to move it to top of list)
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // 3. Real-time: Publish event to Redis
    // The Socket Server listens to this and broadcasts it immediately
    const receiver = newMessage.chat.participants.find(
      (p) => p.id !== senderId,
    );

    if (receiver) {
      const eventPayload = {
        type: "NEW_MESSAGE",
        payload: {
          message: newMessage,
          chatId: chatId,
          receiverId: receiver.id,
        },
      };
      await redis.publish(CHANNELS.EVENTS, JSON.stringify(eventPayload));
    }

    res.status(201).json(newMessage);
  } catch (error) {
    console.error("Send Message Error:", error);
    res.status(500).json({ message: "Failed to send message" });
  }
};
