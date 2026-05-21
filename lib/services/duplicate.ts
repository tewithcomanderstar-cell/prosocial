import { Job } from "@/models/Job";
import { Post } from "@/models/Post";

export async function isDuplicatePostBlocked(params: {
  userId: string;
  fingerprint: string;
  duplicateWindowHours: number;
  targetPageId?: string | null;
}) {
  if (params.duplicateWindowHours <= 0) {
    return false;
  }

  const since = new Date(Date.now() - params.duplicateWindowHours * 60 * 60 * 1000);

  if (params.targetPageId) {
    const recentPageJob = await Job.findOne({
      userId: params.userId,
      targetPageId: params.targetPageId,
      fingerprint: params.fingerprint,
      status: "success",
      completedAt: { $gte: since }
    }).lean();

    return Boolean(recentPageJob);
  }

  const [recentJob, recentPost] = await Promise.all([
    Job.findOne({
      userId: params.userId,
      fingerprint: params.fingerprint,
      status: "success",
      completedAt: { $gte: since }
    }).lean(),
    Post.findOne({
      userId: params.userId,
      fingerprint: params.fingerprint,
      lastPublishedAt: { $gte: since }
    }).lean()
  ]);

  return Boolean(recentJob || recentPost);
}
