import { Server } from "socket.io";
import Redis from "ioredis";
import "dotenv/config";

const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
  retryStrategy(times) {
    if (times > 5) {
      console.warn("⚠️ Redis is unreachable. Switching to DB-only mode.");
      return null; // Stop retrying after 5 attempts
    }
    return Math.min(times * 100, 3000);
  },
});
const STREAM_KEY = "notification_stream";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User joins a room based on their User ID
    socket.on("join_room", (userId) => {
      socket.join(userId);
      console.log(`User ${userId} joined room`);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};

/**
 * Pushes a notification to Redis Stream and emits via Socket.io
 */
export const sendNotification = async (userId, type, message, data = {}) => {
  try {
    const notificationPayload = {
      userId,
      type,
      message,
      data,
      createdAt: new Date().toISOString(),
    };

    // 1. Send Real-time via Socket.io
    const ioInstance = getIO();
    ioInstance.to(userId).emit("notification", notificationPayload);

    // 2. Persist to Redis Stream (XADD)
    // Key: notification_stream, ID: *, Fields: user_id, payload
    await redis.xadd(
      STREAM_KEY,
      "*",
      "userId",
      userId,
      "payload",
      JSON.stringify(notificationPayload),
    );

    return true;
  } catch (error) {
    console.error("Notification Error:", error);
    return false;
  }
};
