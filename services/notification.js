// services/notification.js
import prisma from "../libs/prisma.js";
import { sendPushNotification } from "../libs/firebase.js";
import { sendNotification as sendSocketNotification } from "../libs/socket.js";

/**
 * Master Dispatcher for all User Notifications
 */
export const notifyUser = async ({
  userId,
  title,
  body,
  type,
  data,
  saveToDb = true,
}) => {
  try {
    // 1. Save to Database (Optional but recommended for In-App Notification Bell)
    let dbNotification;
    if (saveToDb) {
      dbNotification = await prisma.notification.create({
        data: {
          userId,
          title,
          message: body,
          type,
          data: data, // JSON field in Prisma
        },
      });
    }

    // 2. Emit Real-Time Socket Event
    // If the user has the app open, they get this instantly without FCM delay
    await sendSocketNotification(userId, type, body, { title, ...data });

    // 3. Fetch User's FCM Tokens
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmTokens: true }, // Assuming you store an array of tokens or a relation
    });

    if (user && user.fcmTokens && user.fcmTokens.length > 0) {
      // 4. Send Firebase Push Notifications
      const tokens = user.fcmTokens.map((t) => t.token); // Adjust based on your schema

      const fcmResponse = await sendPushNotification(
        "token",
        title,
        body,
        tokens,
        { url: data.url || "/" },
      );

      // 5. Cleanup Dead Tokens (Crucial for maintenance)
      if (fcmResponse && fcmResponse.responses) {
        const deadTokens = [];
        fcmResponse.responses.forEach((resp, idx) => {
          if (
            !resp.success &&
            (resp.error.code === "messaging/invalid-registration-token" ||
              resp.error.code === "messaging/registration-token-not-registered")
          ) {
            deadTokens.push(tokens[idx]);
          }
        });

        if (deadTokens.length > 0) {
          await prisma.fcmToken.deleteMany({
            where: { token: { in: deadTokens } },
          });
          console.log(`🗑️ Cleaned up ${deadTokens.length} dead FCM tokens.`);
        }
      }
    }
  } catch (error) {
    console.error("❌ Notification Dispatcher Error:", error);
  }
};
