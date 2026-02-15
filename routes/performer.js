import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import fs from "fs";
import path from "path";
import { searchPerformers } from "../controllers/search.js";

const router = Router();

// 1. Configure Multer for Performers
// Uses your existing 'createUploader' utility to save files to 'uploads/performers'
const performerUploader = createUploader("performers");

// Define fields for profile and background images
const uploadFields = performerUploader.fields([
  { name: "profilePicture", maxCount: 1 },
  { name: "backgroundPicture", maxCount: 1 },
]);

const documentUploader = createUploader("documents");

// --- GET Profile (Public or Protected depending on needs) ---
router.get("/profile/:performerId", async (req, res) => {
  try {
    const { performerId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: performerId },
      include: {
        reviews_received: true,
        gallery_items: true,
        certificates: true,
        recommendation_letters: true,
        bookings_as_performer: {
          include: {
            customer: {
              select: { name: true, email: true },
            },
          },
          orderBy: { date: "desc" },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: "Performer not found" });
    }

    // Map DB snake_case to Frontend camelCase
    const mappedProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      city: user.city,
      description: user.description,
      accountType: user.account_type,
      profilePicture: user.profile_picture,
      backgroundPicture: user.background_picture,
      roles: user.roles || [],
      priceRange: user.price_range || [],
      moderationStatus: user.moderation_status,
      gallery: user.gallery_items,
      certificates: user.certificates,
      recommendationLetters: user.recommendation_letters,
      bookingRequests: user.bookings_as_performer.map((b) => ({
        id: b.id,
        date: b.date,
        details: b.details,
        status: b.status,
        customerId: b.customerId,
        performerId: b.performerId,
        createdAt: b.createdAt,
        // Extract the name from the relation
        customerName: b.customer?.name || "Unknown Customer",
        // Optional: you can also pass email if needed
        customerEmail: b.customer?.email || null,
      })),
    };

    res.json(mappedProfile);
  } catch (error) {
    console.error("Get Performer Profile Error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// --- PATCH Update Profile (Protected + File Uploads) ---
router.patch(
  "/:id",
  verifyAuth, // 1. Verify Token
  uploadFields, // 2. Handle Files (populate req.files)
  async (req, res) => {
    try {
      const { id } = req.params;

      // 3. Security Check: Access Control
      if (req.user.id !== id) {
        // Clean up uploaded files if auth fails to prevent trash buildup
        if (req.files) {
          Object.values(req.files)
            .flat()
            .forEach((file) => {
              fs.unlinkSync(file.path);
            });
        }
        return res.status(403).json({
          message: "Forbidden: You can only update your own profile.",
        });
      }

      // 4. Parse Text Data
      // FormData sends everything as strings. Simple fields work directly,
      // but arrays/objects (like roles) need JSON.parse if sent as stringified JSON.
      const { name, description, city, phone, roles } = req.body;

      const updateData = {};
      if (name) updateData.name = name;
      if (description) updateData.description = description;
      if (city) updateData.city = city;
      if (phone) updateData.phone = phone;

      // Handle Roles Array
      if (roles) {
        try {
          // If sent as JSON string ["DJ", "Host"]
          updateData.roles =
            typeof roles === "string" ? JSON.parse(roles) : roles;
        } catch (e) {
          console.warn("Roles parsing failed, using raw value or skipping");
        }
      }

      // 5. Handle Profile Picture Update
      if (req.files && req.files["profilePicture"]) {
        const file = req.files["profilePicture"][0];

        const newPath = `${process.env.PHOTO_UPLOAD_URL}/uploads/performers/${file.filename}`;
        updateData.profile_picture = newPath;

        // Cleanup: Delete old image
        const oldUser = await prisma.user.findUnique({
          where: { id },
          select: { profile_picture: true },
        });
        if (oldUser?.profile_picture) {
          // Construct absolute path. Ensure 'uploads' is in your root.
          const oldPath = path.join(process.cwd(), oldUser.profile_picture);
          if (fs.existsSync(oldPath)) {
            try {
              fs.unlinkSync(oldPath);
            } catch (e) {
              console.error("Failed to delete old profile pic", e);
            }
          }
        }
      }

      // 6. Handle Background Picture Update
      if (req.files && req.files["backgroundPicture"]) {
        const file = req.files["backgroundPicture"][0];
        const newPath = `${process.env.PHOTO_UPLOAD_URL}/uploads/performers/${file.filename}`;
        updateData.background_picture = newPath;

        // Cleanup: Delete old image
        const oldUser = await prisma.user.findUnique({
          where: { id },
          select: { background_picture: true },
        });
        if (oldUser?.background_picture) {
          const oldPath = path.join(process.cwd(), oldUser.background_picture);
          if (fs.existsSync(oldPath)) {
            try {
              fs.unlinkSync(oldPath);
            } catch (e) {
              console.error("Failed to delete old bg pic", e);
            }
          }
        }
      }

      // 7. Perform DB Update
      // Setting moderation_status to pending ensures safety after edits
      const updatedUser = await prisma.user.update({
        where: { id },
        data: {
          ...updateData,
          moderation_status: "pending_approval",
        },
      });

      // 8. Return Updated Data (Mapped)
      res.json({
        message: "Profile updated successfully",
        profile: {
          ...updatedUser,
          profilePicture: updatedUser.profile_picture,
          backgroundPicture: updatedUser.background_picture,
        },
      });
    } catch (error) {
      console.error("Update Performer Error:", error);
      res.status(500).json({ message: "Failed to update profile." });
    }
  },
);

// --- DELETE Profile (Protected) ---
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Security Check
    if (req.user.id !== id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // 1. Fetch user to get file paths before deleting
    const userToDelete = await prisma.user.findUnique({
      where: { id },
      select: { profile_picture: true, background_picture: true },
    });

    // 2. Delete from DB (Cascades should handle related bookings/reviews if configured in schema)
    await prisma.user.delete({ where: { id } });

    // 3. Cleanup Files
    if (userToDelete) {
      if (userToDelete.profile_picture) {
        const pPath = path.join(process.cwd(), userToDelete.profile_picture);
        if (fs.existsSync(pPath)) fs.unlinkSync(pPath);
      }
      if (userToDelete.background_picture) {
        const bPath = path.join(process.cwd(), userToDelete.background_picture);
        if (fs.existsSync(bPath)) fs.unlinkSync(bPath);
      }
    }

    res.status(200).json({ message: "Profile deleted successfully" });
  } catch (error) {
    console.error("Delete Performer Error:", error);
    res.status(500).json({ message: "Failed to delete profile." });
  }
});

