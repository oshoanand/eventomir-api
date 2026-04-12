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
  // 🚨 FIX 1: Define `target` and `currentTargetType` at the top scope so the catch block can see it
  let target = userId;
  let currentTargetType = "token";

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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, fcmToken: true },
    });

    if (!user) return;

    // 4. Determine Delivery Method (Topic vs Token)
    const topicName = getUserTopic(user.phone);

    if (topicName) {
      // 🚀 SCENARIO A: Topic-Based Delivery
      target = topicName;
      currentTargetType = "topic";

      const response = await sendPushNotification(
        "topic",
        title,
        body,
        topicName,
        {
          url: data?.url || "/",
        },
      );

      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: "topic",
          target: target, // Now correctly defined
          status: "SUCCESS",
          messageId: response,
        },
      });

      console.log(`✅ FCM Sent via Topic: ${topicName}`);
    } else if (user.fcmToken) {
      // 🔄 SCENARIO B: Fallback to Token-Based Delivery
      target = user.fcmToken;
      currentTargetType = "token";

      const tokens = [user.fcmToken];

      const fcmResponse = await sendPushNotification(
        "token",
        title,
        body,
        tokens,
        { url: data?.url || "/" },
      );

      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: "token",
          target: target, // Now correctly defined
          status: "SUCCESS",
          messageId: fcmResponse,
        },
      });

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

    // 3. ✅ Log Failure to PostgreSQL
    try {
      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: currentTargetType, // 🚨 FIX 3: Passed proper TargetType enum, not the notification 'type'
          target: target,
          status: "FAILED",
          errorDetails: error.message,
        },
      });
    } catch (logError) {
      console.error("Failed to write error log to DB:", logError);
    }

    // 🚨 FIX 2: Removed `res.status(500)` because `res` is not available in a utility function.
    // Returning false lets the calling route (like /register-performer) finish successfully
    // even if the notification push fails.
    return false;
  }
};
