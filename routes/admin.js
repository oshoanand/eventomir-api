import { Router } from "express";
import * as adminService from "../controllers/admin.js";
import prisma from "../libs/prisma.js";
import { invalidatePattern } from "../middleware/redis.js";
import { sendModerationStatusEmail } from "../mailer/email-sender.js";

const router = Router();

router.get("/dashboard", async (req, res) => {
  try {
    const data = await adminService.getAdminDashboardData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch admin dashboard data" });
  }
});

router.put("/profiles/:userId/approve", async (req, res) => {
  try {
    await adminService.approveProfile(req.params.userId);
    res.status(200).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/profiles/:userId/reject", async (req, res) => {
  try {
    await adminService.rejectProfile(req.params.userId);
    res.status(200).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/payouts/:payoutId/approve", async (req, res) => {
  try {
    await adminService.approvePayout(req.params.payoutId);
    res.status(200).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put("/payouts/:payoutId/reject", async (req, res) => {
  try {
    await adminService.rejectPayout(req.params.payoutId);
    res.status(200).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.patch("/profile/moderation/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { moderation_status } = req.body;

    // 1. Validate Input
    const validStatuses = ["approved", "pending_approval", "rejected"];
    if (!validStatuses.includes(moderation_status)) {
      return res.status(400).json({ message: "Invalid moderation status" });
    }

    // 2. Update Database
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { moderation_status },
      select: {
        id: true,
        email: true,
        name: true,
        moderation_status: true,
      },
    });

    // 3. Invalidate Redis Cache
    // The GET route uses fetchCached("customers", "performers_p1...", ...)
    // This creates keys like "customers:performers_p1_l10..."
    // We must delete ALL keys matching this pattern.
    await invalidatePattern("users:performers_p*");

    sendModerationStatusEmail(
      updatedUser.email,
      updatedUser.name,
      updatedUser.moderation_status,
    ).catch((err) => console.error("Background email failed:", err));

    console.log(
      `Updated user ${id} to ${moderation_status} and cleared cache.`,
    );

    return res.status(200).json({
      message: "Moderation status updated successfully",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Error updating status:", error.message);
    return res.status(500).json({ message: "Server error updating status" });
  }
});

export default router;
