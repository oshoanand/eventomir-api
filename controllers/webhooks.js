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

// Import your mailer utilities (You will need to create the Subscription versions of these!)
import {
  generateTicketPDF,
  generateSubscriptionReceiptPDF,
} from "../mailer/pdf-generator.js";
import {
  sendTicketEmail,
  sendSubscriptionReceiptEmail,
} from "../mailer/email-sender.js";

export const handleTinkoffWebhook = async (req, res) => {
  try {
    const payload = req.body;
    // ----------------------------------------------------------------
    // 1. SECURITY: VERIFY SIGNATURE
    // ----------------------------------------------------------------
    const receivedToken = payload.Token;
    const payloadForCheck = { ...payload };
    delete payloadForCheck.Token;

    const calculatedToken = generateTinkoffToken(payloadForCheck);

    if (receivedToken !== calculatedToken) {
      console.error("🚨 CRITICAL: Invalid Tinkoff Webhook Signature detected!");
      return res.status(403).send("Invalid Token");
    }

    // ----------------------------------------------------------------
    // 2. EXTRACT DATA & PREVENT DOUBLE-SPENDING (IDEMPOTENCY)
    // ----------------------------------------------------------------
    const { OrderId, Status, Amount } = payload;
    const actualAmountRubles = Amount / 100; // Convert kopecks back to rubles

    //  include the `user` here so we have their email and name for the PDF!
    const payment = await prisma.payment.findUnique({
      where: { id: OrderId },
      include: {
        paidRequest: { include: { customer: true } },
        user: true, // Included for Subscription emails
      },
    });

    if (!payment) return res.status(404).send("Payment not found");

    if (payment.status === "COMPLETED") {
      return res.status(200).send("OK");
    }

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
            data: { status: "OPEN" },
          }),
        ]);

        if (payment.paidRequest) {
          await notifyTargetedPerformers(
            payment.paidRequest,
            payment.paidRequest.customer.name,
          );
        }
      }

      // === 🚀 SCENARIO C: SUBSCRIPTION PRICING PLAN ===
      else if (metadata.type === "SUBSCRIPTION") {
        const { planId, interval } = metadata;

        // Calculate the new end date based on interval
        let monthsToAdd = 1;
        if (interval === "half_year") monthsToAdd = 6;
        if (interval === "year") monthsToAdd = 12;

        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(startDate.getMonth() + monthsToAdd);

        // Fetch Plan Name for the Email/PDF
        const plan = await prisma.subscriptionPlan.findUnique({
          where: { id: planId },
        });

        // Atomic Transaction: Mark payment completed and activate subscription
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: "COMPLETED" },
          });

          await tx.userSubscription.updateMany({
            where: { userId: payment.userId, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });

          await tx.userSubscription.create({
            data: {
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

        // --- ✉️ PDF GENERATION & EMAIL SENDING ---
        try {
          // Generate PDF Buffer
          const pdfBuffer = await generateSubscriptionReceiptPDF(
            payment,
            payment.user,
            plan,
            actualAmountRubles,
            interval,
          );

          // Send Email with PDF attached
          await sendSubscriptionReceiptEmail(
            payment.user.email,
            payment.user.name,
            plan?.name || "Premium",
            pdfBuffer,
          );

          console.log(
            `✉️ Subscription receipt emailed to ${payment.user.email}`,
          );
        } catch (err) {
          console.error(
            "❌ Failed to generate/send subscription receipt email:",
            err,
          );
          // We don't throw the error here, because the payment was successful
          // and we still want to return 200 OK to Tinkoff so they stop retrying.
        }
      }

      return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Processing Error:", error);
    res.status(500).send("Internal Error");
  }
};

// =====================================================================
// EVENT TICKETS WEBHOOK
// =====================================================================
// export const handleTinkoffEventTicketWebhook = async (req, res) => {
//   try {
//     const notification = req.body;

//     const expectedToken = generateTinkoffToken(notification);
//     if (expectedToken !== notification.Token) {
//       console.error("Tinkoff Webhook Security Alert: Invalid Token");
//       return res.status(403).send("OK");
//     }

//     const orderId = notification.OrderId;
//     const status = notification.Status;
//     const tinkoffPaymentId = String(notification.PaymentId);

//     const order = await prisma.order.findUnique({
//       where: { id: orderId },
//       include: { event: true, user: true },
//     });

//     if (!order) return res.status(200).send("OK");

//     // STRICT IDEMPOTENCY
//     if (order.status === "ACTIVE" || order.status === "CANCELLED") {
//       return res.status(200).send("OK");
//     }

//     if (status === "CONFIRMED") {
//       // ✅ Update BOTH Order and Payment tables atomically
//       await prisma.$transaction([
//         prisma.order.update({
//           where: { id: orderId },
//           data: { status: "ACTIVE" },
//         }),
//         prisma.payment.updateMany({
//           where: { providerTxId: tinkoffPaymentId },
//           data: { status: "COMPLETED" },
//         }),
//       ]);

//       if (typeof invalidateKeys === "function") {
//         await invalidateKeys([
//           "events:all",
//           `events:${order.eventId}`,
//           "orders:all",
//           "orders:my",
//         ]);
//       }

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
//       // ❌ Fail BOTH tables and restore tickets atomically
//       await prisma.$transaction([
//         prisma.order.update({
//           where: { id: orderId },
//           data: { status: "cancelled" },
//         }),
//         prisma.event.update({
//           where: { id: order.eventId },
//           data: { availableTickets: { increment: order.ticketCount } },
//         }),
//         prisma.payment.updateMany({
//           where: { providerTxId: tinkoffPaymentId },
//           data: { status: "FAILED" },
//         }),
//       ]);

//       if (typeof invalidateKeys === "function") {
//         await invalidateKeys(["events:all", `events:${order.eventId}`]);
//       }
//     }

//     res.status(200).send("OK");
//   } catch (error) {
//     console.error("Tinkoff Webhook Error:", error);
//     res.status(500).send("OK");
//   }
// };

/**
 * Обработчик вебхуков от Тинькофф Оплаты для билетов на мероприятия.
 * Tinkoff ожидает ответ "OK" в теле письма и статус 200.
 */
export const handleTinkoffEventTicketWebhook = async (req, res) => {
  try {
    const notification = req.body;

    // 1. БЕЗОПАСНОСТЬ: Проверка подписи (Token)
    // Тинькофф присылает токен, который мы должны пересчитать и сравнить
    const expectedToken = generateTinkoffToken(notification);

    if (expectedToken !== notification.Token) {
      console.error("Tinkoff Webhook Security Alert: Invalid Token received");
      // Возвращаем OK банку, чтобы он перестал слать этот вебхук, но логируем ошибку
      return res.status(200).send("OK");
    }

    const orderId = notification.OrderId;
    const status = notification.Status;
    const tinkoffPaymentId = String(notification.PaymentId);
    const paidAmount = notification.Amount; // В копейках

    // 2. Поиск заказа в базе
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    if (!order) {
      console.error(`Tinkoff Webhook Error: Order ${orderId} not found`);
      return res.status(200).send("OK");
    }

    // 3. ИДЕМПОТЕНТНОСТЬ
    // Если заказ уже оплачен (ACTIVE), ничего не делаем, просто подтверждаем банку
    if (order.status === "ACTIVE") {
      return res.status(200).send("OK");
    }

    // 4. ЛОГИКА ОБРАБОТКИ СТАТУСОВ

    // Статус CONFIRMED — деньги успешно списаны
    if (status === "CONFIRMED") {
      // Проверка суммы (защита от подмены данных)
      if (Number(paidAmount) !== Math.round(order.totalPrice * 100)) {
        console.error(
          `Tinkoff Webhook Error: Amount mismatch for order ${orderId}`,
        );
        return res.status(200).send("OK");
      }

      // Атомарное обновление статуса заказа и платежа
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

      // Очистка кэша в Redis
      if (typeof invalidateKeys === "function") {
        await invalidateKeys([
          "events:all",
          `events:${order.eventId}`,
          "orders:my",
          "orders:all",
        ]);
      }

      // Фоновое выполнение: Генерация билета и отправка Email
      // Мы НЕ используем await здесь, чтобы банк сразу получил ответ "OK"
      processTicketDelivery(order).catch((err) =>
        console.error("Async Ticket Delivery Error:", err),
      );
    }

    // Статусы отмены или ошибки
    else if (["REJECTED", "CANCELED", "DEADLINE_EXPIRED"].includes(status)) {
      // Возвращаем билеты в продажу, если заказ еще не был отменен
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

    // Обязательный ответ для Тинькофф
    res.status(200).send("OK");
  } catch (error) {
    console.error("CRITICAL: Tinkoff Webhook Error:", error);
    // Все равно отправляем OK, чтобы предотвратить бесконечные повторы от банка
    // и разбираемся в логах
    res.status(200).send("OK");
  }
};

/**
 * Вспомогательная функция для генерации PDF и отправки почты.
 * Вынесена отдельно для асинхронного запуска.
 */
async function processTicketDelivery(order) {
  try {
    console.log(`Generating ticket for Order: ${order.id}`);

    const pdfBuffer = await generateTicketPDF(order, order.event, order.user);

    await sendTicketEmail(
      order.user.email,
      order.user.name,
      order.event.title,
      pdfBuffer,
    );

    console.log(`Ticket sent successfully to ${order.user.email}`);
  } catch (error) {
    throw error;
  }
}
