import { randomUUID } from "crypto";
import { jsonError, jsonOk } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { connectDb } from "@/lib/db";
import { MediaCache } from "@/models/MediaCache";

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    await connectDb();

    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File && value.size > 0);

    if (files.length === 0) {
      return jsonError("No files uploaded", 400);
    }

    const uploaded = [] as Array<{ id: string; name: string; mimeType: string; ref: string }>;

    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        continue;
      }

      const fileId = `upload-${randomUUID()}`;
      const bytes = await file.arrayBuffer();

      await MediaCache.findOneAndUpdate(
        { userId, fileId },
        {
          userId,
          fileId,
          mimeType: file.type,
          fileName: file.name,
          bytesBase64: Buffer.from(bytes).toString("base64"),
          source: "local-upload",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        },
        { upsert: true, new: true }
      );

      uploaded.push({
        id: fileId,
        name: file.name,
        mimeType: file.type,
        ref: `upload:${fileId}`
      });
    }

    if (uploaded.length === 0) {
      return jsonError("No image files were uploaded", 400);
    }

    return jsonOk({ uploads: uploaded }, "Files uploaded");
  } catch (error) {
    return handleRoleError(error);
  }
}
