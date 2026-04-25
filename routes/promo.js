import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js";
const router = express.Router();

// ==========================================
// 1. VALIDATE PROMO CODE (Public / Checkout)
// ==========================================
router.post("/validate", verifyAuth, async (req, res) => {
  try {
    const { code, planId, interval } = req.body;
    const userId = req.user.id; // From verifyAuth middleware

    if (!code || !planId || !interval) {
      return res
        .status(400)
        .json({ message: "Не переданы обязательные параметры" });
    }

    // 1. Find promo code and include the current user's usage if they exist
    const promo = await prisma.promoCode.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        usedByUsers: { where: { id: userId } },
      },
    });

    // 2. Authenticity & Validity Checks
    if (!promo || !promo.isActive) {
      return res
        .status(400)
        .json({ message: "Промокод не существует или отключен." });
    }
    if (promo.validUntil && new Date(promo.validUntil) < new Date()) {
      return res
        .status(400)
        .json({ message: "Срок действия промокода истек." });
    }
    if (promo.maxUses && promo.currentUses >= promo.maxUses) {
      return res
        .status(400)
        .json({ message: "Лимит использования промокода исчерпан." });
    }

    // Single Use Per User Constraint Check
    if (promo.isSingleUsePerUser && promo.usedByUsers.length > 0) {
      return res
        .status(400)
        .json({ message: "Вы уже использовали этот промокод ранее." });
    }

    // 3. Fetch the subscription plan to calculate the real discount
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) return res.status(404).json({ message: "Тариф не найден." });

    let basePrice = plan.priceMonthly;
    if (interval === "half_year" && plan.priceHalfYearly)
      basePrice = plan.priceHalfYearly;
    if (interval === "year" && plan.priceYearly) basePrice = plan.priceYearly;

    // 4. Minimum Order Amount Check
    if (promo.minOrderAmount && basePrice < promo.minOrderAmount) {
      return res.status(400).json({
        message: `Этот промокод действует только для заказов от ${promo.minOrderAmount} ₽.`,
      });
    }

    // 5. Calculate Discount
    let discountAmount = 0;
    if (promo.type === "PERCENTAGE") {
      discountAmount = (basePrice * promo.value) / 100;
      if (promo.maxDiscountAmount && discountAmount > promo.maxDiscountAmount) {
        discountAmount = promo.maxDiscountAmount;
      }
    } else if (promo.type === "FLAT") {
      discountAmount = promo.value;
    }

    discountAmount = Math.min(discountAmount, basePrice);
    const finalPrice = basePrice - discountAmount;

    // 6. Return calculated data
    res.status(200).json({
      valid: true,
      basePrice,
      discountAmount,
      finalPrice,
      type: promo.type,
      value: promo.value,
      code: promo.code,
    });
  } catch (error) {
    console.error("Promo validation error:", error);
    res
      .status(500)
      .json({ message: "Внутренняя ошибка сервера при проверке промокода." });
  }
});

// ==========================================
// 2. CREATE PROMO CODE (Admin)
// ==========================================
router.post(
  "/",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const {
        code,
        type,
        value,
        maxDiscountAmount,
        minOrderAmount,
        maxUses,
        validUntil,
        isSingleUsePerUser,
      } = req.body;

      if (!code || !type || value === undefined) {
        return res.status(400).json({
          message: "Не заполнены обязательные поля (code, type, value)",
        });
      }

      const existingCode = await prisma.promoCode.findUnique({
        where: { code: code.toUpperCase() },
      });

      if (existingCode) {
        return res
          .status(409)
          .json({ message: "Промокод с таким названием уже существует" });
      }

      // 🚨 FIX: Safer parsing to allow "0" values without resolving to null
      const newPromo = await prisma.promoCode.create({
        data: {
          code: code.toUpperCase(),
          type,
          value: parseFloat(value),
          maxDiscountAmount:
            maxDiscountAmount != null && maxDiscountAmount !== ""
              ? parseFloat(maxDiscountAmount)
              : null,
          minOrderAmount:
            minOrderAmount != null && minOrderAmount !== ""
              ? parseFloat(minOrderAmount)
              : null,
          maxUses: maxUses != null && maxUses !== "" ? parseInt(maxUses) : null,
          validUntil: validUntil ? new Date(validUntil) : null,
          isSingleUsePerUser: isSingleUsePerUser || false,
          isActive: true,
        },
      });

      res.status(201).json(newPromo);
    } catch (error) {
      console.error("Create Promo Error:", error);
      res.status(500).json({ message: "Ошибка при создании промокода" });
    }
  },
);

