import { Router } from "express";
import multer from "multer";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";
import {
  minioClient,
  MINIO_BUCKET_NAME,
  MINIO_PUBLIC_URL,
} from "../utils/minioClient.js";

const router = Router();

// Configure Multer for Feeds (20MB limit for multiple images/videos)
const feedUploader = createUploader(20);

// --- MINIO HELPER FUNCTIONS ---
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

const uploadMediaOrDoc = async (
  file,
  baseFolder,
  performerId,
  imageWidth = 800,
) => {
  if (!file) return null;
  return await optimizeAndUpload(file, baseFolder, performerId, imageWidth);
};

// ==========================================
// --- FEED POSTS MANAGEMENT ---
// ==========================================

// 1. Create Feed Post -> [POST] /api/feeds/:performerId
router.post(
  "/:performerId",
  verifyAuth,
  feedUploader.array("files", 5),
  async (req, res) => {
    try {
      const { performerId } = req.params;
      const { text } = req.body;

      if (req.user.id !== performerId)
        return res.status(403).json({ message: "Доступ запрещен" });

      const profile = await prisma.performerProfile.findUnique({
        where: { userId: performerId },
      });
      if (!profile)
        return res.status(404).json({ message: "Профиль не найден" });

      let imageUrls = [];
      let videoUrl = null;

      if (req.files && req.files.length > 0) {
        let videoCount = 0;
        for (const file of req.files) {
          if (file.mimetype.startsWith("image/")) {
            if (file.size > 5 * 1024 * 1024)
              return res.status(400).json({ message: `Файл превышает 5MB.` });
          } else if (file.mimetype.startsWith("video/")) {
            videoCount++;
            if (videoCount > 1)
              return res
                .status(400)
                .json({ message: "Только 1 видео на пост." });
            if (file.size > 15 * 1024 * 1024)
              return res.status(400).json({ message: `Видео превышает 15MB.` });
          }
        }

        for (const file of req.files) {
          if (file.mimetype.startsWith("image/")) {
            const url = await uploadMediaOrDoc(
              file,
              "performers/feed",
              performerId,
              1200,
            );
            if (url) imageUrls.push(url);
          } else if (file.mimetype.startsWith("video/")) {
            const uniqueSuffix =
              Date.now() + "-" + Math.round(Math.random() * 1e9);
            const safeOriginalName = file.originalname.replace(
              /[^a-zA-Z0-9.\-_]/g,
              "_",
            );
            const fileKey = `performers/feed/${performerId}/${uniqueSuffix}_${safeOriginalName}`;

            await minioClient.putObject(
              MINIO_BUCKET_NAME,
              fileKey,
              file.buffer,
              file.size,
              { "Content-Type": file.mimetype },
            );
            videoUrl = `${MINIO_PUBLIC_URL}/${MINIO_BUCKET_NAME}/${fileKey}`;
          }
        }
      }

      if ((!text || !text.trim()) && imageUrls.length === 0 && !videoUrl) {
        return res.status(400).json({ message: "Пост не может быть пустым." });
      }

      const post = await prisma.feedPost.create({
        data: {
          performerId: profile.id,
          text: text || "",
          imageUrls: imageUrls,
          videoUrl: videoUrl,
          isPublic: true,
        },
      });

      res.status(201).json(post);
    } catch (error) {
      console.error("Feed Post Create Error:", error);
      res.status(500).json({ message: "Ошибка при создании поста." });
    }
  },
);

