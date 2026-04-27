import prisma from "../libs/prisma.js";
import { initTinkoffRequestPayment } from "../utils/tinkoff.js";
import "dotenv/config";

// 🚨 MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

// Fixed price for publishing a request (in RUB)
const REQUEST_PRICE = parseInt(process.env.REQUEST_PRICE) || 490;

// ==========================================
// HELPER: Targeted Notifications
// ==========================================
export const notifyTargetedPerformers = async (requestData, customerName) => {
  try {
    const whereClause = {
      roles: { has: requestData.category },
    };

    // Only filter by city if the request isn't remote/online
    if (requestData.city) {
      whereClause.city = requestData.city;
    }

    const targetProfiles = await prisma.performerProfile.findMany({
      where: whereClause,
      select: { userId: true }, // We need the Base User ID to send notifications
    });

    if (targetProfiles.length === 0) return;

    const msg = `Новый заказ в г. ${requestData.city || "Онлайн"}: ${requestData.category} (Бюджет: ${requestData.budget || "по договоренности"})`;

    // Dispatch real-time socket, DB, and FCM push notifications asynchronously
    const promises = targetProfiles.map((profile) =>
      notifyUser({
        userId: profile.userId, // Base User ID
        title: "🔔 Новый заказ по вашей специализации!",
        body: msg,
        type: "NEW_REQUEST",
        data: {
          requestId: requestData.id,
          url: `/requests/${requestData.id}`,
        },
      }),
    );

    // Run all notifications concurrently
    await Promise.all(promises);

    console.log(
      `✅ Notified ${targetProfiles.length} performers for request ${requestData.id}`,
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
    const userId = req.user.id;
    const customerEmail = req.user.email;
    const { category, serviceDescription, budget, city, paymentMethod } =
      req.body;

    if (!category || !serviceDescription || !paymentMethod) {
      return res
        .status(400)
        .json({ message: "Не заполнены обязательные поля." });
    }

    // Fetch the Customer Profile ID securely
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: userId },
      include: { user: { select: { name: true, walletBalance: true } } },
    });

    if (!profile) {
      return res
        .status(403)
        .json({
          message:
            "Необходимо заполнить профиль заказчика перед созданием заявки.",
        });
    }

    const customerProfileId = profile.id;
    const customerName = profile.user.name || "Заказчик";

    // ----------------------------------------------------
    // SCENARIO A: PAY WITH WALLET (Atomic Transaction)
    // ----------------------------------------------------
    if (paymentMethod === "wallet") {
      if (profile.user.walletBalance < REQUEST_PRICE) {
        return res
          .status(400)
          .json({ message: "Недостаточно средств на внутреннем кошельке." });
      }

      const requestRecord = await prisma.$transaction(async (tx) => {
        // 1. Deduct Balance safely
        await tx.user.update({
          where: { id: userId },
          data: { walletBalance: { decrement: REQUEST_PRICE } },
        });

        // 2. Create the Request (Status: OPEN immediately)
        const newReq = await tx.paidRequest.create({
          data: {
            customerId: customerProfileId,
            category,
            serviceDescription,
            city: city || null,
            budget: budget || null,
            status: "OPEN",
          },
        });

        // 3. Create Ledger Entry for UI History
        await tx.walletTransaction.create({
          data: {
            userId: userId,
            amount: -REQUEST_PRICE,
            type: "PAYMENT",
            description: `Оплата публикации заявки: ${category}`,
          },
        });

        // 4. 🚨 FIX: Missing Payment Record! Must create a completed payment for accounting.
        await tx.payment.create({
          data: {
            userId: userId,
            amount: REQUEST_PRICE,
            provider: "wallet",
            status: "COMPLETED",
            paidRequest: { connect: { id: newReq.id } },
          },
        });

        return newReq;
      });

      // 5. Fire notifications (Outside the transaction to prevent DB bottlenecks)
      await notifyTargetedPerformers(requestRecord, customerName);

      return res.status(201).json({
        success: true,
        message: "Заявка оплачена с кошелька и успешно опубликована!",
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
          customerId: customerProfileId,
          category,
          serviceDescription,
          city: city || null,
          budget: budget || null,
          status: "PENDING_PAYMENT",
        },
      });

      const paymentRecord = await prisma.payment.create({
        data: {
          userId: userId,
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
        // Rollback internal payment status if gateway API fails
        await prisma.payment.update({
          where: { id: paymentRecord.id },
          data: { status: "FAILED" },
        });
        throw new Error("TINKOFF_INIT_FAILED");
      }
    }

    return res
      .status(400)
      .json({ message: "Выбран недопустимый метод оплаты." });
  } catch (error) {
    if (error.message === "TINKOFF_INIT_FAILED") {
      return res
        .status(502)
        .json({
          message: "Ошибка шлюза оплаты. Пожалуйста, попробуйте позже.",
        });
    }
    console.error("Create Request Error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
};

// ==========================================
// 2. GET CUSTOMER'S OWN REQUESTS
// ==========================================
export const getCustomerRequests = async (req, res) => {
  try {
    const userId = req.user.id;

    const profile = await prisma.customerProfile.findUnique({
      where: { userId: userId },
      select: { id: true },
    });

    if (!profile) return res.status(200).json([]);

    const requests = await prisma.paidRequest.findMany({
      where: {
        customerId: profile.id,
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json(requests);
  } catch (error) {
    console.error("Get Customer Requests Error:", error);
    res.status(500).json({ message: "Не удалось загрузить ваши заявки" });
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
        customer: {
          include: {
            user: { select: { name: true, image: true } },
          },
        },
      },
    });

    // Flatten the data structure so the frontend gets what it expects
    const flattenedRequests = requests.map((req) => ({
      ...req,
      customer: {
        name: req.customer.user.name,
        profile_picture: req.customer.user.image,
      },
    }));

    res.status(200).json(flattenedRequests);
  } catch (error) {
    console.error("Feed Error:", error);
    res.status(500).json({ message: "Не удалось загрузить ленту заявок" });
  }
};

// ==========================================
// 4. 🚨 ADDED: GET SINGLE REQUEST (Increments Views)
// ==========================================
export const getRequestById = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await prisma.paidRequest.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            user: { select: { name: true, image: true, phone: true } },
          },
        },
      },
    });

    if (!request)
      return res.status(404).json({ message: "Заявка не найдена." });

    // Safely increment the view counter
    await prisma.paidRequest.update({
      where: { id },
      data: { views: { increment: 1 } },
    });

    res.status(200).json({
      ...request,
      views: request.views + 1, // Reflect the increment immediately in the response
      customer: {
        name: request.customer.user.name,
        profile_picture: request.customer.user.image,
        phone: request.customer.user.phone,
      },
    });
  } catch (error) {
    console.error("Get Single Request Error:", error);
    res.status(500).json({ message: "Не удалось загрузить данные заявки." });
  }
};

// ==========================================
// 5. 🚨 ADDED: CLOSE/ARCHIVE REQUEST (By Customer)
// ==========================================
export const closeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const request = await prisma.paidRequest.findUnique({
      where: { id },
      include: { customer: true },
    });

    if (!request)
      return res.status(404).json({ message: "Заявка не найдена." });

    // Security check: only the owner can close it
    if (request.customer.userId !== userId) {
      return res
        .status(403)
        .json({ message: "У вас нет прав для закрытия этой заявки." });
    }

    const updatedRequest = await prisma.paidRequest.update({
      where: { id },
      data: { status: "CLOSED" },
    });

    res.status(200).json(updatedRequest);
  } catch (error) {
    console.error("Close Request Error:", error);
    res.status(500).json({ message: "Не удалось закрыть заявку." });
  }
};
