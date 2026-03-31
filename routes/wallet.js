import express from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import { topUpWallet } from "../controllers/wallet.js";

const router = express.Router();

// POST /api/wallet/topup
router.post("/topup/:user", verifyAuth, topUpWallet);

export default router;
