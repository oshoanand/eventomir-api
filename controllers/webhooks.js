import prisma from "../libs/prisma.js";
import { generateTinkoffToken } from "../utils/tinkoff.js";
import { notifyTargetedPerformers } from "./request.js";

export const handleTinkoffWebhook = async (req, res) => {
  try {
    const payload = req.body;

    console.log(payload);

    // ----------------------------------------------------------------
    // 1. SECURITY: VERIFY SIGNATURE
    // ----------------------------------------------------------------
    // Tinkoff sends a "Token" field. We must recalculate it using our
    // secret password and compare it to ensure a hacker isn't faking this request.
    const receivedToken = payload.Token;
    const payloadForCheck = { ...payload };
    delete payloadForCheck.Token; // Remove token before hashing
    console.log(receivedToken);

    const calculatedToken = generateTinkoffToken(payloadForCheck);
    console.log(calculatedToken);
    if (receivedToken !== calculatedToken) {
      console.error("🚨 CRITICAL: Invalid Tinkoff Webhook Signature detected!");
      return res.status(403).send("Invalid Token"); // Tinkoff expects HTTP status
    }

    // ----------------------------------------------------------------
    // 2. EXTRACT DATA & PREVENT DOUBLE-SPENDING (IDEMPOTENCY)
    // ----------------------------------------------------------------
    const { OrderId, Status, Amount } = payload;
    const actualAmountRubles = Amount / 100; // Convert kopecks back to rubles

    // Find the payment in our database
    const payment = await prisma.payment.findUnique({
      where: { id: OrderId },
      include: { paidRequest: { include: { customer: true } } },
    });

    if (!payment) return res.status(404).send("Payment not found");

    // If we already completed this payment, just tell Tinkoff "OK" so they stop pinging us
    if (payment.status === "COMPLETED") {
      return res.status(200).send("OK");
    }

    // If the payment failed or was rejected by the bank
    if (Status === "REJECTED" || Status === "CANCELED") {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(200).send("OK");
    }

    // ----------------------------------------------------------------
    // 3. PROCESS SUCCESSFUL PAYMENTS (CONFIRMED)
    // ----------------------------------------------------------------
    if (Status === "CONFIRMED") {
      const metadata = payment.metadata || {};

      // === SCENARIO A: WALLET TOP-UP ===
      if (metadata.type === "WALLET_TOPUP") {
        // 🚨 Atomic Transaction: Update payment, add funds, create ledger entry all at once
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" },
          }),
          prisma.user.update({
            where: { id: payment.userId },
            data: { walletBalance: { increment: actualAmountRubles } },
          }),
          prisma.walletTransaction.create({
            data: {
              userId: payment.userId,
              amount: actualAmountRubles, // Positive for top-ups
              type: "TOPUP",
              description: `Пополнение кошелька картой`,
            },
          }),
        ]);
        console.log(
          `💰 Successfully topped up user ${payment.userId} by ${actualAmountRubles} RUB`,
        );
      }

      // === SCENARIO B: DIRECT PAID REQUEST (Bank Card checkout) ===
      else if (payment.paidRequestId) {
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" },
          }),
          prisma.paidRequest.update({
            where: { id: payment.paidRequestId },
            data: { status: "OPEN" }, // Make it visible to performers
          }),
        ]);

        // Now that the request is OPEN and paid for, notify the performers!
        if (payment.paidRequest) {
          await notifyTargetedPerformers(
            payment.paidRequest,
            payment.paidRequest.customer.name,
          );
        }
      }

      // Tell Tinkoff we successfully processed the webhook
      return res.status(200).send("OK");
    }

    // For any other intermediate statuses (like AUTHORIZED), just acknowledge receipt
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Processing Error:", error);
    // Tinkoff will retry sending the webhook later if we send a 500 error
    res.status(500).send("Internal Error");
  }
};
