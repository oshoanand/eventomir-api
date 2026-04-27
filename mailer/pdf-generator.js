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

export const generateSubscriptionReceiptPDF = async (
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

// ----------------------------------------------------------------
// HELPER: Convert number to Russian words for the invoice footer
// ----------------------------------------------------------------
const numberToWordsRu = (number) => {
  const units = [
    "",
    "один",
    "два",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
  ];
  const unitsFemale = [
    "",
    "одна",
    "две",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
  ];
  const teens = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
  ];
  const tens = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
  ];
  const hundreds = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
  ];

  const getThousandths = (n) => {
    let result = "";
    const h = Math.floor(n / 100);
    const t = Math.floor((n % 100) / 10);
    const u = n % 10;

    if (h > 0) result += hundreds[h] + " ";
    if (t === 1) result += teens[u] + " ";
    else {
      if (t > 1) result += tens[t] + " ";
      if (u > 0) result += unitsFemale[u] + " ";
    }
    return result.trim();
  };

  let numStr = Math.floor(number);
  const kopecks = Math.round((number - numStr) * 100)
    .toString()
    .padStart(2, "0");

  if (numStr === 0) return `Ноль рублей ${kopecks} копеек`;

  let words = "";
  const thousands = Math.floor(numStr / 1000);
  const remainder = numStr % 1000;

  if (thousands > 0) {
    words += getThousandths(thousands) + " ";
    const lastDigit = thousands % 10;
    const lastTwo = thousands % 100;
    if (lastTwo >= 11 && lastTwo <= 14) words += "тысяч ";
    else if (lastDigit === 1) words += "тысяча ";
    else if (lastDigit >= 2 && lastDigit <= 4) words += "тысячи ";
    else words += "тысяч ";
  }

  if (remainder > 0) {
    const h = Math.floor(remainder / 100);
    const t = Math.floor((remainder % 100) / 10);
    const u = remainder % 10;

    if (h > 0) words += hundreds[h] + " ";
    if (t === 1) words += teens[u] + " ";
    else {
      if (t > 1) words += tens[t] + " ";
      if (u > 0) words += units[u] + " ";
    }
  }

  words = words.trim();
  words = words.charAt(0).toUpperCase() + words.slice(1);

  const lastDigit = numStr % 10;
  const lastTwo = numStr % 100;
  let currency = "рублей";
  if (lastTwo < 11 || lastTwo > 14) {
    if (lastDigit === 1) currency = "рубль";
    else if (lastDigit >= 2 && lastDigit <= 4) currency = "рубля";
  }

  return `${words} ${currency} ${kopecks} копеек`;
};

