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

    // 🚨 FIX: UserSubscription schema has userId as @unique, and uses `isActive` boolean
    const sub = await prisma.userSubscription.findUnique({
      where: { userId: userId },
      include: { plan: true },
    });

    if (!sub) return res.status(200).json(null);

    // Calculate dynamic status
    const isExpired =
      !sub.isActive || (sub.endDate && new Date(sub.endDate) < new Date());

    res.status(200).json({
      id: sub.id,
      planId: sub.planId,
      planName: sub.plan.name,
      status: isExpired ? "EXPIRED" : "ACTIVE", // Mapped for frontend compatibility
      startDate: sub.startDate,
      endDate: sub.endDate,
      pricePaid: 0, // Fallback as pricePaid is not in schema
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
    const userEmail = req.user.email;
    const { planId, interval, paymentMethod } = req.body; // 🚨 Extracted paymentMethod

    if (!planId || !interval) {
      return res
        .status(400)
        .json({ message: "Plan ID and interval are required." });
    }

    // 1. Find the requested plan
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) return res.status(404).json({ message: "Plan not found." });

    // 2. Determine correct price based on interval
    let price = plan.priceMonthly;
    if (interval === "half_year" && plan.priceHalfYearly)
      price = plan.priceHalfYearly;
    if (interval === "year" && plan.priceYearly) price = plan.priceYearly;

    if (price <= 0) {
      return res.status(400).json({ message: "Invalid plan price." });
    }

    // --- 🚀 NEW: WALLET PAYMENT LOGIC ---
    if (paymentMethod === "wallet") {
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (user.walletBalance < price) {
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

      // Execute atomic transaction for wallet payment
      await prisma.$transaction([
        // 1. Deduct Balance
        prisma.user.update({
          where: { id: userId },
          data: { walletBalance: { decrement: price } },
        }),
        // 2. Log Wallet Transaction
        prisma.walletTransaction.create({
          data: {
            userId: userId,
            amount: -price, // Negative because it's a payment
            type: "PAYMENT",
            description: `Оплата подписки: ${plan.name}`,
          },
        }),
        // 3. Upsert User Subscription
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
        // 4. Log General Payment
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

      // Return null checkoutUrl since it's instantly completed
      return res.status(200).json({ success: true, checkoutUrl: null });
    }

    // --- CARD PAYMENT LOGIC (TINKOFF) ---
    // 3. Create Pending Payment with Metadata for the Webhook
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: price,
        provider: "tinkoff",
        status: "PENDING",
        metadata: {
          type: "SUBSCRIPTION",
          planId: plan.id,
          interval: interval,
        },
      },
    });

    // 4. Call Tinkoff API
    try {
      const tinkoffData = await initTinkoffSubscriptionPayment(
        payment.id,
        price,
        plan.name,
        interval,
        userEmail,
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
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      throw new Error("TINKOFF_INIT_FAILED");
    }
  } catch (error) {
    console.error("Checkout Error:", error);
    if (error.message === "TINKOFF_INIT_FAILED") {
      return res.status(502).json({ message: "Ошибка платежного шлюза." });
    }
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getRequestPrice = async (req, res) => {
  try {
    const FIXED_REQUEST_PRICE = process.env.REQUEST_PRICE || 490;

    res.status(200).json({ price: FIXED_REQUEST_PRICE });
  } catch (error) {
    console.error("Get Request Price Error:", error);
    res.status(500).json({ message: "Unable to fetch price" });
  }
};
