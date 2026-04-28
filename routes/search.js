import express from "express";
import prisma from "../libs/prisma.js";
import { fetchCached } from "../libs/redis.js";

const router = express.Router();

/**
 * Formats a user string for PostgreSQL Full Text Search (GIN).
 * Prevents DB crashes by stripping invalid TSVector characters,
 * removes stop words, and formats for prefix OR matching.
 */
const formatFtsQuery = (query) => {
  if (!query) return undefined;

  const sanitized = query
    .trim()
    .replace(/[^a-zA-Zа-яА-Я0-9\s\-]+/g, " ") // Keep letters, numbers, and hyphens
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) return undefined;

  // Remove common Russian stop words so they don't corrupt the search
  const stopWords = new Set([
    "в",
    "во",
    "на",
    "для",
    "с",
    "и",
    "или",
    "по",
    "к",
    "до",
    "от",
    "за",
    "о",
    "об",
  ]);

  const words = sanitized
    .split(" ")
    .filter((w) => !stopWords.has(w.toLowerCase()) && w.length > 1);

  if (words.length === 0) return undefined;

  // Join words with '|' (OR) and add ':*' for prefix matching
  // Example: "свадебная фотосъемка" -> "свадебная:* | фотосъемка:*"
  return words.map((w) => `${w}:*`).join(" | ");
};

router.get("/performers", async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 12,
      category,
      subCategories,
      city,
      priceMin,
      priceMax,
      onlyVip,
      accountType,
      query: textQuery,
    } = req.query;

    // 1. Create a Deterministic Cache Key (Alphabetical sort ignores param order)
    const sortedQuery = Object.keys(req.query)
      .sort()
      .reduce((acc, key) => {
        if (req.query[key]) acc[key] = req.query[key];
        return acc;
      }, {});

    const cacheParams = new URLSearchParams(sortedQuery).toString() || "all";

    // 2. The Database Query Callback
    const dbQuery = async () => {
      const where = {
        moderationStatus: "APPROVED",
      };

      // --- FILTERS ---

      // Category & Subcategory Filter (Native GIN Array intersection)
      const roleFilters = [];
      if (category && category !== "_all_") roleFilters.push(category);
      if (subCategories) roleFilters.push(...subCategories.split(","));

      if (roleFilters.length > 0) {
        where.roles = { hasSome: roleFilters };
      }

      // City Filter (Postgres GIN Trigram Search)
      if (city && city.length > 1) {
        const formattedCity = formatFtsQuery(city);
        if (formattedCity) {
          where.city = { search: formattedCity };
        }
      }

      // Account Type Filter
      if (accountType && accountType !== "all") {
        where.accountType = accountType;
      }

      // Global Text Search (Search across Name, Description, and Company Name using GIN)
      if (textQuery && textQuery.length > 1) {
        const formattedQuery = formatFtsQuery(textQuery);
        if (formattedQuery) {
          where.OR = [
            { user: { name: { search: formattedQuery } } },
            { description: { search: formattedQuery } },
            { companyName: { search: formattedQuery } },
          ];
        }
      }

      // VIP Filter
      if (onlyVip === "true") {
        where.user = {
          ...where.user, // Important: Preserve existing user filters (like Name search)
          subscriptions: {
            some: {
              plan: { tier: "PREMIUM" },
              status: "ACTIVE",
            },
          },
        };
      }

      // --- PAGINATION ---
      const skip = (parseInt(page) - 1) * parseInt(pageSize);
      const take = parseInt(pageSize);

      // --- EXECUTE TRANSACTIONS IN PARALLEL ---
      const [profiles, total] = await prisma.$transaction([
        prisma.performerProfile.findMany({
          where,
          skip,
          take,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                image: true,
                subscriptions: {
                  where: { status: "ACTIVE" },
                  include: { plan: true },
                },
              },
            },
            reviewsReceived: { select: { rating: true } },
          },
          orderBy: {
            user: { createdAt: "desc" },
          },
        }),
        prisma.performerProfile.count({ where }),
      ]);

      // --- POST-PROCESS: PRICE FILTERING ---
      // We do this in-memory because Prisma doesn't perfectly support range checks inside Int[] columns yet
      let filteredProfiles = profiles;
      if (priceMin || priceMax) {
        filteredProfiles = profiles.filter((p) => {
          if (!p.priceRange || p.priceRange.length === 0) return false;

          const minP = p.priceRange[0];
          const maxP = p.priceRange[1] || p.priceRange[0];

          if (priceMin && maxP < parseInt(priceMin)) return false;
          if (priceMax && minP > parseInt(priceMax)) return false;

          return true;
        });
      }

      // --- MAP TO FRONTEND DTO ---
      const formattedItems = filteredProfiles.map((p) => {
        // Calculate average rating safely
        const totalRating =
          p.reviewsReceived?.reduce((sum, r) => sum + r.rating, 0) || 0;
        const avgRating =
          p.reviewsReceived?.length > 0
            ? totalRating / p.reviewsReceived.length
            : null;

        return {
          id: p.user.id, // Base User ID for routing and Chat
          name: p.user.name,
          city: p.city,
          profilePicture: p.user.image,
          backgroundPicture: p.backgroundPicture,
          socialLinks: p.socialLinks || {},
          averageRating: avgRating,
          moderationStatus: p.moderationStatus,
          roles: p.roles || [],
          priceRange: p.priceRange || [],
          description: p.description,
          isVip:
            p.user.subscriptions?.some((sub) => sub.plan.tier === "PREMIUM") ||
            false,
          parentAgencyName: p.parentAgencyName || null,
        };
      });

      // Recalculate total if we filtered by price in-memory
      const finalTotal = priceMin || priceMax ? filteredProfiles.length : total;

      return {
        items: formattedItems,
        total: finalTotal,
        page: parseInt(page),
        pageSize: take,
      };
    };

    // 3. Execute via Redis Cache Layer (300 seconds = 5 mins TTL)
    // If Redis is offline, the fetchCached utility safely executes dbQuery() directly
    const result = await fetchCached(
      "search:performers",
      cacheParams,
      dbQuery,
      300,
    );

    return res.status(200).json(result);
  } catch (error) {
    console.error("Search Error:", error);
    return res
      .status(500)
      .json({ message: "Internal server error during search" });
  }
});

export default router;
