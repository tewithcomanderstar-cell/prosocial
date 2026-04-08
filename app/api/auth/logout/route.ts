import { clearSession, getSessionUserId } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { logAction } from "@/lib/services/logging";

export async function POST() {
  await connectDb();
  const userId = await getSessionUserId();
  await clearSession();

  if (userId) {
    await logAction({
      userId,
      type: "auth",
      level: "info",
      message: "User logged out"
    });
  }

  return jsonOk({}, "Logged out");
}
