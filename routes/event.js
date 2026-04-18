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

// --- POST CHECK-IN (QR Code Scanner Endpoint) ---
router.post("/checkin", verifyAuth, async (req, res) => {
  try {
    const hostId = req.user.id;
    const { ticketToken, eventId } = req.body;

    if (!ticketToken || !eventId) {
      return res
        .status(400)
        .json({ message: "Не указан токен билета или ID события." });
    }

    // 1. Verify Host Authorization
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ message: "Событие не найдено." });

    if (event.hostId !== hostId && req.user.role !== "admin") {
      return res.status(403).json({
        message: "У вас нет прав для проверки билетов этого события.",
      });
    }

    // 2. CHECK INVITATIONS (Free RSVPs)
    const invitation = await prisma.invitation.findUnique({
      where: { ticketToken: ticketToken },
    });

    if (invitation) {
      if (invitation.eventId !== eventId) {
        return res
          .status(400)
          .json({ message: "Этот билет от другого мероприятия!" });
      }
      if (invitation.status !== "ACCEPTED") {
        return res
          .status(400)
          .json({ message: "Гость не подтвердил участие (Ожидание/Отказ)." });
      }
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

      // Invalidate frontend cache so the attendees table updates instantly
      if (typeof invalidateKeys === "function")
        await invalidateKeys([`events:${eventId}:attendees`]);

      return res.json({
        isValid: true,
        guestName: invitation.guestName,
        message: "Вход разрешен!",
      });
    }

    // 3. CHECK ORDERS (Paid Tickets)
    const order = await prisma.order.findUnique({
      where: { ticketCode: ticketToken },
      include: { user: { select: { name: true } } },
    });

    if (order) {
      if (order.eventId !== eventId) {
        return res
          .status(400)
          .json({ message: "Этот билет от другого мероприятия!" });
      }
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

    // 4. IF NEITHER MATCHED
    return res.status(404).json({
      message: "Билет с таким QR-кодом не найден в базе этого события.",
    });
  } catch (error) {
    console.error("Check-in Scanner Error:", error);
    res
      .status(500)
      .json({ message: "Внутренняя ошибка сервера при сканировании билета." });
  }
});

// --- 2. DYNAMIC ID ROUTES ---

