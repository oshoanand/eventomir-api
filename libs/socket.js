import { Server } from "socket.io";
import prisma from "../libs/prisma.js";
import {
  redis,
  redisSub,
  CHANNELS,
  KEYS,
  publishEvent,
} from "../libs/redis.js";

let io;

// --- 1. Redis Event Handler (Pub/Sub for Scaling) ---
const handleRedisEvent = (ioInstance, event) => {
  if (!ioInstance || !event || !event.type) return;

  try {
    switch (event.type) {
      case "USER_STATUS": {
        ioInstance.emit("user_status_change", event.payload);
        break;
      }

      case "NEW_MESSAGE": {
        const { message, chatId, receiverId } = event.payload;

        // Emit to the specific Chat Room
        ioInstance.to(chatId).emit("receive_message", { message, chatId });

        // Emit notification to Receiver's personal room
        if (receiverId) {
          ioInstance.to(receiverId).emit("message_notification", {
            chatId,
            senderName: message.sender?.name || "Пользователь",
            preview: message.content,
          });
        }
        break;
      }

      case "NOTIFICATION": {
        if (event.payload?.userId) {
          ioInstance
            .to(event.payload.userId)
            .emit("notification", event.payload);
        }
        break;
      }

      default:
        console.warn("⚠️ Unknown Redis Event Type:", event.type);
    }
  } catch (err) {
    console.error("❌ Error handling Redis event:", err);
  }
};

// --- 2. Global Subscription Setup ---
// Listen on the dedicated subscriber client
redisSub.subscribe(CHANNELS.EVENTS, (err) => {
  if (err) console.error("⚠️ Redis Subscription Error:", err);
  else console.log("✅ Subscribed to Redis events successfully");
});

redisSub.on("message", (channel, messageStr) => {
  if (channel === CHANNELS.EVENTS && io) {
    try {
      const event = JSON.parse(messageStr);
      handleRedisEvent(io, event);
    } catch (e) {
      console.error("❌ Failed to parse Redis message:", e);
    }
  }
});

// --- 3. Initialize Socket.IO ---
export const initSocket = (server, allowedOrigins) => {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const userId =
      socket.handshake.query.userId || socket.handshake.auth?.userId;
    if (!userId) {
      return next(new Error("Authentication error: User ID required"));
    }
    socket.userId = userId;
    next();
  });

  io.on("connection", async (socket) => {
    const userId = socket.userId;
    console.log(`🟢 User connected: ${userId} (${socket.id})`);

    socket.join(userId);

    try {
      // Use the standard redis client imported from libs/redis.js
      await redis.sadd(KEYS.ONLINE_USERS, userId);

      publishEvent("USER_STATUS", { userId, status: "online" });

      const onlineUsers = await redis.smembers(KEYS.ONLINE_USERS);
      socket.emit("online_users_list", onlineUsers);
    } catch (error) {
      console.error("❌ Redis error during user connection:", error);
    }

    socket.on("join_chat", (chatId) => {
      if (chatId) {
        socket.join(chatId);
        console.log(`👥 User ${userId} joined room: ${chatId}`);
      }
    });

    socket.on("send_message", async (data) => {
      try {
        const savedMessage = await prisma.message.create({
          data: {
            content: data.content,
            chatId: data.chatId,
            senderId: userId,
            isRead: false,
          },
          include: {
            sender: {
              select: {
                id: true,
                name: true,
                profile_picture: true,
                role: true,
              },
            },
          },
        });

        await prisma.chat.update({
          where: { id: data.chatId },
          data: { updatedAt: new Date() },
        });

        // Use the imported publishEvent
        publishEvent("NEW_MESSAGE", {
          message: savedMessage,
          chatId: data.chatId,
          receiverId: data.receiverId,
        });
      } catch (error) {
        console.error("❌ Send Message Error:", error);
        socket.emit("error", {
          message: "Could not send message. Please try again.",
        });
      }
    });

    socket.on("disconnect", async () => {
      console.log(`🔴 User disconnected: ${userId}`);
      try {
        await redis.srem(KEYS.ONLINE_USERS, userId);
        publishEvent("USER_STATUS", { userId, status: "offline" });
      } catch (error) {
        console.error("❌ Redis error during user disconnect:", error);
      }
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io has not been initialized!");
  return io;
};

// --- Helper: Send System Notifications directly to a user's personal room ---
export const sendNotification = async (userId, type, message, data = {}) => {
  return publishEvent("NOTIFICATION", {
    userId,
    type,
    message,
    data,
    createdAt: new Date().toISOString(),
  });
};
