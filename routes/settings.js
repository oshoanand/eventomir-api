import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";

const router = Router();

// Memory uploader with a generous limit for site assets
const photoUploader = createUploader(10);
const SETTINGS_ID = "general_settings";

const defaultCategories = [
  {
    id: "cat_1",
    name: "Фотографы",
    icon: "Camera",
    link: "/search?category=Фотограф",
    subCategories: [],
  },
  {
    id: "cat_2",
    name: "Диджеи",
    icon: "Music",
    link: "/search?category=DJ",
    subCategories: [],
  },
  {
    id: "cat_3",
    name: "Ведущие",
    icon: "Mic",
    link: "/search?category=Ведущие",
    subCategories: [],
  },
  {
    id: "cat_4",
    name: "Артисты",
    icon: "MicVocal",
    link: "/search?category=Артисты",
    subCategories: [],
  },
  {
    id: "cat_5",
    name: "Агентства",
    icon: "Users",
    link: "/search?accountType=agency",
    subCategories: [],
  },
  {
    id: "cat_6",
    name: "Дизайнеры",
    icon: "Palette",
    link: "/search?category=Дизайнер",
    subCategories: [],
  },
  {
    id: "cat_7",
    name: "Видеографы",
    icon: "Film",
    link: "/search?category=Видеограф",
    subCategories: [],
  },
  {
    id: "cat_8",
    name: "Повара",
    icon: "ChefHat",
    link: "/search?category=Повар",
    subCategories: [],
  },
  {
    id: "cat_9",
    name: "Аниматоры",
    icon: "Smile",
    link: "/search?category=Аниматор",
    subCategories: [],
  },
  {
    id: "cat_10",
    name: "Рестораны",
    icon: "Utensils",
    link: "/search?category=Ресторан",
    subCategories: [],
  },
];

const defaultSettings = {
  siteName: "Eventomir",
  logoUrl: "",
  logoAltText: "Eventomir Логотип",
  faviconUrl: "",
  fontFamily: "Arial, Helvetica, sans-serif",
  contacts: { email: "", phone: "", vkLink: "", telegramLink: "" },
  theme: { preset: "zinc", radius: "0.5rem" },
  siteCategories: defaultCategories,
  pageSpecificSEO: [],
};

// ==========================================
// 1. GET PUBLIC SETTINGS
// ==========================================
router.get("/general", async (req, res, next) => {
  try {
    // 🚨 FIX: Atomic UPSERT prevents Race Condition (P2002 Error)
    // If the setting doesn't exist, it creates it. If it does, it returns it without updating.
    const settings = await prisma.siteSettings.upsert({
      where: { id: SETTINGS_ID },
      update: {}, // We don't want to update anything on a GET request if it already exists
      create: {
        id: SETTINGS_ID,
        siteName: defaultSettings.siteName,
        fontFamily: defaultSettings.fontFamily,
        theme: defaultSettings.theme,
        contacts: defaultSettings.contacts,
        siteCategories: defaultSettings.siteCategories,
        pageSpecificSEO: defaultSettings.pageSpecificSEO,
      },
    });

    res.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    // Graceful degradation: Send default settings if DB fails
    res.json(defaultSettings);
  }
});

// ==========================================
// 2. UPDATE SETTINGS (Administrator Only)
// ==========================================
router.put(
  "/general",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res, next) => {
    try {
      const updates = req.body;

      // --- ROBUSTNESS VALIDATION ---
      if (updates.siteCategories !== undefined) {
        if (!Array.isArray(updates.siteCategories)) {
          return res
            .status(400)
            .json({ message: "'siteCategories' must be an array." });
        }

        // Check main categories AND subCategories
        const isValid = updates.siteCategories.every(
          (cat) =>
            cat &&
            typeof cat === "object" &&
            cat.id &&
            cat.name &&
            cat.icon &&
            typeof cat.link === "string" &&
            // Validate subCategories if they exist
            (cat.subCategories === undefined ||
              (Array.isArray(cat.subCategories) &&
                cat.subCategories.every(
                  (sub) =>
                    sub &&
                    typeof sub === "object" &&
                    sub.id &&
                    sub.name &&
                    typeof sub.link === "string",
                ))),
        );

        if (!isValid) {
          return res.status(400).json({
            message:
              "Data corruption detected: Malformed category or subcategory data.",
          });
        }
      }

      // We use Upsert here as well, just in case the PUT request is the very first request
      const updated = await prisma.siteSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          siteName: updates.siteName || defaultSettings.siteName,
          logoUrl: updates.logoUrl || "",
          logoAltText: updates.logoAltText || defaultSettings.logoAltText,
          faviconUrl: updates.faviconUrl || "",
          fontFamily: updates.fontFamily || defaultSettings.fontFamily,
          contacts: updates.contacts || defaultSettings.contacts,
          theme: updates.theme || defaultSettings.theme,
          siteCategories:
            updates.siteCategories || defaultSettings.siteCategories,
          pageSpecificSEO:
            updates.pageSpecificSEO || defaultSettings.pageSpecificSEO,
        },
        update: {
          siteName: updates.siteName,
          logoUrl: updates.logoUrl,
          logoAltText: updates.logoAltText,
          faviconUrl: updates.faviconUrl,
          fontFamily: updates.fontFamily,
          contacts: updates.contacts,
          theme: updates.theme,
          siteCategories: updates.siteCategories,
          pageSpecificSEO: updates.pageSpecificSEO,
        },
      });

      res.json(updated);
    } catch (error) {
      console.error("Settings update error:", error);
      next(error);
    }
  },
);

// ==========================================
// 3. UPLOAD SITE ASSET (Administrator Only)
// ==========================================
router.post(
  "/upload",
  verifyAuth,
  requireRole(["administrator"]),
  photoUploader.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Process the file via MinIO Image Processor
      // 800px width is a solid balance for logos and general site assets
      const fileUrl = await optimizeAndUpload(
        req.file,
        "sitesettings",
        "assets",
        800,
      );

      res.json({ url: fileUrl });
    } catch (error) {
      console.error("Asset Upload Error:", error);
      res.status(500).json({ message: "Internal server error during upload." });
    }
  },
);

export default router;
