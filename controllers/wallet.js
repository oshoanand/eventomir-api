import prisma from "../libs/prisma.js";
import { initTinkoffTopUpPayment } from "../utils/tinkoff.js";

export const topUpWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { amount } = req.body;
    const userType = req.params.user;

    // 1. Validation
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount < 100) {
      return res
        .status(400)
        .json({ message: "Минимальная сумма пополнения — 100 руб." });
    }

    // 2. Create Pending Payment Record
    // We use JSON metadata to tell the webhook what to do when this payment succeeds
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: numericAmount,
        provider: "tinkoff",
        status: "PENDING",
        metadata: {
          type: "WALLET_TOPUP", // Crucial for the webhook
        },
      },
    });

    try {
      // 3. Contact Tinkoff
      const tinkoffData = await initTinkoffTopUpPayment(
        payment.id,
        numericAmount,
        userEmail,
        userType,
      );

      // 4. Save Tinkoff's internal TxID
      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerTxId: String(tinkoffData.paymentId) },
      });

      // 5. Send URL to frontend
      return res.status(200).json({
        success: true,
        paymentUrl: tinkoffData.paymentUrl,
      });
    } catch (tinkoffError) {
      // Cleanup if Tinkoff is down
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      throw new Error("TINKOFF_INIT_FAILED");
    }
  } catch (error) {
    console.error("Top Up Error:", error);
    if (error.message === "TINKOFF_INIT_FAILED") {
      return res.status(502).json({ message: "Ошибка платежного шлюза." });
    }
    res.status(500).json({ message: "Internal server error" });
  }
};
