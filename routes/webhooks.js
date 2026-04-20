import express from "express";
import {
  handleTinkoffWebhook,
  handleTinkoffEventTicketWebhook,
  handleTinkoffB2BSubscriptionPurchase,
} from "../controllers/webhooks.js";

const router = express.Router();

// POST /api/webhooks/tinkoff
router.post("/tinkoff", handleTinkoffWebhook);
router.post("/tinkoff-event-ticket", handleTinkoffEventTicketWebhook);
router.post("/tinkoff-b2b-incoming", handleTinkoffB2BSubscriptionPurchase);

export default router;
