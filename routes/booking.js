import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { initTinkoffEscrowPayment } from "../utils/tinkoff.js";
import { notifyUser } from "../services/notification.js";

const router = Router();

// Helper: Securely log every action inside a Prisma transaction
const createAuditLog = async (
  tx,
  bookingId,
  actorId,
  action,
  metadata = {},
) => {
  await tx.bookingAuditLog.create({
    data: { bookingId, actorId, action, metadata },
  });
};

// ==========================================
// 1. CUSTOMER: Create Request
// ==========================================
router.post("/", verifyAuth, async (req, res) => {
  try {
    const { performerId, date, details } = req.body;
    const baseUserId = req.user.id;

    if (performerId === baseUserId) {
      return res
        .status(403)
        .json({ message: "Отказ: бронирование самого себя." });
    }

    // 🚨 FIX: Fetch the Customer Profile to get the correct 'customerId' for the Booking record
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: baseUserId },
    });

    if (!customerProfile) {
      return res
        .status(403)
        .json({
          message: "Профиль заказчика не найден. Завершите регистрацию.",
        });
    }

    const performer = await prisma.performerProfile.findUnique({
      where: { userId: performerId },
    });

    if (!performer) {
      return res.status(404).json({ message: "Исполнитель не найден." });
    }

    // 🚨 FIX: Safely check dates, ensuring bookedDates is an array to prevent crashes
    const isBusy = performer.bookedDates?.some((d) => {
      const bookedDate = new Date(d).toISOString().split("T")[0];
      const requestDate = new Date(date).toISOString().split("T")[0];
      return bookedDate === requestDate;
    });

    if (isBusy) return res.status(400).json({ message: "Дата уже занята." });

    const booking = await prisma.$transaction(async (tx) => {
      const newBooking = await tx.bookingRequest.create({
        data: {
          performerId: performer.id,
          customerId: customerProfile.id, // 🚨 FIX: Used Profile ID, not User ID
          date: new Date(date),
          details: details,
          status: "PENDING_PERFORMER_APPROVAL",
        },
      });

      await createAuditLog(tx, newBooking.id, baseUserId, "REQUEST_CREATED", {
        details,
        date,
      });
      return newBooking;
    });

    // Run asynchronously without blocking the HTTP response
    notifyUser({
      userId: performer.userId, // 🚨 Ensure this hits the base User ID for sockets
      title: "📅 Новый запрос на бронирование",
      body: "У вас новый запрос на бронирование. Проверьте детали и укажите вашу цену.",
      type: "NEW_BOOKING",
      data: { url: "/bookings", bookingId: booking.id },
    }).catch((err) => console.error("Notification failed silently:", err));

    res.status(201).json(booking);
  } catch (error) {
    console.error("Create Booking Error:", error);
    res.status(500).json({ message: "Ошибка создания бронирования." });
  }
});

