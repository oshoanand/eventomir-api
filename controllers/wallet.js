import prisma from "../libs/prisma.js";
import { initTinkoffTopUpPayment } from "../utils/tinkoff.js";

export const topUpWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;
    const { userType } = req.params; // Matches the route param

    // 1. Validation
    const numericAmount = parseInt(amount, 10);
    if (isNaN(numericAmount) || numericAmount < 100) {
      return res
        .status(400)
        .json({ message: "Минимальная сумма пополнения — 100 руб." });
    }

    // 2. Fetch fresh user data (Email is required for Tinkoff receipts)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, role: true },
    });

    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден." });
    }

    const emailToUse = user.email || req.user.email;

    // 3. Create Pending Payment Record
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: numericAmount,
        provider: "tinkoff",
        status: "PENDING",
        metadata: {
          type: "WALLET_TOPUP",
          userRole: userType || user.role, // Helps webhook with redirect logic
        },
      },
    });

    try {
      // 4. Contact Tinkoff
      const tinkoffData = await initTinkoffTopUpPayment(
        payment.id,
        numericAmount,
        emailToUse,
        userType || user.role,
      );

      // 5. Save Tinkoff's internal TxID (PaymentId)
      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerTxId: String(tinkoffData.paymentId) },
      });

      // 6. Send URL to frontend
      return res.status(200).json({
        success: true,
        paymentUrl: tinkoffData.paymentUrl,
      });
    } catch (tinkoffError) {
      console.error("Tinkoff API Error:", tinkoffError);

      // Cleanup: Mark as failed if the bank gateway couldn't initialize
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });

      return res
        .status(502)
        .json({ message: "Ошибка платежного шлюза. Попробуйте позже." });
    }
  } catch (error) {
    console.error("Top Up Controller Error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
};
