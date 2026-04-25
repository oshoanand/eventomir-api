import express from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth, verifyOptionalAuth } from "../middleware/verify-auth.js";
import { requireRole } from "../middleware/role-check.js"; // 🚨 FIX: Import standard role checker

// Import your custom utilities
import { createUploader } from "../utils/multer.js";
import { optimizeAndUpload } from "../utils/imageProcessor.js";
import { notifyUser } from "../services/notification.js";

const router = express.Router();

// Initialize the secure memory uploader (max 5MB)
const upload = createUploader(5);

// ==========================================
// HELPERS: ENUM MAPPERS
// ==========================================
// Maps frontend simple types to strict database TicketType Enums
const mapSupportType = (type) => {
  switch (type?.toUpperCase()) {
    case "BUG":
      return "BUG_REPORT";
    case "FEATURE":
      return "FEATURE_REQUEST";
    default:
      return "OTHER";
  }
};

// Safely maps frontend statuses to strict database TicketStatus Enums
const mapTicketStatus = (status) => {
  switch (status?.toUpperCase()) {
    case "PENDING":
      return "OPEN";
    case "IN_PROGRESS":
      return "IN_PROGRESS";
    case "RESOLVED":
      return "RESOLVED";
    case "REJECTED":
      return "CLOSED"; // Maps rejected to closed
    case "CLOSED":
      return "CLOSED";
    default:
      return "OPEN";
  }
};

// ==========================================
// 1. CREATE TICKET (Public / Auth App)
// ==========================================
router.post(
  "/create",
  verifyOptionalAuth,
  upload.single("proof"),
  async (req, res) => {
    try {
      const { mobile, support_type, description } = req.body;
      const userId = req.user?.id || null; // Null if guest

      // 1. Process and Upload Image to MinIO
      let attachments = [];
      if (req.file) {
        // Passes the file, bucket folder, dynamic ID, and sets max width to 1080px
        const fileUrl = await optimizeAndUpload(
          req.file,
          "support-proofs",
          userId || "guests",
          1080,
        );
        if (fileUrl) attachments.push(fileUrl);
      }

      // 2. Generate a Subject from description (first 50 chars)
      const subject =
        description.length > 50
          ? description.substring(0, 47) + "..."
          : description;

      // 3. Create Ticket in DB
      const ticket = await prisma.supportTicket.create({
        data: {
          subject,
          description,
          type: mapSupportType(support_type),
          priority: "NORMAL",
          status: "OPEN",
          contact_mobile: mobile,
          attachments,
          requester_id: userId,
        },
        include: { requester: true },
      });

      // 4. Notify All Administrators
      const admins = await prisma.user.findMany({
        where: { role: "administrator" },
        select: { id: true },
      });

      // Dispatch notifications to admins using your master notification service
      for (const admin of admins) {
        await notifyUser({
          userId: admin.id,
          title: `Новый тикет #${ticket.ticket_number}`,
          body: `Тип: ${support_type}. От: ${mobile}`,
          type: "SUPPORT_TICKET",
          data: { ticketId: ticket.id, url: "/support" },
        });
      }

      // 5. Notify the User (Auto-Responder)
      if (userId) {
        await notifyUser({
          userId: userId,
          title: "Запрос получен",
          body: `Ваш запрос #${ticket.ticket_number} зарегистрирован. Мы скоро ответим.`,
          type: "SUPPORT_UPDATE",
          data: { ticketId: ticket.id },
        });
      }

      res.status(201).json({ message: "Тикет успешно создан", ticket });
    } catch (error) {
      console.error("Create Ticket Error:", error);
      res.status(500).json({ message: "Ошибка при создании запроса" });
    }
  },
);

