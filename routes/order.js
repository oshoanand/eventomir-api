import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { generateTicketPDF } from "../mailer/pdf-generator.js";

const router = Router();

/**
 * GET /api/orders
 * Admin route to see all activity (transformed to Unified view)
 */
router.get("/", verifyAuth, async (req, res) => {
  try {
    // 🚨 FIX: Strict check for "administrator" instead of "admin"
    if (req.user.role !== "administrator")
      return res.status(403).json({ message: "Access denied" });

    const [orders, invitations] = await Promise.all([
      prisma.order.findMany({
        include: { event: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.invitation.findMany({
        include: { event: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Map to Unified Format
    const unified = [
      ...orders.map((o) => ({
        id: o.id,
        type: "ORDER",
        title: o.event.title,
        date: o.event.date,
        time: o.event.time,
        city: o.event.city,
        address: o.event.address,
        imageUrl: o.event.imageUrl,
        status: o.status,
        isUsed: o.isUsed,
        ticketCount: o.ticketCount,
        eventId: o.eventId,
        createdAt: o.createdAt,
      })),
      ...invitations.map((i) => ({
        id: i.id,
        type: "INVITATION",
        title: i.event.title,
        date: i.event.date,
        time: i.event.time,
        city: i.event.city,
        address: i.event.address,
        imageUrl: i.event.imageUrl,
        status: i.status,
        isUsed: i.isCheckedIn,
        ticketCount: 1,
        eventId: i.eventId,
        createdAt: i.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(unified);
  } catch (error) {
    console.error("Admin Unified Orders Fetch Error:", error);
    res.status(500).json({ message: "Error fetching all orders" });
  }
});

/**
 * GET /api/orders/my
 * Returns a unified list of Paid Orders and RSVP Invitations for the logged-in user
 */
router.get("/my", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 🚨 FIX: Securely fetch the user to guarantee we have their email for RSVP lookups
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userEmail = user.email;

    // Fetch both types of tickets
    const [orders, invitations] = await Promise.all([
      prisma.order.findMany({
        where: { userId: userId },
        include: { event: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.invitation.findMany({
        where: { guestEmail: userEmail },
        include: { event: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Transform into Unified Format for Frontend
    const unifiedTickets = [
      ...orders.map((o) => ({
        id: o.id,
        type: "ORDER",
        title: o.event.title,
        date: o.event.date,
        time: o.event.time,
        city: o.event.city,
        address: o.event.address,
        imageUrl: o.event.imageUrl,
        status: o.status, // e.g., "PAYMENT_SUCCESS"
        isUsed: o.isUsed,
        ticketCount: o.ticketCount,
        eventId: o.eventId,
        createdAt: o.createdAt,
      })),
      ...invitations.map((i) => ({
        id: i.id,
        type: "INVITATION",
        title: i.event.title,
        date: i.event.date,
        time: i.event.time,
        city: i.event.city,
        address: i.event.address,
        imageUrl: i.event.imageUrl,
        status: i.status, // e.g., "ACCEPTED"
        isUsed: i.isCheckedIn,
        ticketCount: 1,
        eventId: i.eventId,
        createdAt: i.createdAt,
      })),
    ];

    // Sort by most recently acquired
    unifiedTickets.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    res.json(unifiedTickets);
  } catch (error) {
    console.error("Unified Tickets Fetch Error:", error);
    res.status(500).json({ message: "Failed to fetch your tickets" });
  }
});

/**
 * GET /api/orders/:id/pdf
 * Handles PDF generation for PAID orders
 */
router.get("/:id/pdf", verifyAuth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user.id;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    // 🚨 FIX: Strict check for "administrator"
    if (
      !order ||
      (order.userId !== userId && req.user.role !== "administrator")
    ) {
      return res
        .status(404)
        .json({ message: "Order not found or access denied" });
    }

    if (order.status !== "ACTIVE" && order.status !== "PAYMENT_SUCCESS") {
      return res.status(400).json({ message: "Ticket is not active" });
    }

    const pdfBuffer = await generateTicketPDF(order, order.event, order.user);

    // 🚨 FIX: Sanitize filename to prevent header corruption
    const safeFilename = order.event.title.replace(/[^a-zA-Z0-9а-яА-Я]/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Order_${safeFilename}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Order PDF Error:", error);
    res.status(500).json({ message: "Failed to generate PDF" });
  }
});

/**
 * GET /api/orders/invitation/:id/pdf
 * Handles PDF generation for FREE invitations
 */
router.get("/invitation/:id/pdf", verifyAuth, async (req, res) => {
  try {
    const inviteId = req.params.id;
    const userId = req.user.id;

    // Securely fetch user email from DB
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, role: true },
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    const invite = await prisma.invitation.findUnique({
      where: { id: inviteId },
      include: { event: true },
    });

    // Case-insensitive email match, and strict admin check
    if (
      !invite ||
      (invite.guestEmail.toLowerCase() !== user.email.toLowerCase() &&
        user.role !== "administrator")
    ) {
      return res
        .status(404)
        .json({ message: "Invitation not found or access denied" });
    }

    if (invite.status !== "ACCEPTED") {
      return res.status(400).json({ message: "Invitation not confirmed" });
    }

    // Mocking user object for generator
    const mockUser = {
      name: invite.guestName || "Гость",
      email: invite.guestEmail,
    };

    // 🚨 FIX: Map 'ticketToken' to 'ticketCode' so the PDF generator doesn't crash
    const mockOrderPayload = {
      ...invite,
      ticketCode: invite.ticketToken,
      ticketCount: 1,
      totalPrice: 0,
    };

    const pdfBuffer = await generateTicketPDF(
      mockOrderPayload,
      invite.event,
      mockUser,
    );

    const safeFilename = invite.event.title.replace(/[^a-zA-Z0-9а-яА-Я]/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Invite_${safeFilename}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Invite PDF Error:", error);
    res.status(500).json({ message: "Failed to generate PDF" });
  }
});

export default router;
