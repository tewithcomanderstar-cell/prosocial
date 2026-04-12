import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { FacebookConnection } from "@/models/FacebookConnection";
import { Job } from "@/models/Job";
import { Notification } from "@/models/Notification";
import { Post } from "@/models/Post";
import { PostApproval } from "@/models/PostApproval";
import { Schedule } from "@/models/Schedule";

export async function GET() {
  try {
    const userId = await requireAuth();

    const [
      totalPosts,
      scheduledPosts,
      recurringPosts,
      oneTimePosts,
      pendingApprovals,
      failedRuns,
      runningRuns,
      unreadAlerts,
      connections
    ] = await Promise.all([
      Post.countDocuments({ userId }),
      Schedule.countDocuments({ userId, enabled: true }),
      Schedule.countDocuments({
        userId,
        enabled: true,
        frequency: { $in: ["hourly", "daily", "weekly"] }
      }),
      Schedule.countDocuments({ userId, enabled: true, frequency: "once" }),
      PostApproval.countDocuments({ userId, status: "pending" }),
      Job.countDocuments({ userId, status: { $in: ["failed", "rate_limited", "duplicate_blocked"] } }),
      Job.countDocuments({ userId, status: { $in: ["processing", "retrying"] } }),
      Notification.countDocuments({ userId, readAt: { $exists: false } }),
      FacebookConnection.find({ userId }).lean()
    ]);

    const connectedPages = connections.reduce((count, connection) => {
      const pages = Array.isArray(connection.pages) ? connection.pages.length : 0;
      return count + pages;
    }, 0);

    const tokenWarnings = connections.filter((connection) =>
      ["warning", "expired"].includes(String(connection.tokenStatus || "unknown"))
    ).length;

    return jsonOk({
      totalPosts,
      scheduledPosts,
      recurringPosts,
      oneTimePosts,
      pendingApprovals,
      failedRuns,
      runningRuns,
      unreadAlerts,
      connectedPages,
      tokenWarnings,
      activeConnections: connections.length
    });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
