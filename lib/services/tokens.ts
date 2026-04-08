import { FacebookConnection } from "@/models/FacebookConnection";
import { GoogleDriveConnection } from "@/models/GoogleDriveConnection";
import { createNotification, logAction } from "@/lib/services/logging";
import { getUserSettings } from "@/lib/services/settings";

type TokenConnection = {
  expiresAt?: Date | null;
};

function getExpiryStatus(expiresAt?: Date | null, warningHours = 72) {
  if (!expiresAt) {
    return "unknown";
  }

  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) {
    return "expired";
  }
  if (msLeft <= warningHours * 60 * 60 * 1000) {
    return "warning";
  }
  return "healthy";
}

export async function inspectTokenStatus(userId: string) {
  const [{ settings }, facebookRaw, googleRaw] = await Promise.all([
    getUserSettings(userId),
    FacebookConnection.findOne({ userId }).lean(),
    GoogleDriveConnection.findOne({ userId }).lean()
  ]);

  const warningHours = settings?.tokenExpiryWarningHours ?? 72;
  const facebook = facebookRaw as TokenConnection | null;
  const google = googleRaw as TokenConnection | null;

  const items = [
    {
      provider: "facebook",
      connected: Boolean(facebook),
      expiresAt: facebook?.expiresAt ?? null,
      status: getExpiryStatus(facebook?.expiresAt, warningHours)
    },
    {
      provider: "google-drive",
      connected: Boolean(google),
      expiresAt: google?.expiresAt ?? null,
      status: getExpiryStatus(google?.expiresAt, warningHours)
    }
  ];

  for (const item of items) {
    if (item.connected && (item.status === "warning" || item.status === "expired")) {
      await logAction({
        userId,
        type: "token",
        level: item.status === "expired" ? "error" : "warn",
        message: `${item.provider} token is ${item.status}`,
        metadata: { provider: item.provider, expiresAt: item.expiresAt ?? undefined }
      });

      await createNotification({
        userId,
        type: "token",
        severity: item.status === "expired" ? "error" : "warn",
        title: `${item.provider} token ${item.status}`,
        message: item.status === "expired"
          ? `Reconnect ${item.provider} to restore automation.`
          : `Reconnect ${item.provider} soon to avoid automation interruptions.`,
        metadata: { provider: item.provider, expiresAt: item.expiresAt ?? undefined }
      });
    }
  }

  return items;
}
