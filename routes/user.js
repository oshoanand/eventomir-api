import { Router } from "express";
import { fetchCached } from "../libs/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import prisma from "../libs/prisma.js";

const router = Router();

// ==========================================
// STATIC ROUTES
// ==========================================

// GET /api/users/me
router.get("/me", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        walletBalance: true,
        profile_picture: true,
        created_at: true,
      },
    });

    if (!user) {
      return res
        .status(404)
        .json({ message: "Пользователь не найден (User not found)" });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Get Me Error:", error);
    res
      .status(500)
      .json({ message: "Внутренняя ошибка сервера (Internal server error)" });
  }
});

// GET /api/users/customers
router.get("/customers", async (req, res) => {
  try {
    // 1. Get query params (default to Page 1, Limit 10)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    // 2. Construct Prisma "Where" Clause
    const baseWhere = { role: "customer" };

    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const whereClause = { AND: [baseWhere, searchWhere] };

    // 3. Create a unique cache key
    const cacheKey = `customers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    // 4. Use the generic caching function
    const result = await fetchCached("users", cacheKey, async () => {
      const [total, customers] = await prisma.$transaction([
        prisma.user.count({ where: whereClause }),
        prisma.user.findMany({
          where: whereClause,
          skip: skip,
          take: limit,
          orderBy: { created_at: "desc" },
        }),
      ]);

      return {
        data: customers,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    });

    // 5. Return response
    return res.status(200).json({
      data: result.data || [],
      meta: result.meta || { total: 0, page, limit, totalPages: 0 },
    });
  } catch (error) {
    console.error("Error fetching customers:", error.message);
    return res
      .status(500)
      .json({ message: "Server error while fetching customers" });
  }
});

// GET /api/users/performers
router.get("/performers", async (req, res) => {
  try {
    // 1. Get query params
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    // 2. Construct Prisma "Where" Clause
    const baseWhere = { role: "performer" };

    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const whereClause = { AND: [baseWhere, searchWhere] };

    // 3. Create a unique cache key
    const cacheKey = `performers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    // 4. Use the generic caching function
    const result = await fetchCached("users", cacheKey, async () => {
      const [total, performers] = await prisma.$transaction([
        prisma.user.count({ where: whereClause }),
        prisma.user.findMany({
          where: whereClause,
          skip: skip,
          take: limit,
          orderBy: { created_at: "desc" },
        }),
      ]);

      return {
        data: performers,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    });

    // 5. Return response
    return res.status(200).json({
      data: result.data || [],
      meta: result.meta || { total: 0, page, limit, totalPages: 0 },
    });
  } catch (error) {
    console.error("Error fetching performers:", error.message); // Fixed log message
    return res
      .status(500)
      .json({ message: "Server error while fetching performers" });
  }
});

// ==========================================
// PARAMETERIZED ROUTES (Favorites)
// ==========================================

// Middleware array to combine auth check + ownership check
const verifyUserOwnership = [
  verifyAuth,
  (req, res, next) => {
    // Ensure the :customerId in the URL matches the logged-in user's ID
    if (req.user.id !== req.params.customerId) {
      return res
        .status(403)
        .json({ message: "Forbidden: You can only access your own data." });
    }
    next();
  },
];

// GET /api/users/:customerId/favorites
router.get("/:customerId/favorites", verifyUserOwnership, async (req, res) => {
  const { customerId } = req.params;
  try {
    const user = await prisma.user.findUnique({
      where: { id: customerId },
      select: { favorite_performers: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json(user.favorite_performers || []);
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// POST /api/users/:customerId/favorites
router.post("/:customerId/favorites", verifyUserOwnership, async (req, res) => {
  const { customerId } = req.params;
  const { performer } = req.body;

  if (!performer || !performer.id) {
    return res
      .status(400)
      .json({ message: "Performer data is missing or invalid." });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: customerId },
      select: { favorite_performers: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const currentFavorites = user.favorite_performers || [];

    // Prevent duplicates
    if (currentFavorites.some((fav) => fav.id === performer.id)) {
      return res
        .status(200)
        .json({ message: "Performer is already in favorites." });
    }

    const updatedFavorites = [...currentFavorites, performer];

    await prisma.user.update({
      where: { id: customerId },
      data: { favorite_performers: updatedFavorites },
    });

    res.status(201).json({ message: "Added to favorites." });
  } catch (error) {
    console.error("Error adding to favorites:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// GET /api/users/:customerId/favorites/:performerId
router.get(
  "/:customerId/favorites/:performerId",
  verifyUserOwnership,
  async (req, res) => {
    const { customerId, performerId } = req.params;
    try {
      const user = await prisma.user.findUnique({
        where: { id: customerId },
        select: { favorite_performers: true },
      });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const currentFavorites = user.favorite_performers || [];
      const isFavorite = currentFavorites.some((fav) => fav.id === performerId);

      if (isFavorite) {
        res.status(200).json({ isFavorite: true });
      } else {
        res.status(404).json({ isFavorite: false });
      }
    } catch (error) {
      console.error("Error checking favorite status:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
);

// DELETE /api/users/:customerId/favorites/:performerId
router.delete(
  "/:customerId/favorites/:performerId",
  verifyUserOwnership,
  async (req, res) => {
    const { customerId, performerId } = req.params;

    try {
      const user = await prisma.user.findUnique({
        where: { id: customerId },
        select: { favorite_performers: true },
      });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const currentFavorites = user.favorite_performers || [];
      const updatedFavorites = currentFavorites.filter(
        (fav) => fav.id !== performerId,
      );

      await prisma.user.update({
        where: { id: customerId },
        data: { favorite_performers: updatedFavorites },
      });

      res.status(204).send();
    } catch (error) {
      console.error("Error removing from favorites:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
);

export default router;
