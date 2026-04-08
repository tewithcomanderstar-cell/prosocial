import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";

export async function GET() {
  try {
    const userId = await requireAuth();

    const [totalPosts, scheduledPosts, recurringPosts, oneTimePosts] = await Promise.all([
      Post.countDocuments({ userId }),
      Schedule.countDocuments({ userId, enabled: true }),
      Schedule.countDocuments({
        userId,
        enabled: true,
        frequency: { $in: ["hourly", "daily", "weekly"] }
      }),
      Schedule.countDocuments({ userId, enabled: true, frequency: "once" })
    ]);

    return jsonOk({
      totalPosts,
      scheduledPosts,
      recurringPosts,
      oneTimePosts
    });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

