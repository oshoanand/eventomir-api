import express from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import {
  createPaidRequest,
  getCustomerRequests,
  getRequestsFeed,
} from "../controllers/request.js";

const router = express.Router();

// POST /api/requests
router.post("/", verifyAuth, createPaidRequest);

// Matches the frontend url: `/api/requests/customer/${customerId}`
// router.get("/customer/:customerId", verifyAuth, getRequestsByCustomer);

// POST /api/requests - Create (Protected)
router.post("/", verifyAuth, createPaidRequest);

// GET /api/requests/customer/:customerId - My Requests (Protected)
router.get("/customer/:customerId", verifyAuth, getCustomerRequests);

// GET /api/requests/feed - Feed for Performers (Protected)
router.get("/feed", verifyAuth, getRequestsFeed);

export default router;
