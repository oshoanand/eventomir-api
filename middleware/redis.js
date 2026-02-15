import Redis from "ioredis";
import prisma from "../libs/prisma.js";
import "dotenv/config";

const DEFAULT_TTL = 3600 * 24 * 2; // 2 day

// 1. Initialize Redis with fail-safe retry strategy
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
redis.on("error", (err) => {
  // Prevent unhandled error crashes
  console.error("Redis Client Error", err.message);
});

const connectRedis = async () => {
  try {
    const status = await redis.ping();
    console.log(
      `✅ Redis Connection: ${status === "PONG" ? "Healthy" : "Unstable"}`,
    );
  } catch (err) {
    console.error("❌ Redis Connection Failed:", err.message);
    // In some architectures, you might want to process.exit(1) here
  }
};

// Helper to invalidate specific cache keys
const invalidateKeys = async (keys) => {
  if (!keys || keys.length === 0) return;

  const keysToDelete = Array.isArray(keys) ? keys : [keys];

  try {
    await redis.del(...keysToDelete);
    console.log(`🗑️ Invalidated Cache Keys: ${keysToDelete.join(", ")}`);
  } catch (err) {
    console.error("Failed to invalidate keys:", err);
  }
};

// --- Invalidate by Pattern (for Pagination) ---
/**
 * Deletes all keys matching a wildcard pattern (e.g. "jobs_p*")
 * Uses SCAN to avoid blocking the Redis server.
 */
const invalidatePattern = async (pattern) => {
  try {
    let cursor = "0";
    do {
      // ioredis scan returns [nextCursor, keysArray]
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
 * @param {string} resource - The model name (e.g., 'users', 'posts')
 * @param {string|number} id - The specific ID or 'all'
 * @param {Function} dbQuery - An async function containing the Prisma logic
 * @param {number} ttl - Time to live in seconds (optional)
 */
const fetchCached = async (resource, id, dbQuery, ttl = DEFAULT_TTL) => {
  const key = `${resource}:${id}`;

  try {
    // 1. Attempt to retrieve data from Redis
    const cachedData = await redis.get(key);

    if (cachedData) {
      console.log(`--- Cache Hit: ${key} ---`);
      return JSON.parse(cachedData);
    }

    // 2. Cache Miss: Execute the database query
    console.log(`--- Cache Miss: ${key}. Fetching from DB ---`);
    const data = await dbQuery();

    // 3. If data exists, store it in Redis for next time
    if (data) {
      // 'EX' sets the expiration in seconds
      await redis.set(key, JSON.stringify(data), "EX", ttl);
    }

    return data;
  } catch (error) {
    // 4. Fail-soft: If Redis fails, log it and return DB data so the app doesn't crash
    console.error(`Redis Error on ${key}:`, error);
    return await dbQuery();
  }
};

async function generateUniqueCode() {
  let isUnique = false;
  let randomCode;
  // Calculate seconds for 2 days
  const EXPIRY_IN_SECONDS = 2 * 24 * 60 * 60;

  try {
    // Keep generating until a unique code is found
    while (!isUnique) {
      // 1. Generate a random 2-digit code (0-99)
      const randomNum = Math.floor(Math.random() * 100);
      // Pad with a leading zero if the number is a single digit
      randomCode = randomNum.toString().padStart(2, "0");

      // 2. Check if this code already exists as a key in Redis
      const exists = await redis.exists(`code:${randomCode}`);

      if (exists === 0) {
        // 0 means it does not exist, so it's unique
        isUnique = true;
      } else {
        console.log(`Code ${randomCode} already exists. Retrying...`);
      }
    }

    // 3. Save the unique code to Redis
    // Optional: Use 'EX' and a number to set an expiration (e.g., 3600 seconds)
    await redis.set(
      `code:${randomCode}`,
      "active",
      "EX",
      EXPIRY_IN_SECONDS,
      "NX",
    );

    console.log(`Successfully generated and saved unique code:${randomCode}`);
    return randomCode;
  } catch (error) {
    console.error("Redis error:", error);
    return null;
  } finally {
    // redis.quit(); // Close connection if no longer needed
  }
}

export {
  connectRedis,
  invalidateKeys,
  prisma,
  redis,
  fetchCached,
  generateUniqueCode,
  invalidatePattern,
};
