import cron from "node-cron";
import prisma from "../libs/prisma.js";

export const startSubscriptionCron = () => {
  // Run every hour at minute 0 (e.g., 1:00, 2:00, 3:00)
  cron.schedule("0 * * * *", async () => {
    console.log("⏳ [CRON] Running Subscription Expiration Sweeper...");

    try {
      const now = new Date();

      // 1. Find all active subscriptions that have passed their end date
      const expiredSubscriptions = await prisma.userSubscription.findMany({
        where: {
          isActive: true,
          endDate: { lt: now },
          plan: { tier: { not: "FREE" } }, // Don't downgrade people already on FREE
        },
        include: { user: true },
      });

      if (expiredSubscriptions.length === 0) {
        console.log("✅ [CRON] No expired subscriptions found.");
        return;
      }

      // 2. Fetch the FREE plan fallback
      const freePlan = await prisma.subscriptionPlan.findUnique({
        where: { tier: "FREE" },
      });

      if (!freePlan) {
        console.error("❌ [CRON] CRITICAL: 'FREE' plan not found in database.");
        return;
      }

      // 3. Process Downgrades
      let downgradeCount = 0;
      for (const sub of expiredSubscriptions) {
        await prisma.userSubscription.update({
          where: { id: sub.id },
          data: {
            planId: freePlan.id,
            endDate: null, // Free plans don't expire
            autoRenew: false,
          },
        });

        // Optional: Log this to your notification system so the user knows
        await prisma.notification.create({
          data: {
            userId: sub.userId,
            title: "Срок действия тарифа истек",
            message:
              "Ваша платная подписка завершилась. Вы были переведены на бесплатный тариф.",
            type: "SYSTEM",
          },
        });

        downgradeCount++;
      }

      console.log(
        `✅ [CRON] Successfully downgraded ${downgradeCount} users to the FREE tier.`,
      );
    } catch (error) {
      console.error("❌ [CRON] Error during subscription sweep:", error);
    }
  });
};
