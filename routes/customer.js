import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js"; // 🚨 FIX: Added image processor

const router = express.Router();

// Initialize memory uploader with 5MB limit
const profileUpload = createUploader(5);

// ==========================================
// GET CUSTOMER PROFILE
// ==========================================
router.get("/profile", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 🚨 FIX: Include the customerProfile to get the city
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        customerProfile: true,
        _count: {
          select: { notifications: { where: { isRead: false } } },
        },
      },
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    // Map DB fields to Frontend camelCase
    const profileData = {
      id: user.id,
      name: user.name || "",
      email: user.email,
      phone: user.phone || "",
      city: user.customerProfile?.city || "", // 🚨 FIX: Extract from profile
      profilePicture: user.image || "", // 🚨 FIX: Extract from new image field
      role: user.role,
      walletBalance: user.walletBalance || 0,
      unreadNotifications: user._count?.notifications || 0,
    };

    res.status(200).json(profileData);
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ==========================================
// UPDATE CUSTOMER PROFILE
// ==========================================
router.put(
  "/profile",
  verifyAuth,
  profileUpload.single("profile_image"),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { name, phone, city } = req.body;

      // 1. Process Image Upload via MinIO if a file is provided
      let imageUrl = undefined;
      if (req.file) {
        imageUrl = await optimizeAndUpload(
          req.file,
          "profiles",
          userId,
          800, // standard profile picture width
        );
      }

      // 2. 🚨 FIX: Use Nested Writes to update User and CustomerProfile simultaneously
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          name: name || undefined,
          phone: phone || undefined,
          ...(imageUrl && { image: imageUrl }), // Only update image if new one was uploaded
          customerProfile: {
            upsert: {
              create: { city: city || null },
              update: { city: city || null },
            },
          },
        },
        include: { customerProfile: true },
      });

      // 3. Return the FULL updated profile so the frontend cache can instantly update
      res.status(200).json({
        id: updatedUser.id,
        name: updatedUser.name || "",
        email: updatedUser.email,
        phone: updatedUser.phone || "",
        city: updatedUser.customerProfile?.city || "",
        profilePicture: updatedUser.image || "",
        role: updatedUser.role,
        walletBalance: updatedUser.walletBalance || 0,
      });
    } catch (error) {
      console.error("Update error:", error);
      res.status(500).json({ message: "Update failed" });
    }
  },
);

// ==========================================
// GET ORDER HISTORY (BOOKINGS)
// ==========================================
router.get("/orders", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. 🚨 FIX: Get the underlying CustomerProfile ID first
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: userId },
    });

    if (!customerProfile) {
      return res.status(200).json([]); // No profile = no bookings
    }

    // 2. 🚨 FIX: Query Bookings using CustomerProfile ID and deep populate Performer
    const bookings = await prisma.booking.findMany({
      where: { customerId: customerProfile.id },
      include: {
        performer: {
          include: {
            user: { select: { id: true, name: true } }, // Deep fetch Base User name
          },
        },
      },
      orderBy: { date: "desc" },
    });

    // 3. Map to frontend OrderHistoryItem interface
    const history = bookings.map((b) => ({
      id: b.id,
      performerId: b.performer.user.id, // Point back to Base User ID for frontend routing
      performerName: b.performer.user.name || "Неизвестный исполнитель",
      service: b.details || "Бронирование", // Default fallback if no details provided
      date: b.date,
      status: b.status,
      price: 0, // Replace with actual price logic if added to Booking model
    }));

    res.status(200).json(history);
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

export default router;
