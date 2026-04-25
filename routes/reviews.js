import { Router } from "express";
import prisma from "../libs/prisma.js";
import { verifyAuth } from "../middleware/verify-auth.js";

const router = Router();

// ==========================================
// --- 1. CREATE A REVIEW (Customer -> Performer) ---
// ==========================================
router.post("/", verifyAuth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
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

    // 1. Fetch Customer Profile (Only customers can leave reviews)
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!customerProfile) {
      return res.status(403).json({
        message: "Только зарегистрированные заказчики могут оставлять отзывы.",
      });
    }

    // 2. Fetch Target Performer Profile
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: targetId },
    });

    if (!performerProfile) {
      return res.status(404).json({ message: "Исполнитель не найден." });
    }

    // 3. Check if the review already exists
    const existingReview = await prisma.review.findFirst({
      where: {
        performerId: performerProfile.id,
        customerId: customerProfile.id,
      },
    });

    if (existingReview) {
      return res
        .status(400)
        .json({ message: "Вы уже оставляли отзыв этому пользователю." });
    }

    // 4. Create Review linking the two profiles
    const newReview = await prisma.review.create({
      data: {
        performerId: performerProfile.id,
        customerId: customerProfile.id,
        rating: Number(rating),
        comment: comment || "",
      },
      include: {
        customer: {
          include: {
            user: { select: { id: true, name: true, image: true, role: true } },
          },
        },
        performer: { select: { userId: true } },
      },
    });

    // 5. Map database IDs to what the frontend expects
    const formattedReview = {
      ...newReview,
      authorId: newReview.customer.userId, // Map to User ID for frontend checks
      targetId: newReview.performer.userId, // Map to User ID
      author: {
        id: newReview.customer.user.id,
        name: newReview.customer.user.name,
        image: newReview.customer.user.image,
        profilePicture: newReview.customer.user.image,
        role: newReview.customer.user.role,
      },
    };

    res.status(201).json(formattedReview);
  } catch (error) {
    console.error("Create Review Error:", error);
    res.status(500).json({ message: "Не удалось сохранить отзыв." });
  }
});

// ==========================================
// --- 2. GET REVIEWS FOR A SPECIFIC PERFORMER ---
// ==========================================
router.get("/target/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // 1. Resolve the Performer Profile
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: userId },
    });

    if (!performerProfile) {
      return res.status(200).json([]); // No profile, no reviews
    }

    // 2. Find all reviews targeted at this performer profile
    const reviews = await prisma.review.findMany({
      where: { performerId: performerProfile.id },
      orderBy: { createdAt: "desc" },
      include: {
        customer: {
          include: {
            user: { select: { id: true, name: true, image: true, role: true } },
          },
        },
        performer: { select: { userId: true } },
      },
    });

    // 3. Map to frontend expected format
    const enrichedReviews = reviews.map((review) => {
      const { customer, performer, ...rest } = review;
      return {
        ...rest,
        authorId: customer.userId, // Crucial for 'isOwnProfile' and 'hasAlreadyReviewed'
        targetId: performer.userId,
        author: {
          id: customer.user.id,
          name: customer.user.name,
          image: customer.user.image,
          profilePicture: customer.user.image,
          profile_picture: customer.user.image, // Legacy fallback
          role: customer.user.role,
        },
      };
    });

    res.status(200).json(enrichedReviews);
  } catch (error) {
    console.error("Get Reviews Error:", error);
    res.status(500).json({ message: "Не удалось загрузить отзывы." });
  }
});

// ==========================================
// --- 3. REPLY TO A REVIEW (Performer Only) ---
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

    // Security Check: Ensure the logged in user is the Performer who received the review
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!performerProfile || review.performerId !== performerProfile.id) {
      return res.status(403).json({
        message: "Вы можете отвечать только на отзывы, оставленные вам.",
      });
    }

    const isEditing = !!review.reply;

    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: replyText,
        replyCreatedAt: isEditing ? review.replyCreatedAt : new Date(),
        replyUpdatedAt: isEditing ? new Date() : null, // Track edit timestamp
      },
    });

    res.status(200).json(updatedReview);
  } catch (error) {
    console.error("Reply to Review Error:", error);
    res.status(500).json({ message: "Не удалось сохранить ответ." });
  }
});

// ==========================================
// --- 4. DELETE A REVIEW (Customer Only) ---
// ==========================================
router.delete("/:reviewId", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const currentUserId = req.user.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ message: "Отзыв не найден." });

    // Security Check: Only the original author (Customer) can delete it
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!customerProfile || review.customerId !== customerProfile.id) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои отзывы." });
    }

    // 🚨 CRITICAL BUSINESS LOGIC: Prevent deletion if the performer has already replied
    if (review.reply && review.reply.trim() !== "") {
      return res.status(403).json({
        message:
          "Нельзя удалить отзыв, на который исполнитель уже дал ответ. Вы можете только изменить его.",
      });
    }

    await prisma.review.delete({ where: { id: reviewId } });

    res.status(200).json({ message: "Отзыв успешно удален." });
  } catch (error) {
    console.error("Delete Review Error:", error);
    res.status(500).json({ message: "Не удалось удалить отзыв." });
  }
});

// ==========================================
// --- 5. EDIT A REVIEW (Customer Only) ---
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

    // Security Check: Only the original author (Customer) can edit their review
    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: currentUserId },
      include: {
        user: { select: { id: true, name: true, image: true, role: true } },
      },
    });

    if (!customerProfile || review.customerId !== customerProfile.id) {
      return res
        .status(403)
        .json({ message: "Вы можете редактировать только свои отзывы." });
    }

    // Validation
    if (rating && (rating < 1 || rating > 5)) {
      return res.status(400).json({ message: "Оценка должна быть от 1 до 5." });
    }

    // 1. Update the review in the database
    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(rating && { rating: Number(rating) }),
        ...(comment !== undefined && { comment }),
      },
      include: {
        performer: { select: { userId: true } },
      },
    });

    // 2. Format output matching the GET request mapping
    const formattedReview = {
      ...updatedReview,
      authorId: customerProfile.userId,
      targetId: updatedReview.performer.userId,
      author: {
        id: customerProfile.user.id,
        name: customerProfile.user.name,
        image: customerProfile.user.image,
        profilePicture: customerProfile.user.image,
        role: customerProfile.user.role,
      },
    };

    res.status(200).json(formattedReview);
  } catch (error) {
    console.error("Edit Review Error:", error);
    res.status(500).json({ message: "Не удалось обновить отзыв." });
  }
});

// ==========================================
// --- 6. DELETE A REPLY (Performer Only) ---
// ==========================================
router.delete("/:reviewId/reply", verifyAuth, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const currentUserId = req.user.id;

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) {
      return res.status(404).json({ message: "Отзыв не найден." });
    }

    // Security Check: Only the Performer who replied can delete the reply
    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!performerProfile || review.performerId !== performerProfile.id) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои ответы." });
    }

    // Update the review to remove the reply text and timestamps
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: null,
        replyCreatedAt: null,
        replyUpdatedAt: null,
      },
    });

    res.status(200).json({ message: "Ответ успешно удален." });
  } catch (error) {
    console.error("Delete Reply Error:", error);
    res.status(500).json({ message: "Не удалось удалить ответ." });
  }
});

export default router;
