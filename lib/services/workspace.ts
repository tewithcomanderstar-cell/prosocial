import { randomUUID } from "crypto";
import { connectDb } from "@/lib/db";
import { TeamMember } from "@/models/TeamMember";
import { User } from "@/models/User";
import { Workspace } from "@/models/Workspace";

function slugifyWorkspaceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

async function buildUniqueWorkspaceSlug(base: string) {
  const normalizedBase = slugifyWorkspaceName(base);
  let candidate = normalizedBase;
  let attempts = 0;

  while (attempts < 5) {
    const existing = await Workspace.findOne({ slug: candidate }).select("_id").lean();
    if (!existing) {
      return candidate;
    }

    attempts += 1;
    candidate = `${normalizedBase}-${randomUUID().slice(0, 6)}`;
  }

  return `${normalizedBase}-${Date.now().toString(36)}`;
}

export async function resolveCurrentWorkspaceOrCreate(userId: string) {
  await connectDb();

  const existingMembership = await TeamMember.findOne({ userId }).sort({ updatedAt: -1 });
  if (existingMembership?.workspaceId) {
    const workspace = await Workspace.findById(existingMembership.workspaceId);
    if (workspace) {
      return workspace;
    }
  }

  const ownedWorkspace = await Workspace.findOne({ ownerUserId: userId }).sort({ updatedAt: -1 });
  if (ownedWorkspace) {
    await TeamMember.findOneAndUpdate(
      { workspaceId: ownedWorkspace._id, userId },
      {
        workspaceId: ownedWorkspace._id,
        userId,
        role: "admin"
      },
      { upsert: true, new: true }
    );
    return ownedWorkspace;
  }

  const user = (await User.findById(userId).lean()) as
    | {
        name?: string | null;
        email?: string | null;
        timezone?: string | null;
        locale?: string | null;
        plan?: "free" | "pro" | "business" | null;
        pageLimit?: number | null;
        subscriptionStatus?: "trialing" | "active" | "inactive" | null;
      }
    | null;
  const workspaceName = user?.name?.trim() ? `${user.name.trim()}'s Workspace` : "Default Workspace";
  const slugBase = user?.email?.split("@")[0] || user?.name || "workspace";
  const workspace = await Workspace.create({
    ownerUserId: userId,
    name: workspaceName,
    slug: await buildUniqueWorkspaceSlug(slugBase),
    timezone: user?.timezone || "Asia/Bangkok",
    locale: user?.locale || "th-TH",
    plan: user?.plan || "free",
    pageLimit: user?.pageLimit || 5,
    subscriptionStatus: user?.subscriptionStatus || "trialing"
  });

  await TeamMember.findOneAndUpdate(
    { workspaceId: workspace._id, userId },
    {
      workspaceId: workspace._id,
      userId,
      role: "admin"
    },
    { upsert: true, new: true }
  );

  return workspace;
}
