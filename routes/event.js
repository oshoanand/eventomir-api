import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached, invalidateKeys } from "../libs/redis.js";
import { initTinkoffEventTicketPayment } from "../utils/tinkoff.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";
import "dotenv/config";

const router = Router();
const eventImageUploader = createUploader(5);

// ==========================================
// 1. STATIC & LIST ROUTES
// ==========================================

router.get("/hosts/list", async (req, res) => {
  try {
    const dbQuery = async () => {
      // 🚨 FIX: Fetch PerformerProfiles to get the correct host IDs
      const profiles = await prisma.performerProfile.findMany({
        include: {
          user: { select: { name: true, email: true } },
        },
      });
      return profiles
        .map((p) => ({
          id: p.id, // This is the PerformerProfile ID required for Event.hostId
          name: p.user.name,
          email: p.user.email,
        }))
        .sort((a, b) => a.name?.localeCompare(b.name));
    };

    const hosts = await fetchCached("hosts", "all", dbQuery, 3600);
    res.json(hosts);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch hosts" });
  }
});

router.get("/hosted", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 🚨 FIX: Get the PerformerProfile ID
    const profile = await prisma.performerProfile.findUnique({
      where: { userId: userId },
    });

    if (!profile) return res.status(200).json([]);

    const events = await prisma.event.findMany({
      where: { hostId: profile.id }, // Use Profile ID
      orderBy: { date: "desc" },
    });
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch hosted events" });
  }
});

router.post(
  "/upload",
  verifyAuth,
  eventImageUploader.single("image"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "No image uploaded." });

      const fullUrl = await optimizeAndUpload(
        req.file,
        "events",
        req.user.id,
        1920, // High quality for event banners
      );
      res.status(200).json({ url: fullUrl });
    } catch (error) {
      res.status(500).json({ message: "Image upload failed." });
    }
  },
);

// ==========================================
// 2. CHECK-IN (QR Code Scanner Endpoint)
// ==========================================
router.post("/checkin", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { ticketToken, eventId } = req.body;

    if (!ticketToken || !eventId) {
      return res
        .status(400)
        .json({ message: "Не указан токен билета или ID события." });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Событие не найдено." });

    // 🚨 FIX: Verify Host Authorization via PerformerProfile
    let isAuthorized = req.user.role === "administrator";
    if (!isAuthorized) {
      const profile = await prisma.performerProfile.findUnique({
        where: { userId },
      });
      if (profile && event.hostId === profile.id) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res
        .status(403)
        .json({
          message: "У вас нет прав для проверки билетов этого события.",
        });
    }

    // 1. CHECK INVITATIONS (Free RSVPs)
    const invitation = await prisma.invitation.findUnique({
      where: { ticketToken: ticketToken },
    });

    if (invitation) {
      if (invitation.eventId !== eventId)
        return res
          .status(400)
          .json({ message: "Этот билет от другого мероприятия!" });
      if (invitation.status !== "ACCEPTED")
        return res
          .status(400)
          .json({ message: "Гость не подтвердил участие (Ожидание/Отказ)." });
      if (invitation.isCheckedIn) {
        const time = invitation.checkInTime
          ? invitation.checkInTime.toLocaleTimeString("ru-RU")
          : "ранее";
        return res.status(400).json({ message: `Гость уже вошел в ${time}` });
      }

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { isCheckedIn: true, checkInTime: new Date() },
      });

      if (typeof invalidateKeys === "function")
        await invalidateKeys([`events:${eventId}:attendees`]);

      return res.json({
        isValid: true,
        guestName: invitation.guestName,
        message: "Вход разрешен!",
      });
    }

    // 2. CHECK ORDERS (Paid Tickets)
    const order = await prisma.order.findUnique({
      where: { ticketCode: ticketToken },
      include: { user: { select: { name: true } } },
    });

    if (order) {
      if (order.eventId !== eventId)
        return res
          .status(400)
          .json({ message: "Этот билет от другого мероприятия!" });
      if (order.status !== "ACTIVE" && order.status !== "PAYMENT_SUCCESS") {
        return res
          .status(400)
          .json({ message: "Билет не оплачен или был отменен." });
      }
      if (order.isUsed) {
        const time = order.enteredAt
          ? order.enteredAt.toLocaleTimeString("ru-RU")
          : "ранее";
        return res
          .status(400)
          .json({ message: `Билет уже был использован в ${time}` });
      }

      await prisma.order.update({
        where: { id: order.id },
        data: { isUsed: true, enteredAt: new Date() },
      });

      if (typeof invalidateKeys === "function")
        await invalidateKeys([`events:${eventId}:attendees`]);

      return res.json({
        isValid: true,
        guestName: order.user?.name || "Гость",
        message: "Вход разрешен!",
      });
    }

    return res
      .status(404)
      .json({
        message: "Билет с таким QR-кодом не найден в базе этого события.",
      });
  } catch (error) {
    console.error("Check-in Scanner Error:", error);
    res
      .status(500)
      .json({ message: "Внутренняя ошибка сервера при сканировании билета." });
  }
});

