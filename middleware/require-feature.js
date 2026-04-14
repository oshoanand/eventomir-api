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
  if (sub && sub.isActive && sub.plan) {
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
    const rawFeatures = sub.plan.features;
    const normalizedFeatures = {};

    // 🚨 ROBUST FIX: Extract the actual 'value' from the new rich JSON objects
    if (typeof rawFeatures === "object" && rawFeatures !== null) {
      for (const [key, data] of Object.entries(rawFeatures)) {
        // Check if the feature is saved as the new rich object format { key, label, type, value }
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          data.value !== undefined
        ) {
          normalizedFeatures[key] = data.value;
        } else {
          // Fallback for legacy flat data (e.g., maxPhotoUpload: 10)
          normalizedFeatures[key] = data;
        }
      }
    }

    // Merge normalized plan features with defaults to fill any missing gaps
    return { ...DEFAULT_FREE_FEATURES, ...normalizedFeatures };
  }

  // Fallback if user has no subscription or it was set to inactive
  return DEFAULT_FREE_FEATURES;
};

// The Middleware Generator
export const requireFeature = (featureKey, getUsageCount = null) => {
  return async (req, res, next) => {
    try {
      // Ensure req.user exists (Safety check)
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Не авторизован." });
      }

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
              "Эта функция недоступна на вашем текущем тарифе. Пожалуйста, улучшите тариф.",
          });
        }

        // If we provided a callback to check the database for their current usage count
        if (getUsageCount) {
          const currentUsage = await getUsageCount(req.user.id);

          if (currentUsage >= limit) {
            return res.status(403).json({
              error: `Достигнут лимит (${limit}). Пожалуйста, улучшите тариф для расширения лимита.`,
            });
          }
        }

        return next();
      }

      // If it passes all checks (or is a string-based feature), allow the user to proceed
      next();
    } catch (error) {
      console.error("[Feature Guard Error]:", error);
      res.status(500).json({ error: "Ошибка проверки прав доступа." });
    }
  };
};
