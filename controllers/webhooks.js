// import prisma from "../libs/prisma.js";
// import { generateTinkoffToken } from "../utils/tinkoff.js";
// import { notifyTargetedPerformers } from "./request.js";
// import { generateTinkoffToken } from "../utils/tinkoff.js";
// import { generateTicketPDF } from "../mailer/pdf-generator.js";
// import { sendTicketEmail } from "../mailer/email-sender.js";

// export const handleTinkoffWebhook = async (req, res) => {
//   try {
//     const payload = req.body;

//     console.log(payload);

//     // ----------------------------------------------------------------
//     // 1. SECURITY: VERIFY SIGNATURE
//     // ----------------------------------------------------------------
//     // Tinkoff sends a "Token" field. We must recalculate it using our
//     // secret password and compare it to ensure a hacker isn't faking this request.
//     const receivedToken = payload.Token;
//     const payloadForCheck = { ...payload };
//     delete payloadForCheck.Token; // Remove token before hashing
//     console.log(receivedToken);

//     const calculatedToken = generateTinkoffToken(payloadForCheck);
//     console.log(calculatedToken);
//     if (receivedToken !== calculatedToken) {
//       console.error("🚨 CRITICAL: Invalid Tinkoff Webhook Signature detected!");
//       return res.status(403).send("Invalid Token"); // Tinkoff expects HTTP status
//     }

//     // ----------------------------------------------------------------
//     // 2. EXTRACT DATA & PREVENT DOUBLE-SPENDING (IDEMPOTENCY)
//     // ----------------------------------------------------------------
//     const { OrderId, Status, Amount } = payload;
//     const actualAmountRubles = Amount / 100; // Convert kopecks back to rubles

//     // Find the payment in our database
//     const payment = await prisma.payment.findUnique({
//       where: { id: OrderId },
//       include: { paidRequest: { include: { customer: true } } },
//     });

//     if (!payment) return res.status(404).send("Payment not found");

//     // If we already completed this payment, just tell Tinkoff "OK" so they stop pinging us
//     if (payment.status === "COMPLETED") {
//       return res.status(200).send("OK");
//     }

//     // If the payment failed or was rejected by the bank
//     if (Status === "REJECTED" || Status === "CANCELED") {
//       await prisma.payment.update({
//         where: { id: payment.id },
//         data: { status: "FAILED" },
//       });
//       return res.status(200).send("OK");
//     }

//     // ----------------------------------------------------------------
//     // 3. PROCESS SUCCESSFUL PAYMENTS (CONFIRMED)
//     // ----------------------------------------------------------------
//     if (Status === "CONFIRMED") {
//       const metadata = payment.metadata || {};

//       // === SCENARIO A: WALLET TOP-UP ===
//       if (metadata.type === "WALLET_TOPUP") {
//         // 🚨 Atomic Transaction: Update payment, add funds, create ledger entry all at once
//         await prisma.$transaction([
//           prisma.payment.update({
//             where: { id: payment.id },
//             data: { status: "COMPLETED" },
//           }),
//           prisma.user.update({
//             where: { id: payment.userId },
//             data: { walletBalance: { increment: actualAmountRubles } },
//           }),
//           prisma.walletTransaction.create({
//             data: {
//               userId: payment.userId,
//               amount: actualAmountRubles, // Positive for top-ups
//               type: "TOPUP",
//               description: `Пополнение кошелька картой`,
//             },
//           }),
//         ]);
//         console.log(
//           `💰 Successfully topped up user ${payment.userId} by ${actualAmountRubles} RUB`,
//         );
//       }

//       // === SCENARIO B: DIRECT PAID REQUEST (Bank Card checkout) ===
//       else if (payment.paidRequestId) {
//         await prisma.$transaction([
//           prisma.payment.update({
//             where: { id: payment.id },
//             data: { status: "COMPLETED" },
//           }),
//           prisma.paidRequest.update({
//             where: { id: payment.paidRequestId },
//             data: { status: "OPEN" }, // Make it visible to performers
//           }),
//         ]);

//         // Now that the request is OPEN and paid for, notify the performers!
//         if (payment.paidRequest) {
//           await notifyTargetedPerformers(
//             payment.paidRequest,
//             payment.paidRequest.customer.name,
//           );
//         }
//       }

//       // Tell Tinkoff we successfully processed the webhook
//       return res.status(200).send("OK");
//     }

//     // For any other intermediate statuses (like AUTHORIZED), just acknowledge receipt
//     return res.status(200).send("OK");
//   } catch (error) {
//     console.error("Webhook Processing Error:", error);
//     // Tinkoff will retry sending the webhook later if we send a 500 error
//     res.status(500).send("Internal Error");
//   }
// };

// export const handleTinkoffSubscriptionWebhook = async (req, res) => {
//   try {
//     const notification = req.body;

//     // 1. Verify the signature (Token) to ensure the request is actually from Tinkoff
//     const expectedToken = generateTinkoffToken(notification);
//     if (expectedToken !== notification.Token) {
//       console.error("Tinkoff Webhook Security Alert: Invalid Token");
//       return res.status(403).send("OK"); // Return OK so Tinkoff stops retrying
//     }

//     const orderId = notification.OrderId;
//     const status = notification.Status; // e.g., "CONFIRMED", "REJECTED", "CANCELED"

//     // Fetch the existing pending order
//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//       include: { event: true, user: true },
//     });

//     if (!order) return res.status(200).send("OK");
//     if (order.status === "completed") return res.status(200).send("OK"); // Already processed

//     // 3. Handle Status Changes
//     if (status === "CONFIRMED") {
//       // Payment Successful!
//       await prisma.order.update({
//         where: { id: orderId },
//         data: { status: "completed" },
//       });

