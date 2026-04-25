import prisma from "../libs/prisma.js";

import { notifyUser } from "../services/notification.js";

// ==========================================
// 1. CREATE BOOKING REQUEST (Customer -> Performer)
// ==========================================
export const createBooking = async (req, res) => {
  try {
    // Note: performerId from frontend is usually the base User ID of the performer
    const { performerId, date, details } = req.body;

    // SECURITY: Use the ID from the verified JWT token
    const customerUserId = req.user?.id || req.body.customerId;

    // 1. Validation
    if (!performerId || !date || !customerUserId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 2. Fetch the strict Customer Profile
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: customerUserId },
      include: { user: { select: { name: true } } },
    });

    if (!customerProfile) {
      return res
        .status(403)
        .json({ message: "Customer profile required to make a booking." });
    }

    // 3. Fetch the strict Performer Profile
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: performerId }, // Assuming frontend sends base User ID
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!performerProfile) {
      return res.status(404).json({ message: "Performer not found" });
    }

    // 4. Check for availability (Prevent double booking)
    const existingBooking = await prisma.booking.findFirst({
      where: {
        performerId: performerProfile.id, // Use Profile ID, not User ID
        date: new Date(date),
        status: "CONFIRMED",
      },
    });

    if (existingBooking) {
      return res
        .status(409)
        .json({ message: "Performer is not available on this date" });
    }

    // 5. Create Booking connecting the Profiles
    const booking = await prisma.booking.create({
      data: {
        date: new Date(date),
        details,
        status: "PENDING",
        customer: { connect: { id: customerProfile.id } },
        performer: { connect: { id: performerProfile.id } },
      },
    });

    // ---------------------------------------------------------
    // 6. NOTIFY PERFORMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: performerProfile.userId, // Notification requires base User ID
      title: "📅 Новый запрос на бронирование",
      body: `Вы получили новый запрос на бронирование от ${customerProfile.user.name || "пользователя"}`,
      type: "BOOKING_REQUEST",
      data: {
        bookingId: booking.id,
        date: booking.date,
        url: "/performer-profile/bookings",
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
    const performerUserId = req.user?.id || req.body.performerId;

    const booking = await prisma.booking.findUnique({
      where: { id: requestId },
      include: {
        performer: { include: { user: true } },
        customer: { include: { user: true } },
      },
    });

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // Check if the underlying user ID matches the token
    if (booking.performer.userId !== performerUserId) {
      return res.status(403).json({ message: "Unauthorized action" });
    }

    // Update Status
    const updatedBooking = await prisma.booking.update({
      where: { id: requestId },
      data: { status: "CONFIRMED" },
    });

    // ---------------------------------------------------------
    // NOTIFY CUSTOMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: booking.customer.userId, // Notification requires base User ID
      title: "Заказ принят! 🎉",
      body: `Исполнитель ${booking.performer.user.name} принял ваш заказ!`,
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

    // SECURITY: Ensure the person rejecting is the actual performer
    const performerUserId = req.user?.id || req.body.performerId;

    const booking = await prisma.booking.findUnique({
      where: { id: requestId },
      include: {
        performer: { include: { user: true } },
        customer: { include: { user: true } },
      },
    });

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // Check if the underlying user ID matches the token
    if (booking.performer.userId !== performerUserId) {
      return res.status(403).json({ message: "Unauthorized action" });
    }

    // Update Status
    const updatedBooking = await prisma.booking.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
    });

    // ---------------------------------------------------------
    // NOTIFY CUSTOMER (FCM Push + Socket + DB)
    // ---------------------------------------------------------
    await notifyUser({
      userId: booking.customer.userId, // Notification requires base User ID
      title: "Заказ отклонен",
      body: `Исполнитель ${booking.performer.user.name} отклонил ваш запрос.`,
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
