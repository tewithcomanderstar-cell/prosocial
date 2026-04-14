import { ActionLog } from "@/models/ActionLog";
import { Job } from "@/models/Job";
import { Notification } from "@/models/Notification";

type LeanActionLog = {
  _id: string;
  type: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  relatedJobId?: string;
  relatedPostId?: string;
  createdAt: Date | string;
};

type LeanNotification = {
  _id: string;
  type: string;
  severity: "info" | "warn" | "error";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: Date | string;
};

type LeanJob = {
  _id: string;
  targetPageId?: string;
  postId?: string;
  status: string;
  lastError?: string;
  createdAt: Date | string;
};

export type IncidentSeverity = "info" | "warn" | "error";

export type IncidentItem = {
  id: string;
  severity: IncidentSeverity;
  title: string;
  rootCause: string;
  source: string;
  fingerprint: string;
  affectedPosts: string[];
  affectedPages: string[];
  occurrences: number;
  latestAt: string;
  suggestedFix: string;
  action: {
    label: string;
    href?: string;
  };
  samples: string[];
};

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function pushUnique(list: string[], value?: string | null) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function classifyIncident(message: string, metadata: Record<string, unknown> = {}) {
  const normalized = normalizeText(message);
  const reason = typeof metadata.reason === "string" ? metadata.reason : "";
  const full = `${normalized} ${normalizeText(reason)}`.trim();

  if (full.includes("token expired") || full.includes("reconnect your account")) {
    const provider = full.includes("google") ? "Google Drive" : "Facebook";
    return {
      title: `${provider} token expired`,
      rootCause: `${provider} access token is no longer valid for automation tasks.`,
      fingerprint: `${provider.toLowerCase()}-token-expired`,
      source: provider.toLowerCase(),
      suggestedFix: `Reconnect ${provider} to refresh the token and restore automation.`,
      action: {
        label: provider === "Facebook" ? "Reconnect Facebook" : "Reconnect Google Drive",
        href: provider === "Facebook" ? "/connections/facebook" : "/connections/google-drive"
      }
    };
  }

  if (full.includes("daily auto post limit reached") || full.includes("per-page daily auto post limit reached")) {
    return {
      title: "Daily posting limit reached",
      rootCause: "The automation hit its configured daily publish ceiling and stopped scheduling new posts.",
      fingerprint: "daily-post-limit",
      source: "auto-post",
      suggestedFix: "Increase or remove the daily posting limit, or wait for the next day before retrying.",
      action: {
        label: "Review auto post settings",
        href: "/auto-post"
      }
    };
  }

  if (full.includes("failed to upload facebook photo binary") || full.includes("media invalid")) {
    return {
      title: "Media file could not be published",
      rootCause: "One or more selected media files are not valid for Facebook upload in the current publish run.",
      fingerprint: "facebook-media-invalid",
      source: "publish",
      suggestedFix: "Replace the media file, re-upload it, or choose a different Google Drive image before retrying.",
      action: {
        label: "Review media source",
        href: "/auto-post"
      }
    };
  }

  if (full.includes("could not connect to any servers in your mongodb atlas cluster")) {
    return {
      title: "Database network access is blocked",
      rootCause: "MongoDB Atlas is rejecting the server connection because the deployment IP is not allowlisted.",
      fingerprint: "mongodb-network-access",
      source: "database",
      suggestedFix: "Allow the deployment IP range in MongoDB Atlas Network Access, then redeploy and retry.",
      action: {
        label: "Check setup wizard",
        href: "/setup"
      }
    };
  }

  if (full.includes("bad auth") || full.includes("authentication failed")) {
    return {
      title: "Database authentication failed",
      rootCause: "The application cannot authenticate with the configured database credentials.",
      fingerprint: "database-auth-failed",
      source: "database",
      suggestedFix: "Verify MONGODB_URI, rotate the password if needed, and redeploy with the updated value.",
      action: {
        label: "Review setup",
        href: "/setup"
      }
    };
  }

  if (full.includes("facebook is not connected")) {
    return {
      title: "Facebook account is not connected",
      rootCause: "Publishing or page-loading requires an active Facebook workspace connection.",
      fingerprint: "facebook-not-connected",
      source: "facebook",
      suggestedFix: "Connect Facebook again and validate the page permissions before retrying.",
      action: {
        label: "Connect Facebook",
        href: "/connections/facebook"
      }
    };
  }

  if (full.includes("google drive is not connected")) {
    return {
      title: "Google Drive is not connected",
      rootCause: "The automation cannot load media because the Drive integration is not active.",
      fingerprint: "drive-not-connected",
      source: "google-drive",
      suggestedFix: "Reconnect Google Drive and reselect the source folder.",
      action: {
        label: "Connect Google Drive",
        href: "/connections/google-drive"
      }
    };
  }

  if (full.includes("duplicate")) {
    return {
      title: "Duplicate content was blocked",
      rootCause: "The queue detected a repeated post fingerprint and stopped the duplicate run.",
      fingerprint: "duplicate-content",
      source: "queue",
      suggestedFix: "Edit the caption, image, or schedule so the next run is treated as new content.",
      action: {
        label: "Open queue",
        href: "/queue"
      }
    };
  }

  if (full.includes("rate limit")) {
    return {
      title: "Platform rate limit reached",
      rootCause: "The platform throttled publishing requests for the current page or token.",
      fingerprint: "platform-rate-limit",
      source: "publish",
      suggestedFix: "Retry later or reduce concurrency for the affected page.",
      action: {
        label: "Review queue",
        href: "/queue"
      }
    };
  }

  return {
    title: "Automation issue detected",
    rootCause: "The system recorded an operational error that still needs a human decision.",
    fingerprint: normalizeText(message).slice(0, 120) || "generic-incident",
    source: "system",
    suggestedFix: "Open the logs, review the affected content, and retry the workflow once the underlying issue is fixed.",
    action: {
      label: "Open logs",
      href: "/logs"
    }
  };
}

