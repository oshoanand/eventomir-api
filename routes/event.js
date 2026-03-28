import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached, invalidateKeys } from "../middleware/redis.js";
import { generateCustomOrderId } from "../utils/helper.js";
import { initTinkoffEventTicketPayment } from "../utils/tinkoff.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import "dotenv/config";

const router = Router();

// --- HELPER ROUTE FOR ADMIN DROPDOWN ---
// GET /api/events/hosts/list - Fetch users to assign as event hosts
router.get("/hosts/list", async (req, res, next) => {
  try {
    const dbQuery = () =>
      prisma.user.findMany({
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      });

    const hosts = await fetchCached("hosts", "all", dbQuery, 3600);
    res.json(hosts);
  } catch (error) {
    console.error("Failed to fetch hosts:", error);
    res.status(500).json({ message: "Failed to fetch hosts" });
  }
});

// --- PERFOMER SECURE ROUTE ---
// GET /api/events/hosted - Fetch events created by the logged-in performer
router.get("/hosted", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // IMPORTANT: Never cache this globally, it's specific to the logged-in user.
    const events = await prisma.event.findMany({
      where: { hostId: userId },
      orderBy: { date: "desc" },
    });

    res.json(events);
  } catch (error) {
    console.error("Error fetching hosted events:", error);
    res.status(500).json({ message: "Failed to fetch hosted events" });
  }
});

// --- PUBLIC ROUTES ---
// GET all events
router.get("/", async (req, res, next) => {
  try {
    const dbQuery = () =>
      prisma.event.findMany({
        orderBy: { date: "asc" },
        include: {
          host: {
            select: { id: true, name: true, email: true },
          },
        },
      });

    const events = await fetchCached("events", "all", dbQuery);
    res.json(events);
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

// GET single event by ID
router.get("/:id", async (req, res, next) => {
  try {
    const eventId = req.params.id;
    if (eventId === "hosted") return next(); // Prevent clash with /hosted route

    const dbQuery = () =>
      prisma.event.findUnique({
        where: { id: eventId },
        include: {
          host: {
            select: { id: true, name: true, email: true },
          },
        },
      });

    const event = await fetchCached("events", eventId, dbQuery);

    if (!event) return res.status(404).json({ message: "Event not found" });
    res.json(event);
  } catch (error) {
    next(error);
  }
});

// --- SECURE CRUD ROUTES ---
// POST new event (Secured with requireAuth to prevent assigning to others)
router.post("/", verifyAuth, async (req, res, next) => {
  try {
    const {
      title,
      category,
      price,
      date,
      time,
      city,
      address,
      imageUrl,
      description,
      totalTickets,
      availableTickets,
      status,
      // hostId // Ignore any hostId sent from the frontend client
    } = req.body;

    // Use the verified user ID from the auth token
    const verifiedHostId =
      req.user.role === "admin" && req.body.hostId
        ? req.body.hostId // Admin can assign to anyone
        : req.user.id; // Performer can only assign to themselves

    const newEvent = await prisma.event.create({
      data: {
        title,
        category,
        price: parseFloat(price) || 0,
        date: new Date(date),
        time: time || null,
        city,
        address: address || null,
        imageUrl: imageUrl || "https://picsum.photos/seed/event/800/600",
        description,
        totalTickets: parseInt(totalTickets) || 0,
        availableTickets: parseInt(availableTickets) || 0,
        status: status || "active",
        hostId: verifiedHostId,
      },
      include: { host: { select: { id: true, name: true } } },
    });

    await invalidateKeys(["events:all"]);
    res.status(201).json(newEvent);
  } catch (error) {
    console.error("Failed to create event:", error);
    res.status(400).json({ message: "Invalid event data" });
  }
});

// PUT update event (Secured)
router.put("/:id", verifyAuth, async (req, res, next) => {
  try {
    const eventId = req.params.id;

    // Authorization Check: Only Admin or the Event Host can edit this event
    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!existingEvent)
      return res.status(404).json({ message: "Event not found" });

    if (req.user.role !== "admin" && existingEvent.hostId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Unauthorized to edit this event" });
    }

    const {
      title,
      category,
      price,
      date,
      time,
      city,
      address,
      imageUrl,
      description,
      totalTickets,
      availableTickets,
      status,
    } = req.body;

    const updatedEvent = await prisma.event.update({
      where: { id: eventId },
      data: {
        title,
        category,
        price: parseFloat(price),
        date: date ? new Date(date) : undefined,
        time: time || null,
        city,
        address: address || null,
        imageUrl,
        description,
        totalTickets: parseInt(totalTickets) || 0,
        availableTickets: parseInt(availableTickets) || 0,
        status: status || "active",
      },
      include: { host: { select: { id: true, name: true } } },
    });

    await invalidateKeys(["events:all", `events:${eventId}`]);
    res.json(updatedEvent);
  } catch (error) {
    console.error("Failed to update event:", error);
    res.status(400).json({ message: "Failed to update event" });
  }
});

// DELETE event (Secured)
router.delete("/:id", verifyAuth, async (req, res, next) => {
  try {
    const eventId = req.params.id;

    // Authorization Check
    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });
    if (!existingEvent)
      return res.status(404).json({ message: "Event not found" });

    if (req.user.role !== "admin" && existingEvent.hostId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "Unauthorized to delete this event" });
    }

    await prisma.event.delete({
      where: { id: eventId },
    });

    await invalidateKeys(["events:all", `events:${eventId}`]);
    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete event" });
  }
});

