import prisma from "../libs/prisma.js";
import { generateTinkoffToken } from "../utils/tinkoff.js";
import { notifyTargetedPerformers } from "./request.js";
import { invalidateKeys } from "../libs/redis.js";

// Import mailer utilities
import {
  generateTicketPDF,
  generateSubscriptionReceiptPDF,
} from "../mailer/pdf-generator.js";
import {
  sendTicketEmail,
  sendSubscriptionReceiptEmail,
} from "../mailer/email-sender.js";

// =====================================================================
// 1. GENERAL PAYMENTS WEBHOOK (Wallet, Requests, Subscriptions via Card)
// =====================================================================
export const handleTinkoffWebhook = async (req, res) => {
  try {
    const payload = req.body;

    // ----------------------------------------------------------------
    // A. SECURITY: VERIFY SIGNATURE
    // ----------------------------------------------------------------
    const expectedToken = generateTinkoffToken(payload);

    if (expectedToken !== payload.Token) {
      console.error(
        "🚨 CRITICAL: Invalid Tinkoff Webhook Signature detected (General)!",
        { expected: expectedToken, received: payload.Token },
      );
      return res.status(200).send("OK");
    }

    // ----------------------------------------------------------------
    // B. EXTRACT DATA & IDEMPOTENCY CHECK
    // ----------------------------------------------------------------
    const orderId = payload.OrderId;
    const status = payload.Status;
    const actualAmountRubles = payload.Amount / 100;

    const payment = await prisma.payment.findUnique({
      where: { id: orderId },
      include: {
        paidRequest: { include: { customer: true } },
        user: true,
      },
    });

    if (!payment) {
      console.error(`Webhook Error: Payment ID ${orderId} not found in DB.`);
      return res.status(200).send("OK");
    }

    if (payment.status === "COMPLETED") {
      return res.status(200).send("OK");
    }

    if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(200).send("OK");
    }

    // ----------------------------------------------------------------
    // C. PROCESS SUCCESSFUL PAYMENTS (CONFIRMED)
    // ----------------------------------------------------------------
    if (status === "CONFIRMED") {
      if (Number(payload.Amount) !== Math.round(payment.amount * 100)) {
        console.error(
          `🚨 Amount mismatch for Payment ${orderId}. Expected ${payment.amount * 100}, got ${payload.Amount}`,
        );
        return res.status(200).send("OK");
      }

      const metadata = payment.metadata || {};

      // === SCENARIO 1: WALLET TOP-UP ===
      if (metadata.type === "WALLET_TOPUP") {
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
              amount: actualAmountRubles,
              type: "TOPUP",
              description: `Пополнение кошелька картой`,
            },
          }),
        ]);
        console.log(
          `💰 Topped up user ${payment.userId} by ${actualAmountRubles} RUB`,
        );
      }

      // === SCENARIO 2: DIRECT PAID REQUEST ===
      else if (payment.paidRequestId) {
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" },
          }),
          prisma.paidRequest.update({
            where: { id: payment.paidRequestId },
            data: { status: "OPEN" },
          }),
        ]);

        if (payment.paidRequest) {
          notifyTargetedPerformers(
            payment.paidRequest,
            payment.paidRequest.customer.name,
          ).catch((err) => console.error("Notify Error:", err));
        }
      }

      // === SCENARIO 3: SUBSCRIPTION PRICING PLAN ===
      else if (metadata.type === "SUBSCRIPTION") {
        const { planId, interval, promoCodeId, discountAmount } = metadata;

        let monthsToAdd = 1;
        if (interval === "half_year") monthsToAdd = 6;
        if (interval === "year") monthsToAdd = 12;

        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(startDate.getMonth() + monthsToAdd);

        const plan = await prisma.subscriptionPlan.findUnique({
          where: { id: planId },
        });

        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" },
          });

          await tx.userSubscription.updateMany({
            where: { userId: payment.userId, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });

          await tx.userSubscription.upsert({
            where: { userId: payment.userId },
            update: {
              planId: planId,
              status: "ACTIVE",
              startDate: startDate,
              endDate: endDate,
              pricePaid: actualAmountRubles,
              promoCodeId: promoCodeId || null,
              discountAmount: discountAmount || null,
            },
            create: {
              userId: payment.userId,
              planId: planId,
              status: "ACTIVE",
              startDate: startDate,
              endDate: endDate,
              pricePaid: actualAmountRubles,
              promoCodeId: promoCodeId || null,
              discountAmount: discountAmount || null,
            },
          });
        });

        console.log(
          `✅ Subscription [${plan?.name}] activated for user ${payment.userId}`,
        );

        // Non-blocking PDF & Email execution
        processSubscriptionDelivery(
          payment,
          payment.user,
          plan,
          actualAmountRubles,
          interval,
        ).catch((err) => console.error("Async Subscription Email Error:", err));
      }

      return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Processing Error:", error);
    res.status(200).send("OK");
  }
};

