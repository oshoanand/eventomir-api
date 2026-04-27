import prisma from "../libs/prisma.js";
import {
  initTinkoffSubscriptionPayment,
  initTinkoffTopUpPayment,
} from "../utils/tinkoff.js";

import { generateB2BInvoicePDF } from "../mailer/pdf-generator.js";
import { sendB2BInvoiceEmail } from "../mailer/email-sender.js";
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
    const sub = await prisma.userSubscription.findUnique({
      where: { userId: userId },
      include: { plan: true },
    });

    if (!sub) return res.status(200).json(null);

    const isExpired =
      sub.status !== "ACTIVE" ||
      (sub.endDate && new Date(sub.endDate) < new Date());

    res.status(200).json({
      id: sub.id,
      planId: sub.planId,
      planName: sub.plan.name,
      status: isExpired ? "EXPIRED" : "ACTIVE",
      startDate: sub.startDate,
      endDate: sub.endDate,
      pricePaid: sub.pricePaid || 0,
    });
  } catch (error) {
    console.error("Get Subscription Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- UNIFIED SUBSCRIPTION CHECKOUT (B2B, B2C, WALLET) ---
export const initiateSubscriptionCheckout = async (req, res) => {
  try {
    const userId = req.user.id;
    const { planId } = req.params;
    const { interval, paymentMethod, promoCode } = req.body;

    const userEmail = req.user.email || "no-reply@eventomir.ru";

    if (!planId || !interval) {
      return res.status(400).json({ message: "Не указан тариф или период." });
    }

    // 🚨 FIX 1: Include ALL profile types so we can safely check B2B status for any user role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        customerProfile: true,
        performerProfile: true,
        partnerProfile: true,
      },
    });

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });

    if (!user || !plan) {
      return res
        .status(404)
        .json({ message: "Пользователь или тариф не найден." });
    }

    // 1. Calculate Base Price
    let price = plan.priceMonthly;
    if (interval === "half_year" && plan.priceHalfYearly)
      price = plan.priceHalfYearly;
    if (interval === "year" && plan.priceYearly) price = plan.priceYearly;

    if (price <= 0) {
      return res.status(400).json({ message: "Неверная цена тарифа." });
    }

    // 2. Apply Promo Code Logic
    let appliedPromo = null;
    let discountAmount = 0;

    if (promoCode) {
      appliedPromo = await prisma.promoCode.findUnique({
        where: { code: promoCode.toUpperCase() },
        include: { usedByUsers: { where: { id: userId } } },
      });

      if (
        !appliedPromo ||
        !appliedPromo.isActive ||
        (appliedPromo.validUntil &&
          new Date(appliedPromo.validUntil) < new Date()) ||
        (appliedPromo.maxUses &&
          appliedPromo.currentUses >= appliedPromo.maxUses)
      ) {
        return res
          .status(400)
          .json({ message: "Промокод недействителен или истек." });
      }

      if (appliedPromo.minOrderAmount && price < appliedPromo.minOrderAmount) {
        return res.status(400).json({
          message: `Минимальная сумма заказа для этого промокода: ${appliedPromo.minOrderAmount} ₽.`,
        });
      }

      if (
        appliedPromo.isSingleUsePerUser &&
        appliedPromo.usedByUsers.length > 0
      ) {
        return res
          .status(400)
          .json({ message: "Вы уже использовали этот промокод." });
      }

      if (appliedPromo.type === "PERCENTAGE") {
        discountAmount = (price * appliedPromo.value) / 100;
        if (appliedPromo.maxDiscountAmount) {
          discountAmount = Math.min(
            discountAmount,
            appliedPromo.maxDiscountAmount,
          );
        }
      } else {
        discountAmount = appliedPromo.value;
      }

      price = Math.max(0, price - discountAmount);
    }

    // 🚨 FIX 2: Safely extract active profile data (Prisma uses camelCase 'companyName')
    const activeProfile =
      user.customerProfile ||
      user.performerProfile ||
      user.partnerProfile ||
      {};
    const companyName = activeProfile.companyName || null;
    const inn = activeProfile.inn || null;
    const city = activeProfile.city || null;
    const accountType = activeProfile.accountType || user.accountType;

    const isB2B =
      ["individualEntrepreneur", "legalEntity", "agency"].includes(
        accountType,
      ) && Boolean(inn && companyName);

    // ==========================================
    // SCENARIO A: B2B INVOICE (ООО / ИП)
    // ==========================================
    if (paymentMethod === "invoice") {
      if (!isB2B) {
        return res.status(400).json({
          message:
            "Для выставления счета необходимо заполнить ИНН и Название компании в профиле.",
        });
      }

      // Generate invoice number manually
      const invoiceNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const dueDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 Days valid

      // Create Payment via transaction to safely lock promo code usage
      const [paymentRecord] = await prisma.$transaction(async (tx) => {
        const newPayment = await tx.payment.create({
          data: {
            userId,
            amount: price,
            provider: "b2b_invoice",
            providerTxId: invoiceNumber, // Storing INV number here for webhooks to find
            status: "PENDING",
            metadata: {
              type: "SUBSCRIPTION",
              planId,
              interval,
              dueDate: dueDate.toISOString(),
              promoCodeId: appliedPromo?.id || null,
              discountAmount: discountAmount || null,
            },
          },
        });

        if (appliedPromo) {
          await tx.promoCode.update({
            where: { id: appliedPromo.id },
            data: {
              currentUses: { increment: 1 },
              usedByUsers: { connect: { id: userId } },
            },
          });
        }

        return [newPayment];
      });

      try {
        // 🚨 FIX 3: Pass a clean, guaranteed payload to the PDF generator
        const pdfUserPayload = {
          ...user,
          company_name: companyName, // Mapped back to what the PDF generator expects
          inn: inn,
          city: city,
        };

        const pdfBuffer = await generateB2BInvoicePDF(
          paymentRecord,
          pdfUserPayload,
          plan,
          interval,
        );

        await sendB2BInvoiceEmail(
          userEmail,
          companyName,
          invoiceNumber,
          pdfBuffer,
        );

        return res.status(200).json({
          success: true,
          isB2B: true,
          message: "Счет на оплату сформирован и отправлен на ваш Email.",
          paymentId: paymentRecord.id,
        });
      } catch (pdfError) {
        console.error("PDF/Email Error:", pdfError);

        // Complex Rollback if email fails: Delete payment and restore promo count
        await prisma.$transaction(async (tx) => {
          await tx.payment.delete({ where: { id: paymentRecord.id } });
          if (appliedPromo) {
            await tx.promoCode.update({
              where: { id: appliedPromo.id },
              data: {
                currentUses: { decrement: 1 },
                usedByUsers: { disconnect: { id: userId } }, // Revert relation
              },
            });
          }
        });

        return res
          .status(500)
          .json({ message: "Ошибка при генерации счета. Попробуйте позже." });
      }
    }

    // ==========================================
    // SCENARIO B: WALLET PAYMENT
    // ==========================================
    if (paymentMethod === "wallet") {
      const currentBalance = user.walletBalance || 0;

      if (currentBalance < price) {
        return res
          .status(400)
          .json({ message: "Недостаточно средств на балансе кошелька." });
      }

      const newEndDate = new Date();
      if (interval === "month") newEndDate.setMonth(newEndDate.getMonth() + 1);
      if (interval === "half_year")
        newEndDate.setMonth(newEndDate.getMonth() + 6);
      if (interval === "year")
        newEndDate.setFullYear(newEndDate.getFullYear() + 1);

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { walletBalance: { decrement: price } },
        });

        await tx.walletTransaction.create({
          data: {
            userId: userId,
            amount: -price,
            type: "PAYMENT",
            description: `Оплата подписки: ${plan.name}`,
          },
        });

        await tx.userSubscription.upsert({
          where: { userId: userId },
          update: {
            planId: plan.id,
            status: "ACTIVE",
            startDate: new Date(),
            endDate: newEndDate,
            pricePaid: price,
            promoCodeId: appliedPromo?.id || null,
            discountAmount: discountAmount || null,
          },
          create: {
            userId: userId,
            planId: plan.id,
            status: "ACTIVE",
            startDate: new Date(),
            endDate: newEndDate,
            pricePaid: price,
            promoCodeId: appliedPromo?.id || null,
            discountAmount: discountAmount || null,
          },
        });

        await tx.payment.create({
          data: {
            userId: userId,
            amount: price,
            provider: "wallet",
            status: "COMPLETED",
            metadata: { type: "SUBSCRIPTION", planId: plan.id, interval },
          },
        });

        if (appliedPromo) {
          await tx.promoCode.update({
            where: { id: appliedPromo.id },
            data: {
              currentUses: { increment: 1 },
              usedByUsers: { connect: { id: userId } },
            },
          });
        }
      });

      return res
        .status(200)
        .json({ success: true, isB2B: false, checkoutUrl: null });
    }

    // ==========================================
    // SCENARIO C: B2C CARD ACQUIRING (TINKOFF)
    // ==========================================
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: price,
        provider: "tinkoff",
        status: "PENDING",
        metadata: { type: "SUBSCRIPTION", planId: plan.id, interval },
      },
    });

    try {
      const tinkoffData = await initTinkoffSubscriptionPayment(
        payment.id,
        price,
        plan.name,
        interval,
        userEmail,
      );

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { providerTxId: String(tinkoffData.paymentId) },
        });

        if (appliedPromo) {
          await tx.promoCode.update({
            where: { id: appliedPromo.id },
            data: {
              currentUses: { increment: 1 },
              usedByUsers: { connect: { id: userId } },
            },
          });
        }
      });

      return res.status(200).json({
        success: true,
        isB2B: false,
        checkoutUrl: tinkoffData.paymentUrl,
      });
    } catch (tinkoffError) {
      console.error(
        "TINKOFF INIT FATAL ERROR:",
        tinkoffError.message || tinkoffError,
      );

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
      });

      return res.status(502).json({
        message: `Ошибка банка: ${tinkoffError.message || "Сервис временно недоступен"}`,
      });
    }
  } catch (error) {
    console.error("Subscription Checkout Error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
};

// --- WALLET TOP UP ---
export const initiateWalletTopUp = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    // Ensure amount is valid and meets a minimum threshold (e.g., 100 rubles)
    const parsedAmount = parseInt(amount, 10);
    if (!parsedAmount || parsedAmount < 100) {
      return res
        .status(400)
        .json({ message: "Минимальная сумма пополнения — 100 ₽." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      return res.status(404).json({ message: "Пользователь не найден." });

    const userEmail = user.email || "no-reply@eventomir.ru";

    // 1. Create a PENDING payment record
    const payment = await prisma.payment.create({
      data: {
        userId,
        amount: parsedAmount,
        provider: "tinkoff",
        status: "PENDING",
        metadata: { type: "WALLET_TOPUP" },
      },
    });

    try {
      // 2. Initialize Tinkoff session
      // Note: "customer" is passed as userType for the success/fail redirect URL logic
      const tinkoffData = await initTinkoffTopUpPayment(
        payment.id,
        parsedAmount,
        userEmail,
        "customer",
      );

      // 3. Update payment with Tinkoff's internal ID
      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerTxId: String(tinkoffData.paymentId) },
      });

      return res.status(200).json({
        success: true,
        checkoutUrl: tinkoffData.paymentUrl,
      });
    } catch (tinkoffError) {
      console.error("Tinkoff TopUp Init Error:", tinkoffError);

      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });

      return res.status(502).json({
        message: `Ошибка банка: ${tinkoffError.message || "Сервис недоступен"}`,
      });
    }
  } catch (error) {
    console.error("Wallet Top-Up Error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
};

// --- MISC GETTERS ---
export const getRequestPrice = async (req, res) => {
  try {
    const FIXED_REQUEST_PRICE = process.env.REQUEST_PRICE
      ? parseInt(process.env.REQUEST_PRICE)
      : 490;
    res.status(200).json({ price: FIXED_REQUEST_PRICE });
  } catch (error) {
    console.error("Get Request Price Error:", error);
    res.status(500).json({ message: "Unable to fetch price" });
  }
};
