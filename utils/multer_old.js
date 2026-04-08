// import multer from "multer";
// import path from "path";
// import fs from "fs";

// /**
//  * Creates a Multer middleware instance for a specific folder.
//  * @param {string} subfolder - The subfolder inside 'uploads/' (e.g., 'profiles', 'supports')
//  * @returns {multer.Multer} - The configured multer instance
//  */
// export const createUploader = (subfolder) => {
//   // 1. Define storage within the function scope so it captures 'subfolder'
//   const storage = multer.diskStorage({
//     destination: function (req, file, cb) {
//       // Robust path handling using path.join
//       const uploadDir = path.join("uploads", subfolder);

//       // Check if directory exists, if not create it (recursive: true handles nested folders)
//       if (!fs.existsSync(uploadDir)) {
//         fs.mkdirSync(uploadDir, { recursive: true });
//       }

//       cb(null, uploadDir);
//     },
//     filename: function (req, file, cb) {
//       // Your unique naming logic
//       const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
//       const ext = path.extname(file.originalname);
//       cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
//     },
//   });

//   // 2. Return the multer instance
//   return multer({ storage: storage });
// };
import multer from "multer";
import path from "path";
import fs from "fs";

/**
 * Creates a Multer middleware instance for a specific base folder.
 * Dynamically creates subfolders based on the user's ID to keep files organized.
 * * @param {string} baseFolder - The base folder inside 'uploads/' (e.g., 'performers', 'documents')
 * @returns {multer.Multer} - The configured multer instance
 */
export const createUploader = (baseFolder) => {
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      // 1. Extract the dynamic ID
      // If the user is authenticated via verifyAuth, req.user.id exists.
      // If the ID is passed in the URL (e.g., /:id/gallery), req.params.id exists.
      // Fallback to "shared" if neither is available.
      const dynamicId = req.user?.id || req.params?.id || "shared";

      // 2. Create the robust dynamic path
      // Result: "uploads/performers/clk12345..."
      const uploadDir = path.join("uploads", baseFolder, dynamicId);

      // 3. Check if directory exists, if not create it (recursive: true handles nested folders)
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      // 4. Generate a unique, safe filename
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
  });

  // Return the configured multer instance
  return multer({ storage: storage });
};
