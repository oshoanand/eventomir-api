import express from "express";
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
import { notifyUser } from "../services/notification.js";

const router = express.Router();

// ==========================================
// UTILS: SUBSCRIPTION & FEATURES
// ==========================================

const DEFAULT_FREE_FEATURES = {
  maxPhotoUpload: 3,
  emailSupport: true,
  chatSupport: false,
  profileSeo: false,
};

async function getUserSubscriptionData(userId) {
  try {
    const activeSub = await prisma.userSubscription.findFirst({
      where: {
        userId: userId,
        status: "ACTIVE",
      },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();
    let activeFeatures = { ...DEFAULT_FREE_FEATURES };
    let subscriptionEndDate = null;

    if (activeSub) {
      const isNotExpired =
        !activeSub.endDate || new Date(activeSub.endDate) > now;

      if (isNotExpired) {
        const planFeatures =
          typeof activeSub.plan?.features === "object" &&
          activeSub.plan.features !== null
            ? activeSub.plan.features
            : {};

        activeFeatures = {
          ...activeFeatures,
          ...planFeatures,
        };

        subscriptionEndDate = activeSub.endDate
          ? activeSub.endDate.toISOString()
          : null;
      }
    }

    return { features: activeFeatures, subscriptionEndDate };
  } catch (error) {
    console.error("Error fetching subscription data:", error.message);
    return { features: DEFAULT_FREE_FEATURES, subscriptionEndDate: null };
  }
}

// ==========================================
// 1. STANDARD LOGIN ROUTES
// ==========================================

router.post("/app/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Требуется Email и пароль." });
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.password) {
      return res.status(401).json({ message: "Неверный Email или пароль!" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ message: "Неверный Email или пароль!" });
    }

    if (user.moderationStatus === "BLOCKED") {
      return res
        .status(403)
        .json({ message: "Ваш аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const { features, subscriptionEndDate } = await getUserSubscriptionData(
      user.id,
    );

    const secret = process.env.JWT_SECRET || process.env.SECRET;
    if (!secret) {
      console.error("CRITICAL ERROR: JWT_SECRET is not defined");
      return res.status(500).json({ message: "Ошибка конфигурации сервера." });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, secret, {
      expiresIn: "30d",
      algorithm: "HS256",
    });

    res.status(200).json({
      message: "Успешный вход",
      token,
      features,
      subscriptionEndDate,
      user: {
        name: user.name,
        email: user.email,
        image: user.image,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error("❌ Login Error:", error.message);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
});

router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Требуется Email и пароль." });
    }

    // Admins only
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (
      !user ||
      !user.password ||
      !["administrator", "support"].includes(user.role)
    ) {
      return res
        .status(401)
        .json({ message: "Неверный Email или нет доступа!" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ message: "Неверный Email или пароль!" });
    }

    if (user.moderationStatus === "BLOCKED") {
      return res.status(403).json({ message: "Ваш аккаунт заблокирован." });
    }

    const secret = process.env.JWT_SECRET || process.env.SECRET;
    if (!secret) {
      console.error("CRITICAL ERROR: JWT_SECRET is not defined");
      return res.status(500).json({ message: "Ошибка конфигурации сервера." });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, secret, {
      expiresIn: "30d",
      algorithm: "HS256",
    });

    console.log(token);
    res.status(200).json({
      message: "Успешный вход",
      token,
      user: {
        name: user.name,
        email: user.email,
        image: user.image,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error("❌ Admin Login Error:", error.message);
    res.status(500).json({ message: "Внутренняя ошибка сервера" });
  }
});

// ==========================================
// 2. OAUTH ROUTES
// ==========================================

router.post("/oauth", async (req, res) => {
  try {
    const { provider, providerAccountId, email, name, image } = req.body;

    if (!provider || !providerAccountId || !email) {
      return res
        .status(400)
        .json({ message: "Неполные данные OAuth провайдера." });
    }

    let user = await prisma.user.findUnique({
      where: { email },
    });

    if (user && user.moderationStatus === "BLOCKED") {
      return res
        .status(403)
        .json({ message: "Ваш аккаунт заблокирован. Обратитесь в поддержку." });
    }

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name || "Пользователь",
          authProvider: provider,
          image: image || null,
          role: "",
          emailVerified: new Date(),
        },
      });
    }

    const existingAccount = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId,
        },
      },
    });

    if (!existingAccount) {
      await prisma.account.create({
        data: {
          userId: user.id,
          type: "oauth",
          provider,
          providerAccountId,
        },
      });
    }

    const secret = process.env.JWT_SECRET || process.env.SECRET;
    if (!secret) {
      console.error("CRITICAL ERROR: JWT_SECRET is not defined");
      return res.status(500).json({ message: "Ошибка конфигурации сервера." });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, secret, {
      expiresIn: "30d",
      algorithm: "HS256",
    });

    const { features, subscriptionEndDate } = await getUserSubscriptionData(
      user.id,
    );

    res.status(200).json({
      message: "OAuth авторизация успешна",
      token,
      features,
      subscriptionEndDate,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        image: user.image,
      },
    });
  } catch (error) {
    console.error("❌ OAuth Error:", error.message);
    res.status(500).json({ message: "Ошибка обработки OAuth входа" });
  }
});

