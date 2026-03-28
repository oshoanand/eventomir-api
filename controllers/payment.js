import prisma from "../libs/prisma.js";
import { initTinkoffSubscriptionPayment } from "../utils/tinkoff.js";

// --- 1. GET ALL PLANS ---
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

// --- 2. GET CURRENT SUBSCRIPTION ---
export const getCurrentSubscription = async (req, res) => {
  try {
    const userId = req.user.id;

    const sub = await prisma.userSubscription.findFirst({
      where: {
        userId: userId,
        status: "ACTIVE",
        endDate: { gt: new Date() }, // Ensure it hasn't expired
      },
      include: { plan: true },
      orderBy: { endDate: "desc" },
    });

    if (!sub) return res.status(200).json(null);

    res.status(200).json({
      id: sub.id,
      planId: sub.planId,
      planName: sub.plan.name,
      status: sub.status,
      startDate: sub.startDate,
      endDate: sub.endDate,
      pricePaid: sub.pricePaid,
    });
  } catch (error) {
    console.error("Get Subscription Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- 3. INITIATE CHECKOUT ---
export const initiateCheckout = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { planId, interval } = req.body;

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

    // 3. Create Pending Payment with Metadata for the Webhook
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: price,
        provider: "tinkoff",
        status: "PENDING",
        metadata: {
          type: "SUBSCRIPTION", // Crucial for Webhook routing
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
