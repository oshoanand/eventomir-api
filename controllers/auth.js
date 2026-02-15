import prisma from "../libs/prisma.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendPasswordResetEmail = async (email) => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw new Error("User not found");
  }

  const resetToken = crypto.randomBytes(20).toString("hex");
  const resetPasswordExpires = new Date(Date.now() + 3600000);

  await prisma.user.update({
    where: { email },
    data: {
      resetPasswordToken: resetToken,
      resetPasswordExpires: resetPasswordExpires,
    },
  });

  const resetUrl = `http://localhost:3000/reset-password?token=${resetToken}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: "Сброс пароля",
    text: `Вы запросили сброс пароля. Перейдите по следующей ссылке для сброса пароля: ${resetUrl}`,
    html: `<p>Вы запросили сброс пароля. Перейдите по следующей ссылке для сброса пароля: <a href="${resetUrl}">${resetUrl}</a></p>`,
  });

  return { message: "Password reset email sent" };
};

export const resetPassword = async (token, password) => {
  const user = await prisma.user.findFirst({
    where: {
      resetPasswordToken: token,
      resetPasswordExpires: { gt: new Date() },
    },
  });

  if (!user) {
    throw new Error("Password reset token is invalid or has expired");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      resetPasswordToken: null,
      resetPasswordExpires: null,
    },
  });

  return { message: "Password has been reset" };
};
