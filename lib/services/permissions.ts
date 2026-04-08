import { connectDb } from "@/lib/db";
import { jsonError } from "@/lib/api";
import { User } from "@/models/User";

type UserRoleShape = {
  role?: "admin" | "editor" | "viewer" | null;
};

export async function requireRole(allowedRoles: Array<"admin" | "editor" | "viewer">) {
  const { requireAuth } = await import("@/lib/api");
  const userId = await requireAuth();
  await connectDb();
  const user = (await User.findById(userId).lean()) as UserRoleShape | null;
  const role = user?.role ?? "viewer";

  if (!allowedRoles.includes(role)) {
    throw new Error("FORBIDDEN");
  }

  return { userId, role };
}

export function handleRoleError(error: unknown) {
  if (error instanceof Error && error.message === "FORBIDDEN") {
    return jsonError("Forbidden", 403);
  }
  return jsonError(error instanceof Error ? error.message : "Unable to complete request");
}
