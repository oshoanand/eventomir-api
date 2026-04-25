import { Router } from "express";
import * as adminService from "../controllers/admin.js";
import prisma from "../libs/prisma.js";
import { invalidatePattern } from "../libs/redis.js";
import { sendPushNotification } from "../libs/firebase.js";
import {
  sendModerationStatusEmail,
  sendPartnerApprovalEmail,
} from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import bcrypt from "bcryptjs";
import { notifyUser } from "../services/notification.js";

const router = Router();

// Middleware: All routes require authentication
router.use(verifyAuth);

// =================================================================
//                 USER MANAGEMENT ROUTES
// =================================================================

// --- 1. GET ALL USERS (Admin & Support) ---
router.get(
  "/users",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          role: { in: ["administrator", "support"] },
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          moderationStatus: true,
        },
        orderBy: { createdAt: "desc" },
      });
      res.json(users);
    } catch (error) {
      console.error("Fetch users error:", error);
      res.status(500).json({ message: "Error fetching users" });
    }
  },
);

// --- 2. CREATE USER (Administrator Only) ---
router.post("/user", requireRole(["administrator"]), async (req, res) => {
  try {
    const { email, password, name, role, status } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }

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
        role,
        moderationStatus: status,
      },
    });

    res
      .status(201)
      .json({ message: "User created successfully", userId: newUser.id });
  } catch (error) {
    console.error("Create User Error:", error);
    res.status(500).json({ message: "Error creating user" });
  }
});

// --- 3. UPDATE USER (Administrator Only) ---
router.put("/user/:id", requireRole(["administrator"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, password, status } = req.body;

    const dataToUpdate = { name, role };

    if (password && password.trim() !== "") {
      dataToUpdate.password = await bcrypt.hash(password, 10);
    }
    dataToUpdate.moderationStatus = status;

    await prisma.user.update({
      where: { id },
      data: dataToUpdate,
    });

    res.json({ message: "User updated successfully" });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ message: "Error updating user" });
  }
});

// --- 4. DELETE USER (Administrator Only) ---
router.delete("/user/:id", requireRole(["administrator"]), async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.id === id) {
      return res
        .status(400)
        .json({ message: "Cannot delete your own account" });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ message: "Error deleting user" });
  }
});

// =================================================================
//                 DASHBOARD & BUSINESS ROUTES
// =================================================================

router.get(
  "/dashboard",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const data = await adminService.getAdminDashboardData();
      res.json(data);
    } catch (error) {
      res
        .status(500)
        .json({ error: "Failed to fetch administrator dashboard data" });
    }
  },
);

router.put(
  "/payouts/:payoutId/approve",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      await adminService.approvePayout(req.params.payoutId);
      res.status(200).send();
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  },
);

router.put(
  "/payouts/:payoutId/reject",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      await adminService.rejectPayout(req.params.payoutId);
      res.status(200).send();
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  },
);

// =================================================================
//                 MODERATION ROUTES
// =================================================================

router.patch(
  "/profile/moderation/:id",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // 🚨 Safely handle both camelCase and snake_case from incoming requests
      const { userType } = req.body;
      const moderationStatus =
        req.body.moderationStatus || req.body.moderation_status;

      const validStatuses = ["PENDING", "APPROVED", "REJECTED", "BLOCKED"];
      if (!validStatuses.includes(moderationStatus)) {
        return res.status(400).json({ message: "Invalid moderation status" });
      }

      let updatedProfile;

      if (userType === "customer") {
        updatedProfile = await prisma.customerProfile.update({
          where: { userId: id },
          data: { moderationStatus },
          include: { user: true },
        });
        await invalidatePattern("users:customers_p*");
      } else if (userType === "performer") {
        updatedProfile = await prisma.performerProfile.update({
          where: { userId: id },
          data: { moderationStatus },
          include: { user: true },
        });
        await invalidatePattern("users:performers_p*");
      } else if (userType === "partner") {
        updatedProfile = await prisma.partnerProfile.update({
          where: { userId: id },
          data: { moderationStatus },
          include: { user: true },
        });
        await invalidatePattern("users:partners_p*");
      } else {
        // Fallback updates base user
        updatedProfile = await prisma.user.update({
          where: { id: id },
          data: { moderationStatus },
          include: { user: true },
        });
        updatedProfile.user = updatedProfile;
      }

      // 1. Send Background Email
      sendModerationStatusEmail(
        updatedProfile.user.email,
        updatedProfile.user.name,
        updatedProfile.moderationStatus,
      ).catch((err) => console.error("Background email failed:", err));

      // 2. SEND ROBUST PUSH NOTIFICATION
      let notifTitle = "Модерация профиля";
      let notifBody = "Ваш профиль ожидает проверки.";
      let url = "/users";

      if (moderationStatus === "APPROVED") {
        notifTitle = "🎉 Профиль одобрен!";
        notifBody = "Ваш профиль успешно прошел модерацию и теперь активен.";
      } else if (moderationStatus === "REJECTED") {
        notifTitle = "⚠️ Отклонение профиля";
        notifBody =
          "Ваш профиль не прошел модерацию. Пожалуйста, проверьте данные.";
      }

      if (userType === "customer") url = "/customer-profile";
      else if (userType === "performer") url = "/performer-profile";
      else if (userType === "partner") url = "/dashboard";

      await notifyUser({
        userId: id,
        title: notifTitle,
        body: notifBody,
        type: "MODERATION_UPDATE",
        data: { url: url },
      });

      return res.status(200).json({
        message: "Moderation status updated successfully",
        data: { moderationStatus: updatedProfile.moderationStatus },
      });
    } catch (error) {
      console.error("Error updating status:", error.message);
      return res.status(500).json({ message: "Server error updating status" });
    }
  },
);

