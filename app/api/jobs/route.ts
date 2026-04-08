import { jsonError, jsonOk, requireAuth } from "@/lib/api";
import { Job } from "@/models/Job";

export async function GET() {
  try {
    const userId = await requireAuth();
    const jobs = await Job.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return jsonOk({ jobs });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}
