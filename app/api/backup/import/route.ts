import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { createNotification, logAction } from "@/lib/services/logging";
import { BackupSnapshot } from "@/models/BackupSnapshot";
import { PagePersona } from "@/models/PagePersona";
import { Post } from "@/models/Post";
import { PostingSettings } from "@/models/PostingSettings";
import { Schedule } from "@/models/Schedule";

const schema = z.object({
  posts: z.array(z.record(z.any())).optional(),
  schedules: z.array(z.record(z.any())).optional(),
  personas: z.array(z.record(z.any())).optional(),
  settings: z.record(z.any()).optional(),
  mode: z.enum(["merge", "replace"]).default("merge")
});

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());

    if (payload.settings) {
      await PostingSettings.findOneAndUpdate({ userId }, payload.settings, { upsert: true });
    }

    if (payload.personas?.length) {
      for (const persona of payload.personas) {
        await PagePersona.findOneAndUpdate(
          { userId, pageId: persona.pageId },
          { ...persona, userId },
          { upsert: true }
        );
      }
    }

    if (payload.posts?.length) {
      for (const post of payload.posts) {
        await Post.create({ ...post, userId, _id: undefined });
      }
    }

    if (payload.schedules?.length) {
      for (const schedule of payload.schedules) {
        await Schedule.create({ ...schedule, userId, _id: undefined });
      }
    }

    await BackupSnapshot.create({
      userId,
      type: "import",
      status: "completed",
      itemCounts: {
        posts: payload.posts?.length ?? 0,
        schedules: payload.schedules?.length ?? 0,
        personas: payload.personas?.length ?? 0
      },
      note: `Import mode: ${payload.mode}`
    });

    await logAction({
      userId,
      type: "backup",
      level: "success",
      message: "Data import completed"
    });

    await createNotification({
      userId,
      type: "backup",
      severity: "info",
      title: "Import completed",
      message: "Your backup import finished successfully."
    });

    return jsonOk({ imported: true }, "Import completed");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to import data");
  }
}
