import prisma from "../libs/prisma.js";

// 🚨 IMPORT THE MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

// ==========================================
// 1. CREATE BOOKING REQUEST (Customer -> Performer)
// ==========================================
export const createBooking = async (req, res) => {
  try {
    const { performerId, date, details } = req.body;

    // SECURITY: Use the ID from the verified JWT token
    const customerId = req.user?.id || req.body.customerId;

    // 1. Validation
    if (!performerId || !date || !customerId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 2. Check if performer exists
    const performer = await prisma.user.findUnique({
      where: { id: performerId },
      select: { id: true, name: true, email: true },
    });

    if (!performer) {
      return res.status(404).json({ message: "Performer not found" });
    }

    // 3. Check for availability (Prevent double booking)
    const existingBooking = await prisma.booking.findFirst({
      where: {
        performerId,
        date: new Date(date),
        status: "CONFIRMED",
      },
    });

    if (existingBooking) {
      return res
        .status(409)
        .json({ message: "Performer is not available on this date" });
    }

    // 4. Create Booking
    const booking = await prisma.booking.create({
      data: {
        date: new Date(date),
        details,
        status: "PENDING",
        customer: { connect: { id: customerId } },
        performer: { connect: { id: performerId } },
      },
      include: {
        customer: { select: { name: true } },
      },
    });

    // ---------------------------------------------------------
    // 5. NOTIFY PERFORMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: performerId,
      title: "📅 Новый запрос на бронирование",
      body: `Вы получили новый запрос на бронирование от ${booking.customer.name}`,
      type: "BOOKING_REQUEST",
      data: {
        bookingId: booking.id,
        date: booking.date,
        url: "/performer-profile/bookings", // Deep link for Push Notification click
      },
    });

    res.status(201).json(booking);
  } catch (error) {
    console.error("Create Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==========================================
// 2. ACCEPT BOOKING (Performer -> Customer)
// ==========================================
export const acceptBooking = async (req, res) => {
  try {
    const { requestId } = req.params;

    // SECURITY: Ensure the person accepting is the actual performer
    const performerId = req.user?.id || req.body.performerId;

    const booking = await prisma.booking.findUnique({
      where: { id: requestId },
      include: { performer: true },
    });

    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.performerId !== performerId) {
      return res.status(403).json({ message: "Unauthorized action" });
    }

    // Update Status
    const updatedBooking = await prisma.booking.update({
      where: { id: requestId },
      data: { status: "CONFIRMED" },
      include: { performer: { select: { name: true } } },
    });

    // ---------------------------------------------------------
    // NOTIFY CUSTOMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: updatedBooking.customerId,
      title: "Заказ принят! 🎉",
      body: `Исполнитель ${updatedBooking.performer.name} принял ваш заказ!`,
      type: "BOOKING_ACCEPTED",
      data: {
        bookingId: updatedBooking.id,
        status: "CONFIRMED",
        url: "/customer-profile/bookings",
      },
    });

    res.json(updatedBooking);
  } catch (error) {
    console.error("Accept Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ==========================================
// 3. REJECT BOOKING (Performer -> Customer)
// ==========================================
export const rejectBooking = async (req, res) => {
  try {
    const { requestId } = req.params;
    const performerId = req.user?.id || req.body.performerId;

    const booking = await prisma.booking.findUnique({
      where: { id: requestId },
      include: { performer: true },
    });

    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.performerId !== performerId) {
      return res.status(403).json({ message: "Unauthorized action" });
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
      include: { performer: { select: { name: true } } },
    });

    // ---------------------------------------------------------
    // NOTIFY CUSTOMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: updatedBooking.customerId,
      title: "Заказ отклонен",
      body: `Исполнитель ${updatedBooking.performer.name} отклонил ваш запрос.`,
      type: "BOOKING_REJECTED",
      data: {
        bookingId: updatedBooking.id,
        status: "REJECTED",
        url: "/customer-profile/bookings",
      },
    });

    res.json(updatedBooking);
  } catch (error) {
    console.error("Reject Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
