import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// GET /api/admin/plans - List all plans (including inactive)
router.get("/", verifyAuth, async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: { priceMonthly: "asc" },
    });
    res.json(plans);
  } catch (error) {
    console.error("Fetch Plans Error:", error);
    res.status(500).json({ message: "Failed to fetch plans" });
  }
});

// GET /api/admin/plans/:id - Get single plan
router.get("/:id", verifyAuth, async (req, res) => {
  try {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: req.params.id },
    });
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    res.json(plan);
  } catch (error) {
    console.error("Fetch Plan Error:", error);
    res.status(500).json({ message: "Failed to fetch plan" });
  }
});

// POST /api/admin/plans - Create plan
router.post("/", verifyAuth, async (req, res) => {
  try {
    const {
      name,
      description,
      tier,
      features,
      isActive,
      // Pricing fields
      priceMonthly,
      priceHalfYearly,
      priceYearly,
    } = req.body;

    // Basic validation
    if (!name || !tier || priceMonthly === undefined) {
      return res
        .status(400)
        .json({
          message: "Missing required fields (Name, Tier, Monthly Price)",
        });
    }

    const plan = await prisma.subscriptionPlan.create({
      data: {
        name,
        description: description || "",
        tier,
        features: features || [],
        isActive: isActive ?? true,
        // Parse prices to ensure they are numbers or null
        priceMonthly: Number(priceMonthly),
        priceHalfYearly: priceHalfYearly ? Number(priceHalfYearly) : null,
        priceYearly: priceYearly ? Number(priceYearly) : null,
      },
    });

    res.status(201).json(plan);
  } catch (error) {
    console.error("Create Plan Error:", error);
    // Check for unique constraint violation on 'tier'
    if (error.code === "P2002") {
      return res
        .status(409)
        .json({ message: "A plan with this tier already exists." });
    }
    res.status(500).json({ message: "Failed to create plan" });
  }
});

// PATCH /api/admin/plans/:id - Update plan
router.patch("/:id", verifyAuth, async (req, res) => {
  try {
    const {
      name,
      description,
      tier,
      features,
      isActive,
      // Pricing fields
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
        features,
        isActive,
        // Parse prices. Note: checking undefined allows partial updates if needed,
        // but typically a form sends all fields.
        priceMonthly:
          priceMonthly !== undefined ? Number(priceMonthly) : undefined,
        priceHalfYearly: priceHalfYearly ? Number(priceHalfYearly) : null,
        priceYearly: priceYearly ? Number(priceYearly) : null,
      },
    });

    res.json(plan);
  } catch (error) {
    console.error("Update Plan Error:", error);
    res.status(500).json({ message: "Failed to update plan" });
  }
});

// DELETE /api/admin/plans/:id - Delete plan
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    await prisma.subscriptionPlan.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete Plan Error:", error);
    // Likely failed due to foreign key constraints (existing subscriptions)
    res
      .status(500)
      .json({
        message:
          "Cannot delete plan. It might have active subscriptions associated with it.",
      });
  }
});

export default router;
