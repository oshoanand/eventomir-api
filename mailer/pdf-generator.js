// utils/pdf-generator.js
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