// =====================================================================
// 2. EVENT TICKETS WEBHOOK
// =====================================================================
export const handleTinkoffEventTicketWebhook = async (req, res) => {
  try {
    const notification = req.body;
    const expectedToken = generateTinkoffToken(notification);

    if (expectedToken !== notification.Token) {
      console.error(
        "🚨 CRITICAL: Invalid Tinkoff Webhook Signature (Events)!",
        { expected: expectedToken, received: notification.Token },
      );
      return res.status(200).send("OK");
    }

    const orderId = notification.OrderId;
    const status = notification.Status;
    const tinkoffPaymentId = String(notification.PaymentId);
    const paidAmount = notification.Amount;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    if (!order) {
      console.error(`Webhook Error: Order ID ${orderId} not found in DB.`);
      return res.status(200).send("OK");
    }

    if (order.status === "ACTIVE" || order.status === "CANCELLED") {
      return res.status(200).send("OK");
    }

    if (status === "CONFIRMED") {
      if (Number(paidAmount) !== Math.round(order.totalPrice * 100)) {
        console.error(`🚨 Amount mismatch for order ${orderId}`);
        return res.status(200).send("OK");
      }

      await prisma.$transaction([
        prisma.order.update({
          where: { id: orderId },
          data: { status: "ACTIVE" },
        }),
        prisma.payment.updateMany({
          where: { providerTxId: tinkoffPaymentId },
          data: { status: "COMPLETED" },
        }),
      ]);

      if (typeof invalidateKeys === "function") {
        await invalidateKeys([
          "events:all",
          `events:${order.eventId}`,
          "orders:my",
          "orders:all",
        ]);
      }

      processTicketDelivery(order).catch((err) =>
        console.error("Async Ticket Delivery Error:", err),
      );
    } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      if (order.status !== "CANCELLED") {
        await prisma.$transaction([
          prisma.order.update({
            where: { id: orderId },
            data: { status: "CANCELLED" },
          }),
          prisma.event.update({
            where: { id: order.eventId },
            data: { availableTickets: { increment: order.ticketCount } },
          }),
          prisma.payment.updateMany({
            where: { providerTxId: tinkoffPaymentId },
            data: { status: "FAILED" },
          }),
        ]);

        if (typeof invalidateKeys === "function") {
          await invalidateKeys(["events:all", `events:${order.eventId}`]);
        }
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("CRITICAL: Tinkoff Event Webhook Error:", error);
    res.status(200).send("OK");
  }
};

// =====================================================================
// 3. B2B INVOICE SUBSCRIPTION WEBHOOK (Bank Transfer)
// =====================================================================
export const handleTinkoffB2BSubscriptionPurchase = async (req, res) => {
  try {
    const payload = req.body;

    // NOTE: Tinkoff Business API might have a different signature mechanism
    // for incoming wire transfers compared to acquiring. Validate accordingly!
    const expectedToken = generateTinkoffToken(payload);

    if (expectedToken !== payload.Token) {
      console.error(
        "🚨 CRITICAL: Invalid Tinkoff Webhook Signature detected (B2B)!",
      );
      return res.status(200).send("OK");
    }

    const paymentPurpose = payload.paymentPurpose || "";
    const amountReceived = parseFloat(payload.amount);

    // 1. Search for the invoice number
    const invoiceMatch = paymentPurpose.match(/INV-\d+-\d+/i);

    if (!invoiceMatch) {
      console.warn(
        "B2B Payment received, but invoice number not recognized:",
        paymentPurpose,
      );
      return res.status(200).send("OK");
    }

    const invoiceNumber = invoiceMatch[0];

    // 🚨 ROBUST FIX: Search the Payment table, NOT the Order table!
    const paymentRecord = await prisma.payment.findFirst({
      where: {
        providerTxId: invoiceNumber,
        provider: "b2b_invoice",
      },
      include: { user: true },
    });

    if (!paymentRecord) {
      console.error("Invoice not found in the Payment system:", invoiceNumber);
      return res.status(200).send("OK");
    }

    if (
      paymentRecord.status === "COMPLETED" ||
      paymentRecord.status === "FAILED"
    ) {
      return res.status(200).send("OK"); // Already processed
    }

    if (amountReceived < paymentRecord.amount) {
      console.warn(`Incomplete B2B payment for invoice ${invoiceNumber}.`);
      return res.status(200).send("OK");
    }

    // 2. Extract Metadata (Plan, Interval, Promo)
    const metadata = paymentRecord.metadata || {};
    const { planId, interval, promoCodeId, discountAmount } = metadata;

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      console.error(`B2B Webhook Error: Plan ${planId} not found.`);
      return res.status(200).send("OK");
    }

    let monthsToAdd = 1;
    if (interval === "half_year") monthsToAdd = 6;
    if (interval === "year") monthsToAdd = 12;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(startDate.getMonth() + monthsToAdd);

    // 3. Activate the subscription securely
    await prisma.$transaction(async (tx) => {
      // Mark Payment as COMPLETED
      await tx.payment.update({
        where: { id: paymentRecord.id },
        data: { status: "COMPLETED" },
      });

      await tx.userSubscription.updateMany({
        where: { userId: paymentRecord.userId, status: "ACTIVE" },
        data: { status: "EXPIRED" },
      });

      await tx.userSubscription.upsert({
        where: { userId: paymentRecord.userId },
        update: {
          planId: planId,
          status: "ACTIVE",
          startDate: startDate,
          endDate: endDate,
          pricePaid: amountReceived,
          promoCodeId: promoCodeId || null,
          discountAmount: discountAmount || null,
        },
        create: {
          userId: paymentRecord.userId,
          planId: planId,
          status: "ACTIVE",
          startDate: startDate,
          endDate: endDate,
          pricePaid: amountReceived,
          promoCodeId: promoCodeId || null,
          discountAmount: discountAmount || null,
        },
      });
    });

    console.log(
      `✅ B2B Subscription [${plan?.name}] activated for user ${paymentRecord.userId}`,
    );

    // Send receipt
    processSubscriptionDelivery(
      paymentRecord,
      paymentRecord.user,
      plan,
      amountReceived,
      interval,
    ).catch((err) => console.error("Async Subscription Email Error:", err));

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing B2B payment:", error);
    res.status(500).send("Internal Server Error");
  }
};

