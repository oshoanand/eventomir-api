import prisma from "../libs/prisma.js";
import { sendPushNotification } from "../libs/firebase.js";
import { sendNotification as sendSocketNotification } from "../libs/socket.js";

/**
 * Helper to normalize a phone number into a Firebase Topic.
 * Converts "+79898989898" or "8 (989) 898-98-98" -> "user_9898989898"
 */
export const getUserTopic = (phone) => {
  if (!phone) return null;

  // Strip all non-numeric characters
  const digits = phone.replace(/\D/g, "");

  // Standardize Russian/CIS numbers (remove leading 7 or 8 if length is 11)
  if (
    digits.length === 11 &&
    (digits.startsWith("7") || digits.startsWith("8"))
  ) {
    return `user_${digits.slice(1)}`;
  }

  // Fallback for other international formats
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
          data: data || {}, // Fallback to empty object if undefined
        },
      });
    }

    // 2. Emit Real-Time Socket Event (Instant delivery for active users)
    await sendSocketNotification(userId, type, body, { title, ...data });

    // 3. Fetch User's Data (Need Phone for Topic, or Tokens for fallback)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, fcmTokens: true },
    });

    if (!user) return;

    // 4. Determine Delivery Method (Topic vs Token)
    const topicName = getUserTopic(user.phone);

    if (topicName) {
      // 🚀 SCENARIO A: Topic-Based Delivery (Highly Scalable)
      // Firebase will automatically route this to all devices subscribed to this topic
      await sendPushNotification("topic", title, body, topicName, {
        url: data?.url || "/",
      });

      console.log(`✅ FCM Sent via Topic: ${topicName}`);
    } else if (user.fcmTokens && user.fcmTokens.length > 0) {
      // 🔄 SCENARIO B: Fallback to Token-Based Delivery
      // Used if the user hasn't provided a phone number yet
      const tokens = user.fcmTokens.map((t) => t.token);

      const fcmResponse = await sendPushNotification(
        "token",
        title,
        body,
        tokens,
        { url: data?.url || "/" },
      );

      // Cleanup Dead Tokens
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
