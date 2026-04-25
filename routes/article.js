import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth, verifyOptionalAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
import { fetchCached, invalidatePattern } from "../libs/redis.js";
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";

const router = Router();
// Use the memory-based uploader defined previously (max 5MB limit is good for articles)
const upload = createUploader(5);

// ==========================================
// 1. ADMIN SPECIFIC ROUTES (Must be top!)
// ==========================================

// GET /api/articles/admin/all - Fetch ALL articles (Drafts + Published)
router.get(
  "/admin/all",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const articles = await prisma.article.findMany({
        orderBy: { createdAt: "desc" },
      });
      res.json(articles);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch admin articles" });
    }
  },
);

// GET /api/articles/admin/comments - Fetch pending comments for moderation
router.get(
  "/admin/comments",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const status = req.query.status || "pending";
      const comments = await prisma.articleComment.findMany({
        where: { status: status },
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, image: true } },
          article: { select: { title: true, slug: true } },
        },
      });
      res.json(comments);
    } catch (error) {
      console.error("Failed to fetch comments:", error);
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  },
);

// PATCH /api/articles/admin/comments/:commentId - Approve or Reject a comment
router.patch(
  "/admin/comments/:commentId",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { status } = req.body; // "approved" or "rejected"

      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const updatedComment = await prisma.articleComment.update({
        where: { id: req.params.commentId },
        data: { status },
      });

      // Clear cache so the approved comment appears on the public article page immediately
      await invalidatePattern("articles:*");

      res.json(updatedComment);
    } catch (error) {
      res.status(500).json({ message: "Failed to update comment status" });
    }
  },
);

// GET /api/articles/admin/:id - Fetch single article by ID for editing
router.get(
  "/admin/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const article = await prisma.article.findUnique({
        where: { id: req.params.id },
      });
      if (!article)
        return res.status(404).json({ message: "Article not found" });
      res.json(article);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch article" });
    }
  },
);

// ==========================================
// 2. PUBLIC LIST & SINGLE ARTICLE
// ==========================================

// GET /api/articles (Public List)
router.get("/", async (req, res) => {
  try {
    const dbQuery = async () => {
      return await prisma.article.findMany({
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              likes: true,
              comments: { where: { status: "approved" } },
            },
          },
        },
      });
    };

    // Cache the public list
    const articles = await fetchCached("articles", "public:all", dbQuery, 3600);
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch articles" });
  }
});

// GET /api/articles/:slug (Public Single)
// Using verifyOptionalAuth so logged-in users get their like status, but guests can still read
router.get("/:slug", verifyOptionalAuth, async (req, res) => {
  try {
    const slug = req.params.slug;
    const userId = req.user?.id; // Available if verifyOptionalAuth parsed a valid token

    const dbQuery = async () => {
      return await prisma.article.findUnique({
        where: { slug: slug },
        include: {
          _count: { select: { likes: true } },
          // Only fetch APPROVED comments, sorted by oldest first to build a proper tree
          comments: {
            where: { status: "approved" },
            orderBy: { createdAt: "asc" },
            include: {
              user: { select: { id: true, name: true, image: true } },
            },
          },
        },
      });
    };

    // Cache the individual article data
    const article = await fetchCached(
      "articles",
      `slug:${slug}`,
      dbQuery,
      3600,
    );

    if (!article || !article.isActive) {
      return res.status(404).json({ message: "Article not found or inactive" });
    }

    // Check if the current user liked it (We don't cache this part as it's user-specific)
    let userHasLiked = false;
    if (userId) {
      const like = await prisma.articleLike.findUnique({
        where: { articleId_userId: { articleId: article.id, userId } },
      });
      userHasLiked = !!like;
    }

    res.json({ ...article, userHasLiked });
  } catch (error) {
    res.status(500).json({ message: "Error fetching article" });
  }
});

// ==========================================
// 3. USER ACTIONS (LIKES & COMMENTS)
// ==========================================

// POST /api/articles/:id/like (Requires Auth)
router.post("/:id/like", verifyAuth, async (req, res) => {
  try {
    const articleId = req.params.id;
    const userId = req.user.id;

    const existingLike = await prisma.articleLike.findUnique({
      where: { articleId_userId: { articleId, userId } },
    });

    if (existingLike) {
      await prisma.articleLike.delete({ where: { id: existingLike.id } });
    } else {
      await prisma.articleLike.create({ data: { articleId, userId } });
    }

    // Clear cache to update the total like count across the platform
    await invalidatePattern("articles:*");

    res.json({
      message: existingLike ? "Unliked" : "Liked",
      liked: !existingLike,
    });
  } catch (error) {
    res.status(500).json({ message: "Error toggling like" });
  }
});

// POST /api/articles/:id/comments (Requires Auth)
router.post("/:id/comments", verifyAuth, async (req, res) => {
  try {
    const articleId = req.params.id;
    const userId = req.user.id;
    const { content, parentId } = req.body;

    if (!content)
      return res.status(400).json({ message: "Content is required" });

    const comment = await prisma.articleComment.create({
      data: {
        content,
        articleId,
        userId,
        parentId: parentId || null,
        status: "pending", // Requires admin approval
      },
    });

    res
      .status(201)
      .json({ message: "Comment submitted for moderation", comment });
  } catch (error) {
    res.status(500).json({ message: "Error posting comment" });
  }
});

// ==========================================
// 4. ADMIN CRUD ROUTES
// ==========================================

// POST /api/articles (Create)
router.post(
  "/",
  verifyAuth,
  requireRole(["administrator"]),
  upload.single("media"),
  async (req, res) => {
    try {
      const {
        title,
        content,
        slug,
        media_type,
        meta_title,
        meta_description,
        keywords,
      } = req.body;

      // Convert string 'true'/'false' from FormData to boolean
      const isActive = req.body.isActive === "true";

      // Handle Image URL using MinIO processor
      let media_url = req.body.media_url || null;
      if (req.file) {
        media_url = await optimizeAndUpload(
          req.file,
          "articles",
          "admin", // Using a static ID for admin uploads
          1200, // Good width for article hero images
        );
      }

      // Auto-generate slug if not provided
      const generatedSlug =
        slug ||
        title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-") + "-" + Date.now();

      const newArticle = await prisma.article.create({
        data: {
          title,
          content,
          slug: generatedSlug,
          media_url,
          media_type,
          isActive,
          meta_title,
          meta_description,
          keywords,
          image_alt_text: title, // default alt text
        },
      });

      await invalidatePattern("articles:*"); // Clear cache
      res.status(201).json(newArticle);
    } catch (error) {
      console.error("Failed to create article:", error);
      res.status(500).json({ message: "Failed to create article" });
    }
  },
);

// PATCH /api/articles/:id (Update)
router.patch(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  upload.single("media"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      if (updateData.isActive !== undefined) {
        updateData.isActive = updateData.isActive === "true";
      }

      // Handle Image URL using MinIO processor
      if (req.file) {
        updateData.media_url = await optimizeAndUpload(
          req.file,
          "articles",
          "admin",
          1200,
        );
      }

      const updated = await prisma.article.update({
        where: { id },
        data: updateData,
      });

      await invalidatePattern("articles:*"); // Clear cache
      res.json(updated);
    } catch (error) {
      console.error("Update error:", error);
      res.status(500).json({ message: "Failed to update article" });
    }
  },
);

// DELETE /api/articles/:id
router.delete(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      await prisma.article.delete({ where: { id: req.params.id } });

      await invalidatePattern("articles:*"); // Clear cache
      res.json({ message: "Deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete" });
    }
  },
);

export default router;
