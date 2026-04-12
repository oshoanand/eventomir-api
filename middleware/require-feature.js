import prisma from "../libs/prisma.js";

// Define the absolute baseline for a Free/Expired user
const DEFAULT_FREE_FEATURES = {
  maxPhotoUpload: 3,
  emailSupport: true,
  chatSupport: false,
  telephonicSupport: false,
  prioritySupport: false,
  profileSeo: false,
  profileMarketing: false,
  portfolioPromotion: false,
};

// Helper to get effective features
export const getEffectiveFeatures = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { subscription: { include: { plan: true } } },
  });

  const now = new Date();
  const sub = user?.subscription;

  // 🚨 STRICT EXPIRATION CHECK (Backend JIT Guard)
  if (sub && sub.isActive) {
    // If the user is on a paid plan with an expiration date that has ALREADY PASSED
    if (
      sub.plan.tier !== "FREE" &&
      sub.endDate &&
      new Date(sub.endDate) < now
    ) {
      console.warn(
        `[JIT Guard] User ${userId} subscription expired. Enforcing FREE limits.`,
      );
      return DEFAULT_FREE_FEATURES;
    }

    // They have a valid active subscription (either FREE, or an unexpired PAID plan)
    // Ensure we safely parse the JSON features object
    const planFeatures =
      typeof sub.plan.features === "object" && sub.plan.features !== null
        ? sub.plan.features
        : {};

    // Merge plan features with defaults in case a new feature was added to the DB later
    return { ...DEFAULT_FREE_FEATURES, ...planFeatures };
  }

  // Fallback if user has no subscription or it was set to inactive
  return DEFAULT_FREE_FEATURES;
};

// The Middleware Generator
export const requireFeature = (featureKey, getUsageCount = null) => {
  return async (req, res, next) => {
    try {
      const features = await getEffectiveFeatures(req.user.id);
      const limit = features[featureKey];

      // 🚨 SECURITY FIX: If the feature isn't defined in the matrix, block it securely by default
      if (limit === undefined || limit === null) {
        return res.status(403).json({
          error: "Эта функция недоступна или не настроена для вашего тарифа.",
        });
      }

      // 1. Boolean Feature Check
      if (typeof limit === "boolean") {
        if (!limit) {
          return res.status(403).json({
            error: "Для использования этой функции необходимо улучшить тариф.",
          });
        }
        return next();
      }

      // 2. Numeric Limit Check (e.g., maxPhotoUpload)
      if (typeof limit === "number") {
        // If they have 0 limit, reject immediately
        if (limit <= 0) {
          return res.status(403).json({
            error:
              "Вы исчерпали лимит для этой функции. Пожалуйста, улучшите тариф.",
          });
        }

        // If we provided a callback to check the database for their current usage count
        if (getUsageCount) {
          const currentUsage = await getUsageCount(req.user.id);
          if (currentUsage >= limit) {
            return res.status(403).json({
              error: `Достигнут лимит (${limit}). Пожалуйста, улучшите тариф.`,
            });
          }
        }

        return next();
      }

      // If it passes all checks, allow the user to proceed to the controller
      next();
    } catch (error) {
      console.error("[Feature Guard Error]:", error);
      res.status(500).json({ error: "Ошибка проверки прав доступа." });
    }
  };
};
