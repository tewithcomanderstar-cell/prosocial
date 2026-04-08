import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { logRouteError } from "@/lib/services/logging";
import { connectDb } from "@/lib/db";
import { User } from "@/models/User";
import { z } from "zod";

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(120),
  locale: z.string().trim().min(1).max(40),
  avatar: z
    .string()
    .trim()
    .max(2_000_000)
    .refine(
      (value) =>
        value.length === 0 ||
        value.startsWith("data:image/") ||
        value.startsWith("http://") ||
        value.startsWith("https://"),
      "Invalid avatar image"
    )
    .optional()
});

function serializeUser(user: any) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    provider: user.provider,
    hasPassword: Boolean(user.passwordHash),
    role: user.role,
    timezone: user.timezone,
    locale: user.locale,
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    pageLimit: user.pageLimit,
    createdAt: user.createdAt
  };
}

export async function GET() {
  try {
    await connectDb();
    const userId = await requireAuth();
    const user = await User.findById(userId);

    if (!user) {
      return jsonError("User not found", 404);
    }

    return jsonOk({ user: serializeUser(user) });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function PUT(request: Request) {
  try {
    await connectDb();
    const userId = await requireAuth();
    const body = await request.json();
    const payload = parseBody(updateProfileSchema, body);

    const user = await User.findByIdAndUpdate(
      userId,
      {
        name: payload.name,
        timezone: payload.timezone,
        locale: payload.locale,
        avatar: payload.avatar === undefined ? undefined : payload.avatar || null
      },
      { new: true }
    );

    if (!user) {
      return jsonError("User not found", 404);
    }

    return jsonOk({ user: serializeUser(user) }, "Profile updated");
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Invalid profile data", 422);
    }

    try {
      const userId = await requireAuth();
      await logRouteError({
        userId,
        message: "Profile update failed",
        error,
        metadata: { source: "profile-update" }
      });
    } catch {}

    return jsonError("Unable to update profile", 400);
  }
}
