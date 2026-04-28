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
    return res.status(200).json({ unreadCount: count });
  } catch (error) {
    console.error("Fetch Unread Count Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// ==========================================
// 2. GET ALL NOTIFICATIONS (With Safe Limits)
// ==========================================
router.get("/", verifyAuth, async (req, res) => {
  try {
    // 🚨 FIX: Enforce a strict maximum limit of 100 to prevent DB Denial-of-Service attacks
    const requestedLimit = parseInt(req.query.limit) || 50;
    const limit = Math.min(requestedLimit, 100);

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Returning array directly to match your existing frontend expectations
    return res.status(200).json(notifications);
  } catch (error) {
    console.error("Fetch Notifications Error:", error);
    return res.status(500).json({ message: "Internal server error" });
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

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Read All Error:", error);
    return res.status(500).json({ message: "Error updating notifications" });
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

    return res
      .status(200)
      .json({ success: true, message: "History cleared successfully" });
  } catch (error) {
    console.error("Clear All Error:", error);
    return res.status(500).json({ message: "Error clearing notifications" });
  }
});

// ==========================================
// 5. MARK SPECIFIC AS READ
// ==========================================
router.patch("/:id/read", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // SECURITY: updateMany securely applies the userId check
    const result = await prisma.notification.updateMany({
      where: {
        id: id,
        userId: req.user.id,
        isRead: false, // Prevents unnecessary database writes if already read
      },
      data: { isRead: true },
    });

    if (result.count === 0) {
      return res
        .status(404)
        .json({
          message: "Notification not found, already read, or unauthorized",
        });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Read Notification Error:", error);
    return res.status(500).json({ message: "Error updating notification" });
  }
});

// ==========================================
// 6. DELETE SPECIFIC NOTIFICATION
// ==========================================
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await prisma.notification.deleteMany({
      where: {
        id: id,
        userId: req.user.id,
      },
    });

    if (result.count === 0) {
      return res
        .status(404)
        .json({ message: "Notification not found or unauthorized" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    return res.status(500).json({ message: "Error deleting notification" });
  }
});

export default router;
