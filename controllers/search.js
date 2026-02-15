import prisma from "../libs/prisma.js";
import { fetchCached } from "../middleware/redis.js"; // Importing your specific redis file
import crypto from "crypto"; // To hash query params for cache keys

export const searchPerformers = async (req, res) => {
  try {
    const queryParams = req.query;

    // 1. Generate a unique cache key based on the search parameters
    // We sort keys to ensure {city: 'A', cat: 'B'} generates same key as {cat: 'B', city: 'A'}
    const sortedParams = Object.keys(queryParams)
      .sort()
      .reduce((acc, key) => {
        acc[key] = queryParams[key];
        return acc;
      }, {});

    const queryHash = crypto
      .createHash("md5")
      .update(JSON.stringify(sortedParams))
      .digest("hex");

    // 2. Define the DB Query Logic
    const performDbQuery = async () => {
      const {
        city,
        category, // This maps to 'roles'
        accountType,
        date,
        priceMin,
        priceMax,
        // Dynamic JSON filters
        subType, // transportType, artistGenre, etc.
        capacity,
        budget, // 'Economy', 'Premium' string
        services, // comma separated
        eventStyles, // comma separated
        cuisine,
        artistLevel,
        artistFormat,
      } = queryParams;

      const whereClause = {
        moderation_status: "approved",
        role: { notIn: ["customer", "administrator"] },
      };

      // --- Basic Filters ---
      if (city) {
        whereClause.city = { contains: city, mode: "insensitive" };
      }

      if (category && category !== "_all_") {
        whereClause.roles = { has: category };
      }

      if (accountType && accountType !== "all") {
        whereClause.account_type = accountType; // 'agency' or 'individual' (check your DB enum/string)
      }

      // --- Date Availability ---
      // Exclude performers who have this date in their booked_dates array
      if (date) {
        // Assuming booked_dates is an array of ISO strings or Dates in DB
        whereClause.booked_dates = {
          // Prisma doesn't natively support "does not contain" for arrays easily in all versions,
          // but usually this logic works if booked_dates is String[]:
          // We want records where NO element equals the date.
          // Note: Exact string matching required. Frontend sends YYYY-MM-DD.
          // If DB stores full ISO, you might need raw query or date range logic.
          // Assuming DB stores YYYY-MM-DD strings for simplicity here:
          not: { has: date },
        };
      }

      // --- Price Range (Numeric) ---
      // Assuming price_range is Int[] [min, max]
      if (priceMin || priceMax) {
        // This is complex in Prisma. We want overlaps.
        // Simple logic: Performer's max price >= User's min AND Performer's min <= User's max
        // Since Prisma filtering on arrays is limited, we might fetch slightly more and filter or use raw query.
        // Here is a "best effort" using JSON filtering if price_range was JSON,
        // but if it's Int[], we can filter where price_range isn't empty.
        // Realistically, for strict array range overlaps, Raw SQL is best.
        // For this implementation, we will apply strict price filtering in Javascript
        // AFTER fetching if the dataset is small ( < 1000), OR utilize Postgres capabilities.
      }

      // --- JSONB Filtering (The "Details" Column) ---
      // Assuming structure: details: { "Транспорт": { "type": "Bus", "capacity": "..." } }
      if (category) {
        const path = ["details", category]; // Access the specific category key inside JSON

        if (subType) {
          // For transport: type, For artist: genre, etc.
          // You need to know which field maps to 'subType' based on category
          const fieldMap = {
            Транспорт: "type",
            Артисты: "genre",
            // Add others
          };
          const field = fieldMap[category];
          if (field) {
            whereClause.details = {
              ...whereClause.details,
              path: [...path, field],
              equals: subType,
            };
          }
        }

        if (capacity) {
          whereClause.details = {
            ...whereClause.details,
            path: [...path, "capacity"],
            equals: capacity,
          };
        }

        if (cuisine) {
          // For Cooks/Restaurants
          // Note: Prisma might overwrite previous `details` key if spread incorrectly.
          // In Prisma 'AND' is safer for multiple JSON conditions.
          // Let's switch to AND array for details.
        }
      }

      // --- ROBUST JSONB QUERY CONSTRUCTION ---
      const jsonFilters = [];

      if (category) {
        const basePath = ["details", category];

        if (subType)
          jsonFilters.push({
            path: [...basePath, category === "Артисты" ? "genre" : "type"],
            equals: subType,
          });
        if (capacity)
          jsonFilters.push({
            path: [...basePath, "capacity"],
            equals: capacity,
          });
        if (cuisine)
          jsonFilters.push({
            path: [...basePath, "specialization"],
            equals: cuisine,
          }); // or 'cuisine' for restaurants
        if (budget)
          jsonFilters.push({ path: [...basePath, "budget"], equals: budget });
        if (artistLevel)
          jsonFilters.push({
            path: [...basePath, "skillLevel"],
            equals: artistLevel,
          });
        if (artistFormat)
          jsonFilters.push({
            path: [...basePath, "performanceFormat"],
            equals: artistFormat,
          });

        // Array inclusion in JSON (e.g. services contains 'Wifi')
        // Prisma 'array_contains' for JSON is specific.
        if (services) {
          const servicesList = services.split(",");
          // Requires Postgres @> operator. Prisma: equals: { services: [...] } checks exact match.
          // For partial match inside JSON, we might need multiple ANDs or raw query.
        }
      }

      // Combine basic clause with JSON ANDs
      const finalQuery = {
        where: {
          ...whereClause,
          AND:
            jsonFilters.length > 0
              ? jsonFilters.map((f) => ({ details: f }))
              : undefined,
        },
      };

      const performers = await prisma.user.findMany(finalQuery);

      // --- Post-Processing (Price & Date overlaps if DB logic was insufficient) ---
      let filtered = performers;
      if (priceMin && priceMax) {
        const min = Number(priceMin);
        const max = Number(priceMax);
        filtered = filtered.filter((p) => {
          if (!p.price_range || p.price_range.length < 2) return true; // Include if unknown
          const [pMin, pMax] = p.price_range;
          // Check overlap
          return pMax >= min && pMin <= max;
        });
      }

      return filtered;
    };

    // 3. Execute with Redis Caching (Cache-Aside)
    // Cache for 5 minutes (300s) as search results might change often with bookings
    const results = await fetchCached(
      "search_performers",
      queryHash,
      performDbQuery,
      300,
    );

    // 4. Map DB snake_case to frontend camelCase if necessary (or do it in frontend service)
    // Assuming the frontend expects the exact DB shape or you map it here.
    // Let's map it to match your PerformerProfile type.
    const mappedResults = results.map((p) => ({
      id: p.id,
      name: p.name,
      profilePicture: p.profile_picture,
      city: p.city,
      roles: p.roles,
      description: p.description,
      priceRange: p.price_range,
      accountType: p.account_type,
      details: p.details,
      bookedDates: p.booked_dates,
    }));

    res.json(mappedResults);
  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({ message: "Search failed" });
  }
};