// ==========================================
// 3. DYNAMIC ID ROUTES (Public)
// ==========================================

router.get("/", async (req, res) => {
  try {
    const dbQuery = async () => {
      const events = await prisma.event.findMany({
        where: { status: "active", type: "PUBLIC", paymentType: "PAID" },
        orderBy: { date: "asc" },
        include: {
          host: {
            include: {
              user: { select: { id: true, name: true, image: true } },
            },
          },
        },
      });

      // Flatten host data for frontend compatibility
      return events.map((e) => ({
        ...e,
        host: e.host
          ? {
              id: e.host.id, // Profile ID
              userId: e.host.user.id, // Base User ID
              name: e.host.user.name,
              profile_picture: e.host.user.image, // Mapped to new image field
            }
          : null,
      }));
    };

    const events = await fetchCached("events", "all", dbQuery);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const dbQuery = async () => {
      const event = await prisma.event.findUnique({
        where: { id: req.params.id },
        include: {
          host: {
            include: {
              user: { select: { id: true, name: true, image: true } },
            },
          },
        },
      });

      if (!event) return null;

      // Flatten host data
      return {
        ...event,
        host: event.host
          ? {
              id: event.host.id,
              userId: event.host.user.id,
              name: event.host.user.name,
              profile_picture: event.host.user.image,
            }
          : null,
      };
    };

    const event = await fetchCached("events", req.params.id, dbQuery);
    if (!event) return res.status(404).json({ message: "Event not found" });

    res.json(event);
  } catch (error) {
    res.status(500).json({ message: "Error fetching event" });
  }
});

// ==========================================
// 4. TICKETING & RSVP
// ==========================================

