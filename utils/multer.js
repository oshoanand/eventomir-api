import multer from "multer";

/**
 * Creates a secure Multer middleware using Memory Storage.
 * This keeps the file in RAM so it can be directly processed by Sharp
 * and streamed to MinIO/S3.
 * @param {number} maxSizeMB - Maximum file size allowed in Megabytes (default: 5)
 * @returns {multer.Multer} - The configured multer instance
 */
export const createUploader = (maxSizeMB = 5) => {
  // 1. Use Memory Storage
  const storage = multer.memoryStorage();

  // 2. Strict File Filter
  const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf", // 🚨 Added PDF support here
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only JPEG, PNG, WEBP, GIF, and PDF are allowed.",
        ),
        false,
      );
    }
  };

  // 3. Memory limits
  const limits = {
    fileSize: maxSizeMB * 1024 * 1024,
  };

  return multer({
    storage,
    fileFilter,
    limits,
  });
};
