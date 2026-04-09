import { Router } from "express";
import * as adminService from "../controllers/admin.js";
import prisma from "../libs/prisma.js";
import { invalidatePattern } from "../libs/redis.js";
import {
  sendModerationStatusEmail,
  sendPartnerApprovalEmail,
} from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import bcrypt from "bcryptjs";

// 🚨 IMPORT THE NEW MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

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
router.put("/user/:id", requireRole(["administrator"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, status, password } = req.body;

    const dataToUpdate = { name, role, status };

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

// =================================================================
//                 🆕 PERFORMER DETAILS ROUTE
// =================================================================

router.get(
  "/performers/:id",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const performer = await prisma.user.findUnique({
        where: { id },
        include: {
          gallery_items: { orderBy: { created_at: "desc" } },
          certificates: { orderBy: { created_at: "desc" } },
          recommendation_letters: { orderBy: { created_at: "desc" } },
          bookings_as_performer: {
            include: {
              customer: {
                select: { id: true, name: true, email: true, phone: true },
              },
            },
            orderBy: { createdAt: "desc" },
          },
          events: { orderBy: { createdAt: "desc" } },
        },
      });

      if (!performer) {
        return res.status(404).json({ message: "Performer not found" });
      }

      const mappedData = {
        id: performer.id,
        name: performer.name,
        email: performer.email,
        phone: performer.phone,
        city: performer.city,
        accountType: performer.account_type,
        companyName: performer.company_name,
        inn: performer.inn,
        description: performer.description,
        profilePicture: performer.profile_picture,
        backgroundPicture: performer.background_picture,
        roles: performer.roles || [],
        priceRange: performer.price_range || [],
        moderationStatus: performer.moderation_status,
        status: performer.status,
        createdAt: performer.created_at,
        gallery: performer.gallery_items.map((g) => ({
          id: g.id,
          title: g.title,
          imageUrls: g.image_urls,
          description: g.description,
          moderationStatus: g.moderation_status,
          createdAt: g.created_at,
        })),
        certificates: performer.certificates.map((c) => ({
          id: c.id,
          fileUrl: c.file_url,
          description: c.description,
          moderationStatus: c.moderation_status,
          createdAt: c.created_at,
        })),
        recommendationLetters: performer.recommendation_letters.map((l) => ({
          id: l.id,
          fileUrl: l.file_url,
          description: l.description,
          moderationStatus: l.moderation_status,
          createdAt: l.created_at,
        })),
        bookings: performer.bookings_as_performer.map((b) => ({
          id: b.id,
          date: b.date,
          status: b.status,
          price: b.price,
          details: b.details,
          createdAt: b.created_at,
          customerName: b.customer?.name || "Неизвестно",
          customerEmail: b.customer?.email,
          customerPhone: b.customer?.phone,
        })),
        events:
          performer.events?.map((e) => ({
            id: e.id,
            title: e.title,
            date: e.date,
            status: e.status,
            city: e.city,
            price: e.price,
            imageUrl: e.image_url,
            createdAt: e.created_at,
          })) || [],
      };

      res.status(200).json(mappedData);
    } catch (error) {
      console.error("Error fetching admin performer details:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// =================================================================

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

    const validStatuses = ["approved", "pending_approval", "rejected"];
    if (!validStatuses.includes(moderation_status)) {
      return res.status(400).json({ message: "Invalid moderation status" });
    }

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

    await invalidatePattern("users:performers_p*");

    // 1. Send Background Email
    sendModerationStatusEmail(
      updatedUser.email,
      updatedUser.name,
      updatedUser.moderation_status,
    ).catch((err) => console.error("Background email failed:", err));

    // 🚨 2. SEND ROBUST PUSH NOTIFICATION
    let notifTitle = "Модерация профиля";
    let notifBody = "Ваш профиль ожидает проверки.";
    if (moderation_status === "approved") {
      notifTitle = "🎉 Профиль одобрен!";
      notifBody =
        "Ваш профиль успешно прошел модерацию и теперь виден заказчикам.";
    } else if (moderation_status === "rejected") {
      notifTitle = "⚠️ Отклонение профиля";
      notifBody =
        "Ваш профиль не прошел модерацию. Пожалуйста, проверьте данные.";
    }

    await notifyUser({
      userId: updatedUser.id,
      title: notifTitle,
      body: notifBody,
      type: "MODERATION_UPDATE",
      data: { url: "/performer-profile" }, // Directs user to their profile
    });

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

      res.json(bookings);
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

      // 🚨 SEND REAL-TIME NOTIFICATIONS VIA NOTIFY-USER DISPATCHER
      try {
        // 1. Notify Customer
        await notifyUser({
          userId: updatedBooking.customerId,
          title: "Обновление бронирования",
          body: `Статус вашего бронирования изменен администратором на: ${status}`,
          type: "BOOKING_UPDATE",
          data: { bookingId: id, status, url: "/customer-profile/bookings" },
        });

        // 2. Notify Performer
        await notifyUser({
          userId: updatedBooking.performerId,
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

      const request = await prisma.partnershipRequest.findUnique({
        where: { id },
      });
      if (!request)
        return res.status(404).json({ message: "Заявка не найдена" });

      const updatedRequest = await prisma.partnershipRequest.update({
        where: { id },
        data: { status },
      });

      if (status === "APPROVED") {
        let user = await prisma.user.findUnique({
          where: { email: request.email },
        });
        let tempPassword = null;

        if (!user) {
          tempPassword = "Test1234";
          const hashedPassword = await bcrypt.hash(tempPassword, 10);

          user = await prisma.user.create({
            data: {
              email: request.email,
              password: hashedPassword,
              name: request.name,
              role: "partner",
              status: "active",
            },
          });

          const namePrefix = request.name
            .substring(0, 4)
            .toUpperCase()
            .replace(/[^A-Z]/g, "P");
          const randomSuffix = Math.floor(1000 + Math.random() * 9000);
          const referralId = `REF-${namePrefix}${randomSuffix}`;

          await prisma.partner.create({
            data: {
              userId: user.id,
              referralId: referralId,
              balance: 0,
              minPayout: 1500,
            },
          });

          await sendPartnerApprovalEmail(
            request.email,
            request.name,
            tempPassword,
          );
        } else {
          await prisma.user.update({
            where: { id: user.id },
            data: { role: "partner" },
          });

          // 🚨 IF USER ALREADY EXISTS, NOTIFY THEM IN-APP
          await notifyUser({
            userId: user.id,
            title: "🤝 Партнерская программа",
            body: "Ваша заявка на партнерство одобрена! Добро пожаловать в команду.",
            type: "PARTNER_APPROVED",
            data: { url: "/partner-dashboard" },
          });
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