function buildIncidentFromLog(log: LeanActionLog): IncidentItem | null {
  if (log.level !== "error" && log.level !== "warn") {
    return null;
  }

  const metadata = log.metadata ?? {};
  const classified = classifyIncident(log.message, metadata);
  const incident: IncidentItem = {
    id: `log-${String(log._id)}`,
    severity: log.level === "error" ? "error" : "warn",
    title: classified.title,
    rootCause: classified.rootCause,
    source: classified.source,
    fingerprint: classified.fingerprint,
    affectedPosts: [],
    affectedPages: [],
    occurrences: 1,
    latestAt: new Date(log.createdAt).toISOString(),
    suggestedFix: classified.suggestedFix,
    action: classified.action,
    samples: [log.message]
  };

  pushUnique(incident.affectedPosts, log.relatedPostId ? String(log.relatedPostId) : undefined);
  if (typeof metadata.pageId === "string") pushUnique(incident.affectedPages, metadata.pageId);
  if (typeof metadata.targetPageId === "string") pushUnique(incident.affectedPages, metadata.targetPageId);

  return incident;
}

function buildIncidentFromNotification(notification: LeanNotification): IncidentItem | null {
  if (notification.severity === "info") {
    return null;
  }

  const classified = classifyIncident(`${notification.title} ${notification.message}`, notification.metadata ?? {});

  return {
    id: `notification-${String(notification._id)}`,
    severity: notification.severity,
    title: classified.title,
    rootCause: classified.rootCause,
    source: classified.source,
    fingerprint: classified.fingerprint,
    affectedPosts: [],
    affectedPages: [],
    occurrences: 1,
    latestAt: new Date(notification.createdAt).toISOString(),
    suggestedFix: classified.suggestedFix,
    action: classified.action,
    samples: [notification.message]
  };
}

function buildIncidentFromJob(job: LeanJob): IncidentItem | null {
  if (!["failed", "rate_limited", "duplicate_blocked"].includes(job.status)) {
    return null;
  }

  const classified = classifyIncident(job.lastError || job.status);

  const incident: IncidentItem = {
    id: `job-${String(job._id)}`,
    severity: job.status === "duplicate_blocked" ? "warn" : "error",
    title: classified.title,
    rootCause: classified.rootCause,
    source: "queue",
    fingerprint: `${classified.fingerprint}-${job.status}`,
    affectedPosts: [],
    affectedPages: [],
    occurrences: 1,
    latestAt: new Date(job.createdAt).toISOString(),
    suggestedFix: classified.suggestedFix,
    action: classified.action,
    samples: [job.lastError || job.status]
  };

  pushUnique(incident.affectedPosts, job.postId ? String(job.postId) : undefined);
  pushUnique(incident.affectedPages, job.targetPageId);

  return incident;
}

function groupIncidents(incidents: IncidentItem[]) {
  const groups = new Map<string, IncidentItem>();

  for (const incident of incidents) {
    const key = incident.fingerprint;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, incident);
      continue;
    }

    existing.occurrences += incident.occurrences;
    existing.latestAt = existing.latestAt > incident.latestAt ? existing.latestAt : incident.latestAt;
    incident.affectedPosts.forEach((value) => pushUnique(existing.affectedPosts, value));
    incident.affectedPages.forEach((value) => pushUnique(existing.affectedPages, value));
    incident.samples.forEach((value) => pushUnique(existing.samples, value));
    if (existing.severity !== "error" && incident.severity === "error") {
      existing.severity = "error";
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const severityScore = { error: 3, warn: 2, info: 1 };
    const bySeverity = severityScore[b.severity] - severityScore[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
  });
}

export async function listIncidents(userId: string, options?: { severity?: string; source?: string; limit?: number }) {
  const limit = options?.limit ?? 100;
  const [logs, notifications, jobs] = await Promise.all([
    ActionLog.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean<LeanActionLog[]>(),
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(limit, 50)).lean<LeanNotification[]>(),
    Job.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(limit, 50)).lean<LeanJob[]>()
  ]);

  const raw = [
    ...logs.map(buildIncidentFromLog),
    ...notifications.map(buildIncidentFromNotification),
    ...jobs.map(buildIncidentFromJob)
  ].filter(Boolean) as IncidentItem[];

  let grouped = groupIncidents(raw);

  if (options?.severity) {
    grouped = grouped.filter((item) => item.severity === options.severity);
  }

  if (options?.source) {
    grouped = grouped.filter((item) => item.source === options.source);
  }

  return grouped;
}

export async function getIncidentSummary(userId: string) {
  const incidents = await listIncidents(userId, { limit: 120 });
  return {
    total: incidents.length,
    critical: incidents.filter((item) => item.severity === "error").length,
    warnings: incidents.filter((item) => item.severity === "warn").length,
    sources: Array.from(new Set(incidents.map((item) => item.source))).sort(),
    top: incidents.slice(0, 5)
  };
}
