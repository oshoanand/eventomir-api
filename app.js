import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { initSocket } from "./services/socket.js";

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
import adminPlanRoutes from "./routes/subscription-plan.js";

// Services
//import setupTTL from "./utils/ttl-service.js";
import { connectRedis } from "./middleware/redis.js";

dotenv.config();

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function initializeExpressServer() {
  const app = express();

  //  Create HTTP Server explicitly (Required for Socket.io)
  const server = http.createServer(app);
  // Initialize Socket.io
  initSocket(server);

  // 5. Initialize Socket.io
  // const io = new Server(server, {
  //   cors: {
  //     origin: allowedDomains, // Socket.io needs explicit origins
  //     methods: ["GET", "POST"],
  //     credentials: true,
  //   },
  // });

  // 6. Make 'io' accessible in routes via req.app.get('socketio')
  // app.set("socketio", io);

  // Socket Connection Logic
  // io.on("connection", (socket) => {
  //   console.log(`🔌 Admin Connected: ${socket.id}`);
  //   socket.on("disconnect", () => {
  //     console.log(`❌ Admin Disconnected: ${socket.id}`);
  //   });
  // });

  // Express Middleware ---

  app.use(express.json());

  // Serve Static Files
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  // Initialize TTL Service
  // setupTTL();

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

  // Express CORS Setup (Using the shared allowedDomains)
  // Define Allowed Domains (Shared between Express and Socket.io)
  const allowedDomains = [
    "http://localhost:3000",
    process.env.CLIENT_URL,
  ].filter(Boolean); // Removes undefined if env is missing

  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedDomains.indexOf(origin) === -1) {
          const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
          return callback(new Error(msg), false);
        }
        return callback(null, true);
      },
      credentials: true,
    }),
  );

  // Connect to Redis BEFORE mounting routes
  await connectRedis();

  app.use("/api/admin", adminRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/performers", performerRoutes);
  app.use("/api/settings", settingRoutes);
  app.use("/api/pricing", pricingRoutes);
  app.use("/api/requests", requestRoutes);
  app.use("/api/articles", articleRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/admin/plans", adminPlanRoutes);

  // --- Server Start ---

  const PORT = process.env.PORT || 8800;

  // 7. LISTEN on 'server', NOT 'app'
  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.io initialized for Admin Panel`);
  });
}

initializeExpressServer()
  .then()
  .catch((e) => {
    console.error("❌ Failed to start server:", e);
    process.exit(1);
  });
