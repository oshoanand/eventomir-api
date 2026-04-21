import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import prisma from "../libs/prisma.js";
import { redis } from "../libs/redis.js";

// Helper to get real IP behind proxies (Nginx, Vercel, Cloudflare, etc.)
export const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? forwarded.split(/, /)[0]
    : req.connection.remoteAddress;
  return ip || "UNKNOWN_IP";
};

// Global Rate Limiter: Traps spam/brute force attempts using Redis
export const globalRateLimiter = rateLimit({
  // Use Redis as the store
  store: new RedisStore({
    // @ts-expect-error - Known typing issue with rate-limit-redis and ioredis, but works perfectly at runtime
    sendCommand: (...args) => redis.call(...args),
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // Limit each IP to 150 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Слишком много запросов. Пожалуйста, подождите 15 минут.",
  },

  // Custom handler to log malicious activity to PostgreSQL
  handler: async (req, res, next, options) => {
    const ip = getClientIp(req);

    try {
      // Fire and forget to DB so we don't hold up the response
      prisma.securityLog
        .create({
          data: {
            ipAddress: ip,
            eventType: "RATE_LIMIT_EXCEEDED",
            path: req.originalUrl,
            details: `User-Agent: ${req.headers["user-agent"] || "Unknown"}`,
          },
        })
        .catch((err) => console.error("Prisma Security Log Error:", err));
    } catch (e) {
      // Ignore errors
    }

    res.status(options.statusCode).json(options.message);
  },
});
