import cron from "node-cron";
import prisma from "../libs/prisma.js";
import { confirmTinkoffPayment } from "../utils/tinkoff.js";

// Run every hour
cron.schedule("0 * * * *", async () => {
  console.log("🔒 Checking T-Bank Escrow Releases...");

  try {
    const eligiblePayments = await prisma.payment.findMany({
      where: {
        escrowStatus: "HELD",
        releaseEligible: { lte: new Date() }, // 24h passed since event
      },
      include: { booking: true },
    });

    for (const payment of eligiblePayments) {
      try {
        // 1. Tell T-Bank to Capture the Held Funds
        // This takes real money from customer and credits it to your platform
        await confirmTinkoffPayment(payment.providerTxId, payment.amount);

        // 2. Update Internal State & Credit Performer
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { escrowStatus: "RELEASED" }, // Marks logic complete
          });

          await tx.bookingRequest.update({
            where: { id: payment.booking.id },
            data: { status: "FULFILLED" },
          });

          // Credit Performer's Wallet
          await tx.user.update({
            where: { id: payment.booking.performerId },
            data: { walletBalance: { increment: payment.netAmount } },
          });

          await tx.walletTransaction.create({
            data: {
              userId: payment.booking.performerId,
              amount: payment.netAmount,
              type: "PAYOUT",
              description: `Оплата за выступление (Бронь #${payment.booking.id.split("-")[0]})`,
            },
          });
        });
      } catch (err) {
        console.error(`❌ Tinkoff Capture Failed for ${payment.id}:`, err);
      }
    }
  } catch (error) {
    console.error("❌ Cron System Error:", error);
  }
});
