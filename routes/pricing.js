import { Router } from "express";
import prisma from "../libs/prisma.js";

const router = Router();

const CONFIG_ID = "pricing_config";

router.get("/seed", async (req, res) => {
  // Define the config object
  const initialConfig = {
    plans: [
      {
        id: "econom",
        name: "Эконом",
        description: "Базовый бесплатный тариф для старта.",
        price: { monthly: 0, halfYearly: 0, yearly: 0 },
        features: [
          "1 роль в профиле",
          "До 3 работ в галерее",
          "До 3 фото в каждой работе",
        ],
      },
      {
        id: "standard",
        name: "Стандарт",
        description: "Больше возможностей для вашего профиля.",
        price: { monthly: 1500, halfYearly: 7200, yearly: 12000 },
        features: [
          "До 3 ролей в профиле",
          "До 6 работ в галерее",
          "SEO-настройки для профиля",
        ],
      },
      {
        id: "premium",
        name: "Премиум",
        description: "Максимум функций для продвижения.",
        price: { monthly: 3000, halfYearly: 15000, yearly: 25000 },
        features: [
          "Неограниченное кол-во ролей",
          "До 15 работ в галерее",
          "SEO-настройки",
        ],
      },
    ],
    paidRequestPrice: 490,
  };

  try {
    const result = await prisma.pricingConfig.upsert({
      where: { id: "pricing_config" },
      // FIX HERE: Force update if it already exists
      update: {
        config_data: initialConfig,
      },
      create: {
        id: "pricing_config",
        config_data: initialConfig,
      },
    });

    console.log("Database seeded:", result);
    return res
      .status(200)
      .json({ message: "seeding successful", data: result });
  } catch (error) {
    console.error("Seeding error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/pricing - Get all plans
router.get("/", async (req, res) => {
  try {
    const config = await prisma.pricingConfig.findUnique({
      where: { id: CONFIG_ID },
    });

    if (!config) {
      return res.status(404).json({ error: "Configuration not found" });
    }

    res.json(config.config_data);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/pricing - Update plans (Admin only)
router.put("/", async (req, res) => {
  try {
    const newConfigData = req.body; // Expects FullPriceConfig object

    const updated = await prisma.pricingConfig.upsert({
      where: { id: CONFIG_ID },
      update: { config_data: newConfigData },
      create: { id: CONFIG_ID, config_data: newConfigData },
    });

    res.json(updated.config_data);
  } catch (error) {
    console.error("Error updating pricing:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
