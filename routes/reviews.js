import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// --- 1. CREATE A REVIEW (Bidirectional) ---
// ==========================================
router.post("/", verifyAuth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role; // Assuming role is in the token
    const { targetId, rating, comment } = req.body;

    if (!targetId || !rating || rating < 1 || rating > 5) {
      return res
        .status(400)
        .json({ message: "Некорректные данные для отзыва." });
    }

    if (currentUserId === targetId) {
      return res
        .status(400)
        .json({ message: "Вы не можете оставить отзыв самому себе." });
    }

    // Determine the roles based on who is writing it
    let performerId, customerId;

    if (currentUserRole === "customer") {
      customerId = currentUserId;
      performerId = targetId;
    } else if (currentUserRole === "performer") {
      performerId = currentUserId;
      customerId = targetId;
    } else {
      return res
        .status(403)
        .json({ message: "Ваша роль не позволяет оставлять отзывы." });
    }

    // Check if the review already exists in this specific direction
    const existingReview = await prisma.review.findFirst({
      where: {
        performer_id: performerId,
        customer_id: customerId,
        author_id: currentUserId,
      },
    });

    if (existingReview) {
      return res
        .status(400)
        .json({ message: "Вы уже оставляли отзыв этому пользователю." });
    }

    // Fetch customer name for your existing 'customer_name' field
    const customerRecord = await prisma.user.findUnique({
      where: { id: customerId },
      select: { name: true },
    });

    const newReview = await prisma.review.create({
      data: {
        performer_id: performerId,
        customer_id: customerId,
        author_id: currentUserId,
        customer_name: customerRecord?.name || "Пользователь",
        rating: Number(rating),
        comment: comment || "",
      },
    });

    res.status(201).json(newReview);
  } catch (error) {
    console.error("Create Review Error:", error);
    res.status(500).json({ message: "Не удалось сохранить отзыв." });
  }
});

// ==========================================
// --- 2. GET REVIEWS FOR A SPECIFIC USER ---
// ==========================================
router.get("/target/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Find all reviews where this user is the target (NOT the author)
    const reviews = await prisma.review.findMany({
      where: {
        OR: [
          { performer_id: userId, author_id: { not: userId } }, // Performer received these
          { customer_id: userId, author_id: { not: userId } }, // Customer received these
        ],
      },
      orderBy: { created_at: "desc" },
    });

    // To make it easy for the frontend to render, we manually attach the author's details
    // Because Prisma's explicit include would require a dedicated author relation
    const enrichedReviews = await Promise.all(
      reviews.map(async (review) => {
        const author = await prisma.user.findUnique({
          where: { id: review.author_id },
          select: { id: true, name: true, profile_picture: true, role: true },
        });
        return { ...review, author };
      }),
    );

    res.status(200).json(enrichedReviews);
  } catch (error) {
    console.error("Get Reviews Error:", error);
    res.status(500).json({ message: "Не удалось загрузить отзывы." });
  }
});

// ==========================================
// --- 3. REPLY TO A REVIEW ---
// ==========================================
router.patch("/:reviewId/reply", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { replyText } = req.body;
    const currentUserId = req.user.id;

    if (!replyText || replyText.trim() === "") {
      return res
        .status(400)
        .json({ message: "Текст ответа не может быть пустым." });
    }

    const review = await prisma.review.findUnique({ where: { id: reviewId } });

    if (!review) {
      return res.status(404).json({ message: "Отзыв не найден." });
    }

    // Security Check: Only the TARGET of the review can reply
    // If the customer wrote it, the performer is the target. If the performer wrote it, the customer is the target.
    const targetId =
      review.author_id === review.customer_id
        ? review.performer_id
        : review.customer_id;

    if (targetId !== currentUserId) {
      return res.status(403).json({
        message: "Вы можете отвечать только на отзывы, оставленные вам.",
      });
    }

    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: replyText,
        reply_created_at: new Date(),
      },
    });

    res.status(200).json(updatedReview);
  } catch (error) {
    console.error("Reply to Review Error:", error);
    res.status(500).json({ message: "Не удалось отправить ответ." });
  }
});

// ==========================================
// --- 4. DELETE A REVIEW ---
// ==========================================
router.delete("/:reviewId", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const currentUserId = req.user.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });

    if (!review) return res.status(404).json({ message: "Отзыв не найден." });

    // Security Check: Only the original author can delete their review
    if (review.author_id !== currentUserId) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои отзывы." });
    }

    await prisma.review.delete({ where: { id: reviewId } });

    res.status(200).json({ message: "Отзыв успешно удален." });
  } catch (error) {
    console.error("Delete Review Error:", error);
    res.status(500).json({ message: "Не удалось удалить отзыв." });
  }
});

// ==========================================
// --- 5. EDIT A REVIEW ---
// ==========================================
router.patch("/:reviewId", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { rating, comment } = req.body;
    const currentUserId = req.user.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });

    if (!review) {
      return res.status(404).json({ message: "Отзыв не найден." });
    }

    // Security Check: Only the original author can edit their review
    if (review.author_id !== currentUserId) {
      return res
        .status(403)
        .json({ message: "Вы можете редактировать только свои отзывы." });
    }

    // Validation
    if (rating && (rating < 1 || rating > 5)) {
      return res.status(400).json({ message: "Оценка должна быть от 1 до 5." });
    }

    // 1. Update the review in the database (WITHOUT the include statement)
    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(rating && { rating: Number(rating) }),
        ...(comment !== undefined && { comment }), // Allows clearing the comment
      },
    });

    // 2. Manually fetch the author details
    const author = await prisma.user.findUnique({
      where: { id: updatedReview.author_id },
      select: { id: true, name: true, profile_picture: true, role: true },
    });

    // 3. Merge them together and return to frontend
    res.status(200).json({ ...updatedReview, author });
  } catch (error) {
    console.error("Edit Review Error:", error);
    res.status(500).json({ message: "Не удалось обновить отзыв." });
  }
});

// ==========================================
// --- 6. DELETE A REPLY ---
// ==========================================
router.delete("/:reviewId/reply", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const currentUserId = req.user.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });

    if (!review) {
      return res.status(404).json({ message: "Отзыв не найден." });
    }

    // Security Check: Only the TARGET of the review (the person who replied) can delete the reply
    const targetId =
      review.author_id === review.customer_id
        ? review.performer_id
        : review.customer_id;

    if (targetId !== currentUserId) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои ответы." });
    }

    // Update the review to remove the reply text and timestamp
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: null,
        reply_created_at: null,
      },
    });

    res.status(200).json({ message: "Ответ успешно удален." });
  } catch (error) {
    console.error("Delete Reply Error:", error);
    res.status(500).json({ message: "Не удалось удалить ответ." });
  }
});

export default router;
