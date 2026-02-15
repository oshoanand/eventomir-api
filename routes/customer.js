import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { createUploader } from "../utils/multer.js";

const router = express.Router();

const profileUpload = createUploader("profiles");

// Get Customer Profile, Apply verifyAuth to protect these routes
router.get("/profile", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id; // Extracted from JWT

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: { notifications: { where: { isRead: false } } },
        },
      },
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    // Map DB snake_case to Frontend camelCase
    const profileData = {
      id: user.id,
      name: user.name || "",
      email: user.email,
      phone: user.phone || "",
      city: user.city || "",
      profilePicture: user.profile_picture || "",
      role: user.role,
      unreadNotifications: user._count.notifications,
    };

    res.json(profileData);
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Update Customer Profile
router.put(
  "/profile",
  verifyAuth,
  profileUpload.single("profile_image"),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { name, phone, city } = req.body;
      // Prepare data object for Prisma
      const updateData = {
        name,
        phone,
        city,
      };

      // If an image was uploaded, process it
      if (req.file) {
        // Construct the public URL path.
        // Assuming you serve the 'uploads' folder statically from your root.
        // Windows uses backslashes, so we normalize to forward slashes for URLs.
        const profileImageUrl = `${process.env.PHOTO_UPLOAD_URL}/uploads/profiles/${req.file.filename}`;
        updateData.profile_picture = profileImageUrl;
      }

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      // Return the updated profile picture URL so frontend can update state immediately
      res.json({
        success: true,
        message: "Profile updated",
        profilePicture: updatedUser.profile_picture,
      });
    } catch (error) {
      console.error("Update error:", error);
      res.status(500).json({ message: "Update failed" });
    }
  },
);

// Get Order History (Bookings)

router.get("/orders", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch bookings where this user is the customer
    const bookings = await prisma.booking.findMany({
      where: { customerId: userId },
      include: {
        performer: {
          // Include performer details
          select: { name: true },
        },
      },
      orderBy: { date: "desc" },
    });

    // Map to frontend OrderHistoryItem interface
    const history = bookings.map((b) => ({
      id: b.id,
      performerId: b.performer_id,
      performerName: b.performer.name || "Unknown",
      service: b.service || "Uknown Service",
      date: b.date, // Prisma returns Date object
      status: b.status, // pending, confirmed, completed, etc.
      price: b.price || 0,
    }));

    res.json(history);
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

export default router;
