import express from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import { topUpWallet } from "../controllers/wallet.js";

const router = express.Router();

// POST /api/wallet/topup/:userType (where userType is 'customer' or 'performer')
router.post("/topup/:userType", verifyAuth, topUpWallet);

export default router;
