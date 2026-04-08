import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";

const router = Router();
const photoUploader = createUploader("sitesettings");
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
    res.json(defaultSettings);
  }
});

router.put("/general", async (req, res, next) => {
  try {
    const updates = req.body;
    console.log(updates);

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

    const updated = await prisma.siteSettings.update({
      where: { id: SETTINGS_ID },
      data: {
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
});

router.post("/upload", photoUploader.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    const fileUrl = `${process.env.API_BASE_URL || "http://localhost:8800"}/uploads/sitesettings/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (error) {
    next(error);
  }
});

export default router;
