import prisma from "../libs/prisma.js";
import { initTinkoffSubscriptionPayment } from "../utils/tinkoff.js";
import "dotenv/config";

// --- GET ALL PLANS ---
export const getPlans = async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceMonthly: "asc" },
    });
    res.status(200).json(plans);
  } catch (error) {
    console.error("Get Plans Error:", error);
    res.status(500).json({ message: "Failed to fetch plans" });
  }
};

// --- GET CURRENT SUBSCRIPTION ---
export const getCurrentSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const sub = await prisma.userSubscription.findUnique({
      where: { userId: userId },
      include: { plan: true },
    });

    if (!sub) return res.status(200).json(null);

    // const isExpired =
    //   !sub.isActive || (sub.endDate && new Date(sub.endDate) < new Date());

    const isExpired =
      sub.status !== "ACTIVE" ||
      (sub.endDate && new Date(sub.endDate) < new Date());

    res.status(200).json({
      id: sub.id,
      planId: sub.planId,
      planName: sub.plan.name,
      status: isExpired ? "EXPIRED" : "ACTIVE",
      startDate: sub.startDate,
      endDate: sub.endDate,
      pricePaid: 0,
    });
  } catch (error) {
    console.error("Get Subscription Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- INITIATE CHECKOUT ---
export const initiateCheckout = async (req, res) => {
  try {
    const userId = req.user.id;

    // 🚨 FIX: Fallback email to prevent Tinkoff Receipt formatting crash
    const userEmail = req.user.email || "no-reply@eventomir.ru";
    const { planId, interval, paymentMethod } = req.body;

    if (!planId || !interval) {
      return res.status(400).json({ message: "Не указан тариф или период." });
    }

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) return res.status(404).json({ message: "Тариф не найден." });

    // Determine correct price based on interval
    let price = plan.priceMonthly;
    if (interval === "half_year" && plan.priceHalfYearly)
      price = plan.priceHalfYearly;
    if (interval === "year" && plan.priceYearly) price = plan.priceYearly;

    if (price <= 0) {
      return res.status(400).json({ message: "Неверная цена тарифа." });
    }

    // --- WALLET PAYMENT LOGIC ---
    if (paymentMethod === "wallet") {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const currentBalance = user.walletBalance || 0; // Prevent null errors

      if (currentBalance < price) {
        return res
          .status(400)
          .json({ message: "Недостаточно средств на балансе кошелька." });
      }

      // Calculate new end date
      const newEndDate = new Date();
      if (interval === "month") newEndDate.setMonth(newEndDate.getMonth() + 1);
      if (interval === "half_year")
        newEndDate.setMonth(newEndDate.getMonth() + 6);
      if (interval === "year")
        newEndDate.setFullYear(newEndDate.getFullYear() + 1);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { walletBalance: { decrement: price } },
        }),
        prisma.walletTransaction.create({
          data: {
            userId: userId,
            amount: -price,
            type: "PAYMENT",
            description: `Оплата подписки: ${plan.name}`,
          },
        }),
        prisma.userSubscription.upsert({
          where: { userId: userId },
          update: {
            planId: plan.id,
            startDate: new Date(),
            endDate: newEndDate,
            isActive: true,
          },
          create: {
            userId: userId,
            planId: plan.id,
            startDate: new Date(),
            endDate: newEndDate,
            isActive: true,
          },
        }),
        prisma.payment.create({
          data: {
            userId: userId,
            amount: price,
            provider: "wallet",
            status: "COMPLETED",
            metadata: { type: "SUBSCRIPTION", planId: plan.id, interval },
          },
        }),
      ]);

      return res.status(200).json({ success: true, checkoutUrl: null });
    }

    // --- CARD PAYMENT LOGIC (TINKOFF) ---
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: price,
        provider: "tinkoff",
        status: "PENDING",
        metadata: { type: "SUBSCRIPTION", planId: plan.id, interval },
      },
    });

    try {
      const tinkoffData = await initTinkoffSubscriptionPayment(
        payment.id,
        price,
        plan.name,
        interval,
        userEmail, // Now guaranteed to be a valid string
      );

      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerTxId: String(tinkoffData.paymentId) },
      });

      return res.status(200).json({
        success: true,
        checkoutUrl: tinkoffData.paymentUrl,
      });
    } catch (tinkoffError) {
      console.error(
        "TINKOFF INIT FATAL ERROR:",
        tinkoffError.message || tinkoffError,
      );

      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });

      // 🚨 FIX: Pass the exact Tinkoff error to the frontend instead of masking it!
      return res.status(502).json({
        message: `Ошибка банка: ${tinkoffError.message}`,
      });
    }
  } catch (error) {
    console.error("Checkout Error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
};

export const getRequestPrice = async (req, res) => {
  try {
    const FIXED_REQUEST_PRICE = process.env.REQUEST_PRICE
      ? parseInt(process.env.REQUEST_PRICE)
      : 490;
    res.status(200).json({ price: FIXED_REQUEST_PRICE });
  } catch (error) {
    console.error("Get Request Price Error:", error);
    res.status(500).json({ message: "Unable to fetch price" });
  }
};
