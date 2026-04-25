import prisma from "../libs/prisma.js";
import { generateTinkoffToken } from "../utils/tinkoff.js";
import { notifyTargetedPerformers } from "./request.js";
import { invalidateKeys } from "../libs/redis.js";

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
    const expectedToken = generateTinkoffToken(payload);

    if (expectedToken !== payload.Token) {
      console.error(
        "🚨 CRITICAL: Invalid Tinkoff Webhook Signature (General)!",
      );
      return res.status(200).send("OK");
    }

    const orderId = payload.OrderId;
    const status = payload.Status;
    const actualAmountRubles = payload.Amount / 100;

    // 🚨 FIX: Deep include through Profiles
    const payment = await prisma.payment.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        paidRequest: {
          include: {
            customer: { include: { user: true } },
          },
        },
      },
    });

    if (!payment || payment.status === "COMPLETED")
      return res.status(200).send("OK");

    if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(200).send("OK");
    }

    if (status === "CONFIRMED") {
      const metadata = payment.metadata || {};

      // ==============================================================
      // SCENARIO : BOOKING ESCROW (TWO-STEP PAYMENT)
      // ==============================================================
      if (metadata.type === "BOOKING_ESCROW") {
        const bookingId = metadata.bookingId;

        // STATUS 1: AUTHORIZED (Funds are frozen on client's card. Safe to confirm booking)
        if (status === "AUTHORIZED") {
          await prisma.$transaction(async (tx) => {
            // Idempotency check
            const paymentCheck = await tx.payment.findUnique({
              where: { id: payment.id },
            });
            if (paymentCheck.escrowStatus === "HELD") return;

            const booking = await tx.bookingRequest.findUnique({
              where: { id: bookingId },
            });

            // Calculate automatic release window (e.g., 24h after event starts)
            const releaseDate = new Date(booking.date);
            releaseDate.setHours(releaseDate.getHours() + 24);

            // 1. Mark Payment as HELD and store Tinkoff's PaymentId
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                providerTxId: String(payload.PaymentId),
                escrowStatus: "HELD",
                releaseEligible: releaseDate,
              },
            });

            // 2. Mark Booking as CONFIRMED
            await tx.bookingRequest.update({
              where: { id: bookingId },
              data: { status: "CONFIRMED" },
            });

            // 3. Block Performer's Calendar Automatically
            await tx.performerProfile.update({
              where: { id: booking.performerId },
              data: { bookedDates: { push: booking.date } },
            });

            // 4. Record Audit Log
            await tx.bookingAuditLog.create({
              data: {
                bookingId,
                actorId: "SYSTEM_WEBHOOK",
                action: "PAYMENT_AUTHORIZED_FUNDS_HELD",
                metadata: { providerTxId: String(payload.PaymentId) },
              },
            });
          });
        }

        // STATUS 2: CONFIRMED (Cron Job successfully captured the funds from T-Bank)
        else if (status === "CONFIRMED") {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" }, // Real money is now in platform's bank
          });
        }

        // STATUS 3: REFUNDED/REVERSED (Client got their money back)
        else if (
          ["REVERSED", "REJECTED", "CANCELED", "REFUNDED"].includes(status)
        ) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "FAILED", escrowStatus: "REFUNDED" },
          });
          await prisma.bookingRequest.update({
            where: { id: bookingId },
            data: { status: "CANCELLED_BY_CUSTOMER" },
          });
        }

        return res.status(200).send("OK");
      }

      // ==============================================================
      // SCENARIO : WALLET TOP-UP
      // ==============================================================
      else if (metadata.type === "WALLET_TOPUP") {
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
      }

      // ==============================================================
      // SCENARIO : DIRECT PAID REQUEST
      // ==============================================================
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
          // 🚨 FIX: Extract name from the deep profile relation
          const customerName =
            payment.paidRequest.customer.user.name || "Заказчик";
          notifyTargetedPerformers(payment.paidRequest, customerName).catch(
            console.error,
          );
        }
      }
      // ==============================================================
      // SCENARIO : SUBSCRIPTION PLAN
      // ==============================================================
      else if (metadata.type === "SUBSCRIPTION") {
        const { planId, interval, promoCodeId, discountAmount } = metadata;
        let monthsToAdd =
          interval === "year" ? 12 : interval === "half_year" ? 6 : 1;

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

          // Clear active subs
          await tx.userSubscription.updateMany({
            where: { userId: payment.userId, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });

          await tx.userSubscription.upsert({
            where: { userId: payment.userId },
            update: {
              planId,
              status: "ACTIVE",
              startDate,
              endDate,
              pricePaid: actualAmountRubles,
              promoCodeId: promoCodeId || null,
              discountAmount: discountAmount || null,
            },
            create: {
              userId: payment.userId,
              planId,
              status: "ACTIVE",
              startDate,
              endDate,
              pricePaid: actualAmountRubles,
              promoCodeId: promoCodeId || null,
              discountAmount: discountAmount || null,
            },
          });
        });

        processSubscriptionDelivery(
          payment,
          payment.user,
          plan,
          actualAmountRubles,
          interval,
        ).catch(console.error);
      }
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Error:", error);
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

    if (expectedToken !== notification.Token) return res.status(200).send("OK");

    const orderId = notification.OrderId;
    const status = notification.Status;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    if (!order || order.status === "ACTIVE") return res.status(200).send("OK");

    if (status === "CONFIRMED") {
      await prisma.$transaction([
        prisma.order.update({
          where: { id: orderId },
          data: { status: "ACTIVE" },
        }),
        prisma.payment.updateMany({
          where: { providerTxId: String(notification.PaymentId) },
          data: { status: "COMPLETED" },
        }),
      ]);

      await invalidateKeys([
        "events:all",
        `events:${order.eventId}`,
        "orders:my",
      ]);
      processTicketDelivery(order).catch(console.error);
    } else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      await prisma.$transaction([
        prisma.order.update({
          where: { id: orderId },
          data: { status: "CANCELLED" },
        }),
        prisma.event.update({
          where: { id: order.eventId },
          data: { availableTickets: { increment: order.ticketCount } },
        }),
      ]);
    }
    res.status(200).send("OK");
  } catch (error) {
    console.error("Event Webhook Error:", error);
    res.status(200).send("OK");
  }
};

