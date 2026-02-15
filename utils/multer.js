import multer from "multer";
import path from "path";
import fs from "fs";

/**
 * Creates a Multer middleware instance for a specific folder.
 * @param {string} subfolder - The subfolder inside 'uploads/' (e.g., 'profiles', 'supports')
 * @returns {multer.Multer} - The configured multer instance
 */
export const createUploader = (subfolder) => {
  // 1. Define storage within the function scope so it captures 'subfolder'
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      // Robust path handling using path.join
      const uploadDir = path.join("uploads", subfolder);

      // Check if directory exists, if not create it (recursive: true handles nested folders)
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      // Your unique naming logic
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
  });

  // 2. Return the multer instance
  return multer({ storage: storage });
};
