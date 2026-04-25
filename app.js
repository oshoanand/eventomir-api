import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Services & Utils
import { initializeSocket } from "./libs/socket.js";
import { initializeMinio } from "./utils/minioClient.js";
import { connectRedis } from "./libs/redis.js";

// 🚨 IMPORT THE SUBSCRIPTION CRON WORKER
import { startSubscriptionCron } from "./cron/subscription-worker.js";

// 🚨 IMPORT SECURITY & ANALYTICS
import { globalRateLimiter } from "./middleware/security.js";

// Routes
import analyticsRoutes from "./routes/analytics.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import userRoutes from "./routes/user.js";
import customerRoutes from "./routes/customer.js";
import performerRoutes from "./routes/performer.js";
import settingRoutes from "./routes/settings.js";
import pricingRoutes from "./routes/pricing.js";
import requestRoutes from "./routes/request.js";
import articleRoutes from "./routes/article.js";
import bookingRoutes from "./routes/booking.js";
import notificationRoutes from "./routes/notification.js";
import paymentRoutes from "./routes/payment.js";
import subscriptionRoutes from "./routes/subscription.js";
import chatRoutes from "./routes/chat.js";
import partnerRoutes from "./routes/partner.js";
import eventRoutes from "./routes/event.js";
import orderRoutes from "./routes/order.js";
import searchRoutes from "./routes/search.js";
import reviewsRoutes from "./routes/reviews.js";
import walletRoutes from "./routes/wallet.js";
import webhookRoutes from "./routes/webhooks.js";
import fcmRoutes from "./routes/fcm.js";
import invitationRoutes from "./routes/invitation.js";
import promoRoutes from "./routes/promo.js";
import supportRoutes from "./routes/support.js";
import feedRoutes from "./routes/feed.js";
import financeRoutes from "./routes/finance.js";

dotenv.config();

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function initializeExpressServer() {
  const app = express();

  // Create HTTP Server explicitly (Required for Socket.io)
  const server = http.createServer(app);

  // 1. Define Allowed Domains FIRST (Shared between Express and Socket.io)
  const allowedDomains = [
    process.env.PARTNER_APP_URL,
    process.env.WEB_APP_URL,
    process.env.ADMIN_PANEL_URL,
  ].filter(Boolean); // Removes undefined/null if env vars are missing

  // 2. Initialize Socket.io securely by passing the allowed domains
  initializeSocket(server, allowedDomains);

  // 3. Express CORS Setup (Must be before routes)
  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, or curl requests)
        if (!origin) return callback(null, true);

        if (allowedDomains.indexOf(origin) === -1) {
          const msg = `CORS Blocked: The origin ${origin} is not allowed to access this server.`;
          console.warn(msg); // Use warn instead of log for security auditing
          return callback(new Error(msg), false);
        }
        return callback(null, true);
      },
      credentials: true,
    }),
  );

  // Serve Static Files (Kept for legacy uploads, though new ones go to MinIO)
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  // Logging Middleware
  app.use((req, res, next) => {
    console.log(`${req.method} : ${req.path}`);
    next();
  });

  // 🚨 APPLY GLOBAL RATE LIMITER
  // This must be placed here so it protects the body parsers and all routes below
  app.use(globalRateLimiter);

  // --- Standard Express Middleware for all other routes ---
  app.use(express.json());
  app.use(
    express.urlencoded({
      parameterLimit: 100000,
      limit: "50mb",
      extended: true,
    }),
  );

  // --- External Services Initialization ---

  // Connect to Redis BEFORE mounting routes
  await connectRedis();

  // Initialize MinIO Bucket & Policies
  // This will automatically create your bucket if it doesn't exist
  await initializeMinio();

  // 🚨 START THE BACKGROUND SUBSCRIPTION SWEEPER
  startSubscriptionCron();

  // --- Mount Standard Routes ---
  app.use("/api/admin", adminRoutes);
  app.use("/api/articles", articleRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/chats", chatRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/performers", performerRoutes);
  app.use("/api/pricing", pricingRoutes);
  app.use("/api/requests", requestRoutes);
  app.use("/api/settings", settingRoutes);
  app.use("/api/subscriptions", subscriptionRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/partners", partnerRoutes);
  app.use("/api/events", eventRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/reviews", reviewsRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/fcm", fcmRoutes);
  app.use("/api/webhooks", webhookRoutes);
  app.use("/api/invitations", invitationRoutes);
  app.use("/api/promo-codes", promoRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/support", supportRoutes);
  app.use("/api/feeds", feedRoutes);
  app.use("/api/finance", financeRoutes);

  // --- Server Start ---
  const PORT = process.env.PORT || 8800;

  // LISTEN on 'server', NOT 'app'
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Socket.io initialized and secured`);
  });
}

initializeExpressServer()
  .then(() => {
    console.log("✅ Initialization complete.");
  })
  .catch((e) => {
    console.error("❌ Failed to start server:", e);
    process.exit(1);
  });
