import express from "express";
import {
  handleTinkoffWebhook,
  handleTinkoffEventTicketWebhook,
} from "../controllers/webhooks.js";

const router = express.Router();

// POST /api/webhooks/tinkoff
router.post("/tinkoff", handleTinkoffWebhook);
router.post("/tinkoff-event-ticket", handleTinkoffEventTicketWebhook);

export default router;
