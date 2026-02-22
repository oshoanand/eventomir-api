import { Router } from "express";
import * as adminService from "../controllers/admin.js";
import prisma from "../libs/prisma.js";
import { invalidatePattern } from "../middleware/redis.js";
import {
  sendModerationStatusEmail,
  sendPartnerApprovalEmail,
} from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";

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

// =================================================================
//                 🆕 BOOKING MANAGEMENT ROUTES
// =================================================================

// --- 5. GET ALL BOOKINGS (Admin & Support) ---
router.get(
  "/bookings",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { status, search } = req.query;

      const where = {};

      // Filter by Status
      if (status && status !== "ALL") {
        where.status = status;
      }

      // Filter by Search (ID, Customer Name, Performer Name)
      if (search) {
        where.OR = [
          { id: { contains: search, mode: "insensitive" } },
          { customer: { name: { contains: search, mode: "insensitive" } } },
          { performer: { name: { contains: search, mode: "insensitive" } } },
        ];
      }

      const bookings = await prisma.booking.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              profile_picture: true,
            },
          },
          performer: {
            select: {
              id: true,
              name: true,
              email: true,

              profile_picture: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Flatten data for easier frontend consumption if needed,
      // but your frontend interface matches the Prisma structure well.
      res.json(bookings);
    } catch (error) {
      console.error("Fetch bookings error:", error);
      res.status(500).json({ message: "Error fetching bookings" });
    }
  },
);

// --- 6. UPDATE BOOKING STATUS (Admin Only) ---
router.patch(
  "/bookings/:id",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // Validate Status Enum
      const validStatuses = [
        "PENDING",
        "CONFIRMED",
        "REJECTED",
        "COMPLETED",
        "CANCELLED",
        "DISPUTED",
      ];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      const updatedBooking = await prisma.booking.update({
        where: { id },
        data: { status },
        include: {
          customer: { select: { id: true } },
          performer: { select: { id: true } },
        },
      });

      // Notify Parties via Socket/Redis
      // 1. Notify Customer
      await sendNotification(
        updatedBooking.customerId,
        "BOOKING_UPDATE",
        `Статус вашего бронирования изменен администратором на: ${status}`,
        { bookingId: id, status },
      );

      // 2. Notify Performer
      await sendNotification(
        updatedBooking.performerId,
        "BOOKING_UPDATE",
        `Администратор изменил статус бронирования #${id.slice(-4)} на: ${status}`,
        { bookingId: id, status },
      );

      res.json(updatedBooking);
    } catch (error) {
      console.error("Update booking error:", error);
      res.status(500).json({ message: "Error updating booking status" });
    }
  },
);

// --- 7. DELETE BOOKING (Admin Only) ---
router.delete(
  "/bookings/:id",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Optional: Check if it exists first
      const booking = await prisma.booking.findUnique({ where: { id } });
      if (!booking)
        return res.status(404).json({ message: "Booking not found" });

      await prisma.booking.delete({ where: { id } });

      res.json({ message: "Booking deleted successfully" });
    } catch (error) {
      console.error("Delete booking error:", error);
      res.status(500).json({ message: "Error deleting booking" });
    }
  },
);

router.get(
  "/partnership-requests",
  requireRole(["administrator"]),
  async (req, res) => {
    const requests = await prisma.partnershipRequest.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(requests);
  },
);

// PUT /api/admin/partnership-requests/:id/status
router.patch(
  "/partnership-requests/:id/status",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!["APPROVED", "REJECTED"].includes(status)) {
        return res.status(400).json({ message: "Некорректный статус" });
      }

      // 1. Get the current request
      const request = await prisma.partnershipRequest.findUnique({
        where: { id },
      });
      if (!request)
        return res.status(404).json({ message: "Заявка не найдена" });

      // 2. Update the request status
      const updatedRequest = await prisma.partnershipRequest.update({
        where: { id },
        data: { status },
      });

      // 3. Complete the Approval Workflow
      if (status === "APPROVED") {
        // Check if user already exists (just in case they registered normally before)
        let user = await prisma.user.findUnique({
          where: { email: request.email },
        });
        let tempPassword = null;

        if (!user) {
          // A: Generate a random 10-character password
          // tempPassword = crypto.randomBytes(5).toString("hex");
          tempPassword = "Test1234";
          const hashedPassword = await bcrypt.hash(tempPassword, 10);

          // B: Create the User account with role "partner"
          user = await prisma.user.create({
            data: {
              email: request.email,
              password: hashedPassword,
              name: request.name,
              role: "partner",
              status: "active",
            },
          });

          // C: Generate a unique referral ID (e.g., REF-IVAN1234)
          const namePrefix = request.name
            .substring(0, 4)
            .toUpperCase()
            .replace(/[^A-Z]/g, "P");
          const randomSuffix = Math.floor(1000 + Math.random() * 9000);
          const referralId = `REF-${namePrefix}${randomSuffix}`;

          // D: Create the specific Partner Profile/Dashboard record
          // (Assuming you have a Partner model linked to User)
          await prisma.partner.create({
            data: {
              userId: user.id,
              referralId: referralId,
              balance: 0,
              minPayout: 1500, // example minimum payout
            },
          });

          // E: Send the Email with the temporary password
          await sendPartnerApprovalEmail(
            request.email,
            request.name,
            tempPassword,
          );
        } else {
          // If the user already exists, just update their role to partner
          await prisma.user.update({
            where: { id: user.id },
            data: { role: "partner" },
          });

          // Send a generic approval email without a temporary password,
          // telling them to use their existing credentials.
          // await sendPartnerApprovalEmailWithoutPassword(...) (Optional implementation)
        }
      }

      res.status(200).json({
        message: `Заявка успешно ${status === "APPROVED" ? "одобрена" : "отклонена"}`,
        data: updatedRequest,
      });
    } catch (error) {
      console.error("Error updating partnership status:", error);
      res.status(500).json({ message: "Внутренняя ошибка сервера" });
    }
  },
);

export default router;
