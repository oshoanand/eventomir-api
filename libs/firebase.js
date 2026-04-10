import admin from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";
import { getAuth } from "firebase-admin/auth";
import serviceAccount from "../serviceAccountKey.json" with { type: "json" };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const messaging = getMessaging();
const firebaseAuth = getAuth();

/**
 * @param {string} type - "token" or "topic"
 * @param {string} title - Notification Title
 * @param {string} body - Notification Body
 * @param {string|string[]} target - FCM Token(s) or Topic Name
 * @param {object} data - Dynamic data (e.g., { url: "/bookings/123" })
 */
const sendPushNotification = async (type, title, body, target, data = {}) => {
  try {
    // ✅ SAFEGUARD: Ensure data is an actual object, not a string or array
    const safeData =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? data
        : {};

    // Ensure all data payload values are strings (FCM requirement)
    const stringifiedData = Object.keys(safeData).reduce((acc, key) => {
      acc[key] = String(safeData[key]);
      return acc;
    }, {});

    // ✅ Base message structure
    const baseMessage = {
      notification: { title, body },
      data: {
        sentAt: new Date().toISOString(),
        ...stringifiedData,
      },
      android: {
        priority: "high",
        notification: {
          color: "#4D96FF",
          sound: "default",
        },
      },
      apns: {
        payload: { aps: { sound: "default" } },
      },
      webpush: {
        headers: { Urgency: "high" },
        notification: {
          // 🚨 CRITICAL FOR ANDROID PWA: Ensure this image file actually exists in your frontend /public folder!
          icon: "/icons/icon-192.png ",
          requireInteraction: true,
        },
        fcmOptions: {
          link: safeData.url || "/", // Routes the PWA user on click
        },
      },
    };

    if (type === "topic") {
      return await messaging.send({
        ...baseMessage,
        topic: target,
      });
    } else if (type === "token") {
      if (Array.isArray(target)) {
        // ✅ Multicast expects 'tokens' array, not 'token' string
        return await messaging.sendEachForMulticast({
          ...baseMessage,
          tokens: target,
        });
      } else {
        return await messaging.send({
          ...baseMessage,
          token: target,
        });
      }
    }
  } catch (error) {
    console.error("FCM Sending Failed:", error.message);
    throw error;
  }
};

export { admin, messaging, firebaseAuth, sendPushNotification };