// =====================================================================
// 3. B2B INVOICE SUBSCRIPTION WEBHOOK (Bank Transfer)
// =====================================================================
export const handleTinkoffB2BSubscriptionPurchase = async (req, res) => {
  try {
    const payload = req.body;
    const paymentPurpose = payload.paymentPurpose || "";
    const amountReceived = parseFloat(payload.amount);
    const invoiceMatch = paymentPurpose.match(/INV-\d+-\d+/i);

    if (!invoiceMatch) return res.status(200).send("OK");
    const invoiceNumber = invoiceMatch[0];

    const paymentRecord = await prisma.payment.findFirst({
      where: { providerTxId: invoiceNumber, provider: "b2b_invoice" },
      include: { user: true },
    });

    if (!paymentRecord || paymentRecord.status === "COMPLETED")
      return res.status(200).send("OK");

    const { planId, interval, promoCodeId, discountAmount } =
      paymentRecord.metadata || {};
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    let monthsToAdd =
      interval === "year" ? 12 : interval === "half_year" ? 6 : 1;
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(startDate.getMonth() + monthsToAdd);

    await prisma.$transaction(async (tx) => {
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
          planId,
          status: "ACTIVE",
          startDate,
          endDate,
          pricePaid: amountReceived,
          promoCodeId: promoCodeId || null,
          discountAmount: discountAmount || null,
        },
        create: {
          userId: paymentRecord.userId,
          planId,
          status: "ACTIVE",
          startDate,
          endDate,
          pricePaid: amountReceived,
          promoCodeId: promoCodeId || null,
          discountAmount: discountAmount || null,
        },
      });
    });

    processSubscriptionDelivery(
      paymentRecord,
      paymentRecord.user,
      plan,
      amountReceived,
      interval,
    ).catch(console.error);
    res.status(200).send("OK");
  } catch (error) {
    console.error("B2B Webhook Error:", error);
    res.status(200).send("OK");
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
  } catch (error) {
    console.error("Subscription Delivery Error:", error);
  }
}

async function processTicketDelivery(order) {
  try {
    const pdfBuffer = await generateTicketPDF(order, order.event, order.user);
    await sendTicketEmail(
      order.user.email,
      order.user.name,
      order.event.title,
      pdfBuffer,
    );
  } catch (error) {
    console.error("Ticket Delivery Error:", error);
  }
}
