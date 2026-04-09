import prisma from "../libs/prisma.js";
import { sendPushNotification } from "../libs/firebase.js";
import { sendNotification as sendSocketNotification } from "../libs/socket.js";

/**
 * Helper to normalize a phone number into a Firebase Topic.
 * Converts "+79898989898" or "8 (989) 898-98-98" -> "user_9898989898"
 */
export const getUserTopic = (phone) => {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");
  if (
    digits.length === 11 &&
    (digits.startsWith("7") || digits.startsWith("8"))
  ) {
    return `user_${digits.slice(1)}`;
  }
  return `user_${digits}`;
};

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
    // 1. Save to Database (In-App Notification Bell)
    if (saveToDb) {
      await prisma.notification.create({
        data: {
          userId,
          title,
          message: body,
          type,
          data: data || {},
        },
      });
    }

    // 2. Emit Real-Time Socket Event (Instant delivery for active users)
    await sendSocketNotification(userId, type, body, { title, ...data });

    // 🚨 FIX 2: Select 'fcmToken' (String) matching your schema
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, fcmToken: true },
    });

    if (!user) return;

    // 4. Determine Delivery Method (Topic vs Token)
    const topicName = getUserTopic(user.phone);

    if (topicName) {
      // 🚀 SCENARIO A: Topic-Based Delivery
      await sendPushNotification("topic", title, body, topicName, {
        url: data?.url || "/",
      });

      console.log(`✅ FCM Sent via Topic: ${topicName}`);
    } else if (user.fcmToken) {
      // 🔄 SCENARIO B: Fallback to Token-Based Delivery
      // Wrap the single string token in an array for Firebase
      const tokens = [user.fcmToken];

      const fcmResponse = await sendPushNotification(
        "token",
        title,
        body,
        tokens,
        { url: data?.url || "/" },
      );

      // Cleanup Dead Token
      if (fcmResponse && fcmResponse.responses) {
        const resp = fcmResponse.responses[0];
        if (
          !resp.success &&
          (resp.error.code === "messaging/invalid-registration-token" ||
            resp.error.code === "messaging/registration-token-not-registered")
        ) {
          // Nullify the dead token so we don't try sending to it again
          await prisma.user.update({
            where: { id: userId },
            data: { fcmToken: null },
          });
          console.log(`🗑️ Cleaned up dead FCM token for user ${userId}.`);
        }
      }
    }
  } catch (error) {
    console.error("❌ Notification Dispatcher Error:", error);
  }
};
