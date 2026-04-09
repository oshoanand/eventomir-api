import { Router } from "express";
import prisma from "../libs/prisma.js";
import { sendPartnerWelcomeEmail } from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";

// 🚨 IMPORT THE MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

const router = Router();

// =================================================================
// 1. SUBMIT PARTNERSHIP REQUEST (Public Route)
// =================================================================
router.post("/partnership-request", async (req, res) => {
  try {
    const { name, email, website } = req.body;

    // 1. Check if existing request is already pending
    const existing = await prisma.partnershipRequest.findFirst({
      where: { email, status: "PENDING" },
    });
    if (existing) {
      return res.status(400).json({
        message: "Заявка с таким email уже находится на рассмотрении.",
      });
    }

    // 2. Save Request to DB
    const request = await prisma.partnershipRequest.create({
      data: { name, email, website },
    });

    // 3. Send Email to Partner (Non-blocking)
    sendPartnerWelcomeEmail(email, name).catch((err) =>
      console.error("Failed to send partner welcome email:", err),
    );

    // ---------------------------------------------------------
    // 4. NOTIFY ALL ADMINS ROBUSTLY
    // ---------------------------------------------------------
    const admins = await prisma.user.findMany({
      where: { role: "administrator" },
      select: { id: true },
    });

    if (admins.length > 0) {
      // Use Promise.all to dispatch notifications concurrently
      await Promise.all(
        admins.map((admin) =>
          notifyUser({
            userId: admin.id,
            title: "🤝 Новая заявка на партнерство",
            body: `Поступила новая заявка от ${name} (${email}).`,
            type: "PARTNER_REQUEST",
            data: {
              partnerName: name,
              partnerEmail: email,
              requestId: request.id,
              url: "/partners",
            },
          }),
        ),
      );
    }

    res.status(201).json({ message: "Заявка отправлена успешно." });
  } catch (error) {
    console.error("Error submitting partnership request:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
});

// =================================================================
// 2. GET PARTNER DASHBOARD DATA
// =================================================================
router.get(
  "/:userId/dashboard",
  verifyAuth,
  requireRole(["partner"]),
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Verify user is requesting their own data
      if (req.user.id !== userId) {
        return res.status(403).json({ message: "Доступ запрещен" });
      }

      const partner = await prisma.partner.findUnique({
        where: { userId },
        include: {
          referralEvents: {
            orderBy: { created_at: "desc" },
            take: 50, // Get the 50 most recent events
          },
        },
      });

      if (!partner) {
        return res.status(404).json({ message: "Профиль партнера не найден." });
      }

      // Calculate Monthly Revenue (Last 6 months)
      const monthlyRevenue = [];
      const monthNames = [
        "Янв",
        "Фев",
        "Мар",
        "Апр",
        "Май",
        "Июн",
        "Июл",
        "Авг",
        "Сен",
        "Окт",
        "Ноя",
        "Дек",
      ];

      // Initialize last 6 months with 0
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        monthlyRevenue.push({
          name: monthNames[d.getMonth()],
          total: 0,
          monthRaw: d.getMonth(),
          year: d.getFullYear(),
        });
      }

      // Populate revenue
      partner.referralEvents.forEach((event) => {
        if (event.status === "paid" && event.commissionAmount) {
          const d = new Date(event.created_at);
          const targetMonth = monthlyRevenue.find(
            (m) => m.monthRaw === d.getMonth() && m.year === d.getFullYear(),
          );
          if (targetMonth) targetMonth.total += event.commissionAmount;
        }
      });

      res.json({
        partnerId: partner.id,
        referralId: partner.referralId,
        balance: partner.balance,
        totalEarned: partner.totalEarned,
        totalRegistrations: partner.totalRegistrations,
        totalPaidConversions: partner.totalPaidConversions,
        clicks: partner.clicks,
        minPayout: partner.minPayout,
        paymentDetails: partner.paymentDetails,
        referralEvents: partner.referralEvents,
        monthlyRevenue: monthlyRevenue.map(({ name, total }) => ({
          name,
          total,
        })),
      });
    } catch (error) {
      console.error("Dashboard error:", error);
      res.status(500).json({ message: "Ошибка сервера" });
    }
  },
);

// =================================================================
// 3. PATCH PAYMENT DETAILS
// =================================================================
router.patch(
  "/:userId/payment-details",
  verifyAuth,
  requireRole(["partner"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { paymentDetails } = req.body;

      if (req.user.id !== userId) {
        return res.status(403).json({ message: "Доступ запрещен" });
      }

      await prisma.partner.update({
        where: { userId },
        data: { paymentDetails },
      });

      res.json({ message: "Реквизиты обновлены успешно" });
    } catch (error) {
      console.error("Payment details update error:", error);
      res.status(500).json({ message: "Ошибка обновления реквизитов" });
    }
  },
);

// =================================================================
// 4. POST REQUEST PAYOUT
// =================================================================
router.post(
  "/:userId/payouts",
  verifyAuth,
  requireRole(["partner"]),
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (req.user.id !== userId) {
        return res.status(403).json({ message: "Доступ запрещен" });
      }

      // Run inside a transaction to prevent race conditions
      const result = await prisma.$transaction(async (tx) => {
        const partner = await tx.partner.findUnique({
          where: { userId },
          include: { user: true },
        });

        if (!partner) throw new Error("Партнер не найден");
        if (partner.balance < partner.minPayout)
          throw new Error(`Минимальная сумма выплаты ${partner.minPayout}₽`);
        if (!partner.paymentDetails)
          throw new Error("Укажите платежные реквизиты перед запросом выплаты");

        // 1. Create Payout Request
        const payout = await tx.payoutRequest.create({
          data: {
            partner_id: partner.id,
            amount: partner.balance,
            payment_details: partner.paymentDetails,
            status: "pending",
          },
        });

        // 2. Reset Partner Balance
        await tx.partner.update({
          where: { id: partner.id },
          data: { balance: 0 },
        });

        return { payout, partner };
      });

      // ---------------------------------------------------------
      // NOTIFY ADMINS VIA MASTER DISPATCHER
      // ---------------------------------------------------------
      const admins = await prisma.user.findMany({
        where: { role: "administrator" },
        select: { id: true },
      });

      if (admins.length > 0) {
        const partnerName =
          result.partner.user.name || result.partner.user.email;

        await Promise.all(
          admins.map((admin) =>
            notifyUser({
              userId: admin.id,
              title: "💸 Новый запрос на выплату",
              body: `Запрос на выплату ${result.payout.amount}₽ от партнера ${partnerName}`,
              type: "PAYOUT_REQUEST",
              data: {
                payoutId: result.payout.id,
                amount: result.payout.amount,
                url: "/payouts",
              },
            }),
          ),
        );
      }

      res.status(201).json({
        message: "Запрос на выплату успешно создан",
        data: result.payout,
      });
    } catch (error) {
      console.error("Payout request error:", error);
      res.status(400).json({ message: error.message || "Ошибка сервера" });
    }
  },
);

export default router;
