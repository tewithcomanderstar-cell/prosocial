import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { logAction } from "@/lib/services/logging";
import { ActionLog } from "@/models/ActionLog";
import { BackupSnapshot } from "@/models/BackupSnapshot";
import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { Job } from "@/models/Job";
import { PagePersona } from "@/models/PagePersona";
import { Post } from "@/models/Post";
import { PostingSettings } from "@/models/PostingSettings";
import { Schedule } from "@/models/Schedule";

export async function GET() {
  try {
    const userId = await requireAuth();
    const [posts, schedules, personas, settings, jobs, logs, facebook, google] = await Promise.all([
      Post.find({ userId }).lean(),
      Schedule.find({ userId }).lean(),
      PagePersona.find({ userId }).lean(),
      PostingSettings.findOne({ userId }).lean(),
      Job.find({ userId }).lean(),
      ActionLog.find({ userId }).lean(),
      FacebookConnection.findOne({ userId }).lean(),
      GoogleDriveConnection.findOne({ userId }).lean()
    ]);

    const exportedAt = new Date();
    const data = {
      exportedAt,
      posts,
      schedules,
      personas,
      settings,
      jobs,
      logs,
      integrations: {
        facebook,
        googleDrive: google
      }
    };

    await BackupSnapshot.create({
      userId,
      type: "export",
      status: "completed",
      fileName: `prosocial-export-${exportedAt.toISOString()}.json`,
      itemCounts: {
        posts: posts.length,
        schedules: schedules.length,
        personas: personas.length,
        jobs: jobs.length,
        logs: logs.length
      }
    });

    await logAction({
      userId,
      type: "backup",
      level: "success",
      message: "Data export completed"
    });

    return jsonOk(data, "Export ready");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to export data");
  }
}
