import { Router } from "express";
import prisma from "../libs/prisma.js";
import { fetchCached } from "../libs/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { generateTicketPDF } from "../mailer/pdf-generator.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const dbQuery = () =>
      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          event: { select: { title: true, date: true } },
        },
      });

    const orders = await fetchCached("orders", "all", dbQuery);
    res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// GET /api/orders/my (Secure endpoint for logged-in user)
router.get("/my", verifyAuth, async (req, res, next) => {
  try {
    // SECURITY: Get ID from the verified token, NOT from req.query or req.body
    const userId = req.user.id;

    const orders = await prisma.order.findMany({
      where: { userId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            time: true,
            city: true,
            address: true,
            imageUrl: true,
          },
        },
      },
    });

    res.json(orders);
  } catch (error) {
    console.error("Error fetching user orders:", error);
    res.status(500).json({ message: "Failed to fetch your tickets" });
  }
});

router.get("/:id/pdf", verifyAuth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user.id;

    // Fetch the order, event, and user data
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    // Security Check: Only the ticket buyer can download this ticket
    if (!order || order.userId !== userId) {
      return res
        .status(404)
        .json({ message: "Order not found or unauthorized" });
    }

    if (order.status !== "PAYMENT_SUCCESS" && order.status !== "ACTIVE") {
      return res.status(400).json({ message: "Ticket is not fully paid yet" });
    }

    // Generate the PDF using your existing logic
    const pdfBuffer = await generateTicketPDF(order, order.event, order.user);

    // Send the buffer directly as a PDF file
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ticket-${order.id}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Failed to fetch ticket PDF:", error);
    res.status(500).json({ message: "Failed to generate PDF" });
  }
});

export default router;
