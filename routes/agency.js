import { Router } from "express";
import { verifyAuth } from "../middleware/verify-auth.js";
import {
  createSpecialist,
  getAgencySpecialists,
  deleteSpecialist,
  getAgencyBookings,
} from "../controllers/agency.js";

const router = Router();

// Middleware to ensure user is authenticated
router.use(verifyAuth);

// Specialists Management
router.get("/specialists", getAgencySpecialists);
router.post("/specialists", createSpecialist); // Create or Update
router.delete("/specialists/:id", deleteSpecialist);

// Aggregated Bookings for Dashboard
router.get("/bookings", getAgencyBookings);

export default router;
