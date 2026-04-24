import { Job } from "@/models/Job";
import { getUserSettings } from "@/lib/services/settings";

function getBangkokDayWindow(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");

  const start = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
}

export async function checkRateLimits(userId: string, type: "post" | "comment-reply") {
  const { settings } = await getUserSettings(userId);
  const safeSettings = {
    hourlyPostLimit: settings?.hourlyPostLimit ?? 10,
    // Daily caps are intentionally disabled. We keep the field for UI/backward
    // compatibility, but runtime should treat it as unlimited.
    dailyPostLimit: 0,
    commentHourlyLimit: settings?.commentHourlyLimit ?? 20,
    apiBurstWindowMs: settings?.apiBurstWindowMs ?? 60000,
    apiBurstMax: settings?.apiBurstMax ?? 20
  };

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const bangkokDayWindow = getBangkokDayWindow(now);

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
      completedAt: { $gte: bangkokDayWindow.start, $lt: bangkokDayWindow.end }
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
    if (safeSettings.dailyPostLimit > 0 && dayCount >= safeSettings.dailyPostLimit) {
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
