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
 * Reads an HTML file and replaces placeholders
 */
const getTemplate = (templateName, data) => {
  const templatePath = join(__dirname, "templates", `${templateName}.html`);

  // Read the file synchronously (for simplicity in this context)
  let htmlContent = fs.readFileSync(templatePath, "utf8");

  // Replace placeholders dynamically
  // Example: replaces {{name}} with data.name
  Object.keys(data).forEach((key) => {
    const regex = new RegExp(`{{${key}}}`, "g"); // Create global regex for replacement
    htmlContent = htmlContent.replace(regex, data[key]);
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

export {
  sendVerificationEmail,
  sendModerationStatusEmail,
  sendResetPasswordLinkEmail,
  sendPartnerWelcomeEmail,
  sendPartnerApprovalEmail,
};
