import * as Minio from "minio";
import "dotenv/config";

// 1. Initialize the Native MinIO Client
export const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "localhost",
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === "true", // false for local dev
  accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  secretKey: process.env.MINIO_SECRET_KEY || "minioadmin123",
});

export const MINIO_BUCKET_NAME = process.env.MINIO_BUCKET_NAME || "eventomir";
export const MINIO_PUBLIC_URL =
  process.env.MINIO_PUBLIC_URL || "http://localhost:9000/eventomir";

// 2. Auto-Initialize Bucket & Public Policies
export const initializeMinio = async () => {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET_NAME);

    if (!exists) {
      // Create the bucket
      await minioClient.makeBucket(MINIO_BUCKET_NAME, "us-east-1");

      // Set Bucket Policy to Public Read so the frontend can render the images
      const publicPolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["s3:GetObject"],
            Effect: "Allow",
            Principal: "*",
            Resource: [`arn:aws:s3:::${MINIO_BUCKET_NAME}/*`],
          },
        ],
      };

      await minioClient.setBucketPolicy(
        MINIO_BUCKET_NAME,
        JSON.stringify(publicPolicy),
      );
      console.log(
        `✅ MinIO: Created bucket '${MINIO_BUCKET_NAME}' and set to Public Read.`,
      );
    } else {
      console.log(
        `✅ MinIO: Connected to existing bucket '${MINIO_BUCKET_NAME}'.`,
      );
    }
  } catch (error) {
    console.error("❌ MinIO Initialization Error:", error);
  }
};
