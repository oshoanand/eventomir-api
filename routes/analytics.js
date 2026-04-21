import { Router } from "express";
import prisma from "../libs/prisma.js";
import { redis } from "../libs/redis.js";
import { getClientIp } from "../middleware/security.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// 1. TRACK VISIT (Public Endpoint)
// ==========================================
router.post("/track", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { path } = req.body;
    const userAgent = req.headers["user-agent"] || "UNKNOWN";

    const todayStr = new Date().toISOString().split("T")[0];
    const redisKey = `visit:${ip}:${path}:${todayStr}`;

    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(23, 59, 59, 999);
    const secondsUntilMidnight = Math.floor(
      (midnight.getTime() - now.getTime()) / 1000,
    );

    const isNewVisit = await redis.set(
      redisKey,
      "1",
      "EX",
      secondsUntilMidnight,
      "NX",
    );

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

    res.status(200).send("OK");
  } catch (error) {
    console.error("Analytics Tracking Error:", error);
    res.status(500).send("Error");
  }
});

// ==========================================
// 2. GET RICH STATS (Admin Endpoint)
// ==========================================
router.get("/stats", verifyAuth, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Run heavy aggregations in parallel
    const [
      totalVisits,
      uniqueIps,
      spamTrapped,
      visitsByDateRaw,
      topPagesRaw,
      recentSpamLogs,
    ] = await Promise.all([
      prisma.siteVisit.count(),
      prisma.siteVisit.groupBy({ by: ["ipAddress"] }),
      prisma.securityLog.count(),

      // Data for the Chart (Last 30 days)
      prisma.siteVisit.groupBy({
        by: ["visitDate"],
        _count: { id: true },
        where: { visitDate: { gte: thirtyDaysAgo } },
        orderBy: { visitDate: "asc" },
      }),

      // Top 5 most visited pages
      prisma.siteVisit.groupBy({
        by: ["path"],
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      }),

      // Last 5 security incidents
      prisma.securityLog.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          ipAddress: true,
          eventType: true,
          path: true,
          createdAt: true,
        },
      }),
    ]);

    // Format the chart data for the frontend
    const chartData = visitsByDateRaw.map((v) => ({
      date: v.visitDate.toISOString().split("T")[0],
      views: v._count.id,
    }));

    // Format top pages
    const topPages = topPagesRaw.map((p) => ({
      path: p.path,
      views: p._count.id,
    }));

    res.status(200).json({
      totalVisits,
      uniqueVisitors: uniqueIps.length,
      spamTrapped,
      chartData,
      topPages,
      recentSpamLogs,
    });
  } catch (error) {
    console.error("Fetch Stats Error:", error);
    res.status(500).json({ message: "Error fetching stats" });
  }
});

export default router;
