import { z } from "zod";
import { jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { contentFingerprint, imageFingerprint, stableHash } from "@/lib/services/fingerprint";
import { logAction } from "@/lib/services/logging";
import { enqueuePostJobsForPost, processQueuedJobs } from "@/lib/services/queue";
import { Post } from "@/models/Post";

const schema = z.object({
  title: z.string().min(2),
  content: z.string().min(2),
  hashtags: z.array(z.string()).default([]),
  imageUrls: z.array(z.string()).default([]),
  targetPageIds: z.array(z.string()).min(1),
  randomizeImages: z.boolean().default(false),
  randomizeCaption: z.boolean().default(false),
  postingMode: z.enum(["broadcast", "random-page"]),
  variants: z.array(
    z.object({
      caption: z.string(),
      hashtags: z.array(z.string())
    })
  ).default([])
});

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());

    const fingerprint = contentFingerprint(payload);
    const contentHash = stableHash({ content: payload.content, hashtags: payload.hashtags, variants: payload.variants });
    const imageHash = imageFingerprint(payload.imageUrls ?? []);

    const post = await Post.create({
      userId,
      ...payload,
      fingerprint,
      contentHash,
      imageHash,
      status: "scheduled"
    });

    const queued = await enqueuePostJobsForPost(userId, String(post._id), {
      applyRandomDelay: false,
      startAt: new Date()
    });
    const processed = await processQueuedJobs(20);

    await logAction({
      userId,
      type: "post",
      level: "info",
      message: "Immediate posting requested",
      relatedPostId: String(post._id),
      metadata: { queued }
    });

    return jsonOk({ postId: String(post._id), queued, processed }, "Immediate post started");
  } catch (error) {
    return handleRoleError(error);
  }
}