// ----------------------------------------------------------------
// MAIN FUNCTION
// ----------------------------------------------------------------
export const generateB2BInvoicePDF = (paymentRecord, user, plan, interval) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // 1. FONT CONFIGURATION
      const fontsDir = path.join(process.cwd(), "public", "fonts");
      const regularFontPath = path.join(fontsDir, "Roboto-Regular.ttf");
      const boldFontPath = path.join(fontsDir, "Roboto-Bold.ttf");

      if (!fs.existsSync(regularFontPath) || !fs.existsSync(boldFontPath)) {
        throw new Error("Не удалось загрузить шрифты Roboto из public/fonts/");
      }

      doc.registerFont("Roboto", regularFontPath);
      doc.registerFont("Roboto-Bold", boldFontPath);
      doc.font("Roboto");

      // 2. BANK DETAILS GRID (Mimicking 1C Layout)
      doc.lineWidth(1);
      const startX = 40;
      let startY = 40;

      // Draw outer box
      doc.rect(startX, startY, 515, 75).stroke();
      // Draw internal grid lines
      doc
        .moveTo(300, startY)
        .lineTo(300, startY + 75)
        .stroke();
      doc
        .moveTo(startX, startY + 35)
        .lineTo(300, startY + 35)
        .stroke();
      doc
        .moveTo(300, startY + 25)
        .lineTo(555, startY + 25)
        .stroke();
      doc
        .moveTo(170, startY + 35)
        .lineTo(170, startY + 50)
        .stroke();
      doc
        .moveTo(startX, startY + 50)
        .lineTo(300, startY + 50)
        .stroke();

      doc.fontSize(8);
      // Top Left Cell
      doc.text("ПОВОЛЖСКИЙ БАНК Т-Банк г. Самара", startX + 5, startY + 5);
      doc.text("Банк получателя", startX + 5, startY + 25);

      // Top Right Cells
      doc.text("БИК", 305, startY + 5);
      doc.text("043601607", 340, startY + 5);
      doc.text("Сч. №", 305, startY + 15);
      doc.text("30101810200000000607", 340, startY + 15);

      // Middle Left Cells
      doc.text("ИНН 6319258622", startX + 5, startY + 40);
      doc.text("КПП 631901001", 175, startY + 40);

      // Bottom Right Cell
      doc.text("Сч. №", 305, startY + 30);
      doc.text("40802810054400037540", 340, startY + 30);

      // Bottom Left Cell
      doc.text("ООО АМУЛЕТ КОМПАНИ", startX + 5, startY + 55);
      doc.text("Получатель", startX + 5, startY + 65);

      startY += 100;

      // 3. INVOICE TITLE
      const invoiceNumber =
        paymentRecord.providerTxId || `B2B-${paymentRecord.id.substring(0, 6)}`;
      const dateStr = new Date().toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });

      doc.font("Roboto-Bold").fontSize(14);
      doc.text(
        `Счет на оплату № ${invoiceNumber} от ${dateStr} `,
        startX,
        startY,
      );
      doc
        .moveTo(startX, startY + 20)
        .lineTo(555, startY + 20)
        .lineWidth(2)
        .stroke();

      startY += 35;

      // 4. PARTIES INFO
      doc.fontSize(10);
      const supplierText =
        "ООО АМУЛЕТ КОМПАНИ, ИНН 6319258622, КПП 631901001, 443052, Самарская Область, г.о. Самара, вн.р-н Промышленный, г Самара, пер Льговский, дом 21, офис 3";
      const buyerText = `${user.company_name || "ООО Покупатель"}, ИНН ${user.inn || "Не указан"}, КПП ${user.kpp || "Не указан"}, ${user.city} г, ${user.address || ""} `;

      doc.font("Roboto-Bold").text("Поставщик", startX, startY);
      doc.text("(Исполнитель):", startX, startY + 12);
      doc
        .font("Roboto")
        .text(supplierText, startX + 85, startY, { width: 430 });

      startY += 35;
      doc.font("Roboto-Bold").text("Покупатель", startX, startY);
      doc.text("(Заказчик):", startX, startY + 12);
      doc.font("Roboto").text(buyerText, startX + 85, startY, { width: 430 });

      startY += 35;
      doc.font("Roboto-Bold").text("Основание:", startX, startY);
      doc.font("Roboto").text("Основной договор", startX + 85, startY);

      startY += 30;

      // 5. ITEMS TABLE
      const intervalNames = {
        month: "1 мес.",
        half_year: "6 мес.",
        year: "1 год",
      };
      const periodLabel = intervalNames[interval] || "период";
      const itemName = `Корпоративная подписка "${plan?.name || "Платформа"}" (${periodLabel})`;
      const amountStr = paymentRecord.amount.toFixed(2);

      // Table Header
      doc.lineWidth(1).rect(startX, startY, 515, 20).stroke();
      doc
        .moveTo(70, startY)
        .lineTo(70, startY + 20)
        .stroke();
      doc
        .moveTo(350, startY)
        .lineTo(350, startY + 20)
        .stroke();
      doc
        .moveTo(400, startY)
        .lineTo(400, startY + 20)
        .stroke();
      doc
        .moveTo(440, startY)
        .lineTo(440, startY + 20)
        .stroke();
      doc
        .moveTo(490, startY)
        .lineTo(490, startY + 20)
        .stroke();

      doc.font("Roboto-Bold").fontSize(9);
      doc.text("№", startX + 5, startY + 5);
      doc.text("Товары (работы, услуги)", 75, startY + 5);
      doc.text("Кол-во", 355, startY + 5);
      doc.text("Ед.", 405, startY + 5);
      doc.text("Цена", 445, startY + 5);
      doc.text("Сумма", 495, startY + 5);

      startY += 20;

      // Table Row
      doc.rect(startX, startY, 515, 20).stroke();
      doc
        .moveTo(70, startY)
        .lineTo(70, startY + 20)
        .stroke();
      doc
        .moveTo(350, startY)
        .lineTo(350, startY + 20)
        .stroke();
      doc
        .moveTo(400, startY)
        .lineTo(400, startY + 20)
        .stroke();
      doc
        .moveTo(440, startY)
        .lineTo(440, startY + 20)
        .stroke();
      doc
        .moveTo(490, startY)
        .lineTo(490, startY + 20)
        .stroke();

      doc.font("Roboto").fontSize(9);
      doc.text("1", startX + 5, startY + 5);
      doc.text(itemName, 75, startY + 5, {
        width: 270,
        height: 15,
        ellipsis: true,
      });
      doc.text("1", 355, startY + 5);
      doc.text("Усл", 405, startY + 5);
      doc.text(amountStr, 445, startY + 5);
      doc.text(amountStr, 495, startY + 5);

      startY += 30;

      // 6. TOTALS
      doc.font("Roboto-Bold").fontSize(10);
      doc.text("Итого:", 445, startY);
      doc.text(amountStr, 495, startY);
      startY += 15;
      doc.text("Без налога (НДС)", 445, startY);
      startY += 15;
      doc.text("Всего к оплате:", 405, startY);
      doc.text(amountStr, 495, startY);

      startY += 25;

      // 7. FOOTER SUMMARY
      doc.font("Roboto").fontSize(10);
      doc.text(
        `Всего наименований 1, на сумму ${amountStr} руб.`,
        startX,
        startY,
      );
      startY += 15;
      doc.font("Roboto-Bold");
      doc.text(numberToWordsRu(paymentRecord.amount), startX, startY);

      startY += 15;
      doc.moveTo(startX, startY).lineTo(555, startY).lineWidth(1).stroke();
      startY += 15;

      // 8. TERMS & CONDITIONS
      doc.font("Roboto").fontSize(9);
      doc.text(
        "Оплата данного счета означает согласие с условиями поставки товара.",
        startX,
        startY,
      );
      startY += 15;
      doc.text(
        "Уведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе.",
        startX,
        startY,
      );
      startY += 15;
      doc.text(
        "Товар отпускается по факту прихода денег на р/с Поставщика, самовывозом, при наличии доверенности и паспорта.",
        startX,
        startY,
      );

      startY += 40;

      // 9. SIGNATURE
      doc.font("Roboto-Bold").fontSize(10);
      doc.text("Предприниматель", startX, startY);
      doc
        .moveTo(startX + 100, startY + 10)
        .lineTo(startX + 250, startY + 10)
        .stroke(); // Signature line
      doc.text("ООО АМУЛЕТ КОМПАНИ", startX + 260, startY);

      doc.end();
    } catch (error) {
      console.log(error);
      reject(error);
    }
  });
};