router.get("/", async (req, res) => {
  try {
    const dbQuery = () =>
      prisma.event.findMany({
        where: { status: "active", type: "PUBLIC", paymentType: "PAID" },
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

// router.post("/:id/purchase", verifyAuth, async (req, res) => {
//   const eventId = req.params.id;
//   const ticketCount = parseInt(req.body.ticketCount);
//   const userId = req.user.id;

//   if (isNaN(ticketCount) || ticketCount <= 0) {
//     return res
//       .status(400)
//       .json({ message: "Укажите корректное количество билетов" });
//   }

//   try {
//     const user = await prisma.user.findUnique({ where: { id: userId } });
//     if (!user) return res.status(404).json({ message: "User not found" });

//     // Step 1: Secure DB Transaction
//     const result = await prisma.$transaction(async (tx) => {
//       const targetEvent = await tx.event.findUnique({ where: { id: eventId } });

//       if (!targetEvent) throw new Error("EVENT_NOT_FOUND");
//       if (targetEvent.status !== "active") throw new Error("EVENT_NOT_ACTIVE");
//       if (targetEvent.paymentType === "FREE") throw new Error("EVENT_IS_FREE"); // Prevent Tinkoff crash on 0 amount
//       if (targetEvent.availableTickets < ticketCount)
//         throw new Error("NOT_ENOUGH_TICKETS");
//       if (targetEvent.hostId === userId) throw new Error("OWN_EVENT_PURCHASE");

//       const totalPrice = targetEvent.price * ticketCount;

//       // Reserve Inventory
//       await tx.event.update({
//         where: { id: eventId },
//         data: { availableTickets: { decrement: ticketCount } },
//       });

//       const newOrder = await tx.order.create({
//         data: { eventId, userId, ticketCount, totalPrice, status: "INITIATED" },
//       });

//       const newPayment = await tx.payment.create({
//         data: {
//           userId,
//           amount: totalPrice,
//           provider: "tinkoff",
//           status: "PENDING",
//           metadata: { type: "EVENT_TICKET", orderId: newOrder.id, eventId },
//         },
//       });

//       return { newOrder, targetEvent, newPayment };
//     });

//     // Step 2: Tinkoff API Call (with Receipt data integration)
//     try {
//       const paymentData = await initTinkoffEventTicketPayment(
//         result.newOrder,
//         result.targetEvent,
//         user.email,
//       );

//       // Update Tx IDs
//       const tinkoffTxId = String(paymentData.paymentId);
//       await prisma.$transaction([
//         prisma.order.update({
//           where: { id: result.newOrder.id },
//           data: { paymentId: tinkoffTxId },
//         }),
//         prisma.payment.update({
//           where: { id: result.newPayment.id },
//           data: { providerTxId: tinkoffTxId },
//         }),
//       ]);

//       await invalidateKeys(["events:all", `events:${eventId}`, "orders:my"]);
//       return res.json({ paymentUrl: paymentData.paymentUrl });
//     } catch (apiError) {
//       console.error("Tinkoff API Error, performing manual rollback...");
//       // Critical: If Tinkoff fails, restore the tickets and mark failure
//       await prisma.$transaction([
//         prisma.event.update({
//           where: { id: eventId },
//           data: { availableTickets: { increment: ticketCount } },
//         }),
//         prisma.order.update({
//           where: { id: result.newOrder.id },
//           data: { status: "PAYMENT_FAILED" },
//         }),
//         prisma.payment.update({
//           where: { id: result.newPayment.id },
//           data: { status: "FAILED" },
//         }),
//       ]);
//       return res.status(502).json({
//         message: "Сервис оплаты временно недоступен. Попробуйте позже.",
//       });
//     }
//   } catch (error) {
//     const errorMap = {
//       EVENT_NOT_FOUND: "Событие не найдено",
//       EVENT_NOT_ACTIVE: "Мероприятие более не доступно",
//       EVENT_IS_FREE: "Это мероприятие бесплатное, используйте RSVP",
//       NOT_ENOUGH_TICKETS: "Недостаточно свободных билетов",
//       OWN_EVENT_PURCHASE: "Нельзя купить билет на собственное событие",
//     };
//     res
//       .status(400)
//       .json({ message: errorMap[error.message] || "Ошибка создания заказа" });
//   }
// });

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
      if (targetEvent.paymentType === "FREE") throw new Error("EVENT_IS_FREE");
      if (targetEvent.availableTickets < ticketCount)
        throw new Error("NOT_ENOUGH_TICKETS");
      if (targetEvent.hostId === userId) throw new Error("OWN_EVENT_PURCHASE");

      // 🚨 UPDATE: Calculate effective price prioritizing discountPrice
      const effectivePrice =
        targetEvent.discountPrice && targetEvent.discountPrice > 0
          ? targetEvent.discountPrice
          : targetEvent.price;

      const totalPrice = effectivePrice * ticketCount;

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

      if (typeof invalidateKeys === "function") {
        await invalidateKeys(["events:all", `events:${eventId}`, "orders:my"]);
      }

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
      return res.status(502).json({
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
    const mappedMessage = errorMap[error.message] || "Ошибка создания заказа";
    res.status(400).json({ message: mappedMessage });
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

// --- GET EVENT ATTENDEES (Unified RSVPs + Paid Orders) ---
router.get("/:id/attendees", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;

    // 1. Verify Event and Authorization
    const event = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      return res.status(404).json({ message: "Событие не найдено" });
    }

    if (event.hostId !== req.user.id && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Нет прав для просмотра списка гостей" });
    }

    // 2. Fetch both Invitations (Free) and Orders (Paid) in parallel
    const [invitations, orders] = await Promise.all([
      prisma.invitation.findMany({
        where: { eventId: eventId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.findMany({
        where: {
          eventId: eventId,
          status: { in: ["ACTIVE", "PAYMENT_SUCCESS"] }, // Only show successfully paid tickets
        },
        include: { user: { select: { name: true, email: true, phone: true } } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // 3. Map everything into the Unified Attendee Format for the frontend
    const attendees = [
      ...invitations.map((inv) => ({
        id: inv.id,
        eventId: inv.eventId,
        guestName: inv.guestName || "Гость",
        guestEmail: inv.guestEmail,
        guestPhone: inv.guestPhone || null,
        status: inv.status, // "PENDING", "ACCEPTED", "REJECTED"
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
        status: "ACCEPTED", // Paid tickets are inherently "Accepted"
        ticketToken: ord.ticketCode,
        isCheckedIn: ord.isUsed,
        checkInTime: ord.enteredAt,
        createdAt: ord.createdAt,
      })),
    ];

    // Sort combined list so the newest entries are at the top
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

// --- UPDATE EVENT ---
router.put("/:id", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const data = req.body;

    // 1. Check if event exists
    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!existingEvent) {
      return res.status(404).json({ message: "Событие не найдено" });
    }

    // 2. Authorization Check (Only the host or an admin can edit)
    if (
      existingEvent.hostId !== req.user.id &&
      req.user.role !== "administrator"
    ) {
      return res
        .status(403)
        .json({ message: "Нет прав для редактирования этого события" });
    }

    // 3. Prepare clean update data
    const updateData = { ...data };

    // Format numbers and dates
    if (data.price !== undefined)
      updateData.price = parseFloat(data.price) || 0;
    if (data.discountPrice !== undefined)
      updateData.discountPrice = parseFloat(data.discountPrice) || 0;
    if (data.date !== undefined) updateData.date = new Date(data.date);

    // Safely recalculate available tickets if the total capacity changes
    if (data.totalTickets !== undefined) {
      const newTotal = parseInt(data.totalTickets) || 0;
      const difference = newTotal - existingEvent.totalTickets;

      updateData.totalTickets = newTotal;
      // Prevent available tickets from dropping below 0
      updateData.availableTickets = Math.max(
        0,
        existingEvent.availableTickets + difference,
      );
    }

    // Prevent non-admins from transferring ownership
    if (data.hostId && req.user.role !== "performer") {
      delete updateData.hostId;
    }

    // 4. Execute update
    const updatedEvent = await prisma.event.update({
      where: { id: eventId },
      data: updateData,
    });

    // 5. Invalidate relevant caches
    await invalidateKeys(["events:all", `events:${eventId}`, "events:hosted"]);

    res.status(200).json(updatedEvent);
  } catch (error) {
    console.error("Update Event Error:", error);
    res.status(400).json({ message: "Ошибка при обновлении события" });
  }
});

// --- DELETE EVENT ---
router.delete("/:id", verifyAuth, async (req, res) => {
  try {
    const eventId = req.params.id;

    // 1. Find the event
    const existingEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!existingEvent) {
      return res.status(404).json({ message: "Событие не найдено" });
    }

    // 2. Authorization Check
    if (
      existingEvent.hostId !== req.user.id &&
      req.user.role !== "administrator"
    ) {
      return res
        .status(403)
        .json({ message: "Нет прав для удаления этого события" });
    }

    // --- 🚨 NEW SAFETY CHECKS ---
    if (req.user.role !== "administrator") {
      // Check 1: Have people bought tickets?
      const soldTicketsCount = await prisma.order.count({
        where: {
          eventId: eventId,
          status: "ACTIVE", // Or "PAYMENT_SUCCESS" depending on your exact schema
        },
      });

      if (soldTicketsCount > 0) {
        return res.status(400).json({
          message:
            "Нельзя удалить событие: уже есть купленные билеты. Измените статус на 'Отменено', чтобы оформить возвраты.",
        });
      }

      // Check 2: Have people RSVP'd to a free event?
      const rsvpCount = await prisma.invitation.count({
        where: {
          eventId: eventId,
          status: "ACCEPTED",
        },
      });

      if (rsvpCount > 0) {
        return res.status(400).json({
          message:
            "Нельзя удалить событие: уже есть зарегистрированные участники.",
        });
      }

      // Check 3: Has the event already happened?
      if (new Date(existingEvent.date) < new Date()) {
        return res.status(400).json({
          message:
            "Нельзя удалить прошедшее событие. Оно сохраняется для истории.",
        });
      }
    }
    // ----------------------------

    // 3. Execute Deletion
    await prisma.event.delete({
      where: { id: eventId },
    });

    // 4. Clear Cache
    await invalidateKeys(["events:all", `events:${eventId}`, "events:hosted"]);

    res.status(200).json({ message: "Событие успешно удалено" });
  } catch (error) {
    console.error("Delete Event Error:", error);
    res.status(500).json({ message: "Ошибка при удалении события" });
  }
});

export default router;
