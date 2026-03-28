import { Router } from "express";
import {
  getPlans,
  initiateCheckout,
  getRequestPrice,
} from "../controllers/payment.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

router.get("/plans", getPlans);
router.post("/checkout", verifyAuth, initiateCheckout);
router.get("/request-price", getRequestPrice);

export default router;
