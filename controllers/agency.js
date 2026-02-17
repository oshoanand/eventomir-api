import prisma from "../libs/prisma.js";
import bcrypt from "bcryptjs";

// --- 1. Get All Specialists for Logged-in Agency ---
export const getAgencySpecialists = async (req, res) => {
  try {
    const agencyId = req.user.id;

    const specialists = await prisma.user.findMany({
      where: { parentAgencyId: agencyId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true, // mapped to profilePicture in frontend
        roles: true,
        city: true,
        moderation_status: true,
        // Add other necessary fields
      },
      orderBy: { created_at: "desc" },
    });

    // Map database fields to frontend structure if necessary
    const formatted = specialists.map((s) => ({
      ...s,
      profilePicture: s.image,
      moderationStatus: s.moderation_status,
    }));

    res.json(formatted);
  } catch (error) {
    console.error("Get Specialists Error:", error);
    res.status(500).json({ message: "Failed to fetch specialists" });
  }
};

// --- 2. Create or Update Specialist ---
export const createSpecialist = async (req, res) => {
  try {
    const agencyId = req.user.id;
    const { id, name, email, roles, city, about, priceRange } = req.body;

    // Check if agency exists
    const agency = await prisma.user.findUnique({ where: { id: agencyId } });
    if (!agency) return res.status(404).json({ message: "Agency not found" });

    if (id) {
      // --- UPDATE EXISTING ---
      const specialist = await prisma.user.findFirst({
        where: { id, parentAgencyId: agencyId }, // Security check
      });

      if (!specialist)
        return res.status(403).json({ message: "Access denied" });

      const updated = await prisma.user.update({
        where: { id },
        data: {
          name,
          roles,
          city,
          description: about,
          price_range: priceRange,
        },
      });
      return res.json(updated);
    } else {
      // --- CREATE NEW ---
      // Check email uniqueness
      const existingEmail = await prisma.user.findUnique({ where: { email } });
      if (existingEmail)
        return res.status(400).json({ message: "Email already in use" });

      // Create a dummy password for the sub-profile (they might not login directly initially)
      const hashedPassword = await bcrypt.hash("AgencySubProfile123!", 10);

      const newSpecialist = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          role: "performer",
          parentAgencyId: agencyId,
          roles: roles || [],
          city: city || agency.city,
          moderation_status: "approved", // Auto-approve sub-profiles or set to pending
          account_type: "specialist",
        },
      });
      return res.status(201).json(newSpecialist);
    }
  } catch (error) {
    console.error("Create Specialist Error:", error);
    res.status(500).json({ message: "Failed to save specialist" });
  }
};

// --- 3. Delete Specialist ---
export const deleteSpecialist = async (req, res) => {
  try {
    const agencyId = req.user.id;
    const { id } = req.params;

    // Ensure the specialist belongs to this agency
    const specialist = await prisma.user.findFirst({
      where: { id, parentAgencyId: agencyId },
    });

    if (!specialist) {
      return res
        .status(404)
        .json({ message: "Specialist not found or access denied" });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ message: "Specialist deleted successfully" });
  } catch (error) {
    console.error("Delete Specialist Error:", error);
    res.status(500).json({ message: "Failed to delete specialist" });
  }
};

// --- 4. Get Bookings for All Agency Specialists ---
export const getAgencyBookings = async (req, res) => {
  try {
    const agencyId = req.user.id;

    // Find all bookings where the performer is a child of this agency
    const bookings = await prisma.booking.findMany({
      where: {
        performer: {
          parentAgencyId: agencyId,
        },
      },
      include: {
        customer: {
          select: { name: true, email: true, phone: true, image: true },
        },
        performer: {
          select: { name: true, id: true }, // To know which specialist got booked
        },
      },
      orderBy: { date: "desc" },
    });

    // Transform for frontend
    const formatted = bookings.map((b) => ({
      id: b.id,
      date: b.date,
      status: b.status,
      details: b.details,
      customerName: b.customer.name,
      customerPhone: b.customer.phone,
      performerName: b.performer.name, // Helpful for the agency to see who is booked
      createdAt: b.createdAt,
    }));

    res.json(formatted);
  } catch (error) {
    console.error("Agency Bookings Error:", error);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};
