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

  const appUrlConfigured = Boolean(process.env.NEXT_PUBLIC_APP_URL);
  results.push({
    target: "app-url",
    status: appUrlConfigured ? "healthy" : "warning",
    message: appUrlConfigured ? "Application URL configured" : "Application URL missing"
  });

  const facebookConfigured = Boolean(
    process.env.FACEBOOK_APP_ID &&
    process.env.FACEBOOK_APP_SECRET &&
    process.env.FACEBOOK_AUTH_REDIRECT_URI &&
    process.env.FACEBOOK_REDIRECT_URI &&
    process.env.FACEBOOK_LOGIN_CONFIG_ID
  );
  results.push({
    target: "facebook-api",
    status: facebookConfigured ? "healthy" : "warning",
    message: facebookConfigured ? "Facebook OAuth configured" : "Facebook OAuth configuration missing"
  });

  const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_AUTH_REDIRECT_URI &&
    process.env.GOOGLE_REDIRECT_URI
  );
  results.push({
    target: "google-api",
    status: googleConfigured ? "healthy" : "warning",
    message: googleConfigured ? "Google OAuth configured" : "Google OAuth configuration missing"
  });

  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
  results.push({
    target: "ai-api",
    status: openAiConfigured ? "healthy" : "warning",
    message: openAiConfigured ? "OpenAI API key configured" : "OpenAI API key missing"
  });

  const cronConfigured = Boolean(process.env.CRON_SECRET);
  results.push({
    target: "cron",
    status: cronConfigured ? "healthy" : "warning",
    message: cronConfigured ? "Cron secret configured" : "Cron secret missing"
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
