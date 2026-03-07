import { Router } from "express";
import {
  getPlans,
  initiateCheckout,
  handleMockSuccess,
  handlePaymentSuccess,
  getRequestPrice,
} from "../controllers/payment.js";
import { verifyAuth } from "../middleware/verify-auth.js";
import { generateTinkoffToken } from "../utils/tinkoff.js";
import { generateTicketPDF } from "../mailer/pdf-generator.js";
import { sendTicketEmail } from "../mailer/email-sender.js";

const router = Router();

// Public: Get all plans
router.get("/plans", getPlans);

// Protected: Start payment
router.post("/checkout", verifyAuth, initiateCheckout);

// Public (Callback): Handle success redirect
// Note: verifyAuth is NOT used here because this request comes from the "Payment Provider" redirect
// Validation relies on the providerTxId (txId)
router.get("/mock-success", handleMockSuccess);
router.get("/request-price", getRequestPrice);

router.post("/tinkoff-webhook", async (req, res) => {
  try {
    const notification = req.body;

    // 1. Verify the signature (Token) to ensure the request is actually from Tinkoff
    const expectedToken = generateTinkoffToken(notification);
    if (expectedToken !== notification.Token) {
      console.error("Tinkoff Webhook Security Alert: Invalid Token");
      return res.status(403).send("OK"); // Return OK so Tinkoff stops retrying
    }

    const orderId = notification.OrderId;
    const status = notification.Status; // e.g., "CONFIRMED", "REJECTED", "CANCELED"

    // Fetch the existing pending order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { event: true, user: true },
    });

    if (!order) return res.status(200).send("OK");
    if (order.status === "completed") return res.status(200).send("OK"); // Already processed

    // 3. Handle Status Changes
    if (status === "CONFIRMED") {
      // Payment Successful!
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "completed" },
      });

      // Invalidate caches so the UI updates
      await invalidateKeys([
        "events:all",
        `events:${order.eventId}`,
        "orders:all",
        "orders:my",
      ]);

      // Generate PDF and send Email
      try {
        const pdfBuffer = await generateTicketPDF(
          order,
          order.event,
          order.user,
        );
        await sendTicketEmail(
          order.user.email,
          order.user.name,
          order.event.title,
          pdfBuffer,
        );
      } catch (err) {
        console.error("Failed to send ticket email post-purchase", err);
      }
    } else if (
      status === "REJECTED" ||
      status === "CANCELED" ||
      status === "DEADLINE_EXPIRED"
    ) {
      // Payment Failed or Expired. We must release the reserved tickets back to the pool.
      await prisma.$transaction([
        prisma.order.update({
          where: { id: orderId },
          data: { status: "cancelled" },
        }),
        prisma.event.update({
          where: { id: order.eventId },
          data: { availableTickets: { increment: order.ticketCount } },
        }),
      ]);
      await invalidateKeys(["events:all", `events:${order.eventId}`]);
    }

    // Always return "OK" with 200 status to Tinkoff, otherwise they will relentlessly retry the webhook
    res.status(200).send("OK");
  } catch (error) {
    console.error("Tinkoff Webhook Error:", error);
    res.status(500).send("OK");
  }
});

export default router;
