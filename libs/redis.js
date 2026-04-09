import Redis from "ioredis";
import "dotenv/config";

const DEFAULT_TTL = 3600 * 24 * 2; // 2 days

const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    if (times > 5) {
      console.warn("⚠️ Redis is unreachable. Switching to DB-only mode.");
      return null; // Stop retrying after 5 attempts
    }
    return Math.min(times * 100, 3000);
  },
};

// 1. Main Client (For standard commands & Publishing)
export const redis = new Redis(redisConfig);

// 2. Subscriber Client (Strictly for Pub/Sub listening)
export const redisSub = new Redis(redisConfig);

// 3. Centralized Constants
export const CHANNELS = {
  EVENTS: "app_events_stream",
};

export const KEYS = {
  ONLINE_USERS: "online_users_set",
};

// --- Error Handling ---
redis.on("error", (err) =>
  console.error("Redis Main Client Error:", err.message),
);
redisSub.on("error", (err) =>
  console.error("Redis Sub Client Error:", err.message),
);

// --- Connection Check ---
export const connectRedis = async () => {
  try {
    const status = await redis.ping();
    console.log(
      `✅ Redis Connection: ${status === "PONG" ? "Healthy" : "Unstable"}`,
    );
  } catch (err) {
    console.error("❌ Redis Connection Failed:", err.message);
  }
};

// --- Pub/Sub Helper ---
export const publishEvent = async (type, payload) => {
  try {
    const eventData = JSON.stringify({ type, payload });
    await redis.publish(CHANNELS.EVENTS, eventData);
  } catch (err) {
    console.error("❌ Redis Publish Error:", err);
  }
};

// --- Cache Helpers ---
export const invalidateKeys = async (keys) => {
  if (!keys || keys.length === 0) return;
  const keysToDelete = Array.isArray(keys) ? keys : [keys];
  try {
    await redis.del(...keysToDelete);
    console.log(`🗑️ Invalidated Cache Keys: ${keysToDelete.join(", ")}`);
  } catch (err) {
    console.error("Failed to invalidate keys:", err);
  }
};

export const invalidatePattern = async (pattern) => {
  try {
    let cursor = "0";
    do {
      const [newCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = newCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(
          `🗑️ Invalidated Pattern (${pattern}): ${keys.length} keys removed.`,
        );
      }
    } while (cursor !== "0");
  } catch (err) {
    console.error(`❌ Failed to invalidate pattern "${pattern}":`, err);
  }
};

export const fetchCached = async (resource, id, dbQuery, ttl = DEFAULT_TTL) => {
  const key = `${resource}:${id}`;
  try {
    const cachedData = await redis.get(key);
    if (cachedData) {
      console.log(`--- Cache Hit: ${key} ---`);
      return JSON.parse(cachedData);
    }
    console.log(`--- Cache Miss: ${key}. Fetching from DB ---`);
    const data = await dbQuery();
    if (data) {
      await redis.set(key, JSON.stringify(data), "EX", ttl);
    }
    return data;
  } catch (error) {
    console.error(`Redis Error on ${key}:`, error);
    return await dbQuery(); // Fail-soft: fallback to DB
  }
};

export async function generateUniqueCode() {
  let isUnique = false;
  let randomCode;
  const EXPIRY_IN_SECONDS = 2 * 24 * 60 * 60; // 2 days

  try {
    while (!isUnique) {
      const randomNum = Math.floor(Math.random() * 100);
      randomCode = randomNum.toString().padStart(2, "0");
      const exists = await redis.exists(`code:${randomCode}`);
      if (exists === 0) isUnique = true;
    }

    await redis.set(
      `code:${randomCode}`,
      "active",
      "EX",
      EXPIRY_IN_SECONDS,
      "NX",
    );
    return randomCode;
  } catch (error) {
    console.error("Redis Unique Code error:", error);
    return null;
  }
}
