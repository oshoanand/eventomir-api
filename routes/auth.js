import express from "express";
import { sendPasswordResetEmail, resetPassword } from "../controllers/auth.js";
import prisma from "../libs/prisma.js";
import bcrypt from "bcryptjs";
import {
  sendVerificationEmail,
  sendResetPasswordLinkEmail,
} from "../mailer/email-sender.js";
import crypto from "crypto";
const router = express.Router();

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

router.post("/register-performer", async (req, res) => {
  try {
    const { performerData, password, referralId } = req.body;

    // 1. Validate incoming data
    if (!performerData.email || !password || !performerData.name) {
      return res.status(400).json({
        message: "Required fields (email, password, name) are missing.",
      });
    }

    // 2. Check for an existing user
    const existingUser = await prisma.user.findUnique({
      where: { email: performerData.email },
    });

    if (existingUser) {
      return res
        .status(409)
        .json({ message: "User with this email already exists." });
    }

    // 3. Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    // a long random string for the token
    const rawToken = crypto.randomBytes(32).toString("hex");
    // Set expiration to 2 days from now
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const defaultImage = `${process.env.API_BASE_URL}/uploads/no-image.jpg`;

    // 4. Create the user record with all data flattened
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
        subscription_plan_id: "econom",
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

    // 5. Handle the referral link (if provided)
    if (referralId) {
      const partner = await prisma.partner.findUnique({
        where: { referral_id: referralId }, // Make sure this field name is correct
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
          `Referral ID ${referralId} was provided, but no matching partner was found.`,
        );
      }
    }

    // 6. Send Verification Email (Using the utility)
    try {
      // We do not await this if we want the response to return immediately,
      // but usually, it's safer to await to catch config errors early.

      await sendVerificationEmail(newUser.email, newUser.name, rawToken);

      console.log(`Verification email queued for ${newUser.email}`);
    } catch (emailError) {
      // Log error but treat registration as successful
      console.error("Failed to send verification email:", emailError.message);
      // Optional: You might want to flag the user in DB that email sending failed
    }

    // 7. Send a success response
    return res.status(201).json({
      success: true,
      message:
        "Registration successful! Please check your email to verify your account. Your profile will be available after moderation.",
    });
  } catch (error) {
    console.error("Error during performer registration:", error);
    // Provide the actual Prisma error in the response for easier debugging
    return res
      .status(500)
      .json({ message: "Internal Server Error.", error: error.message });
  }
});

router.post("/register-customer", async (req, res) => {
  try {
    const { customerData, password } = req.body;

    // 1. Validate incoming data
    if (!customerData.email || !password || !customerData.name) {
      return res.status(400).json({
        message: "Required fields (email, password, name) are missing.",
      });
    }

    // 2. Check for an existing user
    const existingUser = await prisma.user.findUnique({
      where: { email: customerData.email },
    });

    if (existingUser) {
      return res
        .status(409)
        .json({ message: "User with this email already exists." });
    }

    // 3. Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    // a long random string for the token
    const rawToken = crypto.randomBytes(32).toString("hex");
    // Set expiration to 2 days from now
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const defaultImage = `${process.env.API_BASE_URL}/uploads/no-image.jpg`;

    // 4. Create the user record with all data flattened
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

    // 5. Send Verification Email (Using the utility)
    try {
      // We do not await this if we want the response to return immediately,
      // but usually, it's safer to await to catch config errors early.
      await sendVerificationEmail(newUser.email, newUser.name, rawToken);
    } catch (emailError) {
      // Log error but treat registration as successful
      console.error("Failed to send verification email:", emailError.message);
      // Optional: You might want to flag the user in DB that email sending failed
    }

    // 6. Send a success response
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

router.get("/verify-email", async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).send("<h1>Invalid Link</h1>");
    }

    // 1. Find the token in the specific VerificationToken table
    // We include the 'user' relation so we can update the user later
    const verifyTokenRecord = await prisma.verificationToken.findUnique({
      where: { token: token },
      include: { user: true },
    });

    if (!verifyTokenRecord) {
      return res
        .status(400)
        .send("<h1>Invalid or used verification link.</h1>");
    }

    // 2. Check Expiration
    if (new Date() > verifyTokenRecord.expires) {
      return res
        .status(400)
        .send("<h1>This link has expired. Please request a new one</h1>");
    }

    // 3. Verify User
    // We use a transaction to Update User AND Delete Token (to prevent reuse)
    await prisma.$transaction([
      // Update User: Set emailVerified to current date
      prisma.user.update({
        where: { id: verifyTokenRecord.userId }, // Your schema has userId on VerificationToken
        data: {
          emailVerified: new Date(),
          status: "active", // Optional: Activate user if they were pending
        },
      }),
      // Delete the used token
      prisma.verificationToken.delete({
        where: { id: verifyTokenRecord.id },
      }),
    ]);

    // 4. Redirect
    // return res.redirect(`${process.env.WEB_APP_URL}/login?status=success`);
    return res
      .status(200)
      .json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(500).send("<h1>Internal Server Error</h1>");
  }
});

//  FORGOT PASSWORD (Generate Link)
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    // Security: Always return 200 even if user not found to prevent email enumeration
    if (!user) {
      return res
        .status(200)
        .json({ message: "If that email exists, we sent a link." });
    }

    // Generate Token
    // CRITICAL: We include the user's current password hash in the secret.
    // If the password changes, this secret changes, invalidating all old links instantly.
    const secret = process.env.SECRET + user.password;
    const token = jwt.sign({ id: user.id, email: user.email }, secret, {
      expiresIn: "2h", // Link valid for 2 hours
    });

    const link = `${process.env.WEB_APP_URL}/reset-password/${token}`;
    //  Send Verification Email (Using the utility)
    try {
      // We do not await this if we want the response to return immediately,
      // but usually, it's safer to await to catch config errors early.

      await sendResetPasswordLinkEmail(
        link,
        user.email,
        user.name || "Пользователь",
      );
      console.log(`Reset password email queued `);
    } catch (emailError) {
      // Log error but treat registration as successful
      console.error(
        "Failed to send reset password  email :",
        emailError.message,
      );
      // Optional: You might want to flag the user in DB that email sending failed
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

//  RESET PASSWORD (Verify & Update)
router.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password, email } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email: email } });
    if (!user) return res.status(400).json({ message: "Invalid user." });

    // Verify Token using the same composite secret
    const secret = process.env.SECRET + user.password;
    try {
      jwt.verify(token, secret);
    } catch (err) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    // Hash new password

    const salt = await genSalt(10);
    const hashedPassword = await hash(password, salt);

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

export default router;