// ==========================================
// 3. GET ALL PROMO CODES (Admin)
// ==========================================
router.get(
  "/",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const promos = await prisma.promoCode.findMany({
        orderBy: { createdAt: "desc" },
      });
      res.status(200).json(promos);
    } catch (error) {
      console.error("Get Promos Error:", error);
      res
        .status(500)
        .json({ message: "Ошибка при получении списка промокодов" });
    }
  },
);

// ==========================================
// 4. GET SINGLE PROMO CODE (Admin)
// ==========================================
router.get(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const promo = await prisma.promoCode.findUnique({
        where: { id: req.params.id },
      });

      if (!promo)
        return res.status(404).json({ message: "Промокод не найден" });

      res.status(200).json(promo);
    } catch (error) {
      console.error("Get Single Promo Error:", error);
      res.status(500).json({ message: "Ошибка при получении промокода" });
    }
  },
);

// ==========================================
// 5. UPDATE PROMO CODE (Admin)
// ==========================================
router.patch(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const {
        code,
        type,
        value,
        maxDiscountAmount,
        minOrderAmount,
        maxUses,
        validUntil,
        isActive,
        isSingleUsePerUser,
      } = req.body;

      const promo = await prisma.promoCode.findUnique({
        where: { id: req.params.id },
      });

      if (!promo)
        return res.status(404).json({ message: "Промокод не найден" });

      // 🚨 FIX: Cleaned up the nested ternary parsing logic
      const updatedPromo = await prisma.promoCode.update({
        where: { id: req.params.id },
        data: {
          code: code ? code.toUpperCase() : undefined,
          type: type !== undefined ? type : undefined,
          value: value !== undefined ? parseFloat(value) : undefined,
          maxDiscountAmount:
            maxDiscountAmount !== undefined
              ? maxDiscountAmount === null || maxDiscountAmount === ""
                ? null
                : parseFloat(maxDiscountAmount)
              : undefined,
          minOrderAmount:
            minOrderAmount !== undefined
              ? minOrderAmount === null || minOrderAmount === ""
                ? null
                : parseFloat(minOrderAmount)
              : undefined,
          maxUses:
            maxUses !== undefined
              ? maxUses === null || maxUses === ""
                ? null
                : parseInt(maxUses)
              : undefined,
          validUntil:
            validUntil !== undefined
              ? validUntil
                ? new Date(validUntil)
                : null
              : undefined,
          isActive: isActive !== undefined ? isActive : undefined,
          isSingleUsePerUser:
            isSingleUsePerUser !== undefined ? isSingleUsePerUser : undefined,
        },
      });

      res.status(200).json(updatedPromo);
    } catch (error) {
      console.error("Update Promo Error:", error);
      if (error.code === "P2002") {
        return res
          .status(409)
          .json({ message: "Промокод с таким названием уже существует" });
      }
      res.status(500).json({ message: "Ошибка при обновлении промокода" });
    }
  },
);

// ==========================================
// 6. DELETE PROMO CODE (Admin)
// ==========================================
router.delete(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const promo = await prisma.promoCode.findUnique({
        where: { id: req.params.id },
      });

      if (!promo)
        return res.status(404).json({ message: "Промокод не найден" });

      await prisma.promoCode.delete({
        where: { id: req.params.id },
      });

      res.status(200).json({ message: "Промокод успешно удален" });
    } catch (error) {
      console.error("Delete Promo Error:", error);
      res.status(500).json({ message: "Ошибка при удалении промокода" });
    }
  },
);

export default router;
