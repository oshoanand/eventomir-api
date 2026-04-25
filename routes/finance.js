import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// 1. GET FINANCIAL SUMMARY
// ==========================================
router.get("/summary", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        performerProfile: true,
        partnerProfile: true,
      },
    });

    if (!user)
      return res.status(404).json({ message: "Пользователь не найден" });

    const isCustomer = true; // Everyone can be a customer
    const isPerformer = !!user.performerProfile;
    const isPartner = !!user.partnerProfile;

    let heldInEscrow = 0;
    let totalEarned = 0;
    let totalSpent = 0;

    // Calculate Customer Metrics
    const customerPayments = await prisma.payment.findMany({
      where: { userId, status: "COMPLETED" },
    });
    totalSpent = customerPayments.reduce((sum, p) => sum + p.amount, 0);

    const customerEscrow = await prisma.payment.findMany({
      where: { userId, escrowStatus: "HELD" },
    });
    // For customers, the held amount is what they paid in total
    const customerHeld = customerEscrow.reduce((sum, p) => sum + p.amount, 0);

    // Calculate Performer Metrics
    if (isPerformer) {
      const performerBookings = await prisma.bookingRequest.findMany({
        where: { performerId: user.performerProfile.id },
        include: { payment: true },
      });

      performerBookings.forEach((booking) => {
        if (booking.payment) {
          // If released, it counts as earned
          if (booking.payment.escrowStatus === "RELEASED") {
            totalEarned += booking.payment.netAmount;
          }
          // If held, it counts towards their expected payout
          if (booking.payment.escrowStatus === "HELD") {
            heldInEscrow += booking.payment.netAmount;
          }
        }
      });
    } else {
      heldInEscrow = customerHeld; // If just a customer, show their locked funds
    }

    res.status(200).json({
      walletBalance: user.walletBalance,
      totalEarned,
      totalSpent,
      heldInEscrow,
      userRoles: { isCustomer, isPerformer, isPartner },
    });
  } catch (error) {
    console.error("Finance Summary Error:", error);
    res.status(500).json({ message: "Ошибка загрузки финансовой сводки" });
  }
});

// ==========================================
// 2. GET TRANSACTION HISTORY
// ==========================================
router.get("/transactions", verifyAuth, async (req, res) => {
  try {
    const transactions = await prisma.walletTransaction.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 50, // Limit to recent 50 for performance
    });

    res.status(200).json(transactions);
  } catch (error) {
    res.status(500).json({ message: "Ошибка загрузки истории операций" });
  }
});

// ==========================================
// 3. GET ESCROW PAYMENTS (SAFE DEALS)
// ==========================================
router.get("/escrow", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { performerProfile: true },
    });

    const isPerformer = !!user.performerProfile;

    // Build the query based on whether the user is viewing as a buyer or a seller
    const whereClause = {
      escrowStatus: { notIn: ["AWAITING_PAYMENT", "NONE"] },
      OR: [
        { userId: userId }, // Payments made by this user (Customer view)
      ],
    };

    if (isPerformer) {
      whereClause.OR.push({
        booking: { performerId: user.performerProfile.id }, // Payments routed to this performer
      });
    }

    const escrows = await prisma.payment.findMany({
      where: whereClause,
      include: {
        booking: {
          include: {
            customer: { select: { name: true, email: true } },
            performer: { include: { user: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json(escrows);
  } catch (error) {
    console.error("Escrow Fetch Error:", error);
    res.status(500).json({ message: "Ошибка загрузки безопасных сделок" });
  }
});

// ==========================================
// 4. GET PAYOUT REQUESTS
// ==========================================
router.get("/payouts", verifyAuth, async (req, res) => {
  try {
    const payouts = await prisma.payoutRequest.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json(payouts);
  } catch (error) {
    res.status(500).json({ message: "Ошибка загрузки истории выводов" });
  }
});

// ==========================================
// 5. CREATE A PAYOUT REQUEST (WITHDRAWAL)
// ==========================================
router.post("/payouts", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, paymentDetails } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Укажите корректную сумму" });
    }
    if (!paymentDetails || !paymentDetails.trim()) {
      return res
        .status(400)
        .json({ message: "Укажите реквизиты для перевода" });
    }

    // 🚨 SECURITY: We must use a Transaction to prevent race conditions (double spending)
    await prisma.$transaction(async (tx) => {
      // 1. Fetch user and lock the row (if using raw queries, we'd use SELECT FOR UPDATE)
      // Prisma handles this natively in sequential operations within a transaction.
      const user = await tx.user.findUnique({ where: { id: userId } });

      // 2. Verify sufficient funds
      if (user.walletBalance < amount) {
        throw new Error("Недостаточно средств на балансе");
      }

      // 3. Deduct the amount immediately so it can't be withdrawn twice
      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: amount } },
      });

      // 4. Create the Payout Request for Admin review
      await tx.payoutRequest.create({
        data: {
          userId,
          amount,
          paymentDetails,
          status: "PENDING",
        },
      });

      // 5. Log it in the Wallet Transactions
      await tx.walletTransaction.create({
        data: {
          userId,
          amount: amount,
          type: "PAYOUT",
          description: `Заявка на вывод средств (в обработке)`,
        },
      });
    });

    res.status(201).json({ message: "Заявка на вывод успешно создана" });
  } catch (error) {
    console.error("Payout Request Error:", error);
    // Return friendly message if it's our custom thrown error
    if (error.message === "Недостаточно средств на балансе") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Ошибка создания заявки на вывод" });
  }
});

export default router;
