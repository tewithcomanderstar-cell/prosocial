import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";
import { PostApproval } from "@/models/PostApproval";
import { convertUtcToTimezone } from "@/lib/services/localization";

export async function getPlannerView(userId: string, view: "day" | "week" | "month" = "week", timezone = "Asia/Bangkok", locale = "th-TH") {
  const [posts, schedules, approvals] = await Promise.all([
    Post.find({ userId }).sort({ createdAt: -1 }).lean(),
    Schedule.find({ userId }).sort({ nextRunAt: 1 }).lean(),
    PostApproval.find({ userId, status: "pending" }).lean()
  ]);

  const postMap = new Map(posts.map((post) => [String(post._id), post]));
  const approvalSet = new Set(approvals.map((item) => String(item.postId)));

  const items = schedules.map((schedule) => {
    const post = postMap.get(String(schedule.postId));
    const nextRun = new Date(schedule.nextRunAt);
    return {
      id: String(schedule._id),
      postId: String(schedule.postId),
      title: post?.title ?? "Untitled",
      caption: post?.content ?? "",
      imageUrls: post?.imageUrls ?? [],
      frequency: schedule.frequency,
      intervalHours: schedule.intervalHours ?? 1,
      status: post?.status ?? "scheduled",
      approvalStatus: approvalSet.has(String(schedule.postId)) ? "pending-approval" : "ready",
      nextRunAt: schedule.nextRunAt,
      localTime: convertUtcToTimezone(nextRun, timezone, locale),
      bucket: view === "day"
        ? nextRun.getHours().toString().padStart(2, "0") + ":00"
        : view === "week"
          ? nextRun.toLocaleDateString(locale, { weekday: "short", timeZone: timezone })
          : nextRun.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: timezone })
    };
  });

  return { view, items };
}