// export const generateB2BInvoicePDF = (paymentRecord, user, plan, interval) => {
//   return new Promise((resolve, reject) => {
//     try {
//       const doc = new PDFDocument({ margin: 50 });
//       const buffers = [];

//       doc.on("data", buffers.push.bind(buffers));
//       doc.on("end", () => resolve(Buffer.concat(buffers)));

//       // ----------------------------------------------------------------
//       // 1. ROBUST FONT LOADING FOR CYRILLIC SUPPORT
//       // ----------------------------------------------------------------
//       // process.cwd() ensures the path works in production (e.g., Vercel/Docker)
//       const fontsDir = path.join(process.cwd(), "public", "fonts");
//       const regularFontPath = path.join(fontsDir, "Roboto-Regular.ttf");
//       const boldFontPath = path.join(fontsDir, "Roboto-Bold.ttf");

//       // Defensive check to prevent silent PDF crashes if fonts are missing
//       if (!fs.existsSync(regularFontPath) || !fs.existsSync(boldFontPath)) {
//         console.error(
//           "🚨 PDF Generation Error: Fonts missing in public/fonts/",
//         );
//         console.error(
//           `Checked Paths:\n- ${regularFontPath}\n- ${boldFontPath}`,
//         );
//         throw new Error(
//           "Не удалось загрузить шрифты (Roboto) для генерации PDF-счета. Пожалуйста, убедитесь, что они находятся в папке public/fonts/.",
//         );
//       }

