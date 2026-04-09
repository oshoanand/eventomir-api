import express from "express";
import { sendPasswordResetEmail, resetPassword } from "../controllers/auth.js";
import prisma from "../libs/prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
  sendVerificationEmail,
  sendResetPasswordLinkEmail,
} from "../mailer/email-sender.js";
import { invalidatePattern } from "../libs/redis.js";
import { verifyAuth } from "../middleware/verify-auth.js";

// 🚨 IMPORT THE MASTER DISPATCHER
import { notifyUser } from "../services/notification.js";

const router = express.Router();

// ==========================================
// 1. OAUTH COMPLETION ROUTE
// ==========================================
router.patch("/complete-registration", verifyAuth, async (req, res) => {
  try {
    const { role, phone, city, accountType, companyName, inn } = req.body;
    const userId = req.user.id;

    const validRoles = ["customer", "performer", "partner"];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ message: "Выбрана недопустимая роль." });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        role: role,
        phone: phone || null,
        city: city || null,
        account_type: accountType || "individual",
        company_name: companyName || null,
        inn: inn || null,
      },
    });

    // Invalidate the cache for the specific role lists
    if (role === "customer") await invalidatePattern("users:customers_p*");
    if (role === "performer") await invalidatePattern("users:performers_p*");

    // 🚨 NOTIFY ADMINS IF A NEW PERFORMER COMPLETES OAUTH
    if (role === "performer") {
      const admins = await prisma.user.findMany({
        where: { role: "administrator" },
        select: { id: true },
      });

      if (admins.length > 0) {
        await Promise.all(
          admins.map((admin) =>
            notifyUser({
              userId: admin.id,
              title: "👤 Новый исполнитель (OAuth)",
              body: `${updatedUser.name} завершил регистрацию через соцсети.`,
              type: "MODERATION_UPDATE",
              data: { url: `/users` },
            }),
          ),
        );
      }
    }

    res.status(200).json({
      message: "Регистрация успешно завершена",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Complete registration error:", error);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
});

