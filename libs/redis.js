import Redis from "ioredis";
import "dotenv/config";

const DEFAULT_TTL = 3600 * 24 * 2; // 2 days

// 1. Shared Redis Configuration
const redisOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    if (times > 5) {
      console.warn("⚠️ Redis is unreachable. Switching to DB-only mode.");
      return null; // Stop retrying after 5 attempts
    }
    // Exponential backoff strategy
    return Math.min(times * 100, 3000);
  },
};

// ==========================================
// 2. REDIS CLIENT INITIALIZATION
// ==========================================

// Main Redis Client (for caching, state, and direct key/value operations)
export const redis = new Redis(redisOptions);

// Pub/Sub Redis Clients (Strictly for Socket.io Redis Adapter)
export const pubClient = new Redis(redisOptions);
export const subClient = pubClient.duplicate();

// Centralized Constants (Optional, but good for standardization)
export const CHANNELS = {
  EVENTS: "app_events_stream",
};

export const KEYS = {
  ONLINE_USERS: "online_users",
};

// ==========================================
// 3. ERROR HANDLING
// ==========================================
redis.on("error", (err) =>
  console.error("Redis Main Client Error:", err.message),
);
pubClient.on("error", (err) =>
  console.error("Redis Pub Client Error:", err.message),
);
subClient.on("error", (err) =>
  console.error("Redis Sub Client Error:", err.message),
);

// ==========================================
// 4. CONNECTION BOOTSTRAPPER
// ==========================================
export const connectRedis = async () => {
  try {
    const status = await redis.ping();
    console.log(
      `✅ Main Redis Connection: ${status === "PONG" ? "Healthy" : "Unstable"}`,
    );

    // Wait for Pub/Sub clients to be ready if they aren't already
    const waitForClient = (client) => {
      if (client.status === "ready") return Promise.resolve();
      return new Promise((resolve) => client.once("ready", resolve));
    };

    await Promise.all([waitForClient(pubClient), waitForClient(subClient)]);
    console.log("✅ Redis Pub/Sub clients ready for WebSockets");
  } catch (err) {
    console.error("❌ Redis Connection Failed:", err.message);
  }
};

// ==========================================
// 5. CACHING & UTILITY FUNCTIONS
// ==========================================

/**
 * Helper to explicitly invalidate specific cache keys
 */
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

/**
 * Invalidate by Pattern (Useful for Pagination or Lists, e.g., 'users:*')
 */
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

/**
 * Generic Read-Through Cache Logic
 * Attempts to fetch from Redis first; if miss, executes the DB query, caches the result, and returns it.
 */
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
    return await dbQuery(); // Fail-soft: fallback to DB without caching
  }
};

/**
 * Generates a unique 2-digit code backed by Redis expiry.
 */
export async function generateUniqueCode() {
  let isUnique = false;
  let randomCode;
  const EXPIRY_IN_SECONDS = 2 * 24 * 60 * 60; // 2 Days

  try {
    while (!isUnique) {
      const randomNum = Math.floor(Math.random() * 100);
      randomCode = randomNum.toString().padStart(2, "0");

      const exists = await redis.exists(`code:${randomCode}`);

      if (exists === 0) {
        isUnique = true;
      } else {
        console.log(`Code ${randomCode} already exists. Retrying...`);
      }
    }

    await redis.set(
      `code:${randomCode}`,
      "active",
      "EX",
      EXPIRY_IN_SECONDS,
      "NX",
    );

    console.log(`Successfully generated and saved unique code: ${randomCode}`);
    return randomCode;
  } catch (error) {
    console.error("Redis Unique Code error:", error);
    return null;
  }
}
