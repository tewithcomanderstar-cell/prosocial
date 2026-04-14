import { z } from "zod";
import { isUnauthorizedError, jsonError, jsonOk, requireAuth } from "@/lib/api";
import { mapLegacyPostToContentItem } from "@/lib/domain/mappers";
import { Job } from "@/models/Job";
import { Post } from "@/models/Post";
import { PostApproval } from "@/models/PostApproval";
import { handleRoleError, requireRole } from "@/lib/services/permissions";

const bulkActionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  action: z.enum(["move_to_draft", "retry", "approve"])
});

export async function GET(request: Request) {
  try {
    const userId = await requireAuth();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const pageId = searchParams.get("pageId");

    const [posts, approvals, jobs] = await Promise.all([
      Post.find({ userId }).sort({ createdAt: -1 }).lean(),
      PostApproval.find({ userId }).lean(),
      Job.find({ userId }).sort({ createdAt: -1 }).lean()
    ]);

    const approvalByPostId = new Map(approvals.map((approval) => [String(approval.postId), approval]));
    const latestJobByPostId = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      const postId = String(job.postId || "");
      if (postId && !latestJobByPostId.has(postId)) {
        latestJobByPostId.set(postId, job as Record<string, unknown>);
      }
    }

    const items = posts
      .map((post) =>
        mapLegacyPostToContentItem(
          post as Record<string, unknown>,
          approvalByPostId.get(String(post._id)) as Record<string, unknown> | undefined,
          latestJobByPostId.get(String(post._id))
        )
      )
      .filter((item) => {
        if (status && item.status !== status) return false;
        if (pageId && !item.destinationIds?.includes(pageId)) return false;
        return true;
      });

    const summary = {
      total: items.length,
      draft: items.filter((item) => item.status === "draft").length,
      pendingReview: items.filter((item) => item.status === "pending_review").length,
      approved: items.filter((item) => item.status === "approved").length,
      scheduled: items.filter((item) => item.status === "scheduled").length,
      publishing: items.filter((item) => item.status === "publishing").length,
      failed: items.filter((item) => item.status === "failed").length
    };

    return jsonOk({ items, summary });
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return jsonError("Unauthorized", 401);
    }

    return jsonError(error instanceof Error ? error.message : "Unable to load queue", 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = bulkActionSchema.parse(await request.json());

    if (payload.action === "move_to_draft") {
      await Post.updateMany({ userId, _id: { $in: payload.ids } }, { $set: { status: "draft" } });
      return jsonOk({ ids: payload.ids }, "Moved content back to draft");
    }

    if (payload.action === "retry") {
      await Post.updateMany({ userId, _id: { $in: payload.ids } }, { $set: { status: "scheduled" } });
      await Job.updateMany(
        { userId, postId: { $in: payload.ids } },
        {
          $set: {
            status: "queued",
            nextRunAt: new Date(),
            lastError: null,
            processingStartedAt: null,
            completedAt: null
          }
        }
      );
      return jsonOk({ ids: payload.ids }, "Queued failed items for retry");
    }

    await PostApproval.updateMany(
      { userId, postId: { $in: payload.ids } },
      { $set: { status: "approved", note: "Approved from queue", requestedByUserId: userId } }
    );

    const missingPosts = await Post.find({ userId, _id: { $in: payload.ids } }).select({ _id: 1 }).lean();
    const existingApprovalIds = new Set(
      (await PostApproval.find({ userId, postId: { $in: payload.ids } }).select({ postId: 1 }).lean()).map((approval) => String(approval.postId))
    );

    const inserts = missingPosts
      .filter((post) => !existingApprovalIds.has(String(post._id)))
      .map((post) => ({
        userId,
        postId: post._id,
        requestedByUserId: userId,
        status: "approved",
        note: "Approved from queue"
      }));

    if (inserts.length) {
      await PostApproval.insertMany(inserts);
    }

    return jsonOk({ ids: payload.ids }, "Approved selected content");
  } catch (error) {
    return handleRoleError(error);
  }
}