// ==========================================
// 3. COMPLETE OAUTH REGISTRATION
// ==========================================

router.patch("/complete-registration", verifyAuth, async (req, res) => {
  try {
    // 🚨 FIX: Extracting all fields required by the frontend
    const { role, phone, city, companyName, inn, accountType } = req.body;
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
      },
    });

    if (role === "customer") {
      // 🚨 FIX: Save accountType, companyName, inn for Customers too
      await prisma.customerProfile.upsert({
        where: { userId: userId },
        update: { city, accountType, companyName, inn },
        create: {
          userId,
          city,
          accountType,
          companyName,
          inn,
          moderationStatus: "APPROVED",
        },
      });
      await invalidatePattern("users:customers_p*");
    } else if (role === "performer") {
      // 🚨 FIX: Save city and accountType for Performers
      await prisma.performerProfile.upsert({
        where: { userId: userId },
        update: { city, accountType, companyName, inn },
        create: {
          userId,
          city,
          accountType,
          companyName,
          inn,
          moderationStatus: "APPROVED",
        },
      });

      const freePlan = await prisma.subscriptionPlan.findUnique({
        where: { tier: "FREE" },
      });

      if (freePlan) {
        const existingSub = await prisma.userSubscription.findUnique({
          where: { userId: userId },
        });

        if (!existingSub) {
          await prisma.userSubscription.create({
            data: {
              userId: userId,
              planId: freePlan.id,
              status: "ACTIVE",
              pricePaid: 0,
            },
          });
        }
      }

      await invalidatePattern("users:performers_p*");

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
    } else if (role === "partner") {
      const namePrefix = updatedUser.name
        ? updatedUser.name
            .substring(0, 4)
            .toUpperCase()
            .replace(/[^A-Z]/g, "P")
        : "PART";
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const referralId = `REF-${namePrefix}${randomSuffix}`;

      await prisma.partnerProfile.upsert({
        where: { userId: userId },
        update: { city, accountType, companyName, inn },
        create: {
          userId,
          city,
          accountType,
          companyName,
          inn,
          referralId: referralId,
          balance: 0,
        },
      });
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
// 4. REGISTRATION ROUTES (Email / Password)
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

    const freePlan = await prisma.subscriptionPlan.findUnique({
      where: { tier: "FREE" },
    });

    const newUser = await prisma.user.create({
      data: {
        email: performerData.email,
        password: hashedPassword,
        role: "performer",
        name: performerData.name,
        phone: performerData.phone,
        image: defaultImage,

        performerProfile: {
          create: {
            accountType: performerData.accountType,
            companyName: performerData.companyName,
            inn: performerData.inn,
            moderationStatus: "APPROVED",
            city: performerData.city,
          },
        },

        ...(freePlan && {
          subscriptions: {
            create: {
              planId: freePlan.id,
              status: "ACTIVE",
              pricePaid: 0,
            },
          },
        }),

        verificationTokens: {
          create: {
            token: rawToken,
            identifier: performerData.email,
            expires: expiresAt,
          },
        },
      },
    });

    if (referralId) {
      const partner = await prisma.partnerProfile.findUnique({
        where: { referralId: referralId },
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
      }
    }

    try {
      await sendVerificationEmail(newUser.email, newUser.name, rawToken);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError.message);
    }

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
        "Регистрация прошла успешно! Пожалуйста, проверьте свою электронную почту для подтверждения учетной записи.",
    });
  } catch (error) {
    console.error("Error during performer registration:", error);
    return res.status(500).json({ message: "Внутренняя ошибка сервера" });
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
        image: defaultImage,

        customerProfile: {
          create: {
            accountType: customerData.accountType,
            companyName: customerData.companyName,
            inn: customerData.inn,
            moderationStatus: "APPROVED",
            city: customerData.city,
          },
        },

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
    return res.status(500).json({ message: "Internal Server Error." });
  }
});

// ==========================================
// 5. VERIFICATION & PASSWORD RESET ROUTES
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

    if (!user) {
      return res
        .status(200)
        .json({ message: "If that email exists, we sent a link." });
    }

    const secret = process.env.JWT_SECRET || process.env.SECRET;
    const token = jwt.sign(
      { id: user.id, email: user.email },
      secret + user.password,
      {
        expiresIn: "2h",
      },
    );

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

    const secret = process.env.JWT_SECRET || process.env.SECRET;
    try {
      jwt.verify(token, secret + user.password);
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

    if (user.emailVerified) {
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