// =====================================================================
// 4. ASYNC MAILER HELPERS
// =====================================================================

async function processSubscriptionDelivery(
  paymentRecord,
  user,
  plan,
  amount,
  interval,
) {
  try {
    if (!user || !user.email) {
      throw new Error("Cannot send email: User or User Email not found");
    }

    console.log(`Generating Subscription PDF for: ${user.email}`);

    const pdfBuffer = await generateSubscriptionReceiptPDF(
      paymentRecord,
      user,
      plan,
      amount,
      interval,
    );

    await sendSubscriptionReceiptEmail(
      user.email,
      user.name,
      plan?.name || "Premium",
      amount,
      pdfBuffer,
    );

    console.log(`✅ Subscription email sent to: ${user.email}`);
  } catch (error) {
    console.error("❌ processSubscriptionDelivery error:", error);
  }
}

async function processTicketDelivery(order) {
  try {
    console.log(`Generating Event Ticket PDF for Order: ${order.id}`);
    const pdfBuffer = await generateTicketPDF(order, order.event, order.user);

    await sendTicketEmail(
      order.user.email,
      order.user.name,
      order.event.title,
      pdfBuffer,
    );
    console.log(`✅ Event Ticket email sent to: ${order.user.email}`);
  } catch (error) {
    console.error("❌ processTicketDelivery error:", error);
  }
}
