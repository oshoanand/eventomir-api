// import { Router } from "express";
// import prisma from "../libs/prisma.js";
// import { verifyAuth } from "../middleware/verify-auth.js"; // Ensure only admins can post
// // Use your existing multer uploader logic if you want image uploads in the editor
// // For simplicity, this example assumes mediaUrl is passed as a string or handled separately

// const router = Router();

// // GET /api/articles (Public List)
// router.get("/", async (req, res) => {
//   try {
//     const articles = await prisma.article.findMany({
//       where: { isActive: true }, // Only show published
//       orderBy: { createdAt: "desc" },
//     });
//     res.json(articles);
//   } catch (error) {
//     res.status(500).json({ message: "Failed to fetch articles" });
//   }
// });

// // GET /api/articles/:slug (Public Single)
// router.get("/:slug", async (req, res) => {
//   try {
//     const article = await prisma.article.findUnique({
//       where: { slug: req.params.slug },
//     });
//     if (!article || !article.isActive)
//       return res.status(404).json({ message: "Not found" });
//     res.json(article);
//   } catch (error) {
//     res.status(500).json({ message: "Error fetching article" });
//   }
// });

// // --- ADMIN ROUTES ---

// // POST /api/articles (Create)
// router.post("/", verifyAuth, async (req, res) => {
//   try {
//     // Check admin role here if needed: if (req.user.role !== 'admin') ...
//     const {
//       title,
//       content,
//       slug,
//       mediaUrl,
//       mediaType,
//       isActive,
//       metaTitle,
//       metaDescription,
//     } = req.body;

//     const newArticle = await prisma.article.create({
//       data: {
//         title,
//         content,
//         slug, // ideally generate slug from title if missing
//         mediaUrl,
//         mediaType,
//         isActive,
//         metaTitle,
//         metaDescription,
//       },
//     });
//     res.json(newArticle);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ message: "Failed to create article" });
//   }
// });

// // PATCH /api/articles/:id (Update)
// router.patch("/:id", verifyAuth, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const data = req.body;
//     const updated = await prisma.article.update({
//       where: { id },
//       data,
//     });
//     res.json(updated);
//   } catch (error) {
//     res.status(500).json({ message: "Failed to update article" });
//   }
// });

// // DELETE /api/articles/:id
// router.delete("/:id", verifyAuth, async (req, res) => {
//   try {
//     await prisma.article.delete({ where: { id: req.params.id } });
//     res.json({ message: "Deleted" });
//   } catch (error) {
//     res.status(500).json({ message: "Failed to delete" });
//   }
// });

// // --- ADMIN SPECIFIC ROUTES ---

// // GET /api/articles/admin/all - Fetch ALL articles (Drafts + Published)
// router.get("/admin/all", verifyAuth, async (req, res) => {
//   try {
//     const articles = await prisma.article.findMany({
//       orderBy: { createdAt: "desc" },
//     });
//     res.json(articles);
//   } catch (error) {
//     res.status(500).json({ message: "Failed to fetch admin articles" });
//   }
// });

// // GET /api/articles/admin/:id - Fetch single article by ID for editing
// router.get("/admin/:id", verifyAuth, async (req, res) => {
//   try {
//     const article = await prisma.article.findUnique({
//       where: { id: req.params.id },
//     });
//     if (!article) return res.status(404).json({ message: "Article not found" });
//     res.json(article);
//   } catch (error) {
//     res.status(500).json({ message: "Failed to fetch article" });
//   }
// });

// // ... existing POST, PATCH, DELETE routes

// export default router;

import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { fetchCached, invalidatePattern } from "../libs/redis.js";
import { createUploader } from "../utils/multer.js";

const router = Router();
// Initialize Multer for the 'articles' subfolder
const upload = createUploader("articles");

// ==========================================
// 1. ADMIN SPECIFIC ROUTES (Must be top!)
// ==========================================

// Middleware to ensure user is admin (Optional but highly recommended)
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === "administrator") {
    next();
  } else {
    res.status(403).json({ message: "Forbidden: Admins only" });
  }
};

// GET /api/articles/admin/all - Fetch ALL articles (Drafts + Published)
router.get("/admin/all", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const articles = await prisma.article.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch admin articles" });
  }
});

// GET /api/articles/admin/comments - Fetch pending comments for moderation
router.get("/admin/comments", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const comments = await prisma.articleComment.findMany({
      where: { status: status },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, profile_picture: true } },
        article: { select: { title: true, slug: true } },
      },
    });
    res.json(comments);
  } catch (error) {
    console.error("Failed to fetch comments:", error);
    res.status(500).json({ message: "Failed to fetch comments" });
  }
});

// PATCH /api/articles/admin/comments/:commentId - Approve or Reject a comment
router.patch(
  "/admin/comments/:commentId",
  verifyAuth,
  requireAdmin,
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
router.get("/admin/:id", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
    });
    if (!article) return res.status(404).json({ message: "Article not found" });
    res.json(article);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch article" });
  }
});

// ==========================================
// 2. PUBLIC LIST & SINGLE ARTICLE
// ==========================================

// GET /api/articles (Public List)
router.get("/", async (req, res) => {
  try {
    const dbQuery = async () => {
      return await prisma.article.findMany({
        where: { isActive: true }, // Only show published
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
router.get("/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const userId = req.query.userId; // Optional, to check if current user liked it

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
              user: { select: { id: true, name: true, profile_picture: true } },
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
  requireAdmin,
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

      // Handle Image URL
      let media_url = req.body.media_url || null;
      if (req.file) {
        // Create relative URL assuming your express app serves '/uploads' statically
        media_url = `/uploads/articles/${req.file.filename}`;
      }

      // Auto-generate slug if not provided
      const generatedSlug =
        slug ||
        title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now();

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
  requireAdmin,
  upload.single("media"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      if (updateData.isActive !== undefined) {
        updateData.isActive = updateData.isActive === "true";
      }

      if (req.file) {
        updateData.media_url = `/uploads/articles/${req.file.filename}`;
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
router.delete("/:id", verifyAuth, requireAdmin, async (req, res) => {
  try {
    await prisma.article.delete({ where: { id: req.params.id } });

    await invalidatePattern("articles:*"); // Clear cache
    res.json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete" });
  }
});

export default router;