// ==========================================
// GET MY BOOKINGS (MADE & RECEIVED)
// ==========================================
router.get("/my", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Resolve profiles for the logged-in user
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId },
    });
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId },
    });

    // 2. Fetch bookings made by the user (if they have a customer profile)
    let madeRaw = [];
    if (customerProfile) {
      madeRaw = await prisma.bookingRequest.findMany({
        where: { customerId: customerProfile.id },
        include: {
          performer: {
            include: { user: { select: { name: true, image: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    // Map fields cleanly for the frontend
    const made = madeRaw.map((booking) => {
      if (booking.performer) {
        return {
          ...booking,
          performer: {
            ...booking.performer,
            user: {
              ...booking.performer.user,
              city: booking.performer.city,
            },
          },
        };
      }
      return booking;
    });

    // 3. Fetch bookings received (if they have a performer profile)
    let receivedRaw = [];
    if (performerProfile) {
      receivedRaw = await prisma.bookingRequest.findMany({
        where: { performerId: performerProfile.id },
        // 🚨 FIX: Customer details live on the User table, so we must include 'user'
        include: {
          customer: {
            include: {
              user: {
                select: { name: true, email: true, image: true, phone: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    // Safely flatten the customer data for the frontend mapping
    const received = receivedRaw.map((booking) => ({
      ...booking,
      customer: booking.customer
        ? {
            ...booking.customer,
            name: booking.customer.user?.name,
            email: booking.customer.user?.email,
            image: booking.customer.user?.image,
            phone: booking.customer.user?.phone,
          }
        : null,
    }));

    res.status(200).json({
      made,
      received,
      isPerformer: !!performerProfile,
    });
  } catch (error) {
    console.error("Get Bookings Error:", error);
    res.status(500).json({ message: "Ошибка при загрузке бронирований." });
  }
});

// ==========================================
// 2. PERFORMER: Respond to Request (Accept/Reject)
// ==========================================
router.patch("/:id/performer-reply", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, agreedFee, rejectionReason } = req.body;
    const userId = req.user.id;

    // 🚨 FIX: Include both Performer AND Customer to access their base User IDs
    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: { performer: true, customer: true },
    });

    if (!booking)
      return res.status(404).json({ message: "Бронирование не найдено." });
    if (booking.performer.userId !== userId)
      return res.status(403).json({ message: "Доступ запрещен." });
    if (booking.status !== "PENDING_PERFORMER_APPROVAL") {
      return res
        .status(400)
        .json({ message: "Статус бронирования не позволяет этот ответ." });
    }

    await prisma.$transaction(async (tx) => {
      if (action === "REJECT") {
        if (!rejectionReason)
          throw new Error("Необходимо указать причину отказа.");

        await tx.bookingRequest.update({
          where: { id },
          data: { status: "REJECTED_BY_PERFORMER", rejectionReason },
        });
        await createAuditLog(tx, id, userId, "PERFORMER_REJECTED", {
          reason: rejectionReason,
        });
      } else if (action === "ACCEPT") {
        if (!agreedFee || agreedFee <= 0)
          throw new Error("Необходимо указать сумму гонорара.");

        await tx.bookingRequest.update({
          where: { id },
          data: { status: "PENDING_CUSTOMER_PAYMENT", agreedFee },
        });
        await createAuditLog(tx, id, userId, "PERFORMER_ACCEPTED_WITH_FEE", {
          fee: agreedFee,
        });
      }
    });

    // 🚨 FIX: Use 'booking.customer.userId' (Base User ID) to send the notification
    if (action === "REJECT") {
      notifyUser({
        userId: booking.customer.userId,
        title: "❌ Бронирование отклонено",
        body: `Исполнитель не смог принять ваш заказ. Причина: ${rejectionReason}`,
        type: "BOOKING_REJECTED",
        data: { url: "/bookings", bookingId: booking.id },
      }).catch(console.error);
    } else if (action === "ACCEPT") {
      notifyUser({
        userId: booking.customer.userId,
        title: "✅ Бронирование подтверждено!",
        body: `Исполнитель готов выполнить заказ. Ожидается оплата: ${agreedFee} ₽.`,
        type: "BOOKING_ACCEPTED",
        data: { url: "/bookings", bookingId: booking.id },
      }).catch(console.error);
    }

    res.status(200).json({ message: "Ответ успешно сохранен." });
  } catch (error) {
    res.status(400).json({ message: error.message || "Ошибка обновления." });
  }
});

// ==========================================
// 3a. CUSTOMER: Cancel Deal (Reject Performer's Price)
// ==========================================
router.patch("/:id/customer-cancel", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const baseUserId = req.user.id;

    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: { performer: true, customer: true },
    });

    if (!booking)
      return res.status(404).json({ message: "Бронирование не найдено." });

    // 🚨 FIX: Verify ownership against the Customer Profile, not the base User ID
    if (booking.customer.userId !== baseUserId) {
      return res.status(403).json({ message: "Доступ запрещен." });
    }

    if (booking.status !== "PENDING_CUSTOMER_PAYMENT") {
      return res.status(400).json({ message: "Неверный статус." });
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookingRequest.update({
        where: { id },
        data: { status: "CANCELLED_BY_CUSTOMER" },
      });
      await createAuditLog(tx, id, baseUserId, "CUSTOMER_DECLINED_FEE");
    });

    // Notify Performer
    notifyUser({
      userId: booking.performer.userId,
      title: "🚫 Бронирование отменено",
      body: `Заказчик отменил бронирование и отказался от оплаты.`,
      type: "BOOKING_CANCELLED",
      data: { url: "/bookings", bookingId: booking.id },
    }).catch(console.error);

    res.status(200).json({ message: "Бронирование отменено." });
  } catch (error) {
    res.status(500).json({ message: "Ошибка отмены." });
  }
});

// ==========================================
// 3b. CUSTOMER: Accept & Pay (Initialize Escrow)
// ==========================================
router.post("/:id/pay", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const baseUserId = req.user.id;

    // 🚨 FIX: Include the deeply nested 'user' relation to extract the customer's email
    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        customer: { include: { user: true } },
      },
    });

    if (!booking)
      return res.status(404).json({ message: "Бронирование не найдено." });

    // Verify ownership
    if (booking.customer.userId !== baseUserId) {
      return res.status(403).json({ message: "Доступ запрещен." });
    }

    if (booking.status !== "PENDING_CUSTOMER_PAYMENT") {
      return res.status(400).json({ message: "Ожидается оплата." });
    }

    const totalAmount = booking.agreedFee;
    const platformFee = totalAmount * 0.1; // 10% Platform fee
    const netAmount = totalAmount - platformFee;

    const checkoutUrl = await prisma.$transaction(async (tx) => {
      // 1. Pre-create pending DB payment
      const paymentRecord = await tx.payment.create({
        data: {
          amount: totalAmount,
          platformFee,
          netAmount,
          escrowStatus: "AWAITING_PAYMENT",
          provider: "TINKOFF_ESCROW",
          userId: baseUserId,
          bookingId: id,
          metadata: { type: "BOOKING_ESCROW", bookingId: id },
        },
      });

      // 2. Initialize Tinkoff
      const { paymentUrl } = await initTinkoffEscrowPayment(
        paymentRecord.id,
        totalAmount,
        booking.id,
        booking.customer.user.email, // 🚨 FIX: Safe access to deeply nested email
      );

      // 3. Log the action
      await createAuditLog(tx, id, baseUserId, "CUSTOMER_INITIATED_PAYMENT", {
        paymentId: paymentRecord.id,
      });

      return paymentUrl;
    });

    res.status(200).json({ checkoutUrl });
  } catch (error) {
    console.error("Payment Init Error:", error);
    res.status(500).json({ message: "Ошибка инициализации платежа." });
  }
});

export default router;
