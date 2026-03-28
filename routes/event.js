import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached, invalidateKeys } from "../middleware/redis.js";
import { generateCustomOrderId } from "../utils/helper.js";
import { initTinkoffEventTicketPayment } from "../utils/tinkoff.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import "dotenv/config";

const router = Router();

// --- HELPER ROUTE FOR ADMIN DROPDOWN ---
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

// --- TICKET SCANNING ROUTE (Must be before /:id) ---
// POST /api/events/tickets/scan
router.post("/tickets/scan", verifyAuth, async (req, res) => {
  try {
    const hostId = req.user.id;
    const { ticketCode, eventId } = req.body;

    if (!ticketCode || !eventId) {
      return res
        .status(400)
        .json({ message: "Ticket code and Event ID required." });
    }

    // Find the order by the unique ticket code encoded in the QR
    const order = await prisma.order.findUnique({
      where: { ticketCode: ticketCode },
      include: { event: true, user: { select: { name: true } } },
    });

    if (!order) {
      return res
        .status(404)
        .json({
          isValid: false,
          message: "Билет не найден (Ticket not found).",
        });
    }

    if (order.eventId !== eventId) {
      return res
        .status(400)
        .json({
          isValid: false,
          message: "Билет от другого мероприятия (Wrong event).",
        });
    }

    if (order.event.hostId !== hostId) {
      return res
        .status(403)
        .json({
          isValid: false,
          message: "Вы не являетесь организатором (Unauthorized).",
        });
    }

    if (order.status !== "PAYMENT_SUCCESS" && order.status !== "ACTIVE") {
      return res
        .status(400)
        .json({
          isValid: false,
          message: "Билет не оплачен (Ticket not paid).",
        });
    }

    if (order.isUsed) {
      return res.status(400).json({
        isValid: false,
        message: `Билет уже был использован (Already used at ${order.enteredAt?.toLocaleTimeString()}).`,
      });
    }

    // Auto-Expiration Check
    const now = new Date();
    const eventEndDate = new Date(order.event.date);
    eventEndDate.setHours(eventEndDate.getHours() + 24);

    if (now > eventEndDate) {
      return res
        .status(400)
        .json({
          isValid: false,
          message: "Срок действия билета истек (Event expired).",
        });
    }

    // Mark Ticket as Used
    await prisma.order.update({
      where: { id: order.id },
      data: {
        isUsed: true,
        enteredAt: new Date(),
      },
    });

    res.status(200).json({
      isValid: true,
      message: "Билет действителен! Вход разрешен.",
      attendeeName: order.user.name,
      ticketCount: order.ticketCount,
    });
  } catch (error) {
    console.error("Scan Ticket Error:", error);
    res.status(500).json({ message: "Internal server error during scanning." });
  }
});

// --- PERFOMER SECURE ROUTE ---
router.get("/hosted", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

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

router.get("/:id", async (req, res, next) => {
  try {
    const eventId = req.params.id;
    if (eventId === "hosted" || eventId === "tickets") return next();

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

// --- EVENT HOST ROUTES ---
// GET /api/events/:id/attendees
router.get("/:id/attendees", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const hostId = req.user.id;

    const event = await prisma.event.findUnique({ where: { id: eventId } });

    if (!event) return res.status(404).json({ message: "Event not found." });
    if (event.hostId !== hostId)
      return res.status(403).json({ message: "Access denied." });

    const attendees = await prisma.order.findMany({
      where: {
        eventId: eventId,
        status: { in: ["PAYMENT_SUCCESS", "ACTIVE"] },
      },
      include: {
        user: { select: { name: true, email: true, profile_picture: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const totalSold = attendees.reduce(
      (sum, order) => sum + order.ticketCount,
      0,
    );
    const revenue = attendees.reduce((sum, order) => sum + order.totalPrice, 0);
    const checkedIn = attendees.filter((order) => order.isUsed).length;

    res.status(200).json({
      stats: { totalSold, revenue, checkedIn, capacity: event.totalTickets },
      attendees: attendees.map((a) => ({
        orderId: a.id,
        name: a.user.name,
        email: a.user.email,
        ticketCount: a.ticketCount,
        isUsed: a.isUsed,
        enteredAt: a.enteredAt,
        purchaseDate: a.createdAt,
      })),
    });
  } catch (error) {
    console.error("Get Attendees Error:", error);
    res.status(500).json({ message: "Failed to load attendees." });
  }
});

// --- SECURE CRUD ROUTES ---
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
    } = req.body;

    const verifiedHostId =
      req.user.role === "admin" && req.body.hostId
        ? req.body.hostId
        : req.user.id;

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

    if (typeof invalidateKeys === "function")
      await invalidateKeys(["events:all"]);
    res.status(201).json(newEvent);
  } catch (error) {
    console.error("Failed to create event:", error);
    res.status(400).json({ message: "Invalid event data" });
  }
});

router.put("/:id", verifyAuth, async (req, res, next) => {
  try {
    const eventId = req.params.id;

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

    if (typeof invalidateKeys === "function")
      await invalidateKeys(["events:all", `events:${eventId}`]);
    res.json(updatedEvent);
  } catch (error) {
    console.error("Failed to update event:", error);
    res.status(400).json({ message: "Failed to update event" });
  }
});

router.delete("/:id", verifyAuth, async (req, res, next) => {
  try {
    const eventId = req.params.id;

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

    if (typeof invalidateKeys === "function")
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

      // Auto-Expiration Check dynamically
      const now = new Date();
      const eventDate = new Date(targetEvent.date);
      if (now > eventDate) {
        await tx.event.update({
          where: { id: targetEvent.id },
          data: { status: "expired" },
        });
        throw new Error("This event has already ended.");
      }

      const totalPrice = targetEvent.price * ticketCount;

      await tx.event.update({
        where: { id: eventId },
        data: { availableTickets: { decrement: ticketCount } },
      });

      const newOrder = await tx.order.create({
        data: {
          eventId: eventId,
          userId: userId,
          ticketCount: ticketCount,
          totalPrice: totalPrice,
          status: "INITIATED",
        },
      });

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
      "This event has already ended.",
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
