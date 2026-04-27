import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";

const router = express.Router();

// Initialize memory uploader with 5MB limit
const profileUpload = createUploader(5);

// 🚨 FIX: Configure Multer to accept multiple specific fields instead of a single file
const profileUploadFields = profileUpload.fields([
  { name: "profilePictureFile", maxCount: 1 },
  { name: "backgroundPictureFile", maxCount: 1 },
]);

// ==========================================
// GET CUSTOMER PROFILE
// ==========================================
router.get("/profile", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

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

    // Map DB fields to Frontend expected camelCase format
    const profileData = {
      id: user.id,
      name: user.name || "",
      email: user.email,
      phone: user.phone || "",
      profilePicture: user.image || "",
      role: user.role,
      walletBalance: user.walletBalance || 0,
      unreadNotifications: user._count?.notifications || 0,
      city: user.customerProfile?.city || "",
      address: user.customerProfile?.address || "",
      backgroundPicture: user.customerProfile?.backgroundPicture || "",
      moderationStatus: user.customerProfile?.moderationStatus,
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
router.put("/profile", verifyAuth, profileUploadFields, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, phone, city, address } = req.body;

    // 1. Process Profile Picture Upload
    let profilePicUrl = undefined;
    if (req.files && req.files["profilePictureFile"]) {
      profilePicUrl = await optimizeAndUpload(
        req.files["profilePictureFile"][0],
        "profiles",
        userId,
        800,
      );
    }

    // 2. Process Background Cover Upload
    let bgPicUrl = undefined;
    if (req.files && req.files["backgroundPictureFile"]) {
      bgPicUrl = await optimizeAndUpload(
        req.files["backgroundPictureFile"][0],
        "profiles/backgrounds",
        userId,
        1920,
      );
    }

    // 3. Update User and CustomerProfile simultaneously
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name || undefined,
        phone: phone || undefined,
        ...(profilePicUrl && { image: profilePicUrl }),
        customerProfile: {
          upsert: {
            create: {
              city: city || null,
              address: address || null,

              ...(bgPicUrl && { backgroundPicture: bgPicUrl }),
            },
            update: {
              city: city || null,
              address: address || null,

              ...(bgPicUrl && { backgroundPicture: bgPicUrl }),
            },
          },
        },
      },
      include: { customerProfile: true },
    });

    // 4. Return the FULL updated profile so the frontend cache instantly updates
    res.status(200).json({
      id: updatedUser.id,
      name: updatedUser.name || "",
      email: updatedUser.email,
      phone: updatedUser.phone || "",
      profilePicture: updatedUser.image || "",
      role: updatedUser.role,
      walletBalance: updatedUser.walletBalance || 0,

      city: updatedUser.customerProfile?.city || "",
      address: updatedUser.customerProfile?.address || "",

      backgroundPicture: updatedUser.customerProfile?.backgroundPicture || "",
    });
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ message: "Update failed" });
  }
});

// ==========================================
// GET ORDER HISTORY (BOOKINGS)
// ==========================================
router.get("/orders", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 🚨 FIX: In your schema, `customerId` on `BookingRequest` connects directly to the Base `User` ID.
    // There is no need to query `CustomerProfile` first to get bookings!
    const bookings = await prisma.bookingRequest.findMany({
      where: { customerId: userId },
      include: {
        performer: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Map to frontend OrderHistoryItem interface
    const history = bookings.map((b) => ({
      id: b.id,
      performerId: b.performer?.user?.id || b.performerId,
      performerName: b.performer?.user?.name || "Неизвестный исполнитель",
      service: b.details || "Оформление заказа",
      date: b.date,
      status: b.status,
      price: b.agreedFee || 0, // 🚨 FIX: Mapped to the real fee from our negotiation system
    }));

    res.status(200).json(history);
  } catch (error) {
    console.error("History error:", error);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

export default router;
