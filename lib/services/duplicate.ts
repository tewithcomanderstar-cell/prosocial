import { Job } from "@/models/Job";
import { Post } from "@/models/Post";

export async function isDuplicatePostBlocked(params: {
  userId: string;
  fingerprint: string;
  duplicateWindowHours: number;
}) {
  if (params.duplicateWindowHours <= 0) {
    return false;
  }

  const since = new Date(Date.now() - params.duplicateWindowHours * 60 * 60 * 1000);

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
