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

// --- 1. STATIC ROUTES (Must be above /:id) ---

router.get("/hosts/list", async (req, res) => {
  try {
    const dbQuery = () =>
      prisma.user.findMany({
        where: { role: { in: ["performer", "admin"] } },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      });

    const hosts = await fetchCached("hosts", "all", dbQuery, 3600);
    res.json(hosts);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch hosts" });
  }
});

router.get("/hosted", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const events = await prisma.event.findMany({
      where: { hostId: userId },
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
        1920,
      );
      res.status(200).json({ url: fullUrl });
    } catch (error) {
      res.status(500).json({ message: "Image upload failed." });
    }
  },
);

// --- 2. DYNAMIC ID ROUTES ---

router.get("/", async (req, res) => {
  try {
    const dbQuery = () =>
      prisma.event.findMany({
        where: { status: "active", type: "PUBLIC" },
        orderBy: { date: "asc" },
        include: {
          host: { select: { id: true, name: true, profile_picture: true } },
        },
      });
    const events = await fetchCached("events", "all", dbQuery);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const dbQuery = () =>
      prisma.event.findUnique({
        where: { id: req.params.id },
        include: {
          host: { select: { id: true, name: true, profile_picture: true } },
        },
      });
    const event = await fetchCached("events", req.params.id, dbQuery);
    if (!event) return res.status(404).json({ message: "Event not found" });
    res.json(event);
  } catch (error) {
    res.status(500).json({ message: "Error fetching event" });
  }
});

// --- 3. PURCHASE & RSVP (Crucial Fixes Here) ---

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

    // Step 1: Secure DB Transaction
    const result = await prisma.$transaction(async (tx) => {
      const targetEvent = await tx.event.findUnique({ where: { id: eventId } });

      if (!targetEvent) throw new Error("EVENT_NOT_FOUND");
      if (targetEvent.status !== "active") throw new Error("EVENT_NOT_ACTIVE");
      if (targetEvent.paymentType === "FREE") throw new Error("EVENT_IS_FREE"); // Prevent Tinkoff crash on 0 amount
      if (targetEvent.availableTickets < ticketCount)
        throw new Error("NOT_ENOUGH_TICKETS");
      if (targetEvent.hostId === userId) throw new Error("OWN_EVENT_PURCHASE");

      const totalPrice = targetEvent.price * ticketCount;

      // Reserve Inventory
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

    // Step 2: Tinkoff API Call (with Receipt data integration)
    try {
      const paymentData = await initTinkoffEventTicketPayment(
        result.newOrder,
        result.targetEvent,
        user.email,
      );

      // Update Tx IDs
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

      await invalidateKeys(["events:all", `events:${eventId}`, "orders:my"]);
      return res.json({ paymentUrl: paymentData.paymentUrl });
    } catch (apiError) {
      console.error("Tinkoff API Error, performing manual rollback...");
      // Critical: If Tinkoff fails, restore the tickets and mark failure
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

// RSVP and Organizers CRUD logic remained solid, just ensures invalidateKeys is awaited
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

router.post("/", verifyAuth, async (req, res) => {
  try {
    const data = req.body;
    const newEvent = await prisma.event.create({
      data: {
        ...data,
        price: parseFloat(data.price) || 0,
        discountPrice: parseFloat(data.discountPrice) || 0,
        totalTickets: parseInt(data.totalTickets) || 0,
        availableTickets: parseInt(data.totalTickets) || 0,
        date: new Date(data.date),
        hostId:
          req.user.role === "admin" && data.hostId ? data.hostId : req.user.id,
      },
    });
    await invalidateKeys(["events:all", "events:hosted"]);
    res.status(201).json(newEvent);
  } catch (error) {
    res.status(400).json({ message: "Invalid event data" });
  }
});

export default router;