// --- GALLERY MANAGEMENT ---

// DELETE /api/performers/:id/gallery/:itemId
router.delete("/:id/gallery/:itemId", verifyAuth, async (req, res) => {
  try {
    const { id, itemId } = req.params;

    if (req.user.id !== id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // 1. Find the item to get file paths
    const item = await prisma.galleryItem.findUnique({
      where: { id: itemId },
    });

    if (!item) return res.status(404).json({ message: "Item not found" });

    // 2. Delete from Database
    await prisma.galleryItem.delete({ where: { id: itemId } });

    // 3. Cleanup Files (assuming imageUrls contains relative paths)
    if (item.imageUrls && Array.isArray(item.imageUrls)) {
      item.imageUrls.forEach((url) => {
        const filePath = path.join(process.cwd(), url);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            console.error("File delete error", e);
          }
        }
      });
    }

    res.status(200).json({ message: "Gallery item deleted" });
  } catch (error) {
    console.error("Delete Gallery Item Error:", error);
    res.status(500).json({ message: "Failed to delete item" });
  }
});

// --- RECOMMENDATION LETTERS MANAGEMENT ---

// POST /api/performers/:id/letters
router.post(
  "/:id/letters",
  verifyAuth,
  documentUploader.single("file"), // Expects field name 'file'
  async (req, res) => {
    try {
      const { id } = req.params;
      const { description } = req.body;

      if (req.user.id !== id) {
        // Cleanup if auth fails
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(403).json({ message: "Forbidden" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const fileUrl = `${process.env.PHOTO_UPLOAD_URL}/uploads/documents/${req.file.filename}`;

      const letter = await prisma.recommendationLetter.create({
        data: {
          performer_id: id, // Ensure your schema maps this relation correctly
          file_url: fileUrl,
          description: description || "",
          moderation_status: "pending_approval",
        },
      });

      // Return camelCase for frontend
      res.status(201).json({
        id: letter.id,
        fileUrl: letter.file_url,
        description: letter.description,
        moderationStatus: letter.moderation_status,
      });
    } catch (error) {
      console.error("Add Letter Error:", error);
      res.status(500).json({ message: "Failed to add letter" });
    }
  },
);

// DELETE /api/performers/:id/letters/:itemId
router.delete("/:id/letters/:itemId", verifyAuth, async (req, res) => {
  try {
    const { id, itemId } = req.params;

    if (req.user.id !== id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const letter = await prisma.recommendationLetter.findUnique({
      where: { id: itemId },
    });

    if (!letter) return res.status(404).json({ message: "Letter not found" });

    await prisma.recommendationLetter.delete({ where: { id: itemId } });

    // Cleanup File
    if (letter.file_url) {
      const filePath = path.join(process.cwd(), letter.file_url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.status(200).json({ message: "Letter deleted" });
  } catch (error) {
    console.error("Delete Letter Error:", error);
    res.status(500).json({ message: "Failed to delete letter" });
  }
});

/**
 * Fetch multiple performers by specific IDs
 * Used for the Comparison page and Favorites list
 */
router.get("/batch", async (req, res) => {
  try {
    // Expecting query string like: ?ids=id1,id2,id3
    const { ids } = req.query;

    if (!ids) {
      return res.status(200).json([]); // Return empty array if no IDs provided
    }

    const idList = ids.split(",").filter(Boolean); // Remove empty strings

    if (idList.length === 0) {
      return res.status(200).json([]);
    }

    const performers = await prisma.user.findMany({
      where: {
        id: { in: idList },
        role: "performer", // Security: Only fetch performers
        // moderation_status: "approved" // Optional: Uncomment if you only want approved profiles in comparison
      },
      select: {
        id: true,
        name: true,
        city: true,
        roles: true,
        price_range: true, // Make sure your DB has this field (snake_case)
        profile_picture: true,
        description: true,
        // Include average rating directly in the query for efficiency
        reviews_received: {
          select: {
            rating: true,
          },
        },
      },
    });

    // Format data for frontend (snake_case -> camelCase & calc rating)
    const formattedPerformers = performers.map((p) => {
      const totalRating = p.reviews_received.reduce(
        (sum, review) => sum + review.rating,
        0,
      );
      const avgRating =
        p.reviews_received.length > 0
          ? totalRating / p.reviews_received.length
          : null;

      return {
        id: p.id,
        name: p.name,
        city: p.city,
        roles: p.roles,
        priceRange: p.price_range,
        profilePicture: p.profile_picture,
        description: p.description,
        averageRating: avgRating,
      };
    });

    return res.status(200).json(formattedPerformers);
  } catch (error) {
    console.error("Error fetching performers by IDs:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/search", searchPerformers);

export default router;
