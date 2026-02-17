import { Router } from "express";
import * as adminService from "../controllers/admin.js";
import prisma from "../libs/prisma.js";
import { invalidatePattern } from "../middleware/redis.js";
import { sendModerationStatusEmail } from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import bcrypt from "bcryptjs";

const router = Router();

// Middleware: All routes require authentication
router.use(verifyAuth);

// --- 1. GET ALL USERS (Admin & Support) ---
router.get(
  "/users",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          role: {
            in: ["administrator", "support"],
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          created_at: true,
        },
        orderBy: { created_at: "desc" },
      });
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Error fetching users" });
    }
  },
);

// --- 2. CREATE USER (administrator Only) ---
router.post("/user", requireRole(["administrator"]), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Basic Validation
    if (!email || !password || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role, // "administrator", "support", "customer", etc.
        status: "active",
      },
    });

    res
      .status(201)
      .json({ message: "User created successfully", userId: newUser.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error creating user" });
  }
});

// --- 3. UPDATE USER (administrator Only) ---
// Note: Support can change THEIR OWN password via a different /profile route, not this one.
router.put("/user/:id", requireRole(["administrator"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, status, password } = req.body;

    const dataToUpdate = { name, role, status };

    // Only hash and update password if provided
    if (password && password.trim() !== "") {
      dataToUpdate.password = await bcrypt.hash(password, 10);
    }

    await prisma.user.update({
      where: { id },
      data: dataToUpdate,
    });

    res.json({ message: "User updated successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error updating user" });
  }
});

// --- 4. DELETE USER (administrator Only) ---
router.delete("/user/:id", requireRole(["administrator"]), async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent deleting yourself
    if (req.user.id === id) {
      return res
        .status(400)
        .json({ message: "Cannot delete your own account" });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting user" });
  }
});

router.get("/dashboard", async (req, res) => {
  try {
    const data = await adminService.getAdminDashboardData();
    res.json(data);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to fetch administrator dashboard data" });
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