// 2. Delete Post -> [DELETE] /api/feeds/:performerId/posts/:postId
router.delete("/:performerId/posts/:postId", verifyAuth, async (req, res) => {
  try {
    const { performerId, postId } = req.params;

    if (req.user.id !== performerId)
      return res.status(403).json({ message: "Доступ запрещен" });

    const post = await prisma.feedPost.findUnique({
      where: { id: postId },
      include: { performer: true },
    });

    if (!post) return res.status(404).json({ message: "Пост не найден" });
    if (post.performer.userId !== req.user.id)
      return res.status(403).json({ message: "Доступ запрещен" });

    await prisma.feedPost.delete({ where: { id: postId } });

    if (post.imageUrls)
      for (const url of post.imageUrls) await safeDeleteMinioFile(url);
    if (post.videoUrl) await safeDeleteMinioFile(post.videoUrl);

    res.status(200).json({ message: "Пост удален" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка удаления поста" });
  }
});

// 3. Toggle Visibility -> [PATCH] /api/feeds/:performerId/posts/:postId/visibility
router.patch(
  "/:performerId/posts/:postId/visibility",
  verifyAuth,
  async (req, res) => {
    try {
      const { performerId, postId } = req.params;
      if (req.user.id !== performerId)
        return res.status(403).json({ message: "Доступ запрещен" });

      const post = await prisma.feedPost.findUnique({ where: { id: postId } });
      if (!post) return res.status(404).json({ message: "Пост не найден" });

      const updated = await prisma.feedPost.update({
        where: { id: postId },
        data: { isPublic: !post.isPublic },
      });

      res.status(200).json(updated);
    } catch (error) {
      res.status(500).json({ message: "Ошибка обновления видимости" });
    }
  },
);

// ==========================================
// --- LIKES & COMMENTS ---
// ==========================================

// 4. Toggle Like -> [POST] /api/feeds/posts/:postId/like
router.post("/posts/:postId/like", verifyAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    const existingLike = await prisma.feedPostLike.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    if (existingLike) {
      await prisma.feedPostLike.delete({ where: { id: existingLike.id } });
      return res.status(200).json({ message: "Лайк удален" });
    } else {
      await prisma.feedPostLike.create({ data: { postId, userId } });
      return res.status(200).json({ message: "Лайк добавлен" });
    }
  } catch (error) {
    res.status(500).json({ message: "Ошибка лайка" });
  }
});

// 5. Add Comment -> [POST] /api/feeds/posts/:postId/comments
router.post("/posts/:postId/comments", verifyAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    const userId = req.user.id;

    if (!text || !text.trim())
      return res.status(400).json({ message: "Пустой комментарий" });

    const comment = await prisma.feedPostComment.create({
      data: { postId, userId, text },
      include: { user: { select: { id: true, name: true, image: true } } },
    });

    res.status(201).json(comment);
  } catch (error) {
    res.status(500).json({ message: "Ошибка комментария" });
  }
});

// 6. Edit Comment -> [PATCH] /api/feeds/comments/:commentId
router.patch("/comments/:commentId", verifyAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { text } = req.body;

    if (!text || !text.trim())
      return res.status(400).json({ message: "Пустой комментарий" });

    const existing = await prisma.feedPostComment.findUnique({
      where: { id: commentId },
    });
    if (!existing)
      return res.status(404).json({ message: "Комментарий не найден" });
    if (existing.userId !== req.user.id)
      return res.status(403).json({ message: "Нет прав" });

    const updated = await prisma.feedPostComment.update({
      where: { id: commentId },
      data: { text },
      include: { user: { select: { id: true, name: true, image: true } } },
    });

    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: "Ошибка редактирования" });
  }
});

// 7. Delete Comment -> [DELETE] /api/feeds/comments/:commentId
router.delete("/comments/:commentId", verifyAuth, async (req, res) => {
  try {
    const { commentId } = req.params;

    const existing = await prisma.feedPostComment.findUnique({
      where: { id: commentId },
      include: { post: { include: { performer: true } } },
    });

    if (!existing)
      return res.status(404).json({ message: "Комментарий не найден" });

    const isCommentAuthor = existing.userId === req.user.id;
    const isPostOwner = existing.post.performer.userId === req.user.id;

    if (!isCommentAuthor && !isPostOwner)
      return res.status(403).json({ message: "Нет прав" });

    await prisma.feedPostComment.delete({ where: { id: commentId } });

    res.status(200).json({ message: "Комментарий удален" });
  } catch (error) {
    res.status(500).json({ message: "Ошибка удаления" });
  }
});

// Handle Multer Errors
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `Ошибка загрузки: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ message: err.message });
  }
  next();
});

export default router;
