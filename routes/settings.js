import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";

const router = Router();

// Configure Multer for 'siteSettings' folder
const photoUploader = createUploader("sitesettings");

// --- CONSTANTS ---
const SETTINGS_ID = "general_settings";

const defaultSettings = {
  siteName: "Eventomir",
  logoUrl: "",
  logoAltText: "Eventomir Логотип",
  faviconUrl: "",
  fontFamily: "Arial, Helvetica, sans-serif",
  contacts: {
    email: "",
    phone: "",
    vkLink: "",
    telegramLink: "",
  },
  theme: {
    preset: "classic", // We will define "classic" in the frontend registry
    radius: "0.5rem", // Matches --radius: 0.5rem in globals.css
  },
  siteCategories: [],
  pageSpecificSEO: [],
};

// --- ROUTES ---
router.get("/general", async (req, res, next) => {
  try {
    let settings = await prisma.siteSettings.findUnique({
      where: { id: SETTINGS_ID },
    });

    if (!settings) {
      settings = await prisma.siteSettings.create({
        data: {
          id: SETTINGS_ID,
          siteName: defaultSettings.siteName,
          fontFamily: defaultSettings.fontFamily,
          theme: defaultSettings.theme,
          contacts: defaultSettings.contacts,
          siteCategories: defaultSettings.siteCategories,
          pageSpecificSEO: defaultSettings.pageSpecificSEO,
        },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    // Fallback: send defaults even if DB fails, so site doesn't crash
    res.json(defaultSettings);
  }
});

/**
 * PUT /api/settings/general
 * Update settings (partial update supported)
 */
router.put("/general", async (req, res, next) => {
  try {
    const updates = req.body;

    // We can pass the 'updates' object directly because the keys in your
    // frontend state (SiteSettings interface) match the Prisma model columns exactly.
    // Prisma will ignore undefined fields in the update object.

    const updated = await prisma.siteSettings.update({
      where: { id: SETTINGS_ID },
      data: {
        siteName: updates.siteName,
        logoUrl: updates.logoUrl,
        logoAltText: updates.logoAltText,
        faviconUrl: updates.faviconUrl,
        fontFamily: updates.fontFamily,
        contacts: updates.contacts, // JSON column
        theme: updates.theme, // JSON column
        siteCategories: updates.siteCategories, // JSON column
        pageSpecificSEO: updates.pageSpecificSEO, // JSON column
      },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/upload
 * Handle file uploads for Logo and Favicon
 */
router.post("/upload", photoUploader.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    // Construct the public URL (Assuming you serve 'uploads' folder statically)
    const fileUrl = `${process.env.API_BASE_URL || "http://localhost:8800"}/uploads/sitesettings/${req.file.filename}`;

    res.json({ url: fileUrl });
  } catch (error) {
    next(error);
  }
});

export default router;
