import express from "express";
import { admin } from "../libs/firebase.js";
import prisma from "../libs/prisma.js";
import { getUserTopic, notifyUser } from "../services/notification.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import "dotenv/config";

const router = express.Router();

router.post("/save-fcm", verifyAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;

    if (!token) return res.status(400).json({ message: "Token is required" });

    // 1. Fetch User securely
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    // Save Token in the User table directly
    await prisma.user.update({
      where: { id: user.id },
      data: { fcmToken: token },
    });

    // 3. Define and Execute Subscriptions
    const topicsToSubscribe = [];

    // Personal Topic (user_9898989898)
    const personalTopic = getUserTopic(user.phone);
    if (personalTopic) topicsToSubscribe.push(personalTopic);

    // Group Topics
    if (user.role === "customer") {
      topicsToSubscribe.push(
        process.env.CUSTOMER_FCM_TOPIC || "eventomir_customer_topic",
      );
    } else if (user.role === "performer" || user.role === "partner") {
      topicsToSubscribe.push(
        process.env.PERFORMER_FCM_TOPIC || "eventomir_performer_topic",
      );
    } else if (user.role === "administrator") {
      topicsToSubscribe.push("eventomir_admin_topic");
    }

    const subscriptionPromises = topicsToSubscribe.map((topic) =>
      admin
        .messaging()
        .subscribeToTopic(token, topic)
        .then(() => ({ status: "fulfilled", topic }))
        .catch((err) => ({ status: "rejected", topic, reason: err })),
    );

    await Promise.allSettled(subscriptionPromises);

    // 4. TRIGGER WELCOME PUSH ON FIRST LOGIN
    // if (!user.welcomePushSent) {
    //   await notifyUser({
    //     userId: user.id,
    //     title: "Добро пожаловать в Eventomir! 🎉",
    //     body: "Ваш профиль отправлен на модерацию. Мы сообщим вам, когда он будет одобрен.",
    //     type: "SYSTEM",
    //     data: { url: "/performer-profile" },
    //     saveToDb: true,
    //   });

    //   // Mark the welcome push as sent so they never get it again
    //   await prisma.user.update({
    //     where: { id: user.id },
    //     data: { welcomePushSent: true },
    //   });
    // }

    return res.status(200).json({
      success: true,
      message: "Token saved and subscriptions updated",
    });
  } catch (error) {
    console.error("Error saving FCM token:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
});

// Manual Subscribe Fallback (Optional)
router.post("/subscribe", verifyAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { phone: true },
    });

    const topicName = getUserTopic(user?.phone);

    if (topicName && token) {
      await admin.messaging().subscribeToTopic(token, topicName);
      return res.status(200).send("Subscribed successfully");
    }

    res.status(400).send("Phone or token missing");
  } catch (error) {
    console.error("Manual subscription error:", error);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
