import prisma from "../libs/prisma.js";

export const getAdminDashboardData = async () => {
  const [
    users,
    performers,
    customers,
    partners,
    bookings,
    payoutRequests,
    moderationQueue,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "performer" } }),
    prisma.user.count({ where: { role: "customer" } }),
    prisma.user.count({ where: { role: "partner" } }),
    prisma.booking.count(),

    // 🚨 FIX: Use strict Enum "PENDING" and include nested User data via PartnerProfile
    prisma.payoutRequest.findMany({
      where: { status: "PENDING" },
      include: {
        partner: {
          include: { user: true }, // Pulls email/name for the admin UI
        },
      },
    }),

    // 🚨 FIX: Moderation status now lives on PerformerProfile, default is "pending_approval"
    prisma.performerProfile.findMany({
      where: { moderation_status: "pending_approval" },
      include: { user: true }, // Pulls the base user details for the UI
    }),
  ]);

  const totalRevenue = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: { status: "COMPLETED" }, // 🚨 FIX: Only count actual successful revenue
  });

  return {
    stats: {
      totalUsers: users,
      totalPerformers: performers,
      totalCustomers: customers,
      totalPartners: partners,
      totalBookings: bookings,
      totalRevenue: totalRevenue._sum.amount || 0,
    },
    payoutRequests,
    moderationQueue,
  };
};

export const approvePayout = async (payoutId) => {
  return await prisma.payoutRequest.update({
    where: { id: payoutId },
    // 🚨 FIX: Use strict Enum "PAID" (or "APPROVED" depending on your exact workflow)
    data: { status: "PAID" },
  });
};

export const rejectPayout = async (payoutId) => {
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutId },
  });

  if (payout) {
    // 🚨 FIX: partner_id points to PartnerProfile.id now, balance lives there
    await prisma.partnerProfile.update({
      where: { id: payout.partner_id },
      data: { balance: { increment: payout.amount } },
    });
  }

  return await prisma.payoutRequest.update({
    where: { id: payoutId },
    // 🚨 FIX: Use strict Enum "REJECTED"
    data: { status: "REJECTED" },
  });
};

export const approveProfile = async (userId) => {
  // 🚨 FIX: Update PerformerProfile via the unique userId relation
  return await prisma.performerProfile.update({
    where: { userId: userId },
    data: { moderation_status: "approved" },
  });
};

export const rejectProfile = async (userId) => {
  // 🚨 FIX: Update PerformerProfile via the unique userId relation
  return await prisma.performerProfile.update({
    where: { userId: userId },
    data: { moderation_status: "rejected" },
  });
};
