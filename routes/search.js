import express from "express";
import prisma from "../libs/prisma.js";
import { fetchCached } from "../libs/redis.js";

const router = express.Router();

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

    const sortedQuery = Object.keys(req.query)
      .sort()
      .reduce((acc, key) => {
        acc[key] = req.query[key];
        return acc;
      }, {});

    const cacheParams = new URLSearchParams(sortedQuery).toString() || "all";

    const dbQuery = async () => {
      const where = {
        moderationStatus: "APPROVED",
      };

      // 1. Roles Filtering (Category + SubCategories combined)
      const roleFilters = [];
      if (category && category !== "_all_") roleFilters.push(category);
      if (subCategories) roleFilters.push(...subCategories.split(","));

      if (roleFilters.length > 0) {
        // 🚨 FIX: Used hasSome to match any of the selected categories/subcategories
        where.roles = { hasSome: roleFilters };
      }

      // 2. City Filtering
      if (city && city.length > 1) {
        // 🚨 FIX: Changed 'equals' to 'contains' for better UX and partial matching
        where.city = { contains: city, mode: "insensitive" };
      }

      // 3. Account Type Filtering
      if (accountType && accountType !== "all") {
        where.accountType = accountType;
      }

      // 4. Global Text Search
      if (textQuery && textQuery.length > 1) {
        where.OR = [
          { user: { name: { contains: textQuery, mode: "insensitive" } } },
          { description: { contains: textQuery, mode: "insensitive" } },
          { companyName: { contains: textQuery, mode: "insensitive" } },
        ];
      }

      // 5. VIP Filtering
      if (onlyVip === "true") {
        where.user = {
          ...where.user, // Preserve existing user filters (like the text search above)
          subscriptions: {
            some: {
              plan: { tier: "PREMIUM" },
              status: "ACTIVE",
            },
          },
        };
      }

      const skip = (parseInt(page) - 1) * parseInt(pageSize);
      const take = parseInt(pageSize);

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
            // 🚨  Include reviews to calculate the average rating for the card stars
            reviewsReceived: { select: { rating: true } },
          },
          orderBy: {
            user: { createdAt: "desc" },
          },
        }),
        prisma.performerProfile.count({ where }),
      ]);

      // Post-process Price Filtering
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

      // Map to Frontend format exactly as expected by your new UI
      const formattedItems = filteredProfiles.map((p) => {
        // Calculate average rating safely
        const totalRating =
          p.reviewsReceived?.reduce((sum, r) => sum + r.rating, 0) || 0;
        const avgRating =
          p.reviewsReceived?.length > 0
            ? totalRating / p.reviewsReceived.length
            : null;

        return {
          id: p.user.id, // Base User ID for routing
          name: p.user.name,
          city: p.city,
          profilePicture: p.user.image,

          // 🚨 ADDED: Missing fields required by your newly enhanced frontend cards
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

      return {
        items: formattedItems,
        total: priceMin || priceMax ? filteredProfiles.length : total,
        page: parseInt(page),
        pageSize: take,
      };
    };

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