// =================================================================
//                 BOOKING MANAGEMENT ROUTES
// =================================================================

router.get(
  "/bookings",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { status, search } = req.query;
      const where = {};

      if (status && status !== "ALL") {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { id: { contains: search, mode: "insensitive" } },
          {
            customer: {
              user: { name: { contains: search, mode: "insensitive" } },
            },
          },
          {
            performer: {
              user: { name: { contains: search, mode: "insensitive" } },
            },
          },
        ];
      }

      const bookings = await prisma.booking.findMany({
        where,
        include: {
          customer: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  image: true, // 🚨 camelCase match with User schema
                },
              },
            },
          },
          performer: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const flattenedBookings = bookings.map((b) => ({
        ...b,
        customer: b.customer.user,
        performer: b.performer.user,
      }));

      res.json(flattenedBookings);
    } catch (error) {
      console.error("Fetch bookings error:", error);
      res.status(500).json({ message: "Error fetching bookings" });
    }
  },
);

router.patch(
  "/bookings/:id",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const validStatuses = [
        "PENDING",
        "CONFIRMED",
        "REJECTED",
        "FULFILLED",
        "CANCELLED_BY_CUSTOMER",
      ];
      if (!validStatuses.includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid booking status value" });
      }

      const updatedBooking = await prisma.booking.update({
        where: { id },
        data: { status },
        include: {
          customer: { select: { userId: true } },
          performer: { select: { userId: true } },
        },
      });

      try {
        await notifyUser({
          userId: updatedBooking.customer.userId,
          title: "Обновление бронирования",
          body: `Статус вашего бронирования изменен администратором на: ${status}`,
          type: "BOOKING_UPDATE",
          data: { bookingId: id, status, url: "/customer-profile/bookings" },
        });

        await notifyUser({
          userId: updatedBooking.performer.userId,
          title: "Обновление бронирования",
          body: `Администратор изменил статус бронирования #${id.slice(-4)} на: ${status}`,
          type: "BOOKING_UPDATE",
          data: { bookingId: id, status, url: "/performer-profile/bookings" },
        });
      } catch (notifError) {
        console.error("Failed to send real-time notification:", notifError);
      }

      res.json(updatedBooking);
    } catch (error) {
      console.error("Update booking error:", error);
      res.status(500).json({ message: "Error updating booking status" });
    }
  },
);

router.delete(
  "/bookings/:id",
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      await prisma.booking.delete({ where: { id } });
      res.json({ message: "Booking deleted successfully" });
    } catch (error) {
      console.error("Delete booking error:", error);
      res.status(500).json({ message: "Error deleting booking" });
    }
  },
);

// =================================================================
//                 NOTIFICATION PUSH LOGIC
// =================================================================

router.post(
  "/notifications/send",
  requireRole(["administrator"]),
  async (req, res) => {
    const { type, target, title, body } = req.body;

    if (!type || !["topic", "token"].includes(type)) {
      return res
        .status(400)
        .json({ error: "Type must be either 'topic' or 'token'" });
    }
    if (!target || !title || !body) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const response = await sendPushNotification(type, title, body, target, {
        url: "/",
      });

      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: type,
          target,
          status: "SUCCESS",
          messageId: response?.messageId || "multicast_success",
        },
      });

      return res.status(200).json({ success: true, messageId: response });
    } catch (error) {
      console.error("FCM Error:", error);

      try {
        await prisma.notificationLog.create({
          data: {
            title,
            body,
            targetType: type,
            target,
            status: "FAILED",
            errorDetails: error.message,
          },
        });
      } catch (logError) {
        console.error("Failed to write error log to DB:", logError);
      }

      return res
        .status(500)
        .json({ error: "Failed to send notification", details: error.message });
    }
  },
);

router.get(
  "/notifications/history",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const logs = await prisma.notificationLog.findMany({
        take: 50,
        orderBy: { sentAt: "desc" },
      });
      res.json(logs);
    } catch (error) {
      console.error("Prisma Error:", error);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  },
);

export default router;
