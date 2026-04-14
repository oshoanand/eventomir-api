import prisma from "../libs/prisma.js";
import { sendPushNotification } from "../libs/firebase.js";
import { getIO, sendSystemNotification } from "../libs/socket.js";

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
  // Define target trackers for the catch block
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
    try {
      const io = getIO();
      sendSystemNotification(io, userId, type, body, { title, ...data });
    } catch (socketError) {
      console.warn("⚠️ Socket.io notification skipped:", socketError.message);
    }

    // 3. Fetch user details for Push Notifications
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, fcmToken: true },
    });

    if (!user) return false;

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
        { url: data?.url || "/" },
      );

      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: "topic",
          target: target,
          status: "SUCCESS",
          messageId: response,
        },
      });

      console.log(`✅ FCM Sent via Topic: ${topicName}`);
      return true;
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
          target: target,
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
          await prisma.user.update({
            where: { id: userId },
            data: { fcmToken: null },
          });
          console.log(`🗑️ Cleaned up dead FCM token for user ${userId}.`);
        }
      }
      return true;
    }
  } catch (error) {
    console.error("❌ Notification Dispatcher Error:", error);

    // Log Failure to PostgreSQL
    try {
      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: currentTargetType,
          target: target,
          status: "FAILED",
          errorDetails: error.message,
        },
      });
    } catch (logError) {
      console.error("Failed to write notification error log to DB:", logError);
    }

    // Fail gracefully so the calling route (like /register-performer) can finish
    return false;
  }
};
