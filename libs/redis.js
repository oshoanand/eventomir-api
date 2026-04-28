import Redis from "ioredis";
import "dotenv/config";

const DEFAULT_TTL = 3600 * 24 * 2; // 2 days

// ==========================================
// 1. SHARED REDIS CONFIGURATION
// ==========================================
const redisOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  // 🚨 CRITICAL: Prevents commands from hanging forever if Redis drops mid-flight
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) {
      console.warn(
        "⚠️ Redis is unreachable. Switching to DB-only fallback mode.",
      );
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

// Centralized Constants
export const CHANNELS = {
  EVENTS: "app_events_stream",
};

export const KEYS = {
  ONLINE_USERS: "online_users",
};

// ==========================================
// 3. ERROR HANDLING
// ==========================================
// Using .on("error") prevents Node.js from crashing on unhandled socket errors
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
    // Only ping if the connection hasn't permanently failed
    if (redis.status === "ready" || redis.status === "connecting") {
      const status = await redis.ping();
      console.log(
        `✅ Main Redis Connection: ${status === "PONG" ? "Healthy" : "Unstable"}`,
      );
    }

    // Wait for Pub/Sub clients to be ready
    const waitForClient = (client) => {
      if (client.status === "ready") return Promise.resolve();
      // Add a timeout so bootstrapper doesn't hang forever if Redis is offline on startup
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        client.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    };

    await Promise.all([waitForClient(pubClient), waitForClient(subClient)]);
    console.log("✅ Redis Bootstrapper completed.");
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
  if (!keys || keys.length === 0 || redis.status !== "ready") return;

  const keysToDelete = Array.isArray(keys) ? keys : [keys];

  try {
    await redis.del(...keysToDelete);
    console.log(`🗑️ Invalidated Cache Keys: ${keysToDelete.join(", ")}`);
  } catch (err) {
    console.error("Failed to invalidate keys:", err);
  }
};

/**
 * Invalidate by Pattern (Useful for Search queries, Pagination, e.g., 'search:performers:*')
 * Aliased as invalidateCachePattern for cross-compatibility with other files.
 */
export const invalidatePattern = async (pattern) => {
  // 🚨 CRITICAL: Prevent hanging if Redis is offline
  if (redis.status !== "ready") return;

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

export const invalidateCachePattern = invalidatePattern; // Alias

/**
 * Generic Read-Through Cache Logic (Highly Resilient)
 * Attempts to fetch from Redis first; if miss OR Redis is down, executes DB query.
 */
export const fetchCached = async (resource, id, dbQuery, ttl = DEFAULT_TTL) => {
  const key = id ? `${resource}:${id}` : resource;

  try {
    // 🚨 CRITICAL: Check status BEFORE calling .get() to bypass ioredis offline queueing
    if (redis.status === "ready") {
      const cachedData = await redis.get(key);

      if (cachedData) {
        // console.log(`--- Cache Hit: ${key} ---`); // Uncomment for debugging
        return JSON.parse(cachedData);
      }
    }
  } catch (error) {
    console.warn(
      `⚠️ Redis Read Error on ${key}. Bypassing cache:`,
      error.message,
    );
  }

  // Cache Miss OR Redis is offline: Fetch directly from Database
  // console.log(`--- Cache Miss: ${key}. Fetching from DB ---`);
  const data = await dbQuery();

  try {
    // 🚨 CRITICAL: Check status BEFORE calling .set() so it doesn't queue in memory
    if (data && redis.status === "ready") {
      await redis.set(key, JSON.stringify(data), "EX", ttl);
    }
  } catch (error) {
    console.warn(
      `⚠️ Redis Write Error on ${key}. Data not cached:`,
      error.message,
    );
  }

  return data;
};

/**
 * Generates a unique 2-digit code backed by Redis expiry.
 */
export async function generateUniqueCode() {
  // Fallback if Redis is completely down (useful for dev environments or outages)
  if (redis.status !== "ready") {
    console.warn("Redis is offline. Generating unsafe random code.");
    return Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, "0");
  }

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

    return randomCode;
  } catch (error) {
    console.error("Redis Unique Code error:", error.message);
    // Ultimate fallback
    return Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, "0");
  }
}
