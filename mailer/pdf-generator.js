import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

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
// export const generateSubscriptionReceiptPDF = (
//   payment,
//   user,
//   plan,
//   amount,
//   interval,
// ) => {
//   return new Promise((resolve, reject) => {
//     try {
//       const doc = new PDFDocument({ size: "A4", margin: 50 });
//       const buffers = [];

//       doc.on("data", buffers.push.bind(buffers));

//       doc.on("end", () => {
//         const pdfData = Buffer.concat(buffers);
//         resolve(pdfData);
//       });

//       // Map interval to readable English text
//       const intervalMap = {
//         month: "1 Month",
//         half_year: "6 Months",
//         year: "1 Year",
//       };
//       const billingPeriod = intervalMap[interval] || interval;

//       const paymentDate = new Date().toLocaleDateString();

//       // --- RECEIPT DESIGN ---

//       // Header
//       doc
//         .fontSize(28)
//         .fillColor("#2563EB") // A professional blue for receipts
//         .text("Eventomir", { align: "left" });

//       doc
//         .fontSize(12)
//         .fillColor("#6B7280")
//         .text("Payment Receipt / Invoice", { align: "left" });
//       doc.moveDown(2);

//       // Customer Details & Invoice Details (Two Columns)
//       const topY = doc.y;

//       // Left Column: Billed To
//       doc.fontSize(10).fillColor("#9CA3AF").text("BILLED TO:", 50, topY);
//       doc
//         .fontSize(12)
//         .fillColor("#111827")
//         .text(user.name || "Customer", 50, topY + 15);
//       doc
//         .fontSize(10)
//         .fillColor("#4B5563")
//         .text(user.email, 50, topY + 30);

//       // Right Column: Receipt Info
//       doc.fontSize(10).fillColor("#9CA3AF").text("RECEIPT DETAILS:", 350, topY);
//       doc
//         .fontSize(10)
//         .fillColor("#4B5563")
//         .text(
//           `Receipt No: ${payment.id.split("-")[0].toUpperCase()}`,
//           350,
//           topY + 15,
//         );
//       doc.text(`Date: ${paymentDate}`, 350, topY + 30);
//       doc.text(`Status: PAID`, 350, topY + 45);

//       doc.moveDown(4);

//       // Table Header
//       const tableTop = doc.y;
//       doc.rect(50, tableTop, 495, 25).fill("#F3F4F6"); // Light gray header background
//       doc.fontSize(10).fillColor("#374151").font("Helvetica-Bold");
//       doc.text("DESCRIPTION", 60, tableTop + 8);
//       doc.text("BILLING PERIOD", 250, tableTop + 8);
//       doc.text("AMOUNT", 450, tableTop + 8);

//       doc.font("Helvetica"); // reset to normal

//       // Table Row
//       const rowTop = tableTop + 35;
//       doc.fontSize(12).fillColor("#111827");
//       doc.text(`Subscription: ${plan?.name || "Premium"} Plan`, 60, rowTop);
//       doc.text(billingPeriod, 250, rowTop);
//       doc.text(`${amount.toLocaleString("ru-RU")} RUB`, 450, rowTop);

//       // Divider Line
//       doc
//         .moveTo(50, rowTop + 25)
//         .lineTo(545, rowTop + 25)
//         .stroke("#E5E7EB");

//       // Total Section
//       doc.fontSize(14).font("Helvetica-Bold");
//       doc.text("TOTAL PAID:", 300, rowTop + 45);
//       doc
//         .fillColor("#10B981")
//         .text(`${amount.toLocaleString("ru-RU")} RUB`, 450, rowTop + 45);
//       doc.font("Helvetica"); // reset to normal

//       doc.moveDown(6);

//       // Footer
//       doc
//         .fontSize(10)
//         .fillColor("#9CA3AF")
//         .text(
//           "Thank you for your subscription! If you have any questions, please contact support.",
//           50,
//           doc.y,
//           { align: "center", width: 495 },
//         );

