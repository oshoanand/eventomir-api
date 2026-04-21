import sharp from "sharp";
import {
  minioClient,
  MINIO_BUCKET_NAME,
  MINIO_PUBLIC_URL,
} from "./minioClient.js";

/**
 * Optimizes an image buffer using Sharp and uploads it to a MinIO container.
 * @param {Object} file - The file object from Multer (req.file)
 * @param {string} baseFolder - The base folder in the bucket (e.g., 'articles', 'chats')
 * @param {string} dynamicId - Usually the user ID or entity ID
 * @param {number} width - Target width
 * @returns {Promise<string>} - The absolute public URL of the uploaded image
 */
export const optimizeAndUpload = async (
  file,
  baseFolder,
  dynamicId = "shared",
  width = 800,
) => {
  if (!file || !file.buffer) return null;

  try {
    // 1. Process with Sharp strictly in memory
    const optimizedBuffer = await sharp(file.buffer)
      .resize(width, null, { withoutEnlargement: true }) // Auto-height, prevents small images from blurring
      .webp({ quality: 85 }) // Modern WebP compression (85 is optimal for chat/profile photos)
      .toBuffer();

    // 2. Generate secure filename
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    // Sanitize original name to prevent URL encoding issues
    const safeOriginalName = file.originalname
      ? file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")
      : "image";

    const filename = `${file.fieldname || "file"}-${uniqueSuffix}-${safeOriginalName}.webp`;

    // 3. Construct the storage key (e.g., chats/user123/image-1234.webp)
    // .replace handles accidental double slashes
    const fileKey = `${baseFolder}/${dynamicId}/${filename}`.replace(
      /\/+/g,
      "/",
    );

    // 4. Metadata for the browser
    const metaData = {
      "Content-Type": "image/webp",
    };

    // 5. Upload buffer directly to MinIO
    await minioClient.putObject(
      MINIO_BUCKET_NAME,
      fileKey,
      optimizedBuffer,
      optimizedBuffer.length,
      metaData,
    );

    // 6. Return the direct URL to save in your PostgreSQL database
    return `${MINIO_PUBLIC_URL}/${fileKey}`;
  } catch (error) {
    console.error("[MinIO Upload Error]:", error);
    throw new Error("Failed to process and upload image to MinIO");
  }
};