router.post("/:id/purchase", verifyAuth, async (req, res) => {
  const eventId = req.params.id;
  const ticketCount = parseInt(req.body.ticketCount);
  const userId = req.user.id;

  if (isNaN(ticketCount) || ticketCount <= 0) {
    return res
      .status(400)
      .json({ message: "Укажите корректное количество билетов" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Look up user's performer profile to prevent self-purchasing
    const profile = await prisma.performerProfile.findUnique({
      where: { userId },
    });

    const result = await prisma.$transaction(async (tx) => {
      const targetEvent = await tx.event.findUnique({ where: { id: eventId } });

      if (!targetEvent) throw new Error("EVENT_NOT_FOUND");
      if (targetEvent.status !== "active") throw new Error("EVENT_NOT_ACTIVE");
      if (targetEvent.paymentType === "FREE") throw new Error("EVENT_IS_FREE");
      if (targetEvent.availableTickets < ticketCount)
        throw new Error("NOT_ENOUGH_TICKETS");

      // 🚨 FIX: Prevent buying own tickets by checking PerformerProfile ID
      if (profile && targetEvent.hostId === profile.id)
        throw new Error("OWN_EVENT_PURCHASE");

      const effectivePrice =
        targetEvent.discountPrice && targetEvent.discountPrice > 0
          ? targetEvent.discountPrice
          : targetEvent.price;

      const totalPrice = effectivePrice * ticketCount;

      await tx.event.update({
        where: { id: eventId },
        data: { availableTickets: { decrement: ticketCount } },
      });

      const newOrder = await tx.order.create({
        data: { eventId, userId, ticketCount, totalPrice, status: "INITIATED" },
      });

      const newPayment = await tx.payment.create({
        data: {
          userId,
          amount: totalPrice,
          provider: "tinkoff",
          status: "PENDING",
          metadata: { type: "EVENT_TICKET", orderId: newOrder.id, eventId },
        },
      });

      return { newOrder, targetEvent, newPayment };
    });

    try {
      const paymentData = await initTinkoffEventTicketPayment(
        result.newOrder,
        result.targetEvent,
        user.email,
      );
      const tinkoffTxId = String(paymentData.paymentId);

      await prisma.$transaction([
        prisma.order.update({
          where: { id: result.newOrder.id },
          data: { paymentId: tinkoffTxId },
        }),
        prisma.payment.update({
          where: { id: result.newPayment.id },
          data: { providerTxId: tinkoffTxId },
        }),
      ]);

      if (typeof invalidateKeys === "function") {
        await invalidateKeys(["events:all", `events:${eventId}`, "orders:my"]);
      }

      return res.json({ paymentUrl: paymentData.paymentUrl });
    } catch (apiError) {
      console.error("Tinkoff API Error, manual rollback...", apiError);
      await prisma.$transaction([
        prisma.event.update({
          where: { id: eventId },
          data: { availableTickets: { increment: ticketCount } },
        }),
        prisma.order.update({
          where: { id: result.newOrder.id },
          data: { status: "PAYMENT_FAILED" },
        }),
        prisma.payment.update({
          where: { id: result.newPayment.id },
          data: { status: "FAILED" },
        }),
      ]);
      return res
        .status(502)
        .json({
          message: "Сервис оплаты временно недоступен. Попробуйте позже.",
        });
    }
  } catch (error) {
    const errorMap = {
      EVENT_NOT_FOUND: "Событие не найдено",
      EVENT_NOT_ACTIVE: "Мероприятие более не доступно",
      EVENT_IS_FREE: "Это мероприятие бесплатное, используйте RSVP",
      NOT_ENOUGH_TICKETS: "Недостаточно свободных билетов",
      OWN_EVENT_PURCHASE: "Нельзя купить билет на собственное событие",
    };
    res
      .status(400)
      .json({ message: errorMap[error.message] || "Ошибка создания заказа" });
  }
});

router.post("/:id/rsvp", async (req, res) => {
  try {
    const eventId = req.params.id;
    const { guestName, guestEmail, guestPhone, status } = req.body;

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Event not found" });

    const existingInvitation = await prisma.invitation.findUnique({
      where: { eventId_guestEmail: { eventId, guestEmail } },
    });

    if (
      status === "ACCEPTED" &&
      (!existingInvitation || existingInvitation.status !== "ACCEPTED")
    ) {
      if (event.availableTickets <= 0)
        return res.status(400).json({ message: "Мест больше нет" });
      await prisma.event.update({
        where: { id: eventId },
        data: { availableTickets: { decrement: 1 } },
      });
    }

    const invitation = await prisma.invitation.upsert({
      where: { eventId_guestEmail: { eventId, guestEmail } },
      update: { guestName, guestPhone, status },
      create: { eventId, guestName, guestEmail, guestPhone, status },
    });

    await invalidateKeys([
      "events:all",
      `events:${eventId}`,
      `events:${eventId}:attendees`,
    ]);
    res.json({ ticketToken: invitation.ticketToken, message: "RSVP принят" });
  } catch (error) {
    res.status(500).json({ message: "RSVP failed" });
  }
});

// ==========================================
// 5. EVENT CRUD OPERATIONS
// ==========================================

router.get("/:id/attendees", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.id;

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Событие не найдено" });

    // 🚨 FIX: Check against PerformerProfile ID
    let isAuthorized = req.user.role === "administrator";
    if (!isAuthorized) {
      const profile = await prisma.performerProfile.findUnique({
        where: { userId },
      });
      if (profile && event.hostId === profile.id) isAuthorized = true;
    }

    if (!isAuthorized)
      return res
        .status(403)
        .json({ message: "Нет прав для просмотра списка гостей" });

    const [invitations, orders] = await Promise.all([
      prisma.invitation.findMany({
        where: { eventId: eventId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.findMany({
        where: {
          eventId: eventId,
          status: { in: ["ACTIVE", "PAYMENT_SUCCESS"] },
        },
        include: { user: { select: { name: true, email: true, phone: true } } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const attendees = [
      ...invitations.map((inv) => ({
        id: inv.id,
        eventId: inv.eventId,
        guestName: inv.guestName || "Гость",
        guestEmail: inv.guestEmail,
        guestPhone: inv.guestPhone || null,
        status: inv.status,
        ticketToken: inv.ticketToken,
        isCheckedIn: inv.isCheckedIn,
        checkInTime: inv.checkInTime,
        createdAt: inv.createdAt,
      })),
      ...orders.map((ord) => ({
        id: ord.id,
        eventId: ord.eventId,
        guestName: ord.user?.name || "Гость",
        guestEmail: ord.user?.email || "Нет email",
        guestPhone: ord.user?.phone || null,
        status: "ACCEPTED",
        ticketToken: ord.ticketCode,
        isCheckedIn: ord.isUsed,
        checkInTime: ord.enteredAt,
        createdAt: ord.createdAt,
      })),
    ];

    attendees.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(attendees);
  } catch (error) {
    console.error("Fetch Attendees Error:", error);
    res.status(500).json({ message: "Ошибка при загрузке списка гостей" });
  }
});

router.post("/", verifyAuth, async (req, res) => {
  try {
    const data = req.body;
    let hostProfileId = data.hostId;

    // 🚨 FIX: Resolve the PerformerProfile ID for the creator
    if (req.user.role !== "administrator" || !hostProfileId) {
      const profile = await prisma.performerProfile.findUnique({
        where: { userId: req.user.id },
      });
      if (!profile)
        return res
          .status(403)
          .json({ message: "Только исполнители могут создавать события." });
      hostProfileId = profile.id;
    }

    const newEvent = await prisma.event.create({
      data: {
        ...data,
        price: parseFloat(data.price) || 0,
        discountPrice: parseFloat(data.discountPrice) || 0,
        totalTickets: parseInt(data.totalTickets) || 0,
        availableTickets: parseInt(data.totalTickets) || 0,
        date: new Date(data.date),
        hostId: hostProfileId, // Now correctly using PerformerProfile.id
      },
    });

    await invalidateKeys(["events:all", "events:hosted"]);
    res.status(201).json(newEvent);
  } catch (error) {
    res.status(400).json({ message: "Invalid event data" });
  }
});

router.put("/:id", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const data = req.body;

    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!existingEvent)
      return res.status(404).json({ message: "Событие не найдено" });

    // 🚨 FIX: Authorize against PerformerProfile
    let isAuthorized = req.user.role === "administrator";
    if (!isAuthorized) {
      const profile = await prisma.performerProfile.findUnique({
        where: { userId: req.user.id },
      });
      if (profile && existingEvent.hostId === profile.id) isAuthorized = true;
    }

    if (!isAuthorized)
      return res.status(403).json({ message: "Нет прав для редактирования" });

    const updateData = { ...data };
    if (data.price !== undefined)
      updateData.price = parseFloat(data.price) || 0;
    if (data.discountPrice !== undefined)
      updateData.discountPrice = parseFloat(data.discountPrice) || 0;
    if (data.date !== undefined) updateData.date = new Date(data.date);

    if (data.totalTickets !== undefined) {
      const newTotal = parseInt(data.totalTickets) || 0;
      const difference = newTotal - existingEvent.totalTickets;
      updateData.totalTickets = newTotal;
      updateData.availableTickets = Math.max(
        0,
        existingEvent.availableTickets + difference,
      );
    }

    if (data.hostId && req.user.role !== "administrator")
      delete updateData.hostId;

    const updatedEvent = await prisma.event.update({
      where: { id: eventId },
      data: updateData,
    });

    await invalidateKeys(["events:all", `events:${eventId}`, "events:hosted"]);
    res.status(200).json(updatedEvent);
  } catch (error) {
    console.error("Update Event Error:", error);
    res.status(400).json({ message: "Ошибка при обновлении события" });
  }
});

router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;

    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!existingEvent)
      return res.status(404).json({ message: "Событие не найдено" });

    // 🚨 FIX: Authorize against PerformerProfile
    let isAuthorized = req.user.role === "administrator";
    if (!isAuthorized) {
      const profile = await prisma.performerProfile.findUnique({
        where: { userId: req.user.id },
      });
      if (profile && existingEvent.hostId === profile.id) isAuthorized = true;
    }

    if (!isAuthorized)
      return res.status(403).json({ message: "Нет прав для удаления" });

    if (req.user.role !== "administrator") {
      const soldTicketsCount = await prisma.order.count({
        where: {
          eventId: eventId,
          status: { in: ["ACTIVE", "PAYMENT_SUCCESS"] },
        },
      });

      if (soldTicketsCount > 0)
        return res
          .status(400)
          .json({
            message: "Нельзя удалить событие: уже есть купленные билеты.",
          });

      const rsvpCount = await prisma.invitation.count({
        where: { eventId: eventId, status: "ACCEPTED" },
      });

      if (rsvpCount > 0)
        return res
          .status(400)
          .json({
            message:
              "Нельзя удалить событие: уже есть зарегистрированные участники.",
          });

      if (new Date(existingEvent.date) < new Date()) {
        return res
          .status(400)
          .json({
            message:
              "Нельзя удалить прошедшее событие. Оно сохраняется для истории.",
          });
      }
    }

    await prisma.event.delete({ where: { id: eventId } });
    await invalidateKeys(["events:all", `events:${eventId}`, "events:hosted"]);

    res.status(200).json({ message: "Событие успешно удалено" });
  } catch (error) {
    console.error("Delete Event Error:", error);
    res.status(500).json({ message: "Ошибка при удалении события" });
  }
});

export default router;
