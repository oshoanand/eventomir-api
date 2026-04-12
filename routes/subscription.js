import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";

const router = Router();

// ==========================================
// GET /api/subscriptions - List all plans
// ==========================================
// Accessible by all authenticated users (so they can see pricing),
// but you could restrict this if it's strictly for the admin panel.
router.get("/", verifyAuth, async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: { priceMonthly: "asc" },
      include: {
        // Include the count of users subscribed to this plan for the Admin UI
        _count: {
          select: { subscriptions: true },
        },
      },
    });
    res.json(plans);
  } catch (error) {
    console.error("Fetch Plans Error:", error);
    res.status(500).json({ message: "Не удалось загрузить тарифные планы." });
  }
});

// ==========================================
// GET /api/subscriptions/:id - Get single plan
// ==========================================
router.get(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const plan = await prisma.subscriptionPlan.findUnique({
        where: { id: req.params.id },
      });

      if (!plan) {
        return res.status(404).json({ message: "Тарифный план не найден." });
      }

      res.json(plan);
    } catch (error) {
      console.error("Fetch Plan Error:", error);
      res.status(500).json({ message: "Ошибка при загрузке тарифа." });
    }
  },
);

// ==========================================
// POST /api/subscriptions - Create plan
// ==========================================
router.post(
  "/",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const {
        name,
        description,
        tier,
        features,
        isActive,
        priceMonthly,
        priceHalfYearly,
        priceYearly,
      } = req.body;

      // Basic validation
      if (!name || !tier || priceMonthly === undefined) {
        return res.status(400).json({
          message:
            "Отсутствуют обязательные поля (Название, Уровень, Цена за месяц).",
        });
      }

      // Ensure Tier is unique before attempting creation
      const existingTier = await prisma.subscriptionPlan.findUnique({
        where: { tier },
      });

      if (existingTier) {
        return res
          .status(409)
          .json({ message: `Тариф с уровнем ${tier} уже существует.` });
      }

      const plan = await prisma.subscriptionPlan.create({
        data: {
          name,
          description: description || "",
          tier,

          features:
            typeof features === "object" && features !== null ? features : {},
          isActive: isActive ?? true,
          priceMonthly: Number(priceMonthly),
          priceHalfYearly: priceHalfYearly ? Number(priceHalfYearly) : null,
          priceYearly: priceYearly ? Number(priceYearly) : null,
        },
      });

      res.status(201).json(plan);
    } catch (error) {
      console.error("Create Plan Error:", error);
      res.status(500).json({ message: "Не удалось создать тарифный план." });
    }
  },
);

// ==========================================
// PATCH /api/subscriptions/:id - Update plan
// ==========================================
router.patch(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const {
        name,
        description,
        tier,
        features,
        isActive,
        priceMonthly,
        priceHalfYearly,
        priceYearly,
      } = req.body;

      const plan = await prisma.subscriptionPlan.update({
        where: { id: req.params.id },
        data: {
          name,
          description,
          tier,
          // 🚨 FIX: Safely pass the JSON features object
          features: features !== undefined ? features : undefined,
          isActive,
          priceMonthly:
            priceMonthly !== undefined ? Number(priceMonthly) : undefined,
          priceHalfYearly: priceHalfYearly ? Number(priceHalfYearly) : null,
          priceYearly: priceYearly ? Number(priceYearly) : null,
        },
      });

      res.json(plan);
    } catch (error) {
      console.error("Update Plan Error:", error);

      // Check if they tried to update the tier to one that already exists
      if (error.code === "P2002") {
        return res
          .status(409)
          .json({ message: "Тариф с таким уровнем (Tier) уже существует." });
      }

      res.status(500).json({ message: "Не удалось обновить тарифный план." });
    }
  },
);

// ==========================================
// DELETE /api/subscriptions/:id - Delete plan
// ==========================================
router.delete(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // 🚨 ROBUST FIX: Check for active users before deleting
      const activeSubscribersCount = await prisma.userSubscription.count({
        where: { planId: id },
      });

      if (activeSubscribersCount > 0) {
        return res.status(400).json({
          message: `Невозможно удалить: к этому тарифу привязано ${activeSubscribersCount} пользователей. Пожалуйста, скройте (деактивируйте) его вместо удаления.`,
        });
      }

      // Safe to delete if 0 subscribers
      await prisma.subscriptionPlan.delete({
        where: { id },
      });

      res.json({ success: true, message: "Тариф успешно удален." });
    } catch (error) {
      console.error("Delete Plan Error:", error);
      res
        .status(500)
        .json({ message: "Произошла ошибка при удалении тарифа." });
    }
  },
);

export default router;