router.post("/:id/purchase", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const ticketCount = parseInt(req.body.ticketCount);
    const userId = req.user.id;

    if (!ticketCount || ticketCount <= 0) {
      return res.status(400).json({ message: "Invalid purchase payload" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // --- SECURE TRANSACTION: INVENTORY & PAYMENT RESERVATION ---
    const { order, event, payment } = await prisma.$transaction(async (tx) => {
      const targetEvent = await tx.event.findUnique({
        where: { id: eventId },
      });

      if (!targetEvent) throw new Error("Event not found");
      if (targetEvent.status !== "active")
        throw new Error("Event is not active");
      if (targetEvent.availableTickets < ticketCount)
        throw new Error("Not enough tickets available");
      if (targetEvent.hostId === userId)
        throw new Error("You cannot purchase tickets for your own event");

      const totalPrice = targetEvent.price * ticketCount;

      // 1. Decrement inventory
      await tx.event.update({
        where: { id: eventId },
        data: { availableTickets: { decrement: ticketCount } },
      });

      // 2. Create Pending Order
      const newOrder = await tx.order.create({
        data: {
          eventId: eventId,
          userId: userId,
          ticketCount: ticketCount,
          totalPrice: totalPrice,
          status: "INITIATED",
        },
      });

      // 3. Create Universal Payment Record with Metadata
      const newPayment = await tx.payment.create({
        data: {
          userId: userId,
          amount: totalPrice,
          provider: "tinkoff",
          status: "PENDING",
          metadata: {
            type: "EVENT_TICKET",
            orderId: newOrder.id,
            eventId: eventId,
          },
        },
      });

      return { order: newOrder, event: targetEvent, payment: newPayment };
    });

    // --- EXTERNAL API CALL: TINKOFF ---
    try {
      const paymentData = await initTinkoffEventTicketPayment(
        order,
        event,
        user.email,
      );

      const tinkoffTxId = String(paymentData.paymentId);

      // Save Tinkoff's ID to both the Order and the Universal Payment table
      await prisma.$transaction([
        prisma.order.update({
          where: { id: order.id },
          data: { paymentId: tinkoffTxId },
        }),
        prisma.payment.update({
          where: { id: payment.id },
          data: { providerTxId: tinkoffTxId },
        }),
      ]);

      // INVALIDATE CACHE
      if (typeof invalidateKeys === "function") {
        await invalidateKeys([
          "events:all",
          `events:${eventId}`,
          "orders:all",
          "orders:my",
        ]);
      }

      return res.status(200).json({
        message: "Order initiated",
        paymentUrl: paymentData.paymentUrl,
      });
    } catch (tinkoffError) {
      //  Restore tickets and fail both records
      await prisma.$transaction([
        prisma.event.update({
          where: { id: event.id },
          data: { availableTickets: { increment: ticketCount } },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: { status: "PAYMENT_FAILED" },
        }),
        prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        }),
      ]);
      console.error("Tinkoff Init Error:", tinkoffError);
      throw new Error("TINKOFF_INIT_FAILED");
    }
  } catch (error) {
    console.error("Purchase failed:", error.message);
    const clientErrors = [
      "Not enough tickets available",
      "Event is not active",
      "You cannot purchase tickets for your own event",
    ];

    if (clientErrors.includes(error.message))
      return res.status(400).json({ message: error.message });
    if (error.message === "TINKOFF_INIT_FAILED")
      return res
        .status(502)
        .json({ message: "Payment gateway unavailable. Try again later." });

    res.status(500).json({ message: "Internal server error during purchase" });
  }
});

export default router;