//       // Finalize the PDF
//       doc.end();
//     } catch (error) {
//       reject(error);
//     }
//   });
// };

export const generateSubscriptionReceiptPDF = async (
  payment,
  user,
  plan,
  amount,
  interval,
) => {
  console.log(payment);
  console.log(user);
  console.log(plan);
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];

      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", (err) => reject(err));

      // --- HEADER ---
      doc
        .fillColor("#2563EB")
        .fontSize(28)
        .font("Helvetica-Bold")
        .text("Eventomir");
      doc
        .fillColor("#6B7280")
        .fontSize(10)
        .font("Helvetica")
        .text("app.eventomir.ru");

      doc.moveDown(2);

      // --- RECEIPT TITLE & META ---
      doc
        .fillColor("#111827")
        .fontSize(20)
        .font("Helvetica-Bold")
        .text("RECEIPT / КВИТАНЦИЯ", { align: "right", continued: true })
        .moveUp();

      doc.fontSize(10).fillColor("#4B5563").font("Helvetica");
      doc.text(`Receipt No: #${payment.id.split("-")[0].toUpperCase()}`, {
        align: "right",
      });
      doc.text(
        `Date: ${new Date(payment.createdAt).toLocaleDateString("ru-RU")}`,
        { align: "right" },
      );
      doc.text(`Status: PAID`, { align: "right" });

      doc.moveDown(3);

      // --- CUSTOMER INFO ---
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#111827")
        .text("BILLED TO:");
      doc.font("Helvetica").fontSize(10).fillColor("#4B5563");
      doc.text(user.name || "Customer");
      doc.text(user.email);
      doc.text(`User ID: ${user.id.slice(0, 8)}...`);

      doc.moveDown(3);

      // --- TABLE HEADER ---
      const tableTop = doc.y;
      doc.rect(50, tableTop, 495, 25).fill("#F3F4F6");

      doc.fillColor("#6B7280").font("Helvetica-Bold").fontSize(10);
      doc.text("DESCRIPTION", 60, tableTop + 8);
      doc.text("INTERVAL", 300, tableTop + 8);
      doc.text("AMOUNT", 450, tableTop + 8, { width: 85, align: "right" });

      // --- TABLE ROW (ITEM) ---
      const itemTop = tableTop + 35;

      const intervalNames = {
        month: "1 Month",
        half_year: "6 Months",
        year: "1 Year",
      };
      const periodLabel = intervalNames[interval] || "Subscription";

      doc.fillColor("#111827").font("Helvetica").fontSize(11);
      doc.text(`Subscription: ${plan.name}`, 60, itemTop);
      doc.text(periodLabel, 300, itemTop);
      doc.text(`${amount.toLocaleString("ru-RU")} RUB`, 450, itemTop, {
        width: 85,
        align: "right",
      });

      doc.moveDown(2);

      // --- TOTALS ---
      doc.moveTo(350, doc.y).lineTo(545, doc.y).stroke("#E5E7EB");
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(14);
      doc.text("TOTAL PAID:", 300, doc.y);
      doc
        .fillColor("#2563EB")
        .text(`${amount.toLocaleString("ru-RU")} RUB`, 400, doc.y, {
          width: 135,
          align: "right",
        });

      // --- FOOTER ---
      doc.moveDown(10);
      doc.fillColor("#9CA3AF").fontSize(9).font("Helvetica-Oblique");
      doc.text(
        "This is an automatically generated electronic receipt.",
        50,
        doc.y,
        { align: "center", width: 495 },
      );
      doc.text("Eventomir LLC | support@eventomir.ru", {
        align: "center",
        width: 495,
      });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

// export const generateB2BInvoicePDF = (order, user, plan) => {
//   return new Promise((resolve, reject) => {
//     try {
//       const doc = new PDFDocument({ margin: 50 });
//       const buffers = [];

