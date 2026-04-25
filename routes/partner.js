import { Router } from "express";
import prisma from "../libs/prisma.js";
import { sendPartnerWelcomeEmail } from "../mailer/email-sender.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import { notifyUser } from "../services/notification.js";

const router = Router();

// =================================================================
// 1. SUBMIT PARTNERSHIP REQUEST (Public Route)
// =================================================================
router.post("/partnership-request", async (req, res) => {
  try {
    // 1. Extract the new fields (phone, city) along with the others
    const { name, email, phone, city, website } = req.body;

    // 2. Basic validation to prevent empty submissions bypassing the frontend
    if (!name || !email || !phone || !city) {
      return res.status(400).json({
        message: "Имя, email, телефон и город обязательны для заполнения.",
      });
    }

    // 3. Check if an existing request is already pending for this email
    const existing = await prisma.partnershipRequest.findFirst({
      where: { email, status: "PENDING" }, // Schema uses strict Status Enum
    });

    if (existing) {
      return res.status(400).json({
        message: "Заявка с таким email уже находится на рассмотрении.",
      });
    }

    // 4. Save Request to DB (Website is optional and will save as null if empty)
    const request = await prisma.partnershipRequest.create({
      data: {
        name,
        email,
        phone,
        city,
        website,
        status: "PENDING",
      },
    });

    // 5. Send Email to Partner (Non-blocking)
    sendPartnerWelcomeEmail(email, name).catch((err) =>
      console.error("Failed to send partner welcome email:", err),
    );

    // ---------------------------------------------------------
    // 6. NOTIFY ALL ADMINS ROBUSTLY
    // ---------------------------------------------------------
    const admins = await prisma.user.findMany({
      where: { role: "administrator" },
      select: { id: true },
    });

    if (admins.length > 0) {
      await Promise.all(
        admins.map((admin) =>
          notifyUser({
            userId: admin.id,
            title: "🤝 Новая заявка на партнерство",
            body: `Поступила новая заявка от ${name} (${email}). Город: ${city}.`,
            type: "PARTNER_REQUEST",
            data: {
              partnerName: name,
              partnerEmail: email,
              partnerPhone: phone,
              partnerCity: city,
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

      if (req.user.id !== userId) {
        return res.status(403).json({ message: "Доступ запрещен" });
      }

      // 🚨 FIX: Query partnerProfile instead of partner
      const partner = await prisma.partnerProfile.findUnique({
        where: { userId },
        include: {
          referralEvents: {
            orderBy: { created_at: "desc" },
            take: 50,
          },
        },
      });

      if (!partner) {
        return res.status(404).json({ message: "Профиль партнера не найден." });
      }

      // Calculate Monthly Revenue
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

      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setDate(1); // Prevent overflow
        d.setMonth(new Date().getMonth() - i);

        monthlyRevenue.push({
          name: monthNames[d.getMonth()],
          total: 0,
          monthRaw: d.getMonth(),
          year: d.getFullYear(),
        });
      }

      partner.referralEvents.forEach((event) => {
        // Matches schema: commission_amount and created_at
        if (event.status === "paid" && event.commission_amount) {
          const d = new Date(event.created_at);
          const targetMonth = monthlyRevenue.find(
            (m) => m.monthRaw === d.getMonth() && m.year === d.getFullYear(),
          );
          if (targetMonth) targetMonth.total += event.commission_amount;
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

      // 🚨 FIX: Update partnerProfile instead of partner
      await prisma.partnerProfile.update({
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

      const result = await prisma.$transaction(async (tx) => {
        // 🚨 FIX: Find partnerProfile instead of partner
        const partner = await tx.partnerProfile.findUnique({
          where: { userId },
          include: { user: true },
        });

        if (!partner) throw new Error("Партнер не найден");
        if (partner.balance < partner.minPayout)
          throw new Error(`Минимальная сумма выплаты ${partner.minPayout}₽`);
        if (!partner.paymentDetails)
          throw new Error("Укажите платежные реквизиты перед запросом выплаты");

        // Create Payout Request
        const payout = await tx.payoutRequest.create({
          data: {
            partner_id: partner.id,
            amount: partner.balance,
            payment_details: partner.paymentDetails,
            status: "PENDING", // Matches schema: PayoutStatus enum
          },
        });

        // Reset Partner Balance
        // 🚨 FIX: Update partnerProfile instead of partner
        await tx.partnerProfile.update({
          where: { id: partner.id },
          data: { balance: 0 },
        });

        return { payout, partner };
      });

      // Notify Admins
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
