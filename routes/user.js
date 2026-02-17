import { Router } from "express";
import { fetchCached, prisma } from "../middleware/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// Placeholder for auth middleware. In a real app, this would verify the user's
// session and ensure the :customerId in the URL matches the logged-in user's ID.
const verifyUserOwnership = (req, res, next) => {
  // Example logic:
  // if (req.user.id !== req.params.customerId) {
  //     return res.status(403).json({ message: "Forbidden" });
  // }
  next();
};

// GET /api/users/:customerId/favorites
// Retrieves the full list of favorite performers for a user.
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

    // The favorite_performers field is expected to be a JSON array.
    res.status(200).json(user.favorite_performers || []);
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// POST /api/users/:customerId/favorites
// Adds a new performer to the user's favorites list.
router.post("/:customerId/favorites", verifyUserOwnership, async (req, res) => {
  const { customerId } = req.params;
  const { performer } = req.body; // performer is the FavoritePerformer object

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
// Checks if a single performer is a favorite.
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
        // Send a 404 to align with the frontend's expectation
        res.status(404).json({ isFavorite: false });
      }
    } catch (error) {
      console.error("Error checking favorite status:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
);

// DELETE /api/users/:customerId/favorites/:performerId
// Removes a performer from the user's favorites list.
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

      res.status(204).send(); // Send 204 No Content for successful deletion
    } catch (error) {
      console.error("Error removing from favorites:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
);

router.get("/customers", async (req, res) => {
  try {
    // 1. Get query params (default to Page 1, Limit 10)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    // 2. Construct Prisma "Where" Clause
    // Base filter to only get users with the 'customer' role
    const baseWhere = { role: "customer" };

    // If search exists, add an OR condition across relevant fields
    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    // Combine base filter with search filter
    const whereClause = { AND: [baseWhere, searchWhere] };

    // 3. Create a unique cache key that includes pagination and search query
    // e.g., "customers_p1_l10_sJohnDoe"
    const cacheKey = `customers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    // 4. Use the generic caching function to fetch data
    const result = await fetchCached("users", cacheKey, async () => {
      // Run a transaction to get both total count and paginated data efficiently
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

    // 5. Always return a successful response with the correct data structure
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

router.get("/performers", async (req, res) => {
  try {
    // 1. Get query params (default to Page 1, Limit 10)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

    // 2. Construct Prisma "Where" Clause
    // Base filter to only get users with the 'customer' role
    const baseWhere = { role: "performer" };

    // If search exists, add an OR condition across relevant fields
    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { phone: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    // Combine base filter with search filter
    const whereClause = { AND: [baseWhere, searchWhere] };

    // 3. Create a unique cache key that includes pagination and search query
    // e.g., "customers_p1_l10_sJohnDoe"
    const cacheKey = `performers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    // 4. Use the generic caching function to fetch data
    const result = await fetchCached("users", cacheKey, async () => {
      // Run a transaction to get both total count and paginated data efficiently
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

    // 5. Always return a successful response with the correct data structure
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

router.get("/me/subscription", verifyAuth, async (req, res) => {
  try {
    // 1. Get User ID from the authenticated request (set by verifyAuth middleware)
    const userId = req.user.id;

    // 2. Fetch Subscription with Plan details
    const subscription = await prisma.userSubscription.findUnique({
      where: { userId },
      include: {
        plan: {
          select: {
            id: true,
            name: true,
            priceMonthly: true, // Use as fallback for price
          },
        },
      },
    });

    // 3. Handle No Subscription
    if (!subscription) {
      return res.status(404).json({ message: "No active subscription found" });
    }

    // 4. Determine Status Logic
    // Prisma stores boolean 'isActive', but frontend expects specific string status
    let status = "ACTIVE";
    const now = new Date();

    if (!subscription.isActive) {
      status = "CANCELLED";
    } else if (subscription.endDate && new Date(subscription.endDate) < now) {
      status = "EXPIRED";
    }

    // 5. Map to Frontend Interface
    const responseData = {
      id: subscription.id,
      planId: subscription.plan.id,
      planName: subscription.plan.name,
      status: status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      // You might want to fetch the actual last Payment amount here,
      // but plan price is a good default
      pricePaid: subscription.plan.priceMonthly,
    };

    res.json(responseData);
  } catch (error) {
    console.error("Get Current Subscription Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
