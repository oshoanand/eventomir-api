import prisma from "../libs/prisma.js";
import { fetchCached } from "../libs/redis.js";

export const searchPerformers = async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 12,
      category,
      city,
      priceMin,
      priceMax,
      onlyVip,
      accountType,
    } = req.query;

    const sortedQuery = Object.keys(req.query)
      .sort()
      .reduce((acc, key) => {
        acc[key] = req.query[key];
        return acc;
      }, {});

    const cacheParams = new URLSearchParams(sortedQuery).toString() || "all";

    const dbQuery = async () => {
      // 🚨 FIX: Used camelCase for Prisma client and uppercase for Enum
      const where = {
        moderationStatus: "APPROVED",
      };

      if (category && category !== "_all_") {
        where.roles = { has: category };
      }

      if (city && city.length > 1) {
        where.city = { equals: city, mode: "insensitive" };
      }

      if (accountType && accountType !== "all") {
        // 🚨 FIX: Changed from account_type to accountType
        where.accountType = accountType;
      }

      if (onlyVip === "true") {
        // VIP logic mapped through user's active subscription
        where.user = {
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
          // 🚨 FIX: Changed from price_range to priceRange
          if (!p.priceRange || p.priceRange.length === 0) return false;
          const minP = p.priceRange[0];
          const maxP = p.priceRange[1] || p.priceRange[0];

          if (priceMin && maxP < parseInt(priceMin)) return false;
          if (priceMax && minP > parseInt(priceMax)) return false;
          return true;
        });
      }

      // Map to Frontend format exactly as it was before
      const formattedItems = filteredProfiles.map((p) => ({
        id: p.user.id, // Base User ID for routing
        name: p.user.name,
        city: p.city,
        profilePicture: p.user.image,
        roles: p.roles || [],
        // 🚨 FIX: Changed from price_range to priceRange
        priceRange: p.priceRange || [],
        description: p.description,
        isVip:
          p.user.subscriptions?.some((sub) => sub.plan.tier === "PREMIUM") ||
          false,
        parentAgencyName: null, // Update this if Agency implementation is fully fleshed out
      }));

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
};
