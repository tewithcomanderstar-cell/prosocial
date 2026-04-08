import { Job } from "@/models/Job";
import { getUserSettings } from "@/lib/services/settings";

export async function checkRateLimits(userId: string, type: "post" | "comment-reply") {
  const { settings } = await getUserSettings(userId);
  const safeSettings = {
    hourlyPostLimit: settings?.hourlyPostLimit ?? 10,
    dailyPostLimit: settings?.dailyPostLimit ?? 40,
    commentHourlyLimit: settings?.commentHourlyLimit ?? 20,
    apiBurstWindowMs: settings?.apiBurstWindowMs ?? 60000,
    apiBurstMax: settings?.apiBurstMax ?? 20
  };

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [hourCount, dayCount, burstCount] = await Promise.all([
    Job.countDocuments({
      userId,
      type,
      status: "success",
      completedAt: { $gte: hourAgo }
    }),
    Job.countDocuments({
      userId,
      type,
      status: "success",
      completedAt: { $gte: dayAgo }
    }),
    Job.countDocuments({
      userId,
      type,
      createdAt: { $gte: new Date(now.getTime() - safeSettings.apiBurstWindowMs) }
    })
  ]);

  if (type === "post") {
    if (hourCount >= safeSettings.hourlyPostLimit) {
      return { allowed: false, reason: "Hourly post limit reached" };
    }
    if (dayCount >= safeSettings.dailyPostLimit) {
      return { allowed: false, reason: "Daily post limit reached" };
    }
  }

  if (type === "comment-reply" && hourCount >= safeSettings.commentHourlyLimit) {
    return { allowed: false, reason: "Comment reply hourly limit reached" };
  }

  if (burstCount >= safeSettings.apiBurstMax) {
    return { allowed: false, reason: "API burst protection triggered" };
  }

  return { allowed: true, reason: null as string | null };
}
