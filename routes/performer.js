import { Router } from "express";
import multer from "multer"; // Added explicit multer import
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { invalidatePattern } from "../libs/redis.js";
import { searchPerformers } from "../controllers/search.js";

// --- MinIO Imports ---
import {
  minioClient,
  MINIO_BUCKET_NAME,
  MINIO_PUBLIC_URL,
} from "../utils/minioClient.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";

const router = Router();

// 1. Configure Standard Multer Instances (Uses your util for Images/PDFs)
const performerUploader = createUploader(5); // 5MB limit
const documentUploader = createUploader(10); // 10MB limit for docs

// 2. NEW: Configure Audio-Specific Multer Instance
// We cannot use createUploader because it blocks audio MIME types.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Только аудиофайлы (MP3, WAV) разрешены!"), false);
    }
  },
});

const profileUploadFields = performerUploader.fields([
  { name: "profilePicture", maxCount: 1 },
  { name: "backgroundPicture", maxCount: 1 },
]);

// ==========================================
// --- MINIO HELPER FUNCTIONS ---
// ==========================================

const safeDeleteMinioFile = async (fileUrl) => {
  if (!fileUrl) return;
  try {
    const prefix = `${MINIO_PUBLIC_URL}/`;
    if (fileUrl.startsWith(prefix)) {
      const fileKey = fileUrl.replace(prefix, "");
      await minioClient.removeObject(MINIO_BUCKET_NAME, fileKey);
      console.log(`🗑️ MinIO: Deleted ${fileKey}`);
    }
  } catch (error) {
    console.error(`❌ MinIO: Failed to delete file: ${fileUrl}`, error);
  }
};

const deleteMinioFolder = async (prefix) => {
  try {
    const objectsList = [];
    const stream = minioClient.listObjectsV2(MINIO_BUCKET_NAME, prefix, true);

    for await (const obj of stream) {
      objectsList.push(obj.name);
    }

    if (objectsList.length > 0) {
      await minioClient.removeObjects(MINIO_BUCKET_NAME, objectsList);
      console.log(
        `🗑️ MinIO: Deleted folder prefix ${prefix} (${objectsList.length} files)`,
      );
    }
  } catch (err) {
    console.error(`❌ MinIO: Failed to delete folder prefix ${prefix}:`, err);
  }
};

const uploadMediaOrDoc = async (
  file,
  baseFolder,
  performerId,
  imageWidth = 800,
) => {
  if (!file) return null;

  if (file.mimetype === "application/pdf") {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const filename = `${file.fieldname}-${uniqueSuffix}.pdf`;
    const fileKey = `${baseFolder}/${performerId}/${filename}`;

    await minioClient.putObject(
      MINIO_BUCKET_NAME,
      fileKey,
      file.buffer,
      file.buffer.length,
      { "Content-Type": "application/pdf" },
    );
    return `${MINIO_PUBLIC_URL}/${MINIO_BUCKET_NAME}/${fileKey}`;
  } else {
    return await optimizeAndUpload(file, baseFolder, performerId, imageWidth);
  }
};

