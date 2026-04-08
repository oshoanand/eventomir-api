import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { initSocket } from "./services/socket.js";
import { initializeMinio } from "./utils/minioClient.js";

// Routes
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
import tarrifPlanRoutes from "./routes/subscription-plan.js";
import chatRoutes from "./routes/chat.js";
import partnerRoutes from "./routes/partner.js";
import eventRoutes from "./routes/event.js";
import orderRoutes from "./routes/order.js";
import searchRoutes from "./routes/search.js";
import reviewsRoutes from "./routes/reviews.js";
import walletRoutes from "./routes/wallet.js";
import webhookRoutes from "./routes/webhooks.js";

// Services
import { connectRedis } from "./middleware/redis.js";

dotenv.config();

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function initializeExpressServer() {
  const app = express();

  // Create HTTP Server explicitly (Required for Socket.io)
  const server = http.createServer(app);

  // Initialize Socket.io
  initSocket(server);

  // Express Middleware ---
  app.use(express.json());

  // Serve Static Files (Kept for legacy uploads, though new ones go to MinIO)
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  // Logging Middleware
  app.use((req, res, next) => {
    console.log(`${req.method} : ${req.path}`);
    next();
  });

  app.use(
    express.urlencoded({
      parameterLimit: 100000,
      limit: "50mb",
      extended: true,
    }),
  );

  // Define Allowed Domains (Shared between Express and Socket.io)
  const allowedDomains = [
    process.env.PARTNER_APP_URL,
    process.env.WEB_APP_URL,
    process.env.ADMIN_PANEL_URL,
  ].filter(Boolean); // Removes undefined if env is missing

  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedDomains.indexOf(origin) === -1) {
          const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
          console.log(msg);
          return callback(new Error(msg), false);
        }
        return callback(null, true);
      },
      credentials: true,
    }),
  );

  // --- External Services Initialization ---

  // 1. Connect to Redis BEFORE mounting routes
  await connectRedis();

  // 2. Initialize MinIO Bucket & Policies
  // 🚨 This will automatically create your bucket if it doesn't exist
  await initializeMinio();

  // --- Mount Routes ---
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
  app.use("/api/tariff/plans", tarrifPlanRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/partners", partnerRoutes);
  app.use("/api/events", eventRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/search", searchRoutes);
  app.use("/api/reviews", reviewsRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/webhooks", webhookRoutes);

  // --- Server Start ---
  const PORT = process.env.PORT || 8800;

  // LISTEN on 'server', NOT 'app'
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Socket.io initialized`);
  });
}

initializeExpressServer()
  .then()
  .catch((e) => {
    console.error("❌ Failed to start server:", e);
    process.exit(1);
  });
