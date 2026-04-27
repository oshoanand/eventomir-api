import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// 1. GET UNREAD COUNT (Fast endpoint for UI badges)
// ==========================================
router.get("/unread-count", verifyAuth, async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: {
        userId: req.user.id,
        isRead: false,
      },
    });
    res.json({ unreadCount: count });
  } catch (error) {
    console.error("Fetch Unread Count Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ==========================================
// 2. GET ALL NOTIFICATIONS (With Limit)
// ==========================================
router.get("/", verifyAuth, async (req, res) => {
  try {
    // 🚨 FIX: Added a limit so the DB doesn't crash when a user has 10,000+ alerts
    const limit = parseInt(req.query.limit) || 50;

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Returning array directly to match your existing frontend expectations
    res.json(notifications);
  } catch (error) {
    console.error("Fetch Notifications Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ==========================================
// 3. MARK ALL AS READ
// ==========================================
router.patch("/read-all", verifyAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: {
        userId: req.user.id,
        isRead: false, // Optimization: Only update rows that actually need it
      },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Read All Error:", error);
    res.status(500).json({ message: "Error updating notifications" });
  }
});

// ==========================================
// 4. CLEAR ALL (Delete History)
// ==========================================
router.delete("/clear-all", verifyAuth, async (req, res) => {
  try {
    await prisma.notification.deleteMany({
      where: { userId: req.user.id },
    });
    res.json({ success: true, message: "History cleared successfully" });
  } catch (error) {
    console.error("Clear All Error:", error);
    res.status(500).json({ message: "Error clearing notifications" });
  }
});

// ==========================================
// 5. MARK SPECIFIC AS READ
// ==========================================
router.patch("/:id/read", verifyAuth, async (req, res) => {
  try {
    // SECURITY: updateMany securely applies the userId check
    const result = await prisma.notification.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      data: { isRead: true },
    });

    if (result.count === 0) {
      return res
        .status(404)
        .json({ message: "Notification not found or unauthorized" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Read Notification Error:", error);
    res.status(500).json({ message: "Error updating notification" });
  }
});

// ==========================================
// 6. DELETE SPECIFIC NOTIFICATION
// ==========================================
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const result = await prisma.notification.deleteMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (result.count === 0) {
      return res
        .status(404)
        .json({ message: "Notification not found or unauthorized" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    res.status(500).json({ message: "Error deleting notification" });
  }
});

export default router;