// ==========================================
// --- PROFILE MANAGEMENT ---
// ==========================================

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
        audio_tracks: true,
        bookings_as_performer: {
          include: {
            customer: { select: { name: true, email: true } },
          },
          orderBy: { date: "desc" },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: "Performer not found" });
    }

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
      audioTracks: user.audio_tracks || [],
      bookingRequests: user.bookings_as_performer.map((b) => ({
        id: b.id,
        date: b.date,
        details: b.details,
        status: b.status,
        customerId: b.customerId,
        performerId: b.performerId,
        createdAt: b.createdAt,
        customerName: b.customer?.name || "Unknown Customer",
        customerEmail: b.customer?.email || null,
      })),
    };

    res.json(mappedProfile);
  } catch (error) {
    console.error("Get Performer Profile Error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:id", verifyAuth, profileUploadFields, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.id !== id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { name, description, city, phone, roles, priceRange } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (description) updateData.description = description;
    if (city) updateData.city = city;
    if (phone) updateData.phone = phone;

    if (priceRange) {
      try {
        updateData.price_range =
          typeof priceRange === "string" ? JSON.parse(priceRange) : priceRange;
      } catch (e) {}
    }
    if (roles) {
      try {
        updateData.roles =
          typeof roles === "string" ? JSON.parse(roles) : roles;
      } catch (e) {}
    }

    if (req.files && req.files["profilePicture"]) {
      const file = req.files["profilePicture"][0];
      updateData.profile_picture = await uploadMediaOrDoc(
        file,
        "performers/profile",
        id,
        600,
      );
      const oldUser = await prisma.user.findUnique({
        where: { id },
        select: { profile_picture: true },
      });
      await safeDeleteMinioFile(oldUser?.profile_picture);
    }

    if (req.files && req.files["backgroundPicture"]) {
      const file = req.files["backgroundPicture"][0];
      updateData.background_picture = await uploadMediaOrDoc(
        file,
        "performers/backgrounds",
        id,
        1920,
      );
      const oldUser = await prisma.user.findUnique({
        where: { id },
        select: { background_picture: true },
      });
      await safeDeleteMinioFile(oldUser?.background_picture);
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { ...updateData },
    });

    await invalidatePattern("search:performers:*");

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
});

router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.id !== id)
      return res.status(403).json({ message: "Forbidden" });

    await prisma.user.delete({ where: { id } });

    await deleteMinioFolder(`performers/profile/${id}/`);
    await deleteMinioFolder(`performers/backgrounds/${id}/`);
    await deleteMinioFolder(`performers/gallery/${id}/`);
    await deleteMinioFolder(`performers/certificates/${id}/`);
    await deleteMinioFolder(`performers/letters/${id}/`);
    await deleteMinioFolder(`performers/audio/${id}/`); // Ensure audio is deleted

    await invalidatePattern("search:performers:*");

    res.status(200).json({ message: "Profile deleted successfully" });
  } catch (error) {
    console.error("Delete Performer Error:", error);
    res.status(500).json({ message: "Failed to delete profile." });
  }
});

// ==========================================
// --- CONTENT MANAGEMENT (GALLERY/DOCS) ---
// ==========================================

router.post(
  "/:id/gallery",
  verifyAuth,
  performerUploader.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, description } = req.body;

      if (req.user.id !== id)
        return res.status(403).json({ message: "Forbidden" });
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/gallery",
        id,
        1200,
      );

      const galleryItem = await prisma.galleryItem.create({
        data: {
          performer_id: id,
          title: title || "Без названия",
          description: description || "",
          image_urls: [fileUrl],
          moderation_status: "pending_approval",
        },
      });

      res.status(201).json(galleryItem);
    } catch (error) {
      res.status(500).json({ message: "Failed to add gallery item" });
    }
  },
);

router.delete("/:id/gallery/:itemId", verifyAuth, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    if (req.user.id !== id)
      return res.status(403).json({ message: "Forbidden" });

    const item = await prisma.galleryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ message: "Item not found" });

    await prisma.galleryItem.delete({ where: { id: itemId } });

    if (item.image_urls && Array.isArray(item.image_urls)) {
      for (const url of item.image_urls) {
        await safeDeleteMinioFile(url);
      }
    }

    res.status(200).json({ message: "Gallery item deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete item" });
  }
});

router.post(
  "/:id/certificates",
  verifyAuth,
  documentUploader.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { description } = req.body;

      if (req.user.id !== id)
        return res.status(403).json({ message: "Forbidden" });
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/certificates",
        id,
        1200,
      );

      const cert = await prisma.certificate.create({
        data: {
          performer_id: id,
          file_url: fileUrl,
          description: description || "",
          moderation_status: "pending_approval",
        },
      });

      res.status(201).json(cert);
    } catch (error) {
      res.status(500).json({ message: "Failed to add certificate" });
    }
  },
);

