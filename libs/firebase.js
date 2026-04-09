// libs/firebase.js
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
    // Ensure all data payload values are strings (FCM requirement)
    const stringifiedData = Object.keys(data).reduce((acc, key) => {
      acc[key] = String(data[key]);
      return acc;
    }, {});

    const message = {
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
          icon: "/icons/icon-192x192.png",
          requireInteraction: true,
        },
        fcmOptions: {
          link: data.url || "/", // Routes the PWA user on click
        },
      },
    };

    if (type === "topic") {
      message.topic = target;
      return await messaging.send(message);
    } else if (type === "token") {
      // Supports sending to a single token or an array of tokens
      if (Array.isArray(target)) {
        const response = await messaging.sendEachForMulticast({
          tokens: target,
          ...message,
        });
        return response;
      } else {
        message.token = target;
        return await messaging.send(message);
      }
    }
  } catch (error) {
    console.error("FCM Sending Failed:", error.message);
    throw error; // Throw so the caller can handle dead tokens
  }
};

export { admin, messaging, firebaseAuth, sendPushNotification };
