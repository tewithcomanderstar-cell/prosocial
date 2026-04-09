import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { contentFingerprint, imageFingerprint, stableHash } from "@/lib/services/fingerprint";
import { getEffectivePageLimit, getUserSettings } from "@/lib/services/settings";
import { logAction } from "@/lib/services/logging";
import { Post } from "@/models/Post";

type UserPlanShape = {
  pageLimit?: number | null;
  plan?: string | null;
};

type SettingsShape = {
  pageLimitOverride?: number | null;
};

const MAX_TARGET_PAGES = 10;

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

export async function GET() {
  try {
    const userId = await requireAuth();
    const posts = await Post.find({ userId }).sort({ createdAt: -1 }).lean();
    return jsonOk({ posts });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const { settings, user } = await getUserSettings(userId);
    const planLimit = getEffectivePageLimit((user ?? {}) as UserPlanShape, (settings ?? {}) as SettingsShape);
    const allowedTargetPages = Math.max(planLimit, MAX_TARGET_PAGES);

    if (payload.targetPageIds.length > allowedTargetPages) {
      return jsonError(`You can post to up to ${allowedTargetPages} pages at once.`);
    }

    const fingerprint = contentFingerprint(payload);
    const contentHash = stableHash({ content: payload.content, hashtags: payload.hashtags, variants: payload.variants });
    const imgHash = imageFingerprint(payload.imageUrls ?? []);

    const post = await Post.create({
      userId,
      ...payload,
      contentHash,
      imageHash: imgHash,
      fingerprint,
      status: "draft"
    });

    await logAction({
      userId,
      type: "post",
      level: "info",
      message: "Post template created",
      relatedPostId: String(post._id),
      metadata: { targetPageCount: payload.targetPageIds.length }
    });

    return jsonOk({ postId: String(post._id) }, `Post saved for ${payload.targetPageIds.length} page(s)`);
  } catch (error) {
    return handleRoleError(error);
  }
}