router.delete("/:id/certificates/:itemId", verifyAuth, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    if (req.user.id !== id)
      return res.status(403).json({ message: "Forbidden" });

    const cert = await prisma.certificate.findUnique({ where: { id: itemId } });
    if (!cert) return res.status(404).json({ message: "Not found" });

    await prisma.certificate.delete({ where: { id: itemId } });
    await safeDeleteMinioFile(cert.file_url);

    res.status(200).json({ message: "Deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete" });
  }
});

router.post(
  "/:id/letters",
  verifyAuth,
  documentUploader.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { description } = req.body;

      if (req.user.id !== id)
        return res.status(403).json({ message: "Forbidden" });
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/letters",
        id,
        1200,
      );

      const letter = await prisma.recommendationLetter.create({
        data: {
          performer_id: id,
          file_url: fileUrl,
          description: description || "",
          moderation_status: "pending_approval",
        },
      });

      res.status(201).json(letter);
    } catch (error) {
      res.status(500).json({ message: "Failed to add letter" });
    }
  },
);

router.delete("/:id/letters/:itemId", verifyAuth, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    if (req.user.id !== id)
      return res.status(403).json({ message: "Forbidden" });

    const letter = await prisma.recommendationLetter.findUnique({
      where: { id: itemId },
    });
    if (!letter) return res.status(404).json({ message: "Letter not found" });

    await prisma.recommendationLetter.delete({ where: { id: itemId } });
    await safeDeleteMinioFile(letter.file_url);

    res.status(200).json({ message: "Letter deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete letter" });
  }
});

// ==========================================
// --- DJ AUDIO TRACKS MANAGEMENT ---
// ==========================================

router.post(
  "/audio",
  verifyAuth,
  audioUpload.single("file"),
  async (req, res) => {
    try {
      const { title, performerId } = req.body;

      if (req.user.id !== performerId) {
        return res.status(403).json({ message: "Unauthorized" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "Аудиофайл обязателен" });
      }

      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      // Replace spaces and special chars to avoid MinIO path issues
      const safeOriginalName = req.file.originalname.replace(
        /[^a-zA-Z0-9.\-_]/g,
        "_",
      );
      const fileKey = `performers/audio/${performerId}/${uniqueSuffix}_${safeOriginalName}`;

      await minioClient.putObject(
        MINIO_BUCKET_NAME,
        fileKey,
        req.file.buffer,
        req.file.size,
        { "Content-Type": req.file.mimetype },
      );

      const fileUrl = `${MINIO_PUBLIC_URL}/${MINIO_BUCKET_NAME}/${fileKey}`;

      const track = await prisma.audioTrack.create({
        data: {
          performer_id: performerId,
          title: title || "Новый трек",
          file_url: fileUrl,
        },
      });

      res.status(201).json(track);
    } catch (error) {
      console.error("Audio Upload Error:", error);
      res.status(500).json({ message: "Upload failed" });
    }
  },
);

router.delete("/audio/:trackId", verifyAuth, async (req, res) => {
  try {
    const { trackId } = req.params;

    const track = await prisma.audioTrack.findUnique({
      where: { id: trackId },
    });

    if (!track) return res.status(404).json({ message: "Track not found" });

    if (track.performer_id !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await prisma.audioTrack.delete({ where: { id: trackId } });
    await safeDeleteMinioFile(track.file_url);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Audio Delete Error:", error);
    res.status(500).json({ message: "Delete failed" });
  }
});

// ==========================================
// --- BATCH FETCH & SEARCH ---
// ==========================================

router.get("/batch", async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(200).json([]);

    const idList = ids.split(",").filter(Boolean);
    if (idList.length === 0) return res.status(200).json([]);

    const performers = await prisma.user.findMany({
      where: { id: { in: idList }, role: "performer" },
      select: {
        id: true,
        name: true,
        city: true,
        roles: true,
        price_range: true,
        profile_picture: true,
        description: true,
        reviews_received: { select: { rating: true } },
      },
    });

    const formattedPerformers = performers.map((p) => {
      const totalRating = p.reviews_received.reduce(
        (sum, r) => sum + r.rating,
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
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/search", searchPerformers);

// Add Multer Error Handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `Ошибка загрузки: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ message: err.message });
  }
  next();
});

export default router;