//       doc.on("data", buffers.push.bind(buffers));
//       doc.on("end", () => resolve(Buffer.concat(buffers)));

//       // Для поддержки кириллицы необходимо загрузить свой шрифт
//       // doc.font("path/to/Roboto-Regular.ttf");

//       // 1. Реквизиты поставщика (Ваша компания)
//       doc
//         .fontSize(14)
//         .text(
//           "Внимание! Оплата данного счета означает согласие с условиями оферты.",
//           { align: "center" },
//         );
//       doc.moveDown();

//       // Таблица реквизитов (упрощенный пример)
//       doc.fontSize(10);
//       doc.text(`Организация: ООО "АМУЛЕТ КОМПАНИ"`);
//       doc.text(`ИНН: 6319258622`);
//       doc.text(`ОГРН: 1226300038360`);
//       doc.text(`КПП: 1226300038360`);
//       doc.text(`Расчетный счет: 40702810000000000000 `);
//       doc.text(`Наименование банка: АО "ТИНЬКОФФ БАНК"`);
//       doc.text(`БИК: 044525974 `);
//       doc.moveDown();

//       // 2. Заголовок счета
//       doc
//         .fontSize(16)
//         .text(
//           `СЧЕТ НА ОПЛАТУ № ${order.invoiceNumber} от ${new Date().toLocaleDateString("ru-RU")}`,
//           { align: "center" },
//         );
//       doc.moveDown();

//       // 3. Реквизиты покупателя
//       doc.fontSize(10);
//       doc.text(`ПОКУПАТЕЛЬ: ${user.company_name} (ИНН: ${user.inn})`);
//       doc.text(`Адрес: ${user.city || "Не указан"}`);
//       doc.moveDown();

//       // 4. Позиции счета (Таблица)
//       const vatAmount = order.amount * 0.2; // НДС 20%
//       const amountWithoutVat = order.amount - vatAmount;

//       doc.text(`Наименование: Подписка "${plan.name}"`);
//       doc.text(`Количество: 1 шт.`);
//       doc.text(`Сумма без НДС: ${amountWithoutVat.toFixed(2)} руб.`);
//       doc.text(`НДС (20%): ${vatAmount.toFixed(2)} руб.`);
//       doc.text(`Итого к оплате: ${order.amount.toFixed(2)} руб.`);
//       doc.moveDown();

//       // Назначение платежа (КРИТИЧНО ДЛЯ ВЕБХУКОВ)
//       doc
//         .font("Helvetica-Bold")
//         .text(
//           `Назначение платежа: Оплата по счету № ${order.invoiceNumber} за услуги платформы. Без НДС / В т.ч. НДС ${vatAmount.toFixed(2)} руб.`,
//         );

//       // 5. Подписи и печати (можно вставить изображения)
//       // doc.image("path/to/stamp.png", 100, 600, { width: 100 });

//       doc.end();
//     } catch (error) {
//       reject(error);
//     }
//   });
// };

