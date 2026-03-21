import express from "express";
import { handleTinkoffWebhook } from "../controllers/webhooks.js";

const router = express.Router();

// POST /api/webhooks/tinkoff
router.post("/tinkoff", handleTinkoffWebhook);

export default router;
