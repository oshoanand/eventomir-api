import prisma from "../libs/prisma.js";
import { sendPushNotification } from "../libs/firebase.js";
import { getIO, sendSystemNotification } from "../libs/socket.js";

/**
 * Helper to normalize a phone number into a Firebase Topic.
 * Converts "+79898989898" or "8 (989) 898-98-98" -> "user_9898989898"
 */
export const getUserTopic = (phone) => {
  if (!phone) return null;

  // Strip all non-numeric characters
  const digits = phone.replace(/\D/g, "");

  // If it's a standard Russian mobile (11 digits starting with 7 or 8)
  if (
    digits.length === 11 &&
    (digits.startsWith("7") || digits.startsWith("8"))
  ) {
    return `user_${digits.slice(1)}`;
  }

  // If it's anything else, just use the raw digits as the unique suffix
  return digits.length > 0 ? `user_${digits}` : null;
};

/**
 * Master Dispatcher for all User Notifications
 * Dispatches to Database, Socket.io (real-time), and Firebase Cloud Messaging (Push)
 */
export const notifyUser = async ({
  userId,
  title,
  body,
  type, // Should match NotificationType Enum
  data = {},
  saveToDb = true,
}) => {
  // Define trackers for the logging logic
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
          // Ensure data is stored as a valid JSON object
          data: data && typeof data === "object" ? data : {},
        },
      });
    }

    // 2. Emit Real-Time Socket Event (Instant delivery for active web users)
    try {
      const io = getIO();
      if (io) {
        sendSystemNotification(io, userId, type, body, { title, ...data });
      }
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
    let fcmResponse = null;

    if (topicName) {
      // 🚀 SCENARIO A: Topic-Based Delivery (Highly Reliable)
      target = topicName;
      currentTargetType = "topic";

      fcmResponse = await sendPushNotification(
        "topic",
        title,
        body,
        topicName,
        { url: data?.url || "/" },
      );
    } else if (user.fcmToken) {
      // 🔄 SCENARIO B: Fallback to Token-Based Delivery
      target = user.fcmToken;
      currentTargetType = "token";

      fcmResponse = await sendPushNotification(
        "token",
        title,
        body,
        [user.fcmToken],
        { url: data?.url || "/" },
      );

      // 5. Cleanup Dead Token if FCM indicates it's no longer valid
      if (fcmResponse && fcmResponse.responses) {
        const resp = fcmResponse.responses[0];
        if (
          !resp.success &&
          resp.error &&
          (resp.error.code === "messaging/invalid-registration-token" ||
            resp.error.code === "messaging/registration-token-not-registered")
        ) {
          await prisma.user.update({
            where: { id: userId },
            data: { fcmToken: null },
          });
          console.log(`🗑️ Cleaned up expired FCM token for user ${userId}.`);
        }
      }
    }

    // 6. Log successful delivery to Persistent Logs
    if (fcmResponse) {
      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: currentTargetType === "topic" ? "topic" : "token",
          target: target,
          status: "SUCCESS",
          // Store the message ID from FCM
          messageId:
            typeof fcmResponse === "string"
              ? fcmResponse
              : fcmResponse.messageId || "batch_processed",
        },
      });
    }

    return true;
  } catch (error) {
    console.error("❌ Notification Dispatcher Error:", error);

    // Log Failure to Database for Admin debugging
    try {
      await prisma.notificationLog.create({
        data: {
          title,
          body,
          targetType: currentTargetType === "topic" ? "topic" : "token",
          target: String(target),
          status: "FAILED",
          errorDetails: error.message,
        },
      });
    } catch (logError) {
      console.error("Failed to write notification error log to DB:", logError);
    }

    // Fail gracefully so the parent business logic (like payment or registration) can complete
    return false;
  }
};
