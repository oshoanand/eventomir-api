import { Router } from "express";
import { verifyAuth } from "../middleware/verify-auth.js"; // Your JWT middleware
import {
  createOrGetChat,
  getUserChats,
  getChatMessages,
  sendMessage,
} from "../controllers/chat.js";

const router = Router();

// All chat routes require authentication
router.use(verifyAuth);

// 1. Get all chats for the sidebar
router.get("/", getUserChats);

// 2. Create a new chat (or open existing)
router.post("/create", createOrGetChat);

// 3. Get messages history for a specific chat
router.get("/:chatId/messages", getChatMessages);

// 4. Send a message to a specific chat
router.post("/:chatId/messages", sendMessage);

export default router;
