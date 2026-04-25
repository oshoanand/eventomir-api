import express from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import {
  createPaidRequest,
  getCustomerRequests,
  getRequestsFeed,
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

export default router;
