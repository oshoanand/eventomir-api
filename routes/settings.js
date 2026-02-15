import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";

const router = Router();
const jobProofUpload = createUploader("proof");

// --- CONSTANTS ---
const SETTINGS_ID = "general_settings";
const PRICING_ID = "pricing_config";

// --- DEFAULTS ---
// Default structure to ensure frontend doesn't break on fresh DB
const defaultSettings = {
  siteName: "My Awesome Site",
  logoUrl: "",
  logoAltText: "",
  faviconUrl: "",
  fontFamily: "Inter, sans-serif",
  contacts: { email: "", phone: "", vkLink: "", telegramLink: "" },
  theme: {
    backgroundColor: "#ffffff",
    primaryColor: "#000000",
    accentColor: "#3b82f6",
  },
  siteCategories: [],
  pageSpecificSEO: [],
};

const defaultPricing = {
  plans: [], // Populate with your default plans if needed
  paidRequestPrice: 0,
};

// --- ROUTES ---

/**
 * GET /api/settings/general
 * Retrieve general site settings
 */
router.get("/general", async (req, res, next) => {
  try {
    let settings = await prisma.siteSettings.findUnique({
      where: { id: SETTINGS_ID },
    });

    if (!settings) {
      // Create default if not exists
      settings = await prisma.siteSettings.create({
        data: {
          id: SETTINGS_ID,
          settings_data: defaultSettings,
        },
      });
    }

    // Merge with defaults to ensure all keys exist (in case DB has partial data)
    res.json({ ...defaultSettings, ...settings.settings_data });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/settings/general
 * Update specific fields in general settings
 */
router.put("/general", async (req, res, next) => {
  try {
    const updates = req.body;

    // Fetch existing data first
    const existing = await prisma.siteSettings.findUnique({
      where: { id: SETTINGS_ID },
    });

    const currentData = existing?.settings_data || defaultSettings;

    // Merge updates into current data
    const newData = { ...currentData, ...updates };

    const updated = await prisma.siteSettings.upsert({
      where: { id: SETTINGS_ID },
      update: { settings_data: newData },
      create: { id: SETTINGS_ID, settings_data: newData },
    });

    res.json(updated.settings_data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/settings/pricing
 * Retrieve pricing configuration
 */
router.get("/pricing", async (req, res, next) => {
  try {
    let pricing = await prisma.pricingConfig.findUnique({
      where: { id: PRICING_ID },
    });

    if (!pricing) {
      pricing = await prisma.pricingConfig.create({
        data: {
          id: PRICING_ID,
          config_data: defaultPricing,
        },
      });
    }

    res.json({ ...defaultPricing, ...pricing.config_data });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/settings/pricing
 * Update pricing configuration
 */
router.put("/pricing", async (req, res, next) => {
  try {
    const updates = req.body; // Expecting full config object usually, or partial

    // If you want to merge carefully like above, do fetch-merge-update.
    // If frontend sends the WHOLE object every time, you can just overwrite.
    // We will do fetch-merge for safety.

    const existing = await prisma.pricingConfig.findUnique({
      where: { id: PRICING_ID },
    });
    const currentData = existing?.config_data || defaultPricing;
    const newData = { ...currentData, ...updates };

    const updated = await prisma.pricingConfig.upsert({
      where: { id: PRICING_ID },
      update: { config_data: newData },
      create: { id: PRICING_ID, config_data: newData },
    });

    res.json(updated.config_data);
  } catch (error) {
    next(error);
  }
});

router.post("/upload", jobProofUpload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Construct public URL
    // NOTE: In production, change 'localhost:5000' to your actual domain or use env var
    const baseUrl = process.env.API_BASE_URL || "http://localhost:5000";
    const fileUrl = `${baseUrl}/uploads/${req.file.filename}`;

    res.json({ url: fileUrl });
  } catch (error) {
    res.status(500).json({ error: "Upload failed", details: error.message });
  }
});

export default router;