export const generateB2BInvoicePDF = (paymentRecord, user, plan, interval) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // ----------------------------------------------------------------
      // 1. ROBUST FONT LOADING FOR CYRILLIC SUPPORT
      // ----------------------------------------------------------------
      // process.cwd() ensures the path works in production (e.g., Vercel/Docker)
      const fontsDir = path.join(process.cwd(), "public", "fonts");
      const regularFontPath = path.join(fontsDir, "Roboto-Regular.ttf");
      const boldFontPath = path.join(fontsDir, "Roboto-Bold.ttf");

      // Defensive check to prevent silent PDF crashes if fonts are missing
      if (!fs.existsSync(regularFontPath) || !fs.existsSync(boldFontPath)) {
        console.error(
          "🚨 PDF Generation Error: Fonts missing in public/fonts/",
        );
        console.error(
          `Checked Paths:\n- ${regularFontPath}\n- ${boldFontPath}`,
        );
        throw new Error(
          "Не удалось загрузить шрифты (Roboto) для генерации PDF-счета. Пожалуйста, убедитесь, что они находятся в папке public/fonts/.",
        );
      }

      // Register fonts with clean aliases
      doc.registerFont("Roboto", regularFontPath);
      doc.registerFont("Roboto-Bold", boldFontPath);

      // Set default font to our registered Regular font
      doc.font("Roboto");

      // ----------------------------------------------------------------
      // 2. INVOICE HEADER & SUPPLIER REQUISITES
      // ----------------------------------------------------------------
      doc
        .fontSize(14)
        .text(
          "Внимание! Оплата данного счета означает согласие с условиями оферты.",
          { align: "center" },
        );
      doc.moveDown();

      doc.fontSize(10);
      doc.text(`Организация: ООО "АМУЛЕТ КОМПАНИ"`);
      doc.text(`ИНН: 6319258622`);
      doc.text(`ОГРН: 1226300038360`);
      doc.text(`КПП: 1226300038360`);
      doc.text(`Расчетный счет: 40702810000000000000`);
      doc.text(`Наименование банка: АО "ТИНЬКОФФ БАНК"`);
      doc.text(`БИК: 044525974`);
      doc.moveDown();

      // ----------------------------------------------------------------
      // 3. INVOICE TITLE & NUMBER
      // ----------------------------------------------------------------
      // In our updated architecture, the B2B invoice number is stored in providerTxId
      const invoiceNumber = paymentRecord.providerTxId;
      const amount = paymentRecord.amount;

      // Translate interval to Russian for the invoice line item
      const intervalNames = {
        month: "1 мес.",
        half_year: "6 мес.",
        year: "1 год",
      };
      const periodLabel = intervalNames[interval] || "период";

      doc
        .font("Roboto-Bold")
        .fontSize(16)
        .text(
          `СЧЕТ НА ОПЛАТУ № ${invoiceNumber} от ${new Date().toLocaleDateString("ru-RU")}`,
          { align: "center" },
        );
      doc.moveDown();

      // ----------------------------------------------------------------
      // 4. BUYER REQUISITES
      // ----------------------------------------------------------------
      doc.font("Roboto").fontSize(10);
      doc.text(
        `ПОКУПАТЕЛЬ: ${user.company_name || "Не указано"} (ИНН: ${user.inn || "Не указан"})`,
      );
      doc.text(`Адрес: ${user.city || "Не указан"}`);
      doc.moveDown();

      // ----------------------------------------------------------------
      // 5. INVOICE ITEMS (TABLE REPLACEMENT)
      // ----------------------------------------------------------------
      const vatAmount = amount * 0.2; // 20% VAT
      const amountWithoutVat = amount - vatAmount;

      doc.text(
        `Наименование: Корпоративная подписка "${plan.name}" (${periodLabel})`,
      );
      doc.text(`Количество: 1 шт.`);
      doc.text(`Сумма без НДС: ${amountWithoutVat.toFixed(2)} руб.`);
      doc.text(`НДС (20%): ${vatAmount.toFixed(2)} руб.`);

      doc.font("Roboto-Bold");
      doc.text(`Итого к оплате: ${amount.toFixed(2)} руб.`);
      doc.moveDown();

      // ----------------------------------------------------------------
      // 6. PAYMENT PURPOSE (CRITICAL FOR BANK WEBHOOKS)
      // ----------------------------------------------------------------
      // The buyer MUST put this exact string in their wire transfer description
      // so our webhook (handleTinkoffB2BSubscriptionPurchase) can parse the INV- number.
      doc.text(
        `Назначение платежа: Оплата по счету № ${invoiceNumber} за услуги платформы. В т.ч. НДС ${vatAmount.toFixed(2)} руб.`,
      );

      // Optional: Add Stamp/Signature images here
      // const stampPath = path.join(process.cwd(), "public", "images", "stamp.png");
      // if (fs.existsSync(stampPath)) {
      //   doc.image(stampPath, 100, 600, { width: 100 });
      // }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};
