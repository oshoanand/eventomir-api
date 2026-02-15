import { Router } from "express";
import {
  createBooking,
  acceptBooking,
  rejectBooking,
} from "../controllers/booking.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// POST /api/bookings
router.post("/", verifyAuth, createBooking);

// PATCH /api/bookings/:requestId/accept
router.patch("/:requestId/accept", verifyAuth, acceptBooking);

// PATCH /api/bookings/:requestId/reject
router.patch("/:requestId/reject", verifyAuth, rejectBooking);

export default router;