//       // Register fonts with clean aliases
//       doc.registerFont("Roboto", regularFontPath);
//       doc.registerFont("Roboto-Bold", boldFontPath);

//       // Set default font to our registered Regular font
//       doc.font("Roboto");

//       // ----------------------------------------------------------------
//       // 2. INVOICE HEADER & SUPPLIER REQUISITES
//       // ----------------------------------------------------------------
//       doc
//         .fontSize(14)
//         .text(
//           "Внимание! Оплата данного счета означает согласие с условиями оферты.",
//           { align: "center" },
//         );
//       doc.moveDown();

//       doc.fontSize(10);
//       doc.text(`Организация: ООО "АМУЛЕТ КОМПАНИ"`);
//       doc.text(`ИНН: 6319258622`);
//       doc.text(`ОГРН: 1226300038360`);
//       doc.text(`КПП: 1226300038360`);
//       doc.text(`Расчетный счет: 40702810000000000000`);
//       doc.text(`Наименование банка: АО "ТИНЬКОФФ БАНК"`);
//       doc.text(`БИК: 044525974`);
//       doc.moveDown();

//       // ----------------------------------------------------------------
//       // 3. INVOICE TITLE & NUMBER
//       // ----------------------------------------------------------------
//       // In our updated architecture, the B2B invoice number is stored in providerTxId
//       const invoiceNumber = paymentRecord.providerTxId;
//       const amount = paymentRecord.amount;

//       // Translate interval to Russian for the invoice line item
//       const intervalNames = {
//         month: "1 мес.",
//         half_year: "6 мес.",
//         year: "1 год",
//       };
//       const periodLabel = intervalNames[interval] || "период";

//       doc
//         .font("Roboto-Bold")
//         .fontSize(16)
//         .text(
//           `СЧЕТ НА ОПЛАТУ № ${invoiceNumber} от ${new Date().toLocaleDateString("ru-RU")}`,
//           { align: "center" },
//         );
//       doc.moveDown();

//       // ----------------------------------------------------------------
//       // 4. BUYER REQUISITES
//       // ----------------------------------------------------------------
//       doc.font("Roboto").fontSize(10);
//       doc.text(
//         `ПОКУПАТЕЛЬ: ${user.company_name || "Не указано"} (ИНН: ${user.inn || "Не указан"})`,
//       );
//       doc.text(`Адрес: ${user.city || "Не указан"}`);
//       doc.moveDown();

//       // ----------------------------------------------------------------
//       // 5. INVOICE ITEMS (TABLE REPLACEMENT)
//       // ----------------------------------------------------------------
//       const vatAmount = amount * 0.2; // 20% VAT
//       const amountWithoutVat = amount - vatAmount;

//       doc.text(
//         `Наименование: Корпоративная подписка "${plan.name}" (${periodLabel})`,
//       );
//       doc.text(`Количество: 1 шт.`);
//       doc.text(`Сумма без НДС: ${amountWithoutVat.toFixed(2)} руб.`);
//       doc.text(`НДС (20%): ${vatAmount.toFixed(2)} руб.`);

//       doc.font("Roboto-Bold");
//       doc.text(`Итого к оплате: ${amount.toFixed(2)} руб.`);
//       doc.moveDown();

//       // ----------------------------------------------------------------
//       // 6. PAYMENT PURPOSE (CRITICAL FOR BANK WEBHOOKS)
//       // ----------------------------------------------------------------
//       // The buyer MUST put this exact string in their wire transfer description
//       // so our webhook (handleTinkoffB2BSubscriptionPurchase) can parse the INV- number.
//       doc.text(
//         `Назначение платежа: Оплата по счету № ${invoiceNumber} за услуги платформы. В т.ч. НДС ${vatAmount.toFixed(2)} руб.`,
//       );

//       // Optional: Add Stamp/Signature images here
//       // const stampPath = path.join(process.cwd(), "public", "images", "stamp.png");
//       // if (fs.existsSync(stampPath)) {
//       //   doc.image(stampPath, 100, 600, { width: 100 });
//       // }

//       doc.end();
//     } catch (error) {
//       reject(error);
//     }
//   });
// };