//       // Invalidate caches so the UI updates
//       await invalidateKeys([
//         "events:all",
//         `events:${order.eventId}`,
//         "orders:all",
//         "orders:my",
//       ]);

//       // Generate PDF and send Email
//       try {
//         const pdfBuffer = await generateTicketPDF(
//           order,
//           order.event,
//           order.user,
//         );
//         await sendTicketEmail(
//           order.user.email,
//           order.user.name,
//           order.event.title,
//           pdfBuffer,
//         );
//       } catch (err) {
//         console.error("Failed to send ticket email post-purchase", err);
//       }
//     } else if (
//       status === "REJECTED" ||
//       status === "CANCELED" ||
//       status === "DEADLINE_EXPIRED"
//     ) {
//       // Payment Failed or Expired. We must release the reserved tickets back to the pool.
//       await prisma.$transaction([
//         prisma.order.update({
//           where: { id: orderId },
//           data: { status: "cancelled" },
//         }),
//         prisma.event.update({
//           where: { id: order.eventId },
//           data: { availableTickets: { increment: order.ticketCount } },
//         }),
//       ]);
//       await invalidateKeys(["events:all", `events:${order.eventId}`]);
//     }

//     // Always return "OK" with 200 status to Tinkoff, otherwise they will relentlessly retry the webhook
//     res.status(200).send("OK");
//   } catch (error) {
//     console.error("Tinkoff Webhook Error:", error);
//     res.status(500).send("OK");
//   }
// };

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
// 1. GENERAL PAYMENTS WEBHOOK (Wallet, Requests, Subscriptions)
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
      // ALWAYS return 200 OK to the bank so it stops retrying the bad request
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

    // Idempotency: If already completed, do nothing and confirm to bank
    if (payment.status === "COMPLETED") {
      return res.status(200).send("OK");
    }

    // Handle Failures
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
      // Security Check: Ensure the amount paid matches the DB record
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
        const { planId, interval } = metadata;

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
            },
            create: {
              userId: payment.userId,
              planId: planId,
              status: "ACTIVE",
              startDate: startDate,
              endDate: endDate,
              pricePaid: actualAmountRubles,
            },
          });
        });

        console.log(
          `✅ Subscription [${plan?.name}] activated for user ${payment.userId}`,
        );

        // Non-blocking PDF & Email execution
        processSubscriptionDelivery(
          payment,
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

    // ----------------------------------------------------------------
    // A. SECURITY: VERIFY SIGNATURE
    // ----------------------------------------------------------------
    const expectedToken = generateTinkoffToken(notification);

    if (expectedToken !== notification.Token) {
      console.error(
        "🚨 CRITICAL: Invalid Tinkoff Webhook Signature (Events)!",
        {
          expected: expectedToken,
          received: notification.Token,
        },
      );
      return res.status(200).send("OK");
    }

    const orderId = notification.OrderId;
    const status = notification.Status;
    const tinkoffPaymentId = String(notification.PaymentId);
    const paidAmount = notification.Amount;

    // ----------------------------------------------------------------
    // B. EXTRACT DATA & IDEMPOTENCY CHECK
    // ----------------------------------------------------------------
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

    // ----------------------------------------------------------------
    // C. PROCESS PAYMENT STATUS
    // ----------------------------------------------------------------
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

      // Non-blocking email send
      processTicketDelivery(order).catch((err) =>
        console.error("Async Ticket Delivery Error:", err),
      );
    } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      if (order.status !== "CANCELLED") {
        // Restore tickets and mark as failed
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
// 3. ASYNC MAILER HELPERS
// =====================================================================

/**
 * Generates and emails the subscription receipt PDF without blocking the response.
 */
// async function processSubscriptionDelivery(payment, plan, amount, interval) {
//   try {
//     console.log(`Generating Subscription PDF for: ${payment.user.email}`);

//     const pdfBuffer = await generateSubscriptionReceiptPDF(
//       payment,
//       payment.user,
//       plan,
//       amount,
//       interval,
//     );

//     await sendSubscriptionReceiptEmail(
//       payment.user.email,
//       payment.user.name,
//       plan?.name || "Premium",
//       pdfBuffer,
//     );
//     console.log(`✅ Subscription email sent to: ${payment.user.email}`);
//   } catch (error) {
//     throw error;
//   }
// }

// Add import at the top of the file if not already there
// import prisma from "../libs/prisma.js";

async function processSubscriptionDelivery(payment, plan, amount, interval) {
  try {
    // 🚨 ROBUST FIX: If payment.user is undefined, fetch the user from DB!
    let targetUser = payment.user;
    if (!targetUser && payment.userId) {
      targetUser = await prisma.user.findUnique({
        where: { id: payment.userId },
      });
      // Attach it to the payment object in case the PDF generator needs it structured this way
      payment.user = targetUser;
    }

    if (!targetUser || !targetUser.email) {
      throw new Error(
        `Cannot send email: User or User Email not found for payment ${payment.id}`,
      );
    }

    console.log(`Generating Subscription PDF for: ${targetUser.email}`);

    const pdfBuffer = await generateSubscriptionReceiptPDF(
      payment,
      targetUser, // Pass the safely fetched user
      plan,
      amount,
      interval,
    );

    await sendSubscriptionReceiptEmail(
      targetUser.email,
      targetUser.name,
      plan?.name || "Premium",
      amount, // 🚨 FIX: Pass the amount to the email function
      pdfBuffer,
    );

    console.log(`✅ Subscription email sent to: ${targetUser.email}`);
  } catch (error) {
    console.error("❌ processSubscriptionDelivery error:", error);
    throw error;
  }
}

/**
 * Generates and emails the Event Ticket PDF without blocking the response.
 */
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
    throw error;
  }
}
