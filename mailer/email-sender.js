import nodemailer from "nodemailer";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure Yandex Transporter
const transporter = nodemailer.createTransport({
  host: "smtp.yandex.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Reads an HTML file and replaces placeholders safely
 */
const getTemplate = (templateName, data) => {
  const templatePath = join(__dirname, "templates", `${templateName}.html`);

  // Read the file synchronously
  let htmlContent = fs.readFileSync(templatePath, "utf8");

  // Replace placeholders dynamically safely
  Object.keys(data).forEach((key) => {
    const regex = new RegExp(`{{${key}}}`, "g");

    // Ensure we don't print "undefined" or "null" in the email
    const replacementValue =
      data[key] !== null && data[key] !== undefined ? data[key] : "";

    htmlContent = htmlContent.replace(regex, replacementValue);
  });

  return htmlContent;
};

/**
 * Sends a verification email to the user.
 * @param {string} toEmail - The recipient's email address.
 * @param {string} userName - The recipient's name.
 * @param {string} token - The unique verification token.
 */
const sendVerificationEmail = async (toEmail, userName, token) => {
  try {
    // 1. Construct the verification link
    const verificationLink = `${process.env.WEB_APP_URL}/verify-email?token=${token}`;

    // 2. Load and populate the HTML template
    const htmlEmail = getTemplate("verification-email", {
      name: userName,
      link: verificationLink,
    });

    // 3. Define email options
    const mailOptions = {
      from: `"Eventomir " <${process.env.EMAIL_USER}>`, // Sender address
      to: toEmail, // Receiver address
      subject:
        "Добро пожаловать! Пожалуйста, подтвердите свой адрес электронной почты.", // Subject line
      html: htmlEmail, // HTML body
    };

    // 4. Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Verification email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendVerificationEmail:", error);
    // We re-throw the error so the calling function knows it failed
    throw new Error(`Failed to send email: ${error.message}`);
  }
};

/**
 * Sends a moderation status update email to the user.
 * @param {string} toEmail - The recipient's email address.
 * @param {string} userName - The recipient's name.
 * @param {string} status - The new moderation status ('approved', 'rejected', 'pending_approval').
 */
const sendModerationStatusEmail = async (toEmail, userName, status) => {
  try {
    const profileLink = `${process.env.WEB_APP_URL}/performer-profile`; // Or /customer-profile based on role logic if needed

    let subject = "";
    let statusText = "";
    let messageText = "";

    // Customize content based on status
    switch (status) {
      case "approved":
        subject = "Ваш профиль успешно подтвержден! 🎉";
        statusText = "✅ Одобрен";
        messageText =
          "Поздравляем! Ваш профиль прошел модерацию. Теперь ваша анкета видна заказчикам, и вы можете получать заявки на бронирование.";
        break;
      case "rejected":
        subject = "Ваш профиль требует доработки";
        statusText = "❌ Отклонен / На доработке";
        messageText =
          "К сожалению, ваш профиль не прошел модерацию. Пожалуйста, проверьте заполненные данные, фото и описание на соответствие правилам сервиса и отправьте профиль на повторную проверку.";
        break;
      case "pending_approval":
        subject = "Ваш профиль на проверке";
        statusText = "⏳ На проверке";
        messageText =
          "Ваш профиль был отправлен на модерацию. Мы уведомим вас, как только проверка будет завершена.";
        break;
      default:
        return false; // Don't send email for unknown statuses
    }

    // Load template
    const htmlEmail = getTemplate("moderation-status-email", {
      name: userName || "Пользователь",
      status_text: statusText,
      message_text: messageText,
      link: profileLink,
    });

    const mailOptions = {
      from: `"Eventomir Support" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: subject,
      html: htmlEmail,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Moderation email sent to ${toEmail}. Status: ${status}. MsgID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendModerationStatusEmail:", error);
    // Log error but don't crash application flow
    return false;
  }
};

const sendResetPasswordLinkEmail = async (link, toEmail, userName) => {
  try {
    //  Load and populate the HTML template
    const htmlEmail = getTemplate("reset-password", {
      name: userName,
      link: link,
    });

    // 3. Define email options
    const mailOptions = {
      from: `"Eventomir" <${process.env.EMAIL_USER}>`, // Sender address
      to: toEmail, // Receiver address
      subject: "Eventomir | Ссылка для сброса пароля", // Subject line
      html: htmlEmail, // HTML body
    };

    // 4. Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `password reset link email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendResetPasswordLinkEmail:", error);
    // We re-throw the error so the calling function knows it failed
    throw new Error(`Failed to send email: ${error.message}`);
  }
};

/**
 * Sends a welcome/confirmation email to a prospective partner.
 * @param {string} toEmail - The prospective partner's email address.
 * @param {string} userName - The prospective partner's name.
 */
const sendPartnerWelcomeEmail = async (toEmail, userName) => {
  try {
    // 1. Load and populate the HTML template
    const htmlEmail = getTemplate("partner-welcome-email", {
      name: userName,
    });

    // 2. Define email options
    const mailOptions = {
      from: `"Eventomir Partners" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Ваша заявка на партнерство получена | Eventomir",
      html: htmlEmail,
    };

    // 3. Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Partner welcome email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendPartnerWelcomeEmail:", error);
    // We don't want to crash the request flow if the email fails,
    // so we return false instead of throwing.
    return false;
  }
};

/**
 * Sends an approval email with login credentials to the new partner.
 * @param {string} toEmail - The partner's email address.
 * @param {string} userName - The partner's name.
 * @param {string} tempPassword - The auto-generated temporary password.
 */
const sendPartnerApprovalEmail = async (toEmail, userName, tempPassword) => {
  try {
    // The URL where partners log in (e.g., your Partner Dashboard project URL)
    const loginLink = `${process.env.PARTNER_DASHBOARD_URL || process.env.WEB_APP_URL}/login`;

    // 1. Load and populate the HTML template
    const htmlEmail = getTemplate("partner-approval-email", {
      name: userName,
      email: toEmail,
      password: tempPassword,
      loginLink: loginLink,
    });

    // 2. Define email options
    const mailOptions = {
      from: `"Eventomir Partners" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Ваша заявка одобрена! Доступы в кабинет партнера",
      html: htmlEmail,
    };

    // 3. Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Partner approval email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendPartnerApprovalEmail:", error);
    return false; // Return false so it doesn't crash the admin approval flow
  }
};

/**
 * Sends an email with the attached PDF ticket.
 * @param {string} toEmail - The buyer's email address.
 * @param {string} userName - The buyer's name.
 * @param {string} eventName - The name of the event.
 * @param {Buffer} pdfBuffer - The generated PDF file in memory.
 */
const sendTicketEmail = async (toEmail, userName, eventName, pdfBuffer) => {
  try {
    // Note: You must create a 'ticket-email.html' inside your templates folder.
    // E.g. "<h1>Hello {{name}}, here are your tickets for {{eventName}}!</h1>"
    const htmlEmail = getTemplate("ticket-email", {
      name: userName || "Гость",
      eventName: eventName,
    });

    const mailOptions = {
      from: `"Eventomir Tickets" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `Ваши билеты на мероприятие: ${eventName}`,
      html: htmlEmail,
      attachments: [
        {
          filename: `Ticket_${eventName.replace(/\s+/g, "_")}.pdf`,
          content: pdfBuffer, // Attach the memory buffer directly
          contentType: "application/pdf",
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Ticket email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );

    return true;
  } catch (error) {
    console.error("Error in sendTicketEmail:", error);
    // Return false so we don't crash the server if email fails
    return false;
  }
};

// /**
//  * Sends an email with the attached PDF receipt for a subscription.
//  * @param {string} toEmail - The buyer's email address.
//  * @param {string} userName - The buyer's name.
//  * @param {string} planName - The name of the purchased subscription plan.
//  * @param {Buffer} pdfBuffer - The generated PDF receipt in memory.
//  */

const sendSubscriptionReceiptEmail = async (
  toEmail,
  userName,
  planName,
  amount,
  pdfBuffer,
) => {
  try {
    // 1. Read the HTML template (using path.join for safety)
    const templatePath = join(
      __dirname,
      "templates",
      "subscription-receipt-email.html",
    );
    let htmlTemplate = fs.readFileSync(templatePath, "utf-8");

    // 2. Replace placeholders with actual data
    const dashboardUrl = `${process.env.WEB_APP_URL || "https://app.eventomir.ru"}/pricing`;

    // 🚨 Safe parsing for the amount
    const safeAmount = Number(amount) || 0;

    htmlTemplate = htmlTemplate
      .replace(/{{userName}}/g, userName || "Пользователь")
      .replace(/{{planName}}/g, planName)
      .replace(/{{amount}}/g, safeAmount.toLocaleString("ru-RU")) // 🚨 Now has access to amount
      .replace(/{{dashboardUrl}}/g, dashboardUrl)
      .replace(/{{year}}/g, new Date().getFullYear().toString());

    // 3. Send the email
    const info = await transporter.sendMail({
      from: `"Eventomir" <${process.env.EMAIL_USER || "noreply@eventomir.ru"}>`,
      to: toEmail,
      subject: `Квитанция об оплате подписки: ${planName}`,
      html: htmlTemplate,
      attachments: [
        {
          filename: `Receipt_${planName.replace(/\s+/g, "_")}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    console.log(`Email sent successfully: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error("Error sending subscription receipt email:", error);
    throw error;
  }
};

// B2B Invoice Email
const sendB2BInvoiceEmail = async (
  toEmail,
  companyName,
  invoiceNumber,
  pdfBuffer,
) => {
  try {
    const htmlTemplate = getTemplate("invoice-b2b-email", {
      companyName,
      invoiceNumber,
    });

    const mailOptions = {
      from: `"Eventomir Бухгалтерия" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `Счет на оплату № ${invoiceNumber}`,
      html: htmlTemplate,
      attachments: [
        {
          filename: `Счет_${invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(
      `b2b invoice email sent to ${toEmail}. Message ID: ${info.messageId}`,
    );
    return info;
  } catch (error) {
    console.error("Error sending subscription invoice b2b email:", error);
    throw error;
  }
};

export {
  sendVerificationEmail,
  sendModerationStatusEmail,
  sendResetPasswordLinkEmail,
  sendPartnerWelcomeEmail,
  sendPartnerApprovalEmail,
  sendTicketEmail,
  sendSubscriptionReceiptEmail,
  sendB2BInvoiceEmail,
};
