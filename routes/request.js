import express from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import {
  createPaidRequest,
  getCustomerRequests,
  getRequestsFeed,
  getRequestById,
  closeRequest,
} from "../controllers/request.js";

const router = express.Router();

// ==========================================
// 1. CREATE PAID REQUEST (Wallet or Gateway)
// POST /api/requests
// ==========================================
router.post("/", verifyAuth, createPaidRequest);

// ==========================================
// 2. GET MY REQUESTS (Customer Dashboard)
// GET /api/requests/customer
// ==========================================
router.get("/customer", verifyAuth, getCustomerRequests);

// ==========================================
// 3. GET PUBLIC FEED (For Performers)
// GET /api/requests/feed
// ==========================================
router.get("/feed", verifyAuth, getRequestsFeed);

// ==========================================
// 4. GET SINGLE REQUEST (Increments Views)
// GET /api/requests/:id
// 🚨 MUST BE AFTER /customer AND /feed!
// ==========================================
router.get("/:id", verifyAuth, getRequestById);

// ==========================================
// 5. CLOSE/ARCHIVE REQUEST (By Customer)
// PATCH /api/requests/:id/close
// ==========================================
router.patch("/:id/close", verifyAuth, closeRequest);

export default router;
