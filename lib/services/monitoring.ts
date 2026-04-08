import { connectDb } from "@/lib/db";
import { createNotification, logAction } from "@/lib/services/logging";
import { HealthCheckRecord } from "@/models/HealthCheckRecord";

export async function runHealthChecks(userId?: string) {
  const results = [] as Array<{ target: string; status: "healthy" | "warning" | "down"; message: string; metadata?: Record<string, unknown> }>;

  try {
    await connectDb();
    results.push({ target: "database", status: "healthy", message: "MongoDB connection is available" });
  } catch (error) {
    results.push({ target: "database", status: "down", message: error instanceof Error ? error.message : "Database unavailable" });
  }

  const facebookConfigured = Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
  results.push({
    target: "facebook-api",
    status: facebookConfigured ? "healthy" : "warning",
    message: facebookConfigured ? "Facebook credentials configured" : "Facebook credentials missing"
  });

  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
  results.push({
    target: "ai-api",
    status: openAiConfigured ? "healthy" : "warning",
    message: openAiConfigured ? "OpenAI API key configured" : "OpenAI API key missing"
  });

  for (const result of results) {
    await HealthCheckRecord.create({
      userId,
      target: result.target,
      status: result.status,
      message: result.message,
      metadata: result.metadata ?? {}
    });

    if (userId && result.status !== "healthy") {
      await logAction({
        userId,
        type: "analytics",
        level: result.status === "down" ? "error" : "warn",
        message: `Health check: ${result.target} is ${result.status}`,
        metadata: { target: result.target, message: result.message }
      });

      await createNotification({
        userId,
        type: "system",
        severity: result.status === "down" ? "error" : "warn",
        title: `${result.target} ${result.status}`,
        message: result.message
      });
    }
  }

  return results;
}
