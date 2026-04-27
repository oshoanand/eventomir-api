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

    const numRating = Number(rating);

    if (!targetId || !numRating || numRating < 1 || numRating > 5) {
      return res
        .status(400)
        .json({ message: "Некорректные данные для отзыва. Оценка от 1 до 5." });
    }

    if (currentUserId === targetId) {
      return res
        .status(400)
        .json({ message: "Вы не можете оставить отзыв самому себе." });
    }

    // 1. Fetch Customer Profile
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
        rating: numRating,
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

    // 5. Map safely to what the frontend expects
    const formattedReview = {
      ...newReview,
      authorId: newReview.customer?.userId,
      targetId: newReview.performer?.userId,
      author: {
        id: newReview.customer?.user?.id,
        name: newReview.customer?.user?.name || "Пользователь",
        image: newReview.customer?.user?.image,
        profilePicture: newReview.customer?.user?.image,
        role: newReview.customer?.user?.role || "customer",
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

    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: userId },
    });

    if (!performerProfile) {
      return res.status(200).json([]); // No profile, no reviews
    }

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

    // Safely map to frontend format
    const enrichedReviews = reviews.map((review) => {
      const { customer, performer, ...rest } = review;
      return {
        ...rest,
        authorId: customer?.userId,
        targetId: performer?.userId,
        author: {
          id: customer?.user?.id,
          name: customer?.user?.name || "Удаленный пользователь",
          image: customer?.user?.image,
          profilePicture: customer?.user?.image,
          role: customer?.user?.role || "customer",
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
        replyUpdatedAt: isEditing ? new Date() : null,
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

    const customerProfile = await prisma.customerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!customerProfile || review.customerId !== customerProfile.id) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои отзывы." });
    }

    // CRITICAL: Prevent deletion if the performer has already replied
    if (review.reply && review.reply.trim() !== "") {
      return res.status(403).json({
        message:
          "Нельзя удалить отзыв, на который исполнитель уже дал ответ. Вы можете только изменить его.",
      });
    }

    // 🚨 FIX: Use deleteMany to avoid P2025 errors on double-click
    await prisma.review.deleteMany({
      where: { id: reviewId, customerId: customerProfile.id },
    });

    res.status(200).json({ success: true, message: "Отзыв успешно удален." });
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

    // 🚨 FIX: Strict number coercion for validation
    const numRating = rating ? Number(rating) : undefined;
    if (numRating && (numRating < 1 || numRating > 5)) {
      return res.status(400).json({ message: "Оценка должна быть от 1 до 5." });
    }

    const updatedReview = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(numRating && { rating: numRating }),
        ...(comment !== undefined && { comment }),
      },
      include: {
        performer: { select: { userId: true } },
      },
    });

    const formattedReview = {
      ...updatedReview,
      authorId: customerProfile.userId,
      targetId: updatedReview.performer?.userId,
      author: {
        id: customerProfile.user?.id,
        name: customerProfile.user?.name || "Пользователь",
        image: customerProfile.user?.image,
        profilePicture: customerProfile.user?.image,
        role: customerProfile.user?.role || "customer",
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

    const performerProfile = await prisma.performerProfile.findUnique({
      where: { userId: currentUserId },
    });

    if (!performerProfile || review.performerId !== performerProfile.id) {
      return res
        .status(403)
        .json({ message: "Вы можете удалять только свои ответы." });
    }

    // Update the review to remove the reply
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        reply: null,
        replyCreatedAt: null,
        replyUpdatedAt: null,
      },
    });

    res.status(200).json({ success: true, message: "Ответ успешно удален." });
  } catch (error) {
    console.error("Delete Reply Error:", error);
    res.status(500).json({ message: "Не удалось удалить ответ." });
  }
});

export default router;
