import { Router } from "express";
import { fetchCached } from "../libs/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import prisma from "../libs/prisma.js";
import { requireRole } from "../middleware/role-check.js";

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
      include: {
        customerProfile: true,
        performerProfile: true,
        partnerProfile: true,
        adminProfile: true,
      },
    });

    if (!user) {
      return res
        .status(404)
        .json({ message: "Пользователь не найден (User not found)" });
    }

    const accountType = user.performerProfile?.accountType || null;

    res.status(200).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      accountType,
      walletBalance: user.walletBalance,
      image: user.image,
      createdAt: user.createdAt,
    });
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

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
    const cacheKey = `customers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    const result = await fetchCached("users", cacheKey, async () => {
      const [total, customers] = await prisma.$transaction([
        prisma.user.count({ where: whereClause }),
        prisma.user.findMany({
          where: whereClause,
          skip: skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            image: true,
            walletBalance: true,
            createdAt: true,
            customerProfile: {
              select: {
                city: true,
                moderationStatus: true,
              },
            },
          },
        }),
      ]);

      const flattenedCustomers = customers.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        image: c.image,
        walletBalance: c.walletBalance,
        createdAt: c.createdAt,
        city: c.customerProfile?.city || null,
        moderationStatus: c.customerProfile?.moderationStatus || "PENDING",
      }));

      return {
        data: flattenedCustomers,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    });

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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const skip = (page - 1) * limit;

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
    const cacheKey = `performers_p${page}_l${limit}_s${search.replace(/\s/g, "")}`;

    const result = await fetchCached("users", cacheKey, async () => {
      const [total, performers] = await prisma.$transaction([
        prisma.user.count({ where: whereClause }),
        prisma.user.findMany({
          where: whereClause,
          skip: skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            image: true,
            walletBalance: true,
            createdAt: true,
            performerProfile: {
              select: {
                city: true,
                roles: true,
                moderationStatus: true,
              },
            },
          },
        }),
      ]);

      const flattenedPerformers = performers.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        image: p.image,
        walletBalance: p.walletBalance,
        createdAt: p.createdAt,
        city: p.performerProfile?.city || null,
        roles: p.performerProfile?.roles || [],
        moderationStatus: p.performerProfile?.moderationStatus || "PENDING",
      }));

      return {
        data: flattenedPerformers,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    });

    return res.status(200).json({
      data: result.data || [],
      meta: result.meta || { total: 0, page, limit, totalPages: 0 },
    });
  } catch (error) {
    console.error("Error fetching performers:", error.message);
    return res
      .status(500)
      .json({ message: "Server error while fetching performers" });
  }
});

// ==========================================
// PARAMETERIZED ROUTES (Favorites)
// ==========================================

const verifyUserOwnership = [
  verifyAuth,
  (req, res, next) => {
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
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
    });

    if (!customerProfile) return res.status(200).json([]);

    const favorites = await prisma.favorite.findMany({
      where: { customer_id: customerProfile.id },
      include: {
        performer: {
          include: { user: { select: { id: true, name: true, image: true } } },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const formattedFavorites = favorites.map((fav) => ({
      id: fav.performer.user.id,
      name: fav.performer.user.name,
      image: fav.performer.user.image,
      roles: fav.performer.roles,
      city: fav.performer.city,
    }));

    res.status(200).json(formattedFavorites);
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
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: customerId },
    });

    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: performer.id },
    });

    if (!customerProfile || !performerProfile) {
      return res.status(404).json({ message: "Профиль не найден" });
    }

    await prisma.favorite.upsert({
      where: {
        customer_id_performer_id: {
          customer_id: customerProfile.id,
          performer_id: performerProfile.id,
        },
      },
      update: {},
      create: {
        customer_id: customerProfile.id,
        performer_id: performerProfile.id,
      },
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
      const customerProfile = await prisma.customerProfile.findUnique({
        where: { userId: customerId },
      });

      const performerProfile = await prisma.performerProfile.findUnique({
        where: { userId: performerId },
      });

      if (!customerProfile || !performerProfile) {
        return res.status(200).json({ isFavorite: false });
      }

      const favorite = await prisma.favorite.findUnique({
        where: {
          customer_id_performer_id: {
            customer_id: customerProfile.id,
            performer_id: performerProfile.id,
          },
        },
      });

      res.status(200).json({ isFavorite: !!favorite });
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
      const customerProfile = await prisma.customerProfile.findUnique({
        where: { userId: customerId },
      });

      const performerProfile = await prisma.performerProfile.findUnique({
        where: { userId: performerId },
      });

      if (!customerProfile || !performerProfile) {
        return res.status(404).json({ message: "Профиль не найден" });
      }

      await prisma.favorite.delete({
        where: {
          customer_id_performer_id: {
            customer_id: customerProfile.id,
            performer_id: performerProfile.id,
          },
        },
      });

      res.status(204).send();
    } catch (error) {
      console.error("Error removing from favorites:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
);

// =================================================================
//                 PERFORMER DETAILS ROUTE (ADMIN)
// =================================================================

router.get(
  "/performers/:id",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          performerProfile: {
            include: {
              galleryItems: { orderBy: { created_at: "desc" } },
              certificates: { orderBy: { created_at: "desc" } },
              recommendations: { orderBy: { created_at: "desc" } },
              bookingsReceived: {
                include: {
                  customer: { include: { user: true } },
                },
                orderBy: { createdAt: "desc" },
              },
              eventsHosted: { orderBy: { createdAt: "desc" } },
            },
          },
        },
      });

      if (!user || !user.performerProfile) {
        return res.status(404).json({ message: "Performer profile not found" });
      }

      const p = user.performerProfile;

      const mappedData = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        companyName: p.companyName,
        inn: p.inn,
        description: p.description,
        image: user.image,
        priceRange: p.priceRange || [],
        moderationStatus: p.moderationStatus,
        createdAt: user.createdAt,
        gallery: p.galleryItems.map((g) => ({
          id: g.id,
          title: g.title,
          imageUrls: g.image_urls,
          description: g.description,
          moderationStatus: g.moderation_status,
          createdAt: g.created_at,
        })),
        certificates: p.certificates.map((c) => ({
          id: c.id,
          fileUrl: c.file_url,
          description: c.description,
          moderationStatus: c.moderation_status,
          createdAt: c.created_at,
        })),
        recommendationLetters: p.recommendations.map((l) => ({
          id: l.id,
          fileUrl: l.file_url,
          description: l.description,
          moderationStatus: l.moderation_status,
          createdAt: l.created_at,
        })),
        bookings: p.bookingsReceived.map((b) => ({
          id: b.id,
          date: b.date,
          status: b.status,
          details: b.details,
          createdAt: b.createdAt,
          price: 0,
          customerName: b.customer.user.name || "Неизвестно",
          customerEmail: b.customer.user.email,
          customerPhone: b.customer.user.phone,
        })),
        events: p.eventsHosted.map((e) => ({
          id: e.id,
          title: e.title,
          date: e.date,
          status: e.status,
          city: e.city,
          price: e.price,
          imageUrl: e.imageUrl,
          createdAt: e.createdAt,
        })),
      };

      res.status(200).json(mappedData);
    } catch (error) {
      console.error("Error fetching admin performer details:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// =================================================================
//                 CUSTOMER DETAILS ROUTE (ADMIN)
// =================================================================

router.get(
  "/customers/:id",
  requireRole(["administrator", "support"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          customerProfile: {
            include: {
              bookings: {
                include: {
                  performer: { include: { user: true } },
                },
                orderBy: { createdAt: "desc" },
              },
              paidRequests: {
                orderBy: { createdAt: "desc" },
              },
            },
          },
        },
      });

      if (!user || !user.customerProfile) {
        return res.status(404).json({ message: "Customer profile not found" });
      }

      const c = user.customerProfile;
      const totalBookings = c.bookings.length;
      const confirmedBookings = c.bookings.filter((b) =>
        ["CONFIRMED", "COMPLETED", "FULFILLED"].includes(b.status),
      ).length;
      const totalPaidRequests = c.paidRequests.length;

      const mappedData = {
        id: user.id,
        name: user.name || "Unknown User",
        email: user.email,
        phone: user.phone,
        city: c.city,
        image: user.image,
        moderationStatus: c.moderationStatus,
        createdAt: user.createdAt,
        bookings: c.bookings.map((b) => ({
          id: b.id,
          date: b.date,
          status: b.status,
          details: b.details,
          price: 0,
          createdAt: b.createdAt,
          performerName: b.performer.user.name || "Неизвестный исполнитель",
          performerEmail: b.performer.user.email,
          performerPhone: b.performer.user.phone,
        })),
        paidRequests: c.paidRequests.map((pr) => ({
          id: pr.id,
          status: pr.status,
          category: pr.category,
          amount: parseInt(pr.budget) || 0,
          description: pr.serviceDescription,
          createdAt: pr.createdAt,
        })),
        stats: {
          totalBookings,
          confirmedBookings,
          totalPaidRequests,
        },
      };

      res.status(200).json(mappedData);
    } catch (error) {
      console.error("Error fetching admin customer details:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
);

// ==========================================
// GET BASIC USER INFO (For Chat Headers, etc.)
// GET /api/users/:id
// ==========================================
router.get("/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        image: true,
        role: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      id: user.id,
      name: user.name || "Пользователь",
      image: user.image || null,
      role: user.role,
    });
  } catch (error) {
    console.error("❌ Error fetching user info:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
