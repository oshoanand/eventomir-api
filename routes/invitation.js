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
    const userEmail = req.user.email; // Extracted from the JWT token via verifyAuth

    // 1. Fetch the invitation and the associated event
    const invitation = await prisma.invitation.findUnique({
      where: { id: inviteId },
      include: { event: true },
    });

    // 2. Validate existence
    if (!invitation) {
      return res.status(404).json({ message: "Приглашение не найдено" }); // Invitation not found
    }

    // 3. Security: Ensure the user requesting the PDF actually owns this invitation
    if (
      invitation.guestEmail !== userEmail &&
      req.user.role !== "administrator"
    ) {
      return res.status(403).json({ message: "Нет доступа к этому билету" }); // Access denied
    }

    // 4. Validate Status: Only accepted RSVPs get a ticket
    if (invitation.status !== "ACCEPTED") {
      return res.status(400).json({ message: "Приглашение не подтверждено" }); // Not accepted
    }

    // 5. Format Data for the PDF Generator
    // Your PDF generator expects a "User" object. Since Invitations use `guestName` and `guestEmail`,
    // we map them into a mock user object to prevent crashes inside the PDF generator.
    const mockUser = {
      name: invitation.guestName || "Гость", // "Guest" fallback
      email: invitation.guestEmail,
    };

    // 6. Generate the PDF
    // Note: Ensure your `generateTicketPDF` handles `invitation.ticketToken`
    // and correctly displays "FREE (RSVP)" if `totalPrice` is undefined.
    const pdfBuffer = await generateTicketPDF(
      invitation,
      invitation.event,
      mockUser,
    );

    // 7. Send the PDF to the client
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Ticket_${invitation.event.title.replace(/\s+/g, "_")}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Generate Invitation PDF Error:", error);
    res.status(500).json({ message: "Ошибка при создании PDF файла билета" });
  }
});

export default router;
