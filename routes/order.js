import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached } from "../middleware/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const dbQuery = () =>
      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          event: { select: { title: true, date: true } },
        },
      });

    const orders = await fetchCached("orders", "all", dbQuery);
    res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// GET /api/orders/my (Secure endpoint for logged-in user)
router.get("/my", verifyAuth, async (req, res, next) => {
  try {
    // SECURITY: Get ID from the verified token, NOT from req.query or req.body
    const userId = req.user.id;

    const orders = await prisma.order.findMany({
      where: { userId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            time: true,
            city: true,
            address: true,
            imageUrl: true,
          },
        },
      },
    });

    res.json(orders);
  } catch (error) {
    console.error("Error fetching user orders:", error);
    res.status(500).json({ message: "Failed to fetch your tickets" });
  }
});

export default router;
