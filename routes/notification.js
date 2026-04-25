import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// 1. GET ALL NOTIFICATIONS
// ==========================================
router.get("/", verifyAuth, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(notifications);
  } catch (error) {
    console.error("Fetch Notifications Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ==========================================
// 2. MARK ALL AS READ
// 🚨 FIX: MUST BE ABOVE `/:id/read` TO PREVENT ROUTE CONFLICTS!
// ==========================================
router.patch("/read-all", verifyAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: {
        userId: req.user.id,
        isRead: false,
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
// 3. MARK SPECIFIC AS READ
// ==========================================
router.patch("/:id/read", verifyAuth, async (req, res) => {
  try {
    // 🚨 SECURITY FIX: Used updateMany to securely include `userId` in the `where` clause.
    // This physically prevents a user from modifying someone else's notification.
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

export default router;
