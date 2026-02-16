import { Router } from "express";
import {
  getPlans,
  initiateCheckout,
  handleMockSuccess,
  handlePaymentSuccess,
  getRequestPrice,
} from "../controllers/payment.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// Public: Get all plans
router.get("/plans", getPlans);

// Protected: Start payment
router.post("/checkout", verifyAuth, initiateCheckout);

// Public (Callback): Handle success redirect
// Note: verifyAuth is NOT used here because this request comes from the "Payment Provider" redirect
// Validation relies on the providerTxId (txId)
router.get("/mock-success", handleMockSuccess);
router.get("/request-price", getRequestPrice);

export default router;
