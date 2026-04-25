import { Router } from "express";
import multer from "multer";
import prisma from "../libs/prisma.js";
import jwt from "jsonwebtoken";
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

// 1. Configure Standard Multer Instances
const performerUploader = createUploader(5); // 5MB limit
const documentUploader = createUploader(10); // 10MB limit for docs

// 2. Audio-Specific Multer Instance
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

// 3. Optional Auth Middleware
const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) {
    try {
      const secret = process.env.JWT_SECRET || process.env.SECRET;
      req.user = jwt.verify(token, secret);
    } catch (e) {}
  }
  next();
};

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

router.get("/profile/:performerId", optionalAuth, async (req, res) => {
  try {
    const { performerId } = req.params;
    const currentUserId = req.user?.id;
    const isOwner = currentUserId === performerId;

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: performerId },
      include: {
        user: true,
        reviewsReceived: true,
        galleryItems: true,
        certificates: true,
        recommendations: true,
        audioTracks: true,
        bookingsReceived: {
          include: {
            customer: {
              // 🚨 FIX: Removed 'city' because the User model doesn't have it anymore
              select: { name: true, email: true, image: true },
            },
          },
          orderBy: { date: "desc" },
        },
        feedPosts: {
          where: isOwner ? undefined : { isPublic: true },
          orderBy: { createdAt: "desc" },
          include: {
            _count: { select: { likes: true, comments: true } },
            likes: currentUserId ? { where: { userId: currentUserId } } : false,
            comments: {
              include: {
                user: { select: { id: true, name: true, image: true } },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (!profile)
      return res.status(404).json({ message: "Performer not found" });

    const mappedProfile = {
      id: profile.user.id,
      name: profile.user.name,
      email: profile.user.email,
      phone: profile.user.phone,
      city: profile.city,
      description: profile.description,
      accountType: profile.accountType,
      profilePicture: profile.user.image,
      backgroundPicture: profile.backgroundPicture,
      roles: profile.roles || [],
      priceRange: profile.priceRange || [],
      socialLinks: profile.socialLinks || {},
      bankDetails: profile.bankDetails || [],
      moderationStatus: profile.moderationStatus,
      gallery: profile.galleryItems,
      certificates: profile.certificates,
      recommendationLetters: profile.recommendations,
      audioTracks: profile.audioTracks || [],
      feedPosts: profile.feedPosts.map((post) => ({
        ...post,
        likesCount: post._count.likes,
        commentsCount: post._count.comments,
        isLikedByMe: post.likes ? post.likes.length > 0 : false,
      })),
      bookingRequests: profile.bookingsReceived.map((b) => ({
        id: b.id,
        date: b.date,
        details: b.details,
        status: b.status,
        customerId: b.customerId,
        performerId: b.performerId,
        createdAt: b.createdAt,
        // Using the safe fields we pulled above
        customerName: b.customer?.name || "Unknown Customer",
        customerEmail: b.customer?.email || null,
        customerImage: b.customer?.image || null,
      })),
      bookedDates: profile.bookedDates || [],
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
    if (req.user.id !== id)
      return res.status(403).json({ message: "Forbidden" });

    const {
      name,
      description,
      city,
      phone,
      roles,
      priceRange,
      socialLinks,
      bankDetails,
    } = req.body;

    const parsedPriceRange =
      typeof priceRange === "string" ? JSON.parse(priceRange) : priceRange;
    const parsedRoles = typeof roles === "string" ? JSON.parse(roles) : roles;
    const parsedSocialLinks =
      typeof socialLinks === "string" ? JSON.parse(socialLinks) : socialLinks;
    const parsedBankDetails =
      typeof bankDetails === "string" ? JSON.parse(bankDetails) : bankDetails;

    const userUpdate = { name, phone };
    const profileUpdate = {
      description,
      city,
      roles: parsedRoles,
      priceRange: parsedPriceRange,
      socialLinks: parsedSocialLinks,
      bankDetails: parsedBankDetails,
    };

    if (req.files && req.files["profilePicture"]) {
      userUpdate.image = await uploadMediaOrDoc(
        req.files["profilePicture"][0],
        "performers/profile",
        id,
        600,
      );
    }
    if (req.files && req.files["backgroundPicture"]) {
      profileUpdate.backgroundPicture = await uploadMediaOrDoc(
        req.files["backgroundPicture"][0],
        "performers/backgrounds",
        id,
        1920,
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { ...userUpdate, performerProfile: { update: profileUpdate } },
      include: { performerProfile: true },
    });

    await invalidatePattern("search:performers:*");

    res.json({
      message: "Profile updated successfully",
      profile: {
        ...updatedUser,
        ...updatedUser.performerProfile,
        profilePicture: updatedUser.image,
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
    await deleteMinioFolder(`performers/audio/${id}/`);
    await deleteMinioFolder(`performers/feed/${id}/`);

    await invalidatePattern("search:performers:*");

    res.status(200).json({ message: "Profile deleted successfully" });
  } catch (error) {
    console.error("Delete Performer Error:", error);
    res.status(500).json({ message: "Failed to delete profile." });
  }
});

// ==========================================
// --- 🗓️ CALENDAR MANAGEMENT ---
// ==========================================

router.patch("/:id/calendar", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { bookedDates } = req.body;

    // Security Check: Only the performer can edit their calendar
    if (req.user.id !== id) {
      return res.status(403).json({ message: "Доступ запрещен" });
    }

    // Ensure bookedDates is an array of valid ISO dates
    const parsedDates = Array.isArray(bookedDates)
      ? bookedDates.map((date) => new Date(date).toISOString())
      : [];

    const updatedProfile = await prisma.performerProfile.update({
      where: { userId: id },
      data: {
        bookedDates: parsedDates,
      },
    });

    res.status(200).json({
      message: "Календарь обновлен",
      bookedDates: updatedProfile.bookedDates,
    });
  } catch (error) {
    console.error("Update Calendar Error:", error);
    res.status(500).json({ message: "Ошибка обновления календаря" });
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

      const profile = await prisma.performerProfile.findUnique({
        where: { userId: id },
      });
      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/gallery",
        id,
        1200,
      );

      const galleryItem = await prisma.galleryItem.create({
        data: {
          performerId: profile.id,
          title: title || "Без названия",
          description: description || "",
          imageUrls: [fileUrl],
          moderationStatus: "PENDING",
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
    if (item.imageUrls) {
      for (const url of item.imageUrls) await safeDeleteMinioFile(url);
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

      const profile = await prisma.performerProfile.findUnique({
        where: { userId: id },
      });
      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/certificates",
        id,
        1200,
      );

      const cert = await prisma.certificate.create({
        data: {
          performerId: profile.id,
          fileUrl: fileUrl,
          description: description || "",
          moderationStatus: "PENDING",
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
    await safeDeleteMinioFile(cert.fileUrl);

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

      const profile = await prisma.performerProfile.findUnique({
        where: { userId: id },
      });
      const fileUrl = await uploadMediaOrDoc(
        req.file,
        "performers/letters",
        id,
        1200,
      );

      const letter = await prisma.recommendationLetter.create({
        data: {
          performerId: profile.id,
          fileUrl: fileUrl,
          description: description || "",
          moderationStatus: "PENDING",
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
    await safeDeleteMinioFile(letter.fileUrl);

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
      if (req.user.id !== performerId)
        return res.status(403).json({ message: "Unauthorized" });
      if (!req.file)
        return res.status(400).json({ message: "Аудиофайл обязателен" });

      const profile = await prisma.performerProfile.findUnique({
        where: { userId: performerId },
      });
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
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

      const track = await prisma.audioTrack.create({
        data: {
          performerId: profile.id,
          title: title || "Новый трек",
          fileUrl: `${MINIO_PUBLIC_URL}/${MINIO_BUCKET_NAME}/${fileKey}`,
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
      include: { performer: true },
    });

    if (!track) return res.status(404).json({ message: "Track not found" });
    if (track.performer.userId !== req.user.id)
      return res.status(403).json({ message: "Unauthorized" });

    await prisma.audioTrack.delete({ where: { id: trackId } });
    await safeDeleteMinioFile(track.fileUrl);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Audio Delete Error:", error);
    res.status(500).json({ message: "Delete failed" });
  }
});

// ==========================================
// --- BATCH FETCH ---
// ==========================================

router.get("/batch", async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(200).json([]);

    const idList = ids.split(",").filter(Boolean);
    if (idList.length === 0) return res.status(200).json([]);

    const profiles = await prisma.performerProfile.findMany({
      where: { userId: { in: idList } },
      include: {
        user: true,
        reviewsReceived: { select: { rating: true } },
      },
    });

    const formattedPerformers = profiles.map((p) => {
      const totalRating = p.reviewsReceived.reduce(
        (sum, r) => sum + r.rating,
        0,
      );
      const avgRating =
        p.reviewsReceived.length > 0
          ? totalRating / p.reviewsReceived.length
          : null;

      return {
        id: p.user.id,
        name: p.user.name,
        city: p.city,
        roles: p.roles,
        priceRange: p.priceRange,
        profilePicture: p.user.image,
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
