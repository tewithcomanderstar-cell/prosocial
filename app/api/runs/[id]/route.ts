import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { mapLegacyJobToWorkflowRun, mapLegacyPostToContentItem } from "@/lib/domain/mappers";
import { ActionLog } from "@/models/ActionLog";
import { Job } from "@/models/Job";
import { Post } from "@/models/Post";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const userId = await requireAuth();
    const { id } = await context.params;

    const job = await Job.findOne({ _id: id, userId }).lean<Record<string, unknown> | null>();
    if (!job) {
      return jsonError("Run not found", 404);
    }

    const run = mapLegacyJobToWorkflowRun(job);
    const relatedPostId = job.postId ? String(job.postId) : null;

    const [post, actionLogs] = await Promise.all([
      relatedPostId ? Post.findOne({ _id: relatedPostId, userId }).lean<Record<string, unknown> | null>() : Promise.resolve(null),
      ActionLog.find({
        userId,
        $or: [{ relatedJobId: job._id }, ...(relatedPostId ? [{ relatedPostId }] : [])]
      })
        .sort({ createdAt: -1 })
        .limit(25)
        .lean<Array<Record<string, unknown>>>()
    ]);

    const contentItem = post ? mapLegacyPostToContentItem(post) : null;
    const timeline = actionLogs.map((log) => ({
      id: String(log._id),
      level: String(log.level || "info"),
      type: String(log.type || "system"),
      message: String(log.message || ""),
      createdAt: log.createdAt instanceof Date ? log.createdAt.toISOString() : new Date(String(log.createdAt)).toISOString(),
      metadata: (log.metadata as Record<string, unknown> | undefined) || {}
    }));

    return jsonOk({
      run,
      contentItem,
      timeline,
      diagnostics: {
        attempts: Number(job.attempts || 0),
        maxAttempts: Number(job.maxAttempts || 0),
        targetPageId: job.targetPageId ? String(job.targetPageId) : undefined,
        fingerprint: job.fingerprint ? String(job.fingerprint) : undefined
      }
    });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
