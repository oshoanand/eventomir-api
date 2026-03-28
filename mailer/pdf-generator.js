import PDFDocument from "pdfkit";

/**
 * Generates a PDF ticket in memory and returns it as a Buffer.
 */
export const generateTicketPDF = (order, event, user) => {
  return new Promise((resolve, reject) => {
    try {
      // Create a document
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];

      // Collect data chunks as they are generated
      doc.on("data", buffers.push.bind(buffers));

      // When the PDF is done, concatenate chunks into a single Buffer
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // --- TICKET DESIGN ---

      // Header
      doc
        .fontSize(25)
        .fillColor("#E11D48")
        .text("Eventomir Ticket", { align: "center" });
      doc.moveDown();

      // Event Info
      doc
        .fontSize(20)
        .fillColor("#000000")
        .text(event.title, { align: "center" });
      doc.moveDown(0.5);

      doc.fontSize(14).fillColor("#4B5563");
      doc.text(
        `Date: ${event.date.toLocaleDateString()} ${event.time ? `at ${event.time}` : ""}`,
      );
      doc.text(`Location: ${event.city}, ${event.address || "TBA"}`);
      doc.moveDown();

      // Order Info
      doc.rect(50, doc.y, 495, 100).stroke("#E5E7EB"); // Draw a box around order details
      doc.moveDown(0.5);

      doc.fontSize(12).fillColor("#000000");
      doc.text(`Order ID: ${order.id}`, 65);
      doc.text(`Ticket Holder: ${user.name}`, 65);
      doc.text(`Number of Tickets: ${order.ticketCount}`, 65);
      doc.text(`Total Price: ${order.totalPrice} RUB`, 65);

      doc.moveDown(3);

      // Footer
      doc
        .fontSize(10)
        .fillColor("#9CA3AF")
        .text(
          "Please present this ticket (digital or printed) at the entrance.",
          { align: "center" },
        );

      // Finalize the PDF
      doc.end();
    } catch (error) {
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
