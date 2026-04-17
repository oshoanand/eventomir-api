import PDFDocument from "pdfkit";
import QRCode from "qrcode";

/**
 * Generates a PDF ticket in memory and returns it as a Buffer.
 * Supports both 'Order' (Paid) and 'Invitation' (Free) objects.
 */
export const generateTicketPDF = async (order, event, user) => {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];

      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", (err) => reject(err));

      // --- DATA PREPARATION ---
      // Handle both Order (ticketCode) and Invitation (ticketToken)
      const secretToken = order.ticketCode || order.ticketToken || order.id;
      const ticketCount = order.ticketCount || 1;
      const priceText = order.totalPrice
        ? `${order.totalPrice} RUB`
        : "FREE (RSVP)";

      // Ensure date is a valid Date object
      const eventDate = new Date(event.date);
      const formattedDate = isNaN(eventDate.getTime())
        ? "Date TBA"
        : eventDate.toLocaleDateString("ru-RU");

      // --- TICKET DESIGN ---

      // Logo/Header
      doc
        .fillColor("#2563EB")
        .fontSize(28)
        .font("Helvetica-Bold")
        .text("Eventomir", { align: "center" });

      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text("app.eventomir.ru", { align: "center" });

      doc.moveDown(2);

      // Event Title
      doc
        .fillColor("#000000")
        .fontSize(22)
        .font("Helvetica-Bold")
        .text(event.title, { align: "center" });

      doc.moveDown(1);

      // Info Section
      doc.font("Helvetica").fontSize(12).fillColor("#4B5563");
      doc.text(
        `Date: ${formattedDate} ${event.time ? `at ${event.time}` : ""}`,
        { align: "center" },
      );
      doc.text(
        `Location: ${event.city}${event.address ? `, ${event.address}` : ""}`,
        { align: "center" },
      );

      doc.moveDown(2);

      // --- TICKET BOX ---
      const boxTop = doc.y;
      const boxHeight = 130;

      // Draw Box Background
      doc
        .roundedRect(50, boxTop, 495, boxHeight, 10)
        .fillAndStroke("#F9FAFB", "#E5E7EB");

      // Text inside box
      doc.fillColor("#000000");

      // Left Column
      const textX = 70;
      const textY = boxTop + 20;

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("TICKET HOLDER", textX, textY);
      doc
        .font("Helvetica")
        .fontSize(12)
        .text(user.name || "Guest", textX, textY + 15);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("ORDER ID", textX, textY + 45);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`#${order.id.slice(0, 8).toUpperCase()}`, textX, textY + 60);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("QUANTITY", textX + 180, textY + 45);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`${ticketCount} Ticket(s)`, textX + 180, textY + 60);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("PRICE", textX, textY + 85);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(priceText, textX, textY + 100);

      // --- QR CODE ---
      // Generate QR
      const qrBuffer = await QRCode.toBuffer(secretToken, {
        errorCorrectionLevel: "H",
        margin: 1,
        color: {
          dark: "#000000",
          light: "#F9FAFB", // Match box background
        },
      });

      // Embed QR (Right aligned in box)
      doc.image(qrBuffer, 430, boxTop + 15, { width: 100 });

      // Footer
      doc.moveDown(8);
      doc
        .fontSize(10)
        .fillColor("#9CA3AF")
        .font("Helvetica-Oblique")
        .text(
          "This ticket is unique. Please show the QR code at the entrance.",
          {
            align: "center",
            width: 400,
          },
        );

      // Finalize
      doc.end();
    } catch (error) {
      console.error("PDF Generation Error:", error);
      reject(error);
    }
  });
};
/**
 * Generates a PDF Receipt/Invoice for Subscription Purchases.
 */
export const generateSubscriptionReceiptPDF = (
  payment,
  user,
  plan,
  amount,
  interval,
) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));

      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Map interval to readable English text
      const intervalMap = {
        month: "1 Month",
        half_year: "6 Months",
        year: "1 Year",
      };
      const billingPeriod = intervalMap[interval] || interval;

      const paymentDate = new Date().toLocaleDateString();

      // --- RECEIPT DESIGN ---

      // Header
      doc
        .fontSize(28)
        .fillColor("#2563EB") // A professional blue for receipts
        .text("Eventomir", { align: "left" });

      doc
        .fontSize(12)
        .fillColor("#6B7280")
        .text("Payment Receipt / Invoice", { align: "left" });
      doc.moveDown(2);

      // Customer Details & Invoice Details (Two Columns)
      const topY = doc.y;

      // Left Column: Billed To
      doc.fontSize(10).fillColor("#9CA3AF").text("BILLED TO:", 50, topY);
      doc
        .fontSize(12)
        .fillColor("#111827")
        .text(user.name || "Customer", 50, topY + 15);
      doc
        .fontSize(10)
        .fillColor("#4B5563")
        .text(user.email, 50, topY + 30);

      // Right Column: Receipt Info
      doc.fontSize(10).fillColor("#9CA3AF").text("RECEIPT DETAILS:", 350, topY);
      doc
        .fontSize(10)
        .fillColor("#4B5563")
        .text(
          `Receipt No: ${payment.id.split("-")[0].toUpperCase()}`,
          350,
          topY + 15,
        );
      doc.text(`Date: ${paymentDate}`, 350, topY + 30);
      doc.text(`Status: PAID`, 350, topY + 45);

      doc.moveDown(4);

      // Table Header
      const tableTop = doc.y;
      doc.rect(50, tableTop, 495, 25).fill("#F3F4F6"); // Light gray header background
      doc.fontSize(10).fillColor("#374151").font("Helvetica-Bold");
      doc.text("DESCRIPTION", 60, tableTop + 8);
      doc.text("BILLING PERIOD", 250, tableTop + 8);
      doc.text("AMOUNT", 450, tableTop + 8);

      doc.font("Helvetica"); // reset to normal

      // Table Row
      const rowTop = tableTop + 35;
      doc.fontSize(12).fillColor("#111827");
      doc.text(`Subscription: ${plan?.name || "Premium"} Plan`, 60, rowTop);
      doc.text(billingPeriod, 250, rowTop);
      doc.text(`${amount.toLocaleString("ru-RU")} RUB`, 450, rowTop);

      // Divider Line
      doc
        .moveTo(50, rowTop + 25)
        .lineTo(545, rowTop + 25)
        .stroke("#E5E7EB");

      // Total Section
      doc.fontSize(14).font("Helvetica-Bold");
      doc.text("TOTAL PAID:", 300, rowTop + 45);
      doc
        .fillColor("#10B981")
        .text(`${amount.toLocaleString("ru-RU")} RUB`, 450, rowTop + 45);
      doc.font("Helvetica"); // reset to normal

      doc.moveDown(6);

      // Footer
      doc
        .fontSize(10)
        .fillColor("#9CA3AF")
        .text(
          "Thank you for your subscription! If you have any questions, please contact support.",
          50,
          doc.y,
          { align: "center", width: 495 },
        );

      // Finalize the PDF
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};