// ==========================================
// 2. GET ALL TICKETS (Admin Panel)
// ==========================================
router.get(
  "/all",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const tickets = await prisma.supportTicket.findMany({
        orderBy: { created_at: "desc" },
        include: {
          requester: {
            select: { id: true, name: true, email: true, phone: true },
          },
          // 🚨 FIX: Deep populate to get the name from the Base User attached to the AdminProfile
          assigned_manager: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      });

      // Format for frontend
      const formattedTickets = tickets.map((ticket) => ({
        ...ticket,
        assigned_manager: ticket.assigned_manager
          ? {
              id: ticket.assigned_manager.id,
              name: ticket.assigned_manager.user.name,
            }
          : null,
      }));

      res.status(200).json(formattedTickets);
    } catch (error) {
      console.error("Get All Tickets Error:", error);
      res.status(500).json({ message: "Ошибка при получении тикетов" });
    }
  },
);

// ==========================================
// 3. GET MY TICKETS (User App)
// ==========================================
router.get("/my-tickets", verifyAuth, async (req, res) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { requester_id: req.user.id },
      orderBy: { created_at: "desc" },
    });
    res.status(200).json(tickets);
  } catch (error) {
    console.error("Get My Tickets Error:", error);
    res.status(500).json({ message: "Ошибка при получении ваших тикетов" });
  }
});

// ==========================================
// 4. UPDATE / RESOLVE TICKET (Admin Panel)
// ==========================================
router.patch(
  "/:id",
  verifyAuth,
  requireRole(["administrator"]),
  async (req, res) => {
    try {
      const { status, priority, adminReply, assigned_manager_id } = req.body;
      const ticketId = req.params.id;

      // 1. Fetch current ticket to check state
      const currentTicket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
      });

      if (!currentTicket) {
        return res.status(404).json({ message: "Тикет не найден" });
      }

      // 🚨 FIX: If frontend sends Base User ID for assigned_manager_id, convert it to AdminProfile ID
      let targetAdminProfileId = undefined;
      if (assigned_manager_id) {
        const adminProfile = await prisma.adminProfile.findUnique({
          where: { userId: assigned_manager_id },
        });
        targetAdminProfileId = adminProfile
          ? adminProfile.id
          : assigned_manager_id; // Fallback in case frontend already sends profile ID
      }

      // 2. SLA Tracking Logic (Calculate Timestamps)
      let first_response_at = currentTicket.first_response_at;
      let resolved_at = currentTicket.resolved_at;
      let closed_at = currentTicket.closed_at;
      const safeStatus = status
        ? mapTicketStatus(status)
        : currentTicket.status;
      const now = new Date();

      if (adminReply && !first_response_at) first_response_at = now;

      if (safeStatus === "RESOLVED" && currentTicket.status !== "RESOLVED") {
        resolved_at = now;
      }

      if (safeStatus === "CLOSED" && currentTicket.status !== "CLOSED") {
        closed_at = now;
        if (!resolved_at) resolved_at = now; // Auto-resolve if closed directly
      }

      // 3. Update the DB
      const updatedTicket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: safeStatus,
          priority: priority || undefined,
          assigned_manager_id: targetAdminProfileId, // Uses resolved profile ID
          first_response_at,
          resolved_at,
          closed_at,
        },
        include: {
          requester: true,
          assigned_manager: { include: { user: true } },
        },
      });

      // 4. Handle Admin Reply & Master Notification Dispatch
      if (adminReply && updatedTicket.requester_id) {
        await notifyUser({
          userId: updatedTicket.requester_id,
          title: `Ответ по тикету #${updatedTicket.ticket_number}`,
          body: adminReply,
          type: "SUPPORT_UPDATE",
          data: {
            ticketId: updatedTicket.id,
            status: updatedTicket.status,
            url: `/support/${updatedTicket.id}`,
          },
        });
      }

      res.status(200).json(updatedTicket);
    } catch (error) {
      console.error("Update Ticket Error:", error);
      res.status(500).json({ message: "Ошибка при обновлении тикета" });
    }
  },
);

export default router;
