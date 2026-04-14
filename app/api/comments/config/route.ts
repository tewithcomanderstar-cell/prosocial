import { z } from "zod";
import { isUnauthorizedError, jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { PostingSettings } from "@/models/PostingSettings";

const schema = z.object({
  autoCommentEnabled: z.boolean(),
  autoCommentPageIds: z.array(z.string()).default([]),
  autoCommentReplies: z.array(z.string()).default([])
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const settings = await PostingSettings.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId } },
      { upsert: true, new: true }
    ).lean<{
      autoCommentEnabled?: boolean;
      autoCommentPageIds?: string[];
      autoCommentReplies?: string[];
    } | null>();

    return jsonOk({
      autoCommentEnabled: Boolean(settings?.autoCommentEnabled),
      autoCommentPageIds: (settings?.autoCommentPageIds ?? []).filter(Boolean),
      autoCommentReplies: (settings?.autoCommentReplies ?? []).map((item) => item.trim()).filter(Boolean)
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load auto comment config", isUnauthorizedError(error) ? 401 : 500);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());

    const settings = await PostingSettings.findOneAndUpdate(
      { userId },
      {
        $set: {
          autoCommentEnabled: payload.autoCommentEnabled,
          autoCommentPageIds: (payload.autoCommentPageIds ?? []).filter(Boolean),
          autoCommentReplies: (payload.autoCommentReplies ?? []).map((item) => item.trim()).filter(Boolean)
        }
      },
      { upsert: true, new: true }
    ).lean();

    return jsonOk({ settings }, "Auto Comment configuration saved");
  } catch (error) {
    return handleRoleError(error);
  }
}
