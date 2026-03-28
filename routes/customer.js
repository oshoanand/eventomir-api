import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { createUploader } from "../utils/multer.js";

const router = express.Router();

const profileUpload = createUploader("profiles");

// ==========================================
// GET CUSTOMER PROFILE
// ==========================================
router.get("/profile", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
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
      city: user.city || "",
      profilePicture: user.profile_picture || user.profilePicture || "",
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

      // Prepare data object for Prisma (Prisma ignores undefined values safely)
      const updateData = {
        name,
        phone,
        city,
      };

      // If an image was uploaded, process it
      if (req.file) {
        // Construct the public URL path.
        // Assuming you serve the 'uploads' folder statically from your root.
        const profileImageUrl = `${process.env.API_BASE_URL}/uploads/profiles/${req.file.filename}`;
        updateData.profile_picture = profileImageUrl;
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      // Return the FULL updated profile so the frontend
      // TanStack Query cache can instantly update the UI without a page reload.
      res.status(200).json({
        id: updatedUser.id,
        name: updatedUser.name || "",
        email: updatedUser.email,
        phone: updatedUser.phone || "",
        city: updatedUser.city || "",
        profilePicture:
          updatedUser.profile_picture || updatedUser.profilePicture || "",
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

    // Fetch bookings where this user is the customer
    const bookings = await prisma.booking.findMany({
      where: { customerId: userId },
      include: {
        performer: {
          select: { name: true }, // Include performer details
        },
      },
      orderBy: { date: "desc" },
    });

    // Map to frontend OrderHistoryItem interface
    const history = bookings.map((b) => ({
      id: b.id,
      // Handle both camelCase and snake_case depending on your Prisma configuration
      performerId: b.performerId || b.performer_id,
      performerName: b.performer?.name || "Неизвестно", // Added optional chaining for safety
      service: b.service || "Неизвестная услуга", // Fixed typo "Uknown"
      date: b.date, // Prisma returns Date object
      status: b.status, // pending, confirmed, completed, etc.
      price: b.price || 0,
    }));

    res.status(200).json(history);
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

export default router;
