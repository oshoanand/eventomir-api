import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { generateTicketPDF } from "../mailer/pdf-generator.js";

const router = Router();

/**
 * GET /api/invitations/:id/pdf
 * Generates and downloads a PDF ticket for a free RSVP/Invitation.
 */
router.get("/:id/pdf", verifyAuth, async (req, res) => {
  try {
    const inviteId = req.params.id;
    const userId = req.user.id;

    // 1. Fetch the user securely from the DB to guarantee we have their correct email and role
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ message: "Пользователь не найден" });
    }

    // 2. Fetch the invitation and the associated event
    const invitation = await prisma.invitation.findUnique({
      where: { id: inviteId },
      include: { event: true },
    });

    if (!invitation) {
      return res.status(404).json({ message: "Приглашение не найдено" });
    }

    // 3. Security: Ensure the user requesting the PDF actually owns this invitation
    // We use .toLowerCase() to prevent case-sensitivity bugs when matching emails
    if (
      invitation.guestEmail.toLowerCase() !== user.email.toLowerCase() &&
      user.role !== "administrator"
    ) {
      return res.status(403).json({ message: "Нет доступа к этому билету" });
    }

    // 4. Validate Status: Only accepted RSVPs get a ticket
    if (invitation.status !== "ACCEPTED") {
      return res.status(400).json({ message: "Приглашение не подтверждено" });
    }

    // 5. Format Data for the PDF Generator
    // Map them into a mock user object to prevent crashes inside the PDF generator.
    const mockUser = {
      name: invitation.guestName || "Гость",
      email: invitation.guestEmail,
    };

    // 🚨 FIX: The PDF generator likely expects an 'Order' object.
    // We map 'ticketToken' to 'ticketCode' and add 'ticketCount' and 'totalPrice' to prevent crashes.
    const mockOrderPayload = {
      ...invitation,
      ticketCode: invitation.ticketToken,
      ticketCount: 1,
      totalPrice: 0,
    };

    // 6. Generate the PDF
    const pdfBuffer = await generateTicketPDF(
      mockOrderPayload,
      invitation.event,
      mockUser,
    );

    // 7. Send the PDF to the client
    // 🚨 FIX: Replaced regex to securely strip out all unsafe characters from the filename
    const safeFilename = invitation.event.title.replace(
      /[^a-zA-Z0-9а-яА-Я]/g,
      "_",
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Ticket_${safeFilename}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Generate Invitation PDF Error:", error);
    res.status(500).json({ message: "Ошибка при создании PDF файла билета" });
  }
});

export default router;
