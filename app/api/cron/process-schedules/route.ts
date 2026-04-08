import { connectDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";
import { processDueSchedules } from "@/lib/services/scheduler";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return jsonError("Unauthorized", 401);
  }

  try {
    await connectDb();
    const processed = await processDueSchedules();
    return jsonOk({ processed }, "Schedules processed");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process schedules", 500);
  }
}
