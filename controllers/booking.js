import prisma from "../libs/prisma.js";
import { sendNotification } from "../services/socket.js";

// --- Create Booking Request ---
export const createBooking = async (req, res) => {
  try {
    const { performerId, date, details, customerId } = req.body;

    // 1. Validation
    if (!performerId || !date || !customerId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 2. Check if performer exists
    const performer = await prisma.user.findUnique({
      where: { id: performerId },
      select: { id: true, name: true, email: true }, // Select minimal fields
    });

    if (!performer) {
      return res.status(404).json({ message: "Performer not found" });
    }

    // 3. Check for availability (Optional: prevent double booking)
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

    // 4. Create Booking & Persist Notification in Transaction
    const result = await prisma.$transaction(async (prisma) => {
      // A. Create Booking
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

      // B. Create DB Notification Record (Permanent History)
      await prisma.notification.create({
        data: {
          userId: performerId,
          type: "BOOKING_REQUEST",
          message: `Новый запрос на бронирование от ${booking.customer.name}`,
          data: { bookingId: booking.id },
        },
      });

      return booking;
    });

    // 5. Send Real-time/Redis Stream Notification
    await sendNotification(
      performerId,
      "BOOKING_REQUEST",
      `Новый запрос на бронирование от ${result.customer.name}`,
      { bookingId: result.id, date: result.date },
    );

    res.status(201).json(result);
  } catch (error) {
    console.error("Create Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Accept Booking ---
export const acceptBooking = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { performerId } = req.body; // Passed from verifyAuth middleware usually, or body

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

    // Notify Customer
    const message = `Исполнитель ${updatedBooking.performer.name} принял ваш заказ!`;

    // Save to DB
    await prisma.notification.create({
      data: {
        userId: updatedBooking.customerId,
        type: "BOOKING_UPDATE",
        message: message,
        data: { bookingId: updatedBooking.id, status: "CONFIRMED" },
      },
    });

    // Send Real-time
    await sendNotification(
      updatedBooking.customerId,
      "BOOKING_ACCEPTED",
      message,
      { bookingId: updatedBooking.id },
    );

    res.json(updatedBooking);
  } catch (error) {
    console.error("Accept Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// --- Reject Booking ---
export const rejectBooking = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { performerId } = req.body;

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

    // Notify Customer
    const message = `Исполнитель ${updatedBooking.performer.name} отклонил ваш запрос.`;

    await prisma.notification.create({
      data: {
        userId: updatedBooking.customerId,
        type: "BOOKING_UPDATE",
        message: message,
        data: { bookingId: updatedBooking.id, status: "REJECTED" },
      },
    });

    await sendNotification(
      updatedBooking.customerId,
      "BOOKING_REJECTED",
      message,
      { bookingId: updatedBooking.id },
    );

    res.json(updatedBooking);
  } catch (error) {
    console.error("Reject Booking Error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
