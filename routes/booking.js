import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { initTinkoffEscrowPayment } from "../utils/tinkoff.js";

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
    const customerId = req.user.id;

    if (performerId === customerId)
      return res
        .status(403)
        .json({ message: "Отказ: бронирование самого себя." });

    const performer = await prisma.performerProfile.findUnique({
      where: { userId: performerId },
    });
    if (!performer)
      return res.status(404).json({ message: "Исполнитель не найден." });

    // Block overlapping requests
    const isBusy = performer.bookedDates.some(
      (d) =>
        new Date(d).toISOString().split("T")[0] ===
        new Date(date).toISOString().split("T")[0],
    );
    if (isBusy) return res.status(400).json({ message: "Дата уже занята." });

    const booking = await prisma.$transaction(async (tx) => {
      const newBooking = await tx.bookingRequest.create({
        data: {
          performerId: performer.id,
          customerId,
          date: new Date(date),
          details: details,
          status: "PENDING_PERFORMER_APPROVAL",
        },
      });

      await createAuditLog(tx, newBooking.id, customerId, "REQUEST_CREATED", {
        details,
        date,
      });
      return newBooking;
    });

    res.status(201).json(booking);
  } catch (error) {
    console.error("Create Booking Error:", error);
    res.status(500).json({ message: "Ошибка создания бронирования." });
  }
});

// ==========================================
// 🚨 RESTORED: GET MY BOOKINGS (MADE & RECEIVED)
// ==========================================
router.get("/my", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch bookings made by the logged-in user
    const madeRaw = await prisma.bookingRequest.findMany({
      where: { customerId: userId },
      include: {
        performer: {
          include: {
            user: { select: { name: true, image: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Map the city from the profile into the user object for the frontend
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

    // Check if the user is a performer to fetch received bookings
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId },
    });

    let received = [];
    if (performerProfile) {
      received = await prisma.bookingRequest.findMany({
        where: { performerId: performerProfile.id },
        include: {
          customer: {
            select: { name: true, email: true, image: true, phone: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    }

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

    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: { performer: true },
    });

    if (!booking)
      return res.status(404).json({ message: "Бронирование не найдено." });
    if (booking.performer.userId !== userId)
      return res.status(403).json({ message: "Доступ запрещен." });
    if (booking.status !== "PENDING_PERFORMER_APPROVAL")
      return res
        .status(400)
        .json({ message: "Статус бронирования не позволяет этот ответ." });

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
    const userId = req.user.id;

    const booking = await prisma.bookingRequest.findUnique({ where: { id } });

    if (!booking || booking.customerId !== userId)
      return res.status(403).json({ message: "Доступ запрещен." });
    if (booking.status !== "PENDING_CUSTOMER_PAYMENT")
      return res.status(400).json({ message: "Неверный статус." });

    await prisma.$transaction(async (tx) => {
      await tx.bookingRequest.update({
        where: { id },
        data: { status: "CANCELLED_BY_CUSTOMER" },
      });
      await createAuditLog(tx, id, userId, "CUSTOMER_DECLINED_FEE");
    });

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
    const userId = req.user.id;

    const booking = await prisma.bookingRequest.findUnique({
      where: { id },
      include: { customer: true },
    });

    if (!booking || booking.customerId !== userId)
      return res.status(403).json({ message: "Доступ запрещен." });
    if (booking.status !== "PENDING_CUSTOMER_PAYMENT")
      return res.status(400).json({ message: "Ожидается оплата." });

    const totalAmount = booking.agreedFee;
    const platformFee = totalAmount * 0.1; // 10% Platform fee
    const netAmount = totalAmount - platformFee;

    // 🚨 FIX: Wrapped the payment creation and Tinkoff init in a Transaction!
    // If Tinkoff fails to initialize, the DB payment record and audit log are safely rolled back.
    const checkoutUrl = await prisma.$transaction(async (tx) => {
      // 1. Pre-create pending DB payment
      const paymentRecord = await tx.payment.create({
        data: {
          amount: totalAmount,
          platformFee,
          netAmount,
          escrowStatus: "AWAITING_PAYMENT",
          provider: "TINKOFF_ESCROW",
          userId,
          bookingId: id,
          metadata: { type: "BOOKING_ESCROW", bookingId: id },
        },
      });

      // 2. Initialize Tinkoff (Throws error if it fails, aborting transaction)
      const { paymentUrl } = await initTinkoffEscrowPayment(
        paymentRecord.id,
        totalAmount,
        booking.id,
        booking.customer.email,
      );

      // 3. Log the action
      await createAuditLog(tx, id, userId, "CUSTOMER_INITIATED_PAYMENT", {
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
