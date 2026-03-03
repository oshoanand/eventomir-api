import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached, invalidateKeys } from "../middleware/redis.js";

const router = Router();

// --- HELPER ROUTE FOR ADMIN DROPDOWN ---
// GET /api/events/hosts/list - Fetch users to assign as event hosts
router.get("/hosts/list", async (req, res, next) => {
  try {
    // Wrap the DB call in fetchCached. Key will be "hosts:all"
    const dbQuery = () =>
      prisma.user.findMany({
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      });

    // Caching hosts for 1 hour (3600 seconds) as they don't change by the second
    const hosts = await fetchCached("hosts", "all", dbQuery, 3600);

    res.json(hosts);
  } catch (error) {
    console.error("Failed to fetch hosts:", error);
    res.status(500).json({ message: "Failed to fetch hosts" });
  }
});

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

    // Fetch from Redis, or DB if cache miss. Key will be "events:all"
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

    const dbQuery = () =>
      prisma.event.findUnique({
        where: { id: eventId },
        include: {
          host: {
            select: { id: true, name: true, email: true },
          },
        },
      });

    // Key will be "events:<id>"
    const event = await fetchCached("events", eventId, dbQuery);

    if (!event) return res.status(404).json({ message: "Event not found" });

    res.json(event);
  } catch (error) {
    next(error);
  }
});

// POST new event
router.post("/", async (req, res, next) => {
  try {
    const {
      title,
      category,
      price,
      date,
      city,
      imageUrl,
      description,
      hostId,
    } = req.body;

    const newEvent = await prisma.event.create({
      data: {
        title,
        category,
        price: parseFloat(price) || 0,
        date: new Date(date),
        city,
        imageUrl: imageUrl || "https://picsum.photos/seed/event/800/600",
        description,
        hostId: hostId ? hostId : null,
      },
      include: { host: { select: { id: true, name: true } } },
    });

    // INVALIDATE CACHE: The 'events:all' list is now outdated
    await invalidateKeys(["events:all"]);

    res.status(201).json(newEvent);
  } catch (error) {
    console.error("Failed to create event:", error);
    res.status(400).json({ message: "Invalid event data" });
  }
});

// PUT update event
router.put("/:id", async (req, res, next) => {
  try {
    const eventId = req.params.id;
    const {
      title,
      category,
      price,
      date,
      city,
      imageUrl,
      description,
      hostId,
    } = req.body;

    const updatedEvent = await prisma.event.update({
      where: { id: eventId },
      data: {
        title,
        category,
        price: parseFloat(price),
        date: date ? new Date(date) : undefined,
        city,
        imageUrl,
        description,
        hostId: hostId === "" ? null : hostId,
      },
      include: { host: { select: { id: true, name: true } } },
    });

    // INVALIDATE CACHE: Clear both the specific event cache and the global list
    await invalidateKeys(["events:all", `events:${eventId}`]);

    res.json(updatedEvent);
  } catch (error) {
    console.error("Failed to update event:", error);
    res.status(400).json({ message: "Failed to update event" });
  }
});

// DELETE event
router.delete("/:id", async (req, res, next) => {
  try {
    const eventId = req.params.id;

    await prisma.event.delete({
      where: { id: eventId },
    });

    // INVALIDATE CACHE: Clear both the specific event cache and the global list
    await invalidateKeys(["events:all", `events:${eventId}`]);

    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete event" });
  }
});

export default router;