// ==========================================
// 2. REGISTRATION ROUTES
// ==========================================
router.post("/register-performer", async (req, res) => {
  try {
    const { performerData, password, referralId } = req.body;

    if (!performerData.email || !password || !performerData.name) {
      return res.status(400).json({
        message: "Required fields (email, password, name) are missing.",
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: performerData.email },
    });

    if (existingUser) {
      return res
        .status(409)
        .json({ message: "Пользователь с таким email уже зарегистрирован!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days
    const defaultImage = `${process.env.API_BASE_URL}/uploads/no-image.jpg`;

    const newUser = await prisma.user.create({
      data: {
        email: performerData.email,
        password: hashedPassword,
        role: "performer",
        name: performerData.name,
        phone: performerData.phone,
        city: performerData.city,
        account_type: performerData.accountType,
        company_name: performerData.companyName,
        inn: performerData.inn,
        moderation_status: "pending_approval",
        subscription_plan_id: "FREE",
        profile_picture: defaultImage,
        verificationTokens: {
          create: {
            token: rawToken,
            identifier: performerData.email,
            expires: expiresAt,
          },
        },
      },
    });

    // Handle the referral link
    if (referralId) {
      const partner = await prisma.partner.findUnique({
        where: { referral_id: referralId },
      });

      if (partner) {
        await prisma.referralEvent.create({
          data: {
            partnerId: partner.id,
            referredUserId: newUser.id,
            eventType: "registration",
            status: "pending",
          },
        });
      } else {
        console.warn(
          `Referral ID ${referralId} provided, but no partner found.`,
        );
      }
    }

    // Send Verification Email
    try {
      await sendVerificationEmail(newUser.email, newUser.name, rawToken);
      console.log(`Verification email queued for ${newUser.email}`);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError.message);
    }

    // 🚨 NOTIFY ADMINISTRATORS
    const admins = await prisma.user.findMany({
      where: { role: "administrator" },
      select: { id: true },
    });

    if (admins.length > 0) {
      await Promise.all(
        admins.map((admin) =>
          notifyUser({
            userId: admin.id,
            title: "👤 Новый исполнитель",
            body: `${newUser.name} зарегистрировался и ожидает модерации.`,
            type: "MODERATION_UPDATE",
            data: { url: `/users` },
          }),
        ),
      );
    }

    await invalidatePattern("users:performers_p*");

    return res.status(201).json({
      success: true,
      message:
        "Регистрация прошла успешно! Пожалуйста, проверьте свою электронную почту для подтверждения учетной записи. Ваш профиль будет доступен после модерации.",
    });
  } catch (error) {
    console.error("Error during performer registration:", error);
    return res
      .status(500)
      .json({ message: "Внутренняя ошибка сервера : ", error: error.message });
  }
});

router.post("/register-customer", async (req, res) => {
  try {
    const { customerData, password } = req.body;

    if (!customerData.email || !password || !customerData.name) {
      return res.status(400).json({
        message: "Required fields (email, password, name) are missing.",
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: customerData.email },
    });

    if (existingUser) {
      return res
        .status(409)
        .json({ message: "User with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const defaultImage = `${process.env.API_BASE_URL}/uploads/no-image.jpg`;

    const newUser = await prisma.user.create({
      data: {
        email: customerData.email,
        password: hashedPassword,
        role: "customer",
        name: customerData.name,
        phone: customerData.phone,
        city: customerData.city,
        account_type: customerData.accountType,
        company_name: customerData.companyName,
        inn: customerData.inn,
        profile_picture: defaultImage,
        verificationTokens: {
          create: {
            token: rawToken,
            identifier: customerData.email,
            expires: expiresAt,
          },
        },
      },
    });

    try {
      await sendVerificationEmail(newUser.email, newUser.name, rawToken);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError.message);
    }

    // 🚨 NOTIFY ADMINISTRATORS (Optional, but good for tracking growth)
    const admins = await prisma.user.findMany({
      where: { role: "administrator" },
      select: { id: true },
    });

    if (admins.length > 0) {
      await Promise.all(
        admins.map((admin) =>
          notifyUser({
            userId: admin.id,
            title: "👋 Новый клиент",
            body: `${newUser.name} присоединился к платформе.`,
            type: "SYSTEM",
            data: { url: `/users` },
          }),
        ),
      );
    }

    await invalidatePattern("users:customers_p*");

    return res.status(201).json({
      success: true,
      message:
        "Registration successful! Please check your email to verify your account.",
    });
  } catch (error) {
    console.error("Error during customer registration:", error);
    return res
      .status(500)
      .json({ message: "Internal Server Error.", error: error.message });
  }
});

// ==========================================
// 3. VERIFICATION & PASSWORD RESET ROUTES
// ==========================================
router.get("/verify-email", async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) return res.status(400).send("<h1>Invalid Link</h1>");

    const verifyTokenRecord = await prisma.verificationToken.findUnique({
      where: { token: token },
      include: { user: true },
    });

    if (!verifyTokenRecord) {
      return res
        .status(400)
        .send("<h1>Invalid or used verification link.</h1>");
    }

    if (new Date() > verifyTokenRecord.expires) {
      return res
        .status(400)
        .send("<h1>This link has expired. Please request a new one</h1>");
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: verifyTokenRecord.userId },
        data: {
          emailVerified: new Date(),
          status: "active",
        },
      }),
      prisma.verificationToken.delete({
        where: { id: verifyTokenRecord.id },
      }),
    ]);

    return res
      .status(200)
      .json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(500).send("<h1>Internal Server Error</h1>");
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    // Returns immediately to prevent hanging logic
    if (!user) {
      return res
        .status(200)
        .json({ message: "If that email exists, we sent a link." });
    }

    const secret = process.env.SECRET + user.password;
    const token = jwt.sign({ id: user.id, email: user.email }, secret, {
      expiresIn: "2h",
    });

    const link = `${process.env.WEB_APP_URL}/reset-password/${token}`;

    try {
      await sendResetPasswordLinkEmail(
        link,
        user.email,
        user.name || "Пользователь",
      );
    } catch (emailError) {
      console.error("Failed to send reset password email:", emailError.message);
    }

    return res.status(200).json({
      success: true,
      message: "Ссылка отправлена на почту",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password, email } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email: email } });
    if (!user) return res.status(400).json({ message: "Invalid user." });

    const secret = process.env.SECRET + user.password;
    try {
      jwt.verify(token, secret);
    } catch (err) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await prisma.user.update({
      where: { email: email },
      data: { password: hashedPassword },
    });

    res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Legacy passthrough routes to controllers
router.post("/request-password-reset", async (req, res) => {
  const { email } = req.body;
  try {
    const result = await sendPasswordResetEmail(email);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  try {
    const result = await resetPassword(token, password);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// RESEND VERIFICATION EMAIL
// ==========================================
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Email обязателен для заполнения." });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return res.status(200).json({
        message:
          "Если этот email зарегистрирован, мы отправили на него новую ссылку.",
      });
    }

    if (user.emailVerified || user.status === "active") {
      return res.status(400).json({
        message: "Этот аккаунт уже подтвержден. Вы можете войти в систему.",
      });
    }

    await prisma.verificationToken.deleteMany({
      where: { identifier: user.email },
    });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    await prisma.verificationToken.create({
      data: {
        identifier: user.email,
        token: rawToken,
        expires: expiresAt,
        userId: user.id,
      },
    });

    try {
      await sendVerificationEmail(user.email, user.name, rawToken);
    } catch (emailError) {
      console.error("Failed to resend verification email:", emailError.message);
      return res
        .status(500)
        .json({ message: "Ошибка отправки письма. Попробуйте позже." });
    }

    return res.status(200).json({
      success: true,
      message: "Новая ссылка успешно отправлена на ваш email.",
    });
  } catch (error) {
    console.error("Resend Verification Error:", error);
    return res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
});

export default router;
