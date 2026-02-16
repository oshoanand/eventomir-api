import prisma from "../libs/prisma.js";
import { createPaymentIntent } from "../services/payment-gateway.js";

// --- GET /api/payments/plans ---
export const getPlans = async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceMonthly: "asc" },
    });
    res.json(plans);
  } catch (error) {
    console.error("Get Plans Error:", error);
    res.status(500).json({ message: "Failed to fetch plans" });
  }
};

// --- POST /api/payments/checkout ---
export const initiateCheckout = async (req, res) => {
  try {
    const userId = req.user.id; // From verifyAuth middleware
    const { planId } = req.body;

    // 1. Validate Plan
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    // 2. Create Pending Payment Record
    const payment = await prisma.payment.create({
      data: {
        userId,
        amount: plan.priceMonthly,
        provider: "mock-provider",
        status: "PENDING",
        metadata: { planId: plan.id }, // Store plan ID to activate later
      },
    });

    // 3. Generate Provider Checkout URL
    const intent = await createPaymentIntent(plan.priceMonthly, "RUB", {
      paymentId: payment.id,
      userId,
    });

    // 4. Update Payment with Provider Transaction ID
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerTxId: intent.id },
    });

    // 5. Return URL to Frontend
    res.json({ checkoutUrl: intent.checkoutUrl });
  } catch (error) {
    console.error("Checkout Error:", error);
    res.status(500).json({ message: "Checkout failed" });
  }
};

// --- GET /api/payments/mock-success ---
// This endpoint is hit by the "Mock Gateway" (browser redirect)
export const handleMockSuccess = async (req, res) => {
  try {
    const { txId } = req.query;
    const clientUrl = process.env.WEB_APP_URL || "http://localhost:3000";

    if (!txId) {
      return res.redirect(`${clientUrl}/pricing?status=error`);
    }

    // 1. Find the pending payment
    const payment = await prisma.payment.findFirst({
      where: { providerTxId: txId, status: "PENDING" },
    });

    if (!payment) {
      // Already processed or invalid
      return res.redirect(`${clientUrl}/pricing?status=already_processed`);
    }

    const meta = payment.metadata || {};

    // 2. Run Transaction: Complete Payment & Activate Subscription
    await prisma.$transaction(async (tx) => {
      // A. Mark Payment Complete
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "COMPLETED" },
      });

      // B. Calculate Dates (30 Days)
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 30);

      // C. Update/Create User Subscription
      await tx.userSubscription.upsert({
        where: { userId: payment.userId },
        update: {
          planId: meta.planId,
          isActive: true,
          startDate: startDate,
          endDate: endDate,
        },
        create: {
          userId: payment.userId,
          planId: meta.planId,
          isActive: true,
          startDate: startDate,
          endDate: endDate,
        },
      });
    });

    // 3. Redirect User back to Frontend Success Page
    return res.redirect(`${clientUrl}/pricing?status=success`);
  } catch (error) {
    console.error("Payment Success Handler Error:", error);
    const clientUrl = process.env.WEB_APP_URL || "http://localhost:3000";
    return res.redirect(`${clientUrl}/pricing?status=server_error`);
  }
};
