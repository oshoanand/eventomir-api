// import { Router } from "express";
// import prisma from "../libs/prisma.js";
// import { createUploader } from "../utils/multer.js";

// const router = Router();

// // Configure Multer for 'siteSettings' folder
// const photoUploader = createUploader("sitesettings");

// // --- CONSTANTS ---
// const SETTINGS_ID = "general_settings";

// const defaultSettings = {
//   siteName: "Eventomir",
//   logoUrl: "",
//   logoAltText: "Eventomir Логотип",
//   faviconUrl: "",
//   fontFamily: "Arial, Helvetica, sans-serif",
//   contacts: {
//     email: "",
//     phone: "",
//     vkLink: "",
//     telegramLink: "",
//   },
//   theme: {
//     preset: "classic", // We will define "classic" in the frontend registry
//     radius: "0.5rem", // Matches --radius: 0.5rem in globals.css
//   },
//   siteCategories: [],
//   pageSpecificSEO: [],
// };

// // --- ROUTES ---
// router.get("/general", async (req, res, next) => {
//   try {
//     let settings = await prisma.siteSettings.findUnique({
//       where: { id: SETTINGS_ID },
//     });

//     if (!settings) {
//       settings = await prisma.siteSettings.create({
//         data: {
//           id: SETTINGS_ID,
//           siteName: defaultSettings.siteName,
//           fontFamily: defaultSettings.fontFamily,
//           theme: defaultSettings.theme,
//           contacts: defaultSettings.contacts,
//           siteCategories: defaultSettings.siteCategories,
//           pageSpecificSEO: defaultSettings.pageSpecificSEO,
//         },
//       });
//     }

//     res.json(settings);
//   } catch (error) {
//     console.error("Error fetching settings:", error);
//     // Fallback: send defaults even if DB fails, so site doesn't crash
//     res.json(defaultSettings);
//   }
// });

// /**
//  * PUT /api/settings/general
//  * Update settings (partial update supported)
//  */
// router.put("/general", async (req, res, next) => {
//   try {
//     const updates = req.body;

//     // We can pass the 'updates' object directly because the keys in your
//     // frontend state (SiteSettings interface) match the Prisma model columns exactly.
//     // Prisma will ignore undefined fields in the update object.

//     const updated = await prisma.siteSettings.update({
//       where: { id: SETTINGS_ID },
//       data: {
//         siteName: updates.siteName,
//         logoUrl: updates.logoUrl,
//         logoAltText: updates.logoAltText,
//         faviconUrl: updates.faviconUrl,
//         fontFamily: updates.fontFamily,
//         contacts: updates.contacts, // JSON column
//         theme: updates.theme, // JSON column
//         siteCategories: updates.siteCategories, // JSON column
//         pageSpecificSEO: updates.pageSpecificSEO, // JSON column
//       },
//     });

//     res.json(updated);
//   } catch (error) {
//     next(error);
//   }
// });

// /**
//  * POST /api/settings/upload
//  * Handle file uploads for Logo and Favicon
//  */
// router.post("/upload", photoUploader.single("file"), (req, res, next) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({ message: "No file uploaded" });
//     }

//     // Construct the public URL (Assuming you serve 'uploads' folder statically)
//     const fileUrl = `${process.env.API_BASE_URL || "http://localhost:8800"}/uploads/sitesettings/${req.file.filename}`;

//     res.json({ url: fileUrl });
//   } catch (error) {
//     next(error);
//   }
// });

// export default router;

import { Router } from "express";
import prisma from "../libs/prisma.js";
import { createUploader } from "../utils/multer.js";

const router = Router();

// Configure Multer for 'siteSettings' folder
const photoUploader = createUploader("sitesettings");

// --- CONSTANTS ---
const SETTINGS_ID = "general_settings";

// 1. Define the default categories with 'link' and string-based 'icon' names
const defaultCategories = [
  {
    id: "cat_1",
    name: "Фотографы",
    icon: "Camera",
    link: "/search?category=Фотограф",
  },
  { id: "cat_2", name: "Диджеи", icon: "Music", link: "/search?category=DJ" },
  {
    id: "cat_3",
    name: "Ведущие",
    icon: "Mic",
    link: "/search?category=Ведущие",
  },
  {
    id: "cat_4",
    name: "Артисты",
    icon: "MicVocal",
    link: "/search?category=Артисты",
  },
  {
    id: "cat_5",
    name: "Агентства",
    icon: "Users",
    link: "/search?accountType=agency",
  },
  {
    id: "cat_6",
    name: "Дизайнеры",
    icon: "Palette",
    link: "/search?category=Дизайнер",
  },
  {
    id: "cat_7",
    name: "Видеографы",
    icon: "Film",
    link: "/search?category=Видеограф",
  },
  {
    id: "cat_8",
    name: "Повара",
    icon: "ChefHat",
    link: "/search?category=Повар",
  },
  {
    id: "cat_9",
    name: "Аниматоры",
    icon: "Smile",
    link: "/search?category=Аниматор",
  },
  {
    id: "cat_10",
    name: "Рестораны",
    icon: "Utensils",
    link: "/search?category=Ресторан",
  },
];

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
    preset: "zinc", // Updated default to match frontend presets
    radius: "0.5rem",
  },
  siteCategories: defaultCategories, // Injected the predefined categories here
  pageSpecificSEO: [],
};

// --- ROUTES ---

/**
 * GET /api/settings/general
 * Fetch settings or create defaults if they don't exist
 */
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
 * Update settings (partial update supported) with robust validation
 */
router.put("/general", async (req, res, next) => {
  try {
    const updates = req.body;

    // --- ROBUSTNESS VALIDATION ---
    // Prevent malformed data from corrupting the JSON column in the database
    if (updates.siteCategories !== undefined) {
      if (!Array.isArray(updates.siteCategories)) {
        return res
          .status(400)
          .json({ message: "'siteCategories' must be an array." });
      }

      // Validate every item in the array has the required shape
      const isValid = updates.siteCategories.every(
        (cat) =>
          cat &&
          typeof cat === "object" &&
          cat.id &&
          cat.name &&
          cat.icon &&
          typeof cat.link === "string", // Ensures link exists (even if empty string)
      );

      if (!isValid) {
        return res.status(400).json({
          message:
            "Data corruption detected: Each category must include an 'id', 'name', 'icon', and 'link'.",
        });
      }
    }

    // Prisma update: Prisma will intelligently ignore `undefined` fields
    // from the `updates` object and only update what is provided.
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
