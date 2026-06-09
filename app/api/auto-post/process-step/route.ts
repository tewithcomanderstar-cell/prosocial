import { jsonError, jsonOk } from "@/lib/api";
import { processAutoPostConfigNow } from "@/lib/services/auto-post";
import { logAction, logAndNotifyError } from "@/lib/services/logging";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { processQueuedJobs } from "@/lib/services/queue";
import { AutoPostConfig } from "@/models/AutoPostConfig";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ProcessStepBody = {
  configId?: string;
  userId?: string;
  mode?: "prepare" | "publish" | "both";
  limit?: number;
};

async function resolveProcessContext(request: Request, body: ProcessStepBody) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;

  if (expectedSecret && authHeader === expectedSecret) {
    if (!body.userId) {
      throw new Error("Missing userId for internal auto-post worker");
    }
    return { userId: body.userId, internal: true };
  }

  const { userId } = await requireRole(["admin", "editor"]);
  return { userId, internal: false };
}

export async function POST(request: Request) {
  let body: ProcessStepBody = {};

  try {
    body = (await request.json().catch(() => ({}))) as ProcessStepBody;
    const { userId, internal } = await resolveProcessContext(request, body);
    const config = body.configId
      ? await AutoPostConfig.findOne({ _id: body.configId, userId })
      : await AutoPostConfig.findOne({ userId });

    if (!config) {
      return jsonError("Auto Post settings not found", 404, "auto_post_config_not_found");
    }

    const mode = body.mode ?? "both";
    const limit = Math.max(1, Math.min(Number(body.limit ?? Math.max(config.targetPageIds.length, 1)), 10));
    const response: {
      configId: string;
      mode: string;
      prepared?: Awaited<ReturnType<typeof processAutoPostConfigNow>>;
      processedJobs?: Awaited<ReturnType<typeof processQueuedJobs>>;
    } = {
      configId: String(config._id),
      mode
    };

    await logAction({
      userId,
      type: "queue",
      level: "info",
      message: "Auto Post worker step started",
      metadata: {
        autoPost: true,
        autoPostConfigId: String(config._id),
        mode,
        limit,
        internal
      }
    });

    if (mode === "prepare" || mode === "both") {
      response.prepared = await processAutoPostConfigNow(userId, String(config._id), { processInline: false });
    }

    if (mode === "publish" || mode === "both") {
      response.processedJobs = await processQueuedJobs(limit, "post");
    }

    await logAction({
      userId,
      type: "queue",
      level: "success",
      message: "Auto Post worker step completed",
      metadata: {
        autoPost: true,
        autoPostConfigId: String(config._id),
        mode,
        queued: response.prepared?.queued,
        processedJobs: response.processedJobs?.length ?? 0
      }
    });

    return jsonOk(response, "Auto Post worker step completed");
  } catch (error) {
    if (error instanceof Error && (error.message === "FORBIDDEN" || error.message === "UNAUTHORIZED")) {
      return handleRoleError(error);
    }

    const errorRecord = typeof error === "object" && error ? error as Record<string, unknown> : {};
    const errorCode = typeof errorRecord.code === "string" ? errorRecord.code : "";
    const errorStatus = typeof errorRecord.status === "number" ? errorRecord.status : 500;
    let diagnostics: unknown = null;
    if (typeof errorRecord.responseSummary === "string") {
      try {
        diagnostics = JSON.parse(errorRecord.responseSummary);
      } catch {
        diagnostics = errorRecord.responseSummary;
      }
    }

    const userId = body.userId;
    if (userId) {
      await logAndNotifyError({
        userId,
        message: error instanceof Error ? error.message : "Auto Post worker step failed",
        metadata: {
          autoPost: true,
          autoPostConfigId: body.configId,
          action: "process-step",
          mode: body.mode ?? "both"
        },
        error
      });
    }

    if (errorCode === "shopee_no_eligible_products") {
      return NextResponse.json({
        ok: false,
        message: error instanceof Error ? error.message : "No eligible Shopee products found",
        code: errorCode,
        diagnostics
      }, { status: errorStatus });
    }

    return jsonError(error instanceof Error ? error.message : "Auto Post worker step failed", 500, "auto_post_process_step_failed");
  }
}
