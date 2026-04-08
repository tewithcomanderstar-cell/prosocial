import { z } from "zod";
import { comparePassword, hashPassword } from "@/lib/auth";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { connectDb } from "@/lib/db";
import { logAction } from "@/lib/services/logging";
import { User } from "@/models/User";

const schema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8).max(128)
});

export async function POST(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());

    const user = await User.findById(userId);
    if (!user) {
      return jsonError("User not found", 404);
    }

    if (!user.passwordHash) {
      return jsonError("Password login is not available for this account", 400);
    }

    const isValid = await comparePassword(payload.currentPassword, user.passwordHash);
    if (!isValid) {
      await logAction({
        userId,
        type: "auth",
        level: "warn",
        message: "Password change failed because the current password was incorrect"
      });
      return jsonError("Current password is incorrect", 401);
    }

    user.passwordHash = await hashPassword(payload.newPassword);
    await user.save();

    await logAction({
      userId,
      type: "auth",
      level: "success",
      message: "Password changed successfully"
    });

    return jsonOk({}, "Password updated");
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Invalid password data", 422);
    }

    return jsonError("Unable to change password", 400);
  }
}
