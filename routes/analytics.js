import { Router } from "express";
import prisma from "../libs/prisma.js";
import { redis } from "../libs/redis.js";
import { getClientIp } from "../middleware/security.js";
import { verifyAuth } from "../middleware/verify-auth.js"; // Your auth middleware

const router = Router();

// ==========================================
// 1. TRACK VISIT (Public Endpoint)
// ==========================================
router.post("/track", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { path } = req.body;
    const userAgent = req.headers["user-agent"] || "UNKNOWN";

    // Normalize date to YYYY-MM-DD
    const todayStr = new Date().toISOString().split("T")[0];

    // Redis Key format: visit:IP:PATH:DATE
    const redisKey = `visit:${ip}:${path}:${todayStr}`;

    // Calculate seconds until midnight to set exact TTL
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(23, 59, 59, 999);
    const secondsUntilMidnight = Math.floor(
      (midnight.getTime() - now.getTime()) / 1000,
    );

    // Try to set the key in Redis. "NX" means only set if it does NOT exist.
    // If it exists, redis returns null. If it succeeds, it returns "OK".
    const isNewVisit = await redis.set(
      redisKey,
      "1",
      "EX",
      secondsUntilMidnight,
      "NX",
    );

    // If it's a new visit today for this IP on this path, log it to PostgreSQL
    if (isNewVisit === "OK") {
      const visitDate = new Date();
      visitDate.setHours(0, 0, 0, 0);

      await prisma.siteVisit.create({
        data: {
          ipAddress: ip,
          userAgent,
          path,
          visitDate,
        },
      });
    }

    // Always return 200 OK fast so the frontend isn't blocked
    res.status(200).send("OK");
  } catch (error) {
    console.error("Analytics Tracking Error:", error);
    res.status(500).send("Error");
  }
});

// ==========================================
// 2. GET STATS (Admin Endpoint)
// ==========================================
// Make sure you add verifyAdmin middleware here in production
router.get("/stats", verifyAuth, async (req, res) => {
  try {
    // Parallelize queries for speed
    const [totalVisits, uniqueIps, spamTrapped] = await Promise.all([
      prisma.siteVisit.count(),
      prisma.siteVisit.groupBy({
        by: ["ipAddress"],
        _count: true,
      }),
      prisma.securityLog.count(),
    ]);

    res.status(200).json({
      totalVisits,
      uniqueVisitors: uniqueIps.length,
      spamTrapped,
    });
  } catch (error) {
    console.error("Fetch Stats Error:", error);
    res.status(500).json({ message: "Error fetching stats" });
  }
});

export default router;
