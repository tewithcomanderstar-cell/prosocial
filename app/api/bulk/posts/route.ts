import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { parseCsvRows } from "@/lib/services/bulk";
import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";

const schema = z.object({
  csv: z.string().min(1),
  timezone: z.string().default("Asia/Bangkok")
});

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const rows = parseCsvRows(payload.csv);
    const created = [] as string[];

    for (const row of rows) {
      const post = await Post.create({
        userId,
        title: row.title || "Bulk post",
        content: row.content || "",
        hashtags: (row.hashtags || "").split(/\s+/).filter(Boolean),
        imageUrls: (row.imageUrls || "").split("|").filter(Boolean),
        targetPageIds: (row.targetPageIds || "").split("|").filter(Boolean),
        postingMode: row.postingMode === "random-page" ? "random-page" : "broadcast",
        randomizeImages: row.randomizeImages === "true",
        randomizeCaption: row.randomizeCaption === "true",
        variants: [],
        status: "scheduled"
      });

      if (row.runAt) {
        await Schedule.create({
          userId,
          postId: post._id,
          frequency: row.frequency || "once",
          intervalHours: Number(row.intervalHours || 1),
          delayMinutes: Number(row.delayMinutes || 0),
          runAt: new Date(row.runAt),
          nextRunAt: new Date(row.runAt),
          timezone: payload.timezone
        });
      }

      created.push(String(post._id));
    }

    return jsonOk({ createdCount: created.length, postIds: created }, "Bulk upload completed");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process bulk upload");
  }
}
