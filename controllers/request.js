import prisma from "../libs/prisma.js";
import { initTinkoffRequestPayment } from "../utils/tinkoff.js";
import "dotenv/config";

// 🚨 IMPORT THE NEW MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

// Fixed price for publishing a request (in RUB)
const REQUEST_PRICE = process.env.REQUEST_PRICE || 490;

// ==========================================
// HELPER: Targeted Notifications
// ==========================================
export const notifyTargetedPerformers = async (requestData, customerName) => {
  try {
    // Find active performers matching the exact category AND city
    const targetPerformers = await prisma.user.findMany({
      where: {
        role: "performer",
        status: "active",
        roles: { has: requestData.category },
        city: requestData.city,
      },
      select: { id: true },
    });

    if (targetPerformers.length === 0) return;

    const msg = `Новый заказ в г. ${requestData.city}: ${requestData.category} (Бюджет: ${requestData.budget || "не указан"})`;

    // 🚨 Dispatch real-time socket, DB, and FCM push notifications asynchronously
    const promises = targetPerformers.map((performer) =>
      notifyUser({
        userId: performer.id,
        title: "🔔 Новый заказ в вашем городе!",
        body: msg,
        type: "NEW_REQUEST",
        data: {
          requestId: requestData.id,
          url: `/requests/${requestData.id}`, // Clicking the push notification opens this specific request
        },
      }),
    );

    // Run all notifications concurrently
    await Promise.all(promises);

    console.log(
      `✅ Notified ${targetPerformers.length} performers in ${requestData.city}`,
    );
  } catch (error) {
    console.error("❌ Error notifying performers:", error);
  }
};

// ==========================================
// 1. CREATE PAID REQUEST (Wallet or Gateway)
// ==========================================
export const createPaidRequest = async (req, res) => {
  try {
    // SECURITY: Always use ID & Email from the verified JWT token
    const customerId = req.user.id;
    const customerEmail = req.user.email;
    const { category, serviceDescription, budget, city, paymentMethod } =
      req.body;

    if (!category || !serviceDescription || !city || !paymentMethod) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // ----------------------------------------------------
    // SCENARIO A: PAY WITH WALLET (Atomic Transaction)
    // ----------------------------------------------------
    if (paymentMethod === "wallet") {
      const requestRecord = await prisma.$transaction(async (tx) => {
        // 1. Lock the user row and check balance
        const user = await tx.user.findUnique({ where: { id: customerId } });

        if (user.walletBalance < REQUEST_PRICE) {
          throw new Error("INSUFFICIENT_FUNDS");
        }

        // 2. Deduct Balance safely
        await tx.user.update({
          where: { id: customerId },
          data: { walletBalance: { decrement: REQUEST_PRICE } },
        });

        // 3. Create Ledger Entry
        await tx.walletTransaction.create({
          data: {
            userId: customerId,
            amount: -REQUEST_PRICE,
            type: "PAYMENT",
            description: `Оплата публикации заявки: ${category} в г. ${city}`,
          },
        });

        // 4. Create the Request (Status: OPEN immediately)
        const newReq = await tx.paidRequest.create({
          data: {
            customerId,
            category,
            serviceDescription,
            city,
            budget,
            status: "OPEN",
          },
          include: { customer: { select: { name: true } } },
        });

        return newReq;
      });

      // 5. Fire notifications (Outside the transaction to keep DB locks fast)
      await notifyTargetedPerformers(
        requestRecord,
        requestRecord.customer.name,
      );

      return res.status(201).json({
        success: true,
        message: "Оплачено с кошелька и опубликовано!",
        requiresGateway: false,
      });
    }

    // ----------------------------------------------------
    // SCENARIO B: PAY WITH BANK GATEWAY (TINKOFF)
    // ----------------------------------------------------
    if (paymentMethod === "gateway") {
      // 1. Create Pending Request & Payment in DB
      const newRequest = await prisma.paidRequest.create({
        data: {
          customerId,
          category,
          serviceDescription,
          city,
          budget,
          status: "PENDING_PAYMENT",
        },
      });

      const paymentRecord = await prisma.payment.create({
        data: {
          userId: customerId,
          amount: REQUEST_PRICE,
          provider: "tinkoff",
          status: "PENDING",
          paidRequest: { connect: { id: newRequest.id } },
        },
      });

      try {
        // 2. Initialize Tinkoff Session
        const tinkoffData = await initTinkoffRequestPayment(
          paymentRecord.id,
          REQUEST_PRICE,
          category,
          customerEmail,
        );

        // 3. Save Tinkoff's TxID to our DB
        await prisma.payment.update({
          where: { id: paymentRecord.id },
          data: { providerTxId: String(tinkoffData.paymentId) },
        });

        // 4. Return Checkout URL to Frontend
        return res.status(201).json({
          success: true,
          requiresGateway: true,
          paymentUrl: tinkoffData.paymentUrl,
        });
      } catch (tinkoffError) {
        // If Tinkoff API fails, mark our internal payment as failed
        await prisma.payment.update({
          where: { id: paymentRecord.id },
          data: { status: "FAILED" },
        });
        throw new Error("TINKOFF_INIT_FAILED");
      }
    }

    return res.status(400).json({ message: "Invalid payment method." });
  } catch (error) {
    if (error.message === "INSUFFICIENT_FUNDS") {
      return res
        .status(400)
        .json({ message: "Недостаточно средств на кошельке." });
    }
    if (error.message === "TINKOFF_INIT_FAILED") {
      return res
        .status(502)
        .json({ message: "Ошибка шлюза оплаты. Попробуйте позже." });
    }

    console.error("Create Request Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==========================================
// 2. GET CUSTOMER'S OWN REQUESTS
// ==========================================
export const getCustomerRequests = async (req, res) => {
  try {
    // SECURITY: Only fetch requests belonging to the authenticated user
    const customerId = req.user.id;

    const requests = await prisma.paidRequest.findMany({
      where: {
        customerId: customerId,
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json(requests);
  } catch (error) {
    console.error("Get Customer Requests Error:", error);
    res.status(500).json({ message: "Failed to fetch requests" });
  }
};

// ==========================================
// 3. PUBLIC FEED FOR PERFORMERS
// ==========================================
export const getRequestsFeed = async (req, res) => {
  try {
    const { roles, city } = req.query;
    const roleList = roles ? roles.split(",") : [];

    // SECURITY: Never expose PENDING_PAYMENT requests to the public feed
    const whereClause = {
      status: "OPEN",
    };

    if (roleList.length > 0) {
      whereClause.category = { in: roleList };
    }

    if (city) {
      // Include exact city matches OR online/remote requests (city is null)
      whereClause.OR = [
        { city: { equals: city, mode: "insensitive" } },
        { city: null },
      ];
    }

    const requests = await prisma.paidRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: 50, // Pagination limit to protect server memory
      include: {
        customer: { select: { name: true, profile_picture: true } },
      },
    });

    res.status(200).json(requests);
  } catch (error) {
    console.error("Feed Error:", error);
    res.status(500).json({ message: "Failed to fetch feed" });
  }
};
