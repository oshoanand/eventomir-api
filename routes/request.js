import express from "express";
import {
  createPaidRequest,
  getRequestsByCustomer,
} from "../controllers/request.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = express.Router();

// POST /api/requests
router.post("/", verifyAuth, createPaidRequest);

// Matches the frontend url: `/api/requests/customer/${customerId}`
router.get("/customer/:customerId", verifyAuth, getRequestsByCustomer);

export default router;
