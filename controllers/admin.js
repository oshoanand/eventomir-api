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
    prisma.payoutRequest.findMany({ where: { status: "pending" } }),
    prisma.user.findMany({ where: { moderation_status: "pending" } }),
  ]);

  const totalRevenue = await prisma.payment.aggregate({
    _sum: { amount: true },
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
    data: { status: "completed" },
  });
};

export const rejectPayout = async (payoutId) => {
  // Add the amount back to the partner's balance
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutId },
  });
  if (payout) {
    await prisma.user.update({
      where: { id: payout.partner_id },
      data: { balance: { increment: payout.amount } },
    });
  }
  return await prisma.payoutRequest.update({
    where: { id: payoutId },
    data: { status: "rejected" },
  });
};

export const approveProfile = async (userId) => {
  return await prisma.user.update({
    where: { id: userId },
    data: { moderation_status: "approved" },
  });
};

export const rejectProfile = async (userId) => {
  return await prisma.user.update({
    where: { id: userId },
    data: { moderation_status: "rejected" },
  });
};
