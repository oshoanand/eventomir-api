import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js"; // Ensure only admins can post
// Use your existing multer uploader logic if you want image uploads in the editor
// For simplicity, this example assumes mediaUrl is passed as a string or handled separately

const router = Router();

// GET /api/articles (Public List)
router.get("/", async (req, res) => {
  try {
    const articles = await prisma.article.findMany({
      where: { isActive: true }, // Only show published
      orderBy: { createdAt: "desc" },
    });
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch articles" });
  }
});

// GET /api/articles/:slug (Public Single)
router.get("/:slug", async (req, res) => {
  try {
    const article = await prisma.article.findUnique({
      where: { slug: req.params.slug },
    });
    if (!article || !article.isActive)
      return res.status(404).json({ message: "Not found" });
    res.json(article);
  } catch (error) {
    res.status(500).json({ message: "Error fetching article" });
  }
});

// --- ADMIN ROUTES ---

// POST /api/articles (Create)
router.post("/", verifyAuth, async (req, res) => {
  try {
    // Check admin role here if needed: if (req.user.role !== 'admin') ...
    const {
      title,
      content,
      slug,
      mediaUrl,
      mediaType,
      isActive,
      metaTitle,
      metaDescription,
    } = req.body;

    const newArticle = await prisma.article.create({
      data: {
        title,
        content,
        slug, // ideally generate slug from title if missing
        mediaUrl,
        mediaType,
        isActive,
        metaTitle,
        metaDescription,
      },
    });
    res.json(newArticle);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create article" });
  }
});

// PATCH /api/articles/:id (Update)
router.patch("/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    const updated = await prisma.article.update({
      where: { id },
      data,
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: "Failed to update article" });
  }
});

// DELETE /api/articles/:id
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    await prisma.article.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete" });
  }
});

// --- ADMIN SPECIFIC ROUTES ---

// GET /api/articles/admin/all - Fetch ALL articles (Drafts + Published)
router.get("/admin/all", verifyAuth, async (req, res) => {
  try {
    const articles = await prisma.article.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch admin articles" });
  }
});

// GET /api/articles/admin/:id - Fetch single article by ID for editing
router.get("/admin/:id", verifyAuth, async (req, res) => {
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

// ... existing POST, PATCH, DELETE routes

export default router;
