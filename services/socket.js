import { Server } from "socket.io";
import Redis from "ioredis";
import prisma from "../libs/prisma.js";
import "dotenv/config";

// --- 1. Redis Configuration ---
const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
};

const redis = new Redis(redisConfig);
const redisSub = new Redis(redisConfig);

const CHANNELS = {
  EVENTS: "app_events_stream",
};

const KEYS = {
  ONLINE_USERS: "online_users_set",
};

let io;

// --- 2. Redis Event Handler (Defined first to be safe) ---
const handleRedisEvent = (ioInstance, event) => {
  if (!ioInstance) return;

  try {
    switch (event.type) {
      // Case A: Status Change (Online/Offline)
      case "USER_STATUS":
        ioInstance.emit("user_status_change", event.payload);
        break;

      // Case B: New Chat Message
      case "NEW_MESSAGE":
        const { message, chatId, receiverId } = event.payload;

        // 1. Emit to the generic Chat Room (For open chat windows)
        // This is what the Admin Chat Interface listens to!
        ioInstance.to(chatId).emit("receive_message", message);

        // 2. Emit notification to Receiver's personal room (For popups/toasts)
        // CRITICAL FIX: Use optional chaining (?.name) to prevent crashes
        if (receiverId) {
          ioInstance.to(receiverId).emit("message_notification", {
            chatId,
            senderName: message.sender?.name || "User",
            preview: message.content,
          });
        }
        break;

      // Case C: System Notification
      case "NOTIFICATION":
        if (event.payload?.userId) {
          ioInstance
            .to(event.payload.userId)
            .emit("notification", event.payload);
        }
        break;

      default:
        console.warn("Unknown Redis Event Type:", event.type);
    }
  } catch (err) {
    console.error("❌ Error handling Redis event:", err);
  }
};

// --- 3. Subscribe to Redis Channels Globally ---
redisSub.subscribe(CHANNELS.EVENTS, (err) => {
  if (err) console.error("⚠️ Redis Subscription Error:", err);
  else console.log("✅ Subscribed to Redis events");
});

redisSub.on("message", (channel, messageStr) => {
  if (channel === CHANNELS.EVENTS && io) {
    try {
      const event = JSON.parse(messageStr);
      handleRedisEvent(io, event);
    } catch (e) {
      console.error("Failed to parse Redis message:", e);
    }
  }
});

/**
 * Initialize Socket.IO
 */
export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*", // Allow all origins for simplicity (Admin + Client)
      methods: ["GET", "POST"],
    },
  });

  // --- Middleware: Authentication ---
  io.use((socket, next) => {
    const userId =
      socket.handshake.query.userId || socket.handshake.auth.userId;
    if (!userId) {
      return next(new Error("Authentication error: User ID required"));
    }
    socket.userId = userId;
    next();
  });

  // --- Connection Handler ---
  io.on("connection", async (socket) => {
    const userId = socket.userId;
    console.log(`🟢 User connected: ${userId} (${socket.id})`);

    // A. Join Personal Room (for notifications)
    socket.join(userId);

    // B. Set Status to ONLINE
    await redis.sadd(KEYS.ONLINE_USERS, userId);

    // Broadcast status to everyone (so Admin sees green dot)
    publishEvent({
      type: "USER_STATUS",
      payload: { userId, status: "online" },
    });

    // C. Send current online list to the connected user
    const onlineUsers = await redis.smembers(KEYS.ONLINE_USERS);
    socket.emit("online_users_list", onlineUsers);

    // D. Join Specific Chat Room (CRITICAL for Admin Chat Interface)
    socket.on("join_chat", (chatId) => {
      if (chatId) {
        socket.join(chatId);
        console.log(`👥 User ${userId} joined room: ${chatId}`);
      }
    });

    // E. Handle Sending Messages (Socket Fallback)
    // Note: If your frontend uses REST API, this block is skipped,
    // but the REST API *must* publish the NEW_MESSAGE event to Redis.
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
              select: { id: true, name: true, image: true, role: true },
            },
          },
        });

        publishEvent({
          type: "NEW_MESSAGE",
          payload: {
            message: savedMessage,
            chatId: data.chatId,
            receiverId: data.receiverId,
          },
        });
      } catch (error) {
        console.error("❌ Send Message Error:", error);
        socket.emit("error", { message: "Could not send message" });
      }
    });

    // F. Disconnect Handler
    socket.on("disconnect", async () => {
      console.log(`🔴 User disconnected: ${userId}`);
      await redis.srem(KEYS.ONLINE_USERS, userId);

      publishEvent({
        type: "USER_STATUS",
        payload: { userId, status: "offline" },
      });
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized!");
  return io;
};

const publishEvent = async (eventData) => {
  try {
    await redis.publish(CHANNELS.EVENTS, JSON.stringify(eventData));
  } catch (err) {
    console.error("Redis Publish Error:", err);
  }
};

export const sendNotification = async (userId, type, message, data = {}) => {
  return publishEvent({
    type: "NOTIFICATION",
    payload: {
      userId,
      type,
      message,
      data,
      createdAt: new Date().toISOString(),
    },
  });
};
