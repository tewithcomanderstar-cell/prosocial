import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { computeNextRunAt, toUtcDateFromLocal } from "@/lib/utils";
import { logAction } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { Post } from "@/models/Post";
import { Schedule } from "@/models/Schedule";

const schema = z.object({
  postId: z.string().min(1),
  frequency: z.enum(["once", "hourly", "daily", "weekly"]),
  runAt: z.string().optional(),
  runAtLocal: z.string().optional(),
  timezone: z.string().min(1),
  intervalHours: z.number().min(1).max(24).optional(),
  delayMinutes: z.number().min(0).max(1440).optional(),
  startMode: z.enum(["delay", "scheduled"]).default("scheduled")
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const schedules = await Schedule.find({ userId }).sort({ nextRunAt: 1 }).lean();
    return jsonOk({ schedules });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const payload = parseBody(schema, await request.json());
    const safeDelayMinutes = payload.delayMinutes ?? 0;
    const safeIntervalHours = payload.intervalHours ?? 1;

    const firstRunAt =
      payload.startMode === "delay"
        ? new Date(Date.now() + safeDelayMinutes * 60 * 1000)
        : payload.runAtLocal
          ? toUtcDateFromLocal(payload.runAtLocal, payload.timezone)
          : payload.runAt
            ? new Date(payload.runAt)
          : new Date();

    const schedule = await Schedule.create({
      userId,
      postId: payload.postId,
      frequency: payload.frequency,
      intervalHours: payload.frequency === "hourly" ? safeIntervalHours : 1,
      delayMinutes: safeDelayMinutes,
      runAt: firstRunAt,
      nextRunAt: firstRunAt,
      timezone: payload.timezone
    });

    await Post.findByIdAndUpdate(payload.postId, { status: "scheduled" });
    await logAction({
      userId,
      type: "queue",
      level: "info",
      message: "Schedule created",
      relatedPostId: payload.postId,
      relatedScheduleId: String(schedule._id),
      metadata: {
        frequency: payload.frequency,
        runAt: firstRunAt.toISOString(),
        timezone: payload.timezone,
        intervalHours: safeIntervalHours,
        delayMinutes: safeDelayMinutes,
        startMode: payload.startMode
      }
    });

    return jsonOk(
      {
        nextRunAt: computeNextRunAt(
          payload.frequency,
          firstRunAt.toISOString(),
          firstRunAt,
          safeIntervalHours,
          payload.timezone
        ),
        firstRunAt,
        scheduledAtUtc: firstRunAt.toISOString(),
        timezone: payload.timezone
      },
      "Schedule created"
    );
  } catch (error) {
    return handleRoleError(error);
  }
}
