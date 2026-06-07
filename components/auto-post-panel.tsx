"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SHOPEE_CATEGORY,
  SHOPEE_CATEGORY_OPTIONS,
  isValidShopeeCategories,
  normalizeShopeeCategories
} from "@/lib/shopee-categories";

type AutoPostStatus = "idle" | "running" | "posting" | "success" | "partial_success" | "failed" | "retrying" | "paused" | "waiting";
type CaptionStrategy = "manual" | "ai" | "hybrid";

type AutoPostConfig = {
  enabled: boolean;
  contentSource: "shopee-affiliate" | "google-drive";
  folderId: string;
  folderName: string;
  shopeeSourceTag: "trending" | "best_selling" | "top_search" | "best_roi" | "manual";
  shopeeKeyword: string;
  shopeeCategory: string;
  shopeeCategories: string[];
  shopeeCaptionStyle: "soft_sell" | "urgency" | "problem_solution" | "review_style" | "deal_alert" | "lifestyle";
  shopeeTrackingId: string;
  shopeeBlockedCategories: string[];
  shopeeCategoryPriority: string[];
  shopeeMinPrice: number;
  shopeeMaxPrice: number;
  shopeeMinRating: number;
  shopeeMinSales: number;
  shopeeMinDiscountPercent: number;
  approvalMode: boolean;
  targetPageIds: string[];
  intervalMinutes: number;
  captionStrategy: CaptionStrategy;
  captions: string[];
  hashtags: string[];
  aiPrompt: string;
  postingWindowStart: string;
  postingWindowEnd: string;
  language: "th" | "en";
  autoPostStatus?: AutoPostStatus;
  jobStatus?: "pending" | "processing" | "posted" | "failed";
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
  retryCount?: number;
};

type Folder = { id: string; name: string };
type FacebookPage = {
  pageId: string;
  name: string;
};
type PanelState = "loading" | "setup_required" | "facebook_required" | "ready" | "unauthorized" | "mock_mode" | "error";

type ControlPanelStatus = {
  state?: Exclude<PanelState, "loading" | "error" | "unauthorized" | "mock_mode">;
  shopeeApiStatus?: string;
  affiliateConfigStatus?: string;
  facebookPageStatus?: string;
  autoPostEngineStatus?: string;
  lastProductFetchAt?: string | null;
  lastPublishAt?: string | null;
  provider?: string;
  connectedPageCount?: number;
  facebookPages?: FacebookPage[];
  currentJobId?: string | null;
  currentStep?: string | null;
  currentAttempt?: number | null;
  maxProductAttempts?: number | null;
  skippedProductsCount?: number;
  currentProduct?: string | null;
  lastSkippedReason?: string | null;
  selectedPagesCount?: number;
  createdTasksCount?: number;
  queueHealth?: "ok" | "missing_tasks" | string;
  missingTasksCount?: number;
  missingTasksWarning?: string | null;
  repairedTasksCount?: number;
  publishedPagesCount?: number;
  failedPagesCount?: number;
  pendingPagesCount?: number;
  currentPublishingPage?: { pageId?: string; pageName?: string } | null;
  pageResults?: Array<{
    jobId: string | null;
    pageId: string;
    pageName: string;
    status: "pending" | "waiting" | "queued" | "publishing" | "success" | "failed" | "skipped" | "retrying";
    rawStatus?: string;
    facebookPostId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    shortAffiliateLink?: string | null;
    startedAt?: string | null;
    scheduledAt?: string | null;
    finishedAt?: string | null;
  }>;
  latestLogs?: StatusLog[];
  lastActivityAt?: string | null;
  lastWorkerHeartbeat?: string | null;
  lastSuccessAt?: string | null;
  missingEnv?: string[];
  lastError?: {
    source?: "internal_api" | "shopee_api" | "facebook_api" | "config" | "storage" | "unknown";
    status?: number | null;
    message?: string;
  } | null;
  storage?: {
    usedBytes: number;
    limitBytes: number;
    percent: number;
    status: "ok" | "warning" | "critical";
    lastCleanup?: {
      at?: string | null;
      deletedCount?: number;
      estimatedFreedBytes?: number;
      mode?: string;
    } | null;
    collections?: Array<{
      name: string;
      documents: number;
      sizeBytes: number;
      storageBytes: number;
      indexBytes: number;
    }>;
  };
};

type StatusLog = {
  _id: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

type StatusResponse = {
  config: AutoPostConfig;
  logs: StatusLog[];
  controlPanel?: ControlPanelStatus;
};

type ShopeeQueuePreviewItem = {
  _id: string;
  productId: string;
  pageId: string;
  affiliateLink: string;
  scheduledAt?: string;
  status: string;
  product?: {
    productName?: string;
    productPrice?: number;
    discountPrice?: number;
    discountPercent?: number;
    productImageUrl?: string;
    category?: string;
    rating?: number;
    salesCount?: number;
  } | null;
  preview?: {
    caption?: string;
    affiliateLink?: string;
    imageUrls?: string[];
    status?: string | null;
  } | null;
};

const MAX_TARGET_PAGES = 100;
const DEFAULT_POSTING_WINDOW_START = "00:00";
const DEFAULT_POSTING_WINDOW_END = "23:59";
const INTERVAL_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" }
] as const;

const defaults: AutoPostConfig = {
  enabled: false,
  contentSource: "shopee-affiliate",
  folderId: "root",
  folderName: "My Drive",
  shopeeSourceTag: "trending",
  shopeeKeyword: "",
  shopeeCategory: DEFAULT_SHOPEE_CATEGORY,
  shopeeCategories: [],
  shopeeCaptionStyle: "soft_sell",
  shopeeTrackingId: "",
  shopeeBlockedCategories: [],
  shopeeCategoryPriority: [],
  shopeeMinPrice: 0,
  shopeeMaxPrice: 0,
  shopeeMinRating: 0,
  shopeeMinSales: 0,
  shopeeMinDiscountPercent: 0,
  approvalMode: false,
  targetPageIds: [],
  intervalMinutes: 60,
  captionStrategy: "hybrid",
  captions: [],
  hashtags: [],
  aiPrompt: "",
  postingWindowStart: DEFAULT_POSTING_WINDOW_START,
  postingWindowEnd: DEFAULT_POSTING_WINDOW_END,
  language: "th",
  autoPostStatus: "paused",
  jobStatus: "pending",
  retryCount: 0
};

function getConfigShopeeCategories(config?: Partial<AutoPostConfig> | null) {
  return normalizeShopeeCategories(
    Array.isArray(config?.shopeeCategories) && config.shopeeCategories.length
      ? config.shopeeCategories
      : config?.shopeeCategory
  );
}

function withNormalizedShopeeCategories(config: Partial<AutoPostConfig>): AutoPostConfig {
  const shopeeCategories = getConfigShopeeCategories(config);
  return {
    ...defaults,
    ...config,
    shopeeCategories,
    shopeeCategory: shopeeCategories[0] ?? DEFAULT_SHOPEE_CATEGORY
  };
}

function getShopeeCategorySummary(categories: string[]) {
  if (!categories.length) return "All Categories";
  const labels = categories.map((category) => SHOPEE_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ?? category);
  if (labels.length === 1) return labels[0];
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function formatDateTime(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatScheduledLabel(value?: string | null) {
  if (!value) return "";
  const scheduledAt = new Date(value);
  if (Number.isNaN(scheduledAt.getTime())) return "";

  const diffMs = scheduledAt.getTime() - Date.now();
  const timeLabel = scheduledAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffMs <= 0) {
    return `Scheduled for ${timeLabel}`;
  }

  const minutes = Math.max(1, Math.ceil(diffMs / 60_000));
  return `Scheduled for ${timeLabel} (${minutes} min)`;
}

function sanitizeText(value?: string | null) {
  if (!value) return "";
  const raw = value.trim();
  if (!raw) return "";

  const withoutTags = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = withoutTags || raw;
  return normalized.length > 240 ? normalized.slice(0, 237) + "..." : normalized;
}

function formatSkipReason(value?: string | null) {
  const reason = sanitizeText(value);
  if (!reason) return "";

  const normalized = reason.toLowerCase();
  const reasonMap: Array<[string, string]> = [
    ["storyboard_caption_no_forbidden_source_language", "แคปชั่นมีคำต้องห้าม/ภาษาวิเคราะห์ เช่น จากรูปสินค้า หรือจากข้อมูลสินค้า"],
    ["storyboard_caption_has_cta", "แคปชั่นขาด CTA"],
    ["storyboard_caption_has_shopee_short_link", "แคปชั่นขาด Shopee short link"],
    ["storyboard_caption_min_20_chars", "แคปชั่นสั้นเกินไป"],
    ["storyboard_caption_facebook_length_limit", "แคปชั่นยาวเกิน Facebook limit"],
    ["storyboard_caption_has_price_when_price_exists", "แคปชั่นขาดบรรทัดราคา"],
    ["storyboard_caption_validation_failed", "แคปชั่นจาก Storyboard ไม่ผ่าน validation"],
    ["legacy_caption_validation_failed", "แคปชั่นถูกดักโดย validation เก่าหรือรูปแบบเดิมที่ยังหลุดมา"],
    ["caption_generation_failed", "สร้างแคปชั่นไม่สำเร็จ หรือบริบทสินค้าไม่พอสำหรับคอนเทนต์"],
    ["content_generation_failed", "สร้างคอนเทนต์ไม่สำเร็จ"],
    ["missing_shortlink", "Shopee short link ไม่ถูกต้องหรือยังสร้างไม่ได้"],
    ["short_link_invalid", "Shopee short link ไม่ผ่าน validation"],
    ["image_generation_failed", "สร้างภาพ UGC ไม่สำเร็จหรือภาพไม่ผ่าน validation"],
    ["policy_safety_reject", "ติด safety / content policy ของระบบสร้างภาพหรือคอนเทนต์"],
    ["duplicate_product", "สินค้าซ้ำหรือเคยโพสต์แล้วในช่วงที่ล็อกไว้"],
    ["category_conflict", "สินค้าไม่ตรงหมวดหรือถูกบล็อกตามเงื่อนไข"],
    ["product_type_unknown", "ระบบเข้าใจสินค้าไม่ชัดพอ"],
    ["description_too_short", "ข้อมูลสินค้า/รายละเอียดสั้นเกินไป"],
    ["missing_images", "ไม่มีรูปสินค้าพอหรือรูปสินค้าใช้งานไม่ได้"],
    ["image_analysis_failed", "วิเคราะห์รูปสินค้าไม่สำเร็จ"],
    ["title_conflict", "ชื่อสินค้าและข้อมูลสินค้าไม่สอดคล้องกัน"],
    ["no_eligible_candidate", "ไม่พบสินค้าที่ผ่านเงื่อนไขการค้นหา"]
  ];

  const matched = reasonMap.find(([key]) => normalized.includes(key));
  if (matched) return matched[1];

  if (normalized.includes("caption")) return "แคปชั่นไม่ผ่านหรือสร้างแคปชั่นไม่สำเร็จ";
  if (normalized.includes("short link")) return "Shopee short link ไม่ผ่าน validation";
  if (normalized.includes("image")) return "ภาพสินค้า/ภาพ UGC ไม่ผ่านหรือสร้างไม่สำเร็จ";
  if (normalized.includes("safety") || normalized.includes("policy")) return "ติด safety / policy";
  if (normalized.includes("duplicate")) return "สินค้าซ้ำหรือเคยโพสต์แล้ว";

  return reason;
}

function sanitizeAutomationError(value?: string | null) {
  if (!value) return "";

  const normalized = value.toLowerCase();
  if (
    normalized.includes("n8n") ||
    normalized.includes("requested webhook") ||
    normalized.includes("workflow must be active") ||
    normalized.includes("webhook")
  ) {
    return "Legacy automation state detected. Please refresh and trigger Start Now again.";
  }

  return sanitizeText(value);
}

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return "0 MB";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function readApiResult(response: Response) {
  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText) as { ok?: boolean; message?: string; data?: any; code?: string; warning?: string };
    } catch {
      return {
        ok: false,
        message: sanitizeAutomationError(rawText || "The server returned invalid JSON.")
      };
    }
  }

  return {
    ok: false,
    message: sanitizeAutomationError(rawText || "The server returned an unexpected response.")
  };
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms while calling ${url}`)),
    timeoutMs
  );
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error(`Request was aborted while calling ${url}`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizePagesResponse(payload: any): FacebookPage[] {
  const candidates = [
    payload?.data?.pages,
    payload?.pages,
    payload?.data?.destinations,
    payload?.destinations,
    Array.isArray(payload) ? payload : null
  ];
  const rawPages = candidates.find((value) => Array.isArray(value)) ?? [];
  return rawPages
    .map((page: any) => ({
      pageId: String(page.pageId ?? page.id ?? page.externalPageId ?? ""),
      name: String(page.name ?? page.pageName ?? page.label ?? "Facebook Page")
    }))
    .filter((page: FacebookPage) => page.pageId.length > 0);
}

function statusLabel(status?: AutoPostStatus) {
  switch (status) {
    case "running":
      return "Running";
    case "posting":
      return "Posting";
    case "success":
      return "Success";
    case "partial_success":
      return "Partial success";
    case "failed":
      return "Failed";
    case "retrying":
      return "Retrying";
    case "waiting":
      return "Scheduled";
    case "idle":
      return "Idle";
    case "paused":
    default:
      return "Paused";
  }
}

function jobStatusLabel(status?: AutoPostConfig["jobStatus"]) {
  switch (status) {
    case "processing":
      return "Processing";
    case "posted":
      return "Posted";
    case "failed":
      return "Failed";
    case "pending":
    default:
      return "Pending";
  }
}

function statusTone(status?: AutoPostStatus) {
  switch (status) {
    case "running":
    case "posting":
      return "badge-info";
    case "success":
      return "badge-success";
    case "partial_success":
      return "badge-warn";
    case "failed":
      return "badge-warn";
    case "retrying":
    case "waiting":
      return "badge-neutral";
    case "idle":
    case "paused":
    default:
      return "badge-neutral";
  }
}

function logStatusSuffix(log: StatusLog) {
  const rawStatus = String(log.metadata?.autoPostStatus ?? "");
  if (!rawStatus || ["waiting", "idle", "paused"].includes(rawStatus)) {
    return "";
  }
  return ` • ${rawStatus}`;
}

export function AutoPostPanel() {
  const [config, setConfig] = useState<AutoPostConfig>(defaults);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [logs, setLogs] = useState<StatusLog[]>([]);
  const [queuePreview, setQueuePreview] = useState<ShopeeQueuePreviewItem[]>([]);
  const [controlPanel, setControlPanel] = useState<ControlPanelStatus | null>(null);
  const [panelState, setPanelState] = useState<PanelState>("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [clearingStuck, setClearingStuck] = useState(false);
  const [retryingPendingPages, setRetryingPendingPages] = useState(false);
  const [cleaningStorage, setCleaningStorage] = useState(false);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const loadStatusInFlightRef = useRef(false);
  const pagesRef = useRef<FacebookPage[]>([]);
  const categoryDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!categoryDropdownRef.current?.contains(event.target as Node)) {
        setCategoryDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const loadStatus = useCallback(async (showLoader = false) => {
    if (loadStatusInFlightRef.current) {
      console.info("[auto-post/control-panel] fetch skipped because previous request is still running");
      return;
    }

    loadStatusInFlightRef.current = true;
    if (showLoader) {
      setLoading(true);
      setPanelState("loading");
    }
    console.info("[auto-post/control-panel] fetch started", { showLoader });

    try {
      const [statusResult, queueResult] = await Promise.allSettled([
        fetchWithTimeout("/api/auto-post/status", { cache: "no-store" }, 20000),
        fetchWithTimeout("/api/shopee/queue", { cache: "no-store" })
      ]);

      const statusJson =
        statusResult.status === "fulfilled"
          ? await readApiResult(statusResult.value)
          : { ok: false, message: statusResult.reason instanceof Error ? statusResult.reason.message : "Unable to load Auto Post status" };
      const queueJson =
        queueResult.status === "fulfilled"
          ? await readApiResult(queueResult.value)
          : { ok: false, message: queueResult.reason instanceof Error ? queueResult.reason.message : "Unable to load Shopee queue" };

      let statusData: StatusResponse | null = null;
      if (statusJson.ok) {
        const loadedStatusData = statusJson.data as StatusResponse;
        statusData = loadedStatusData;
        setConfig((current) => withNormalizedShopeeCategories({
          ...current,
          ...defaults,
          ...loadedStatusData.config
        }));
        const liveLogs = loadedStatusData.controlPanel?.latestLogs ?? loadedStatusData.logs ?? [];
        setLogs(liveLogs.slice(0, 20).map((log) => ({ ...log, message: sanitizeText(log.message) })));
        setControlPanel(loadedStatusData.controlPanel ?? null);
      } else if (statusJson.message) {
        setError(statusJson.message);
      }

      const statusPages = normalizePagesResponse(statusData?.controlPanel?.facebookPages ?? []);
      const existingPages = pagesRef.current;
      let parsedPages: FacebookPage[] = [];
      let pagesJson: any = { ok: false, message: "", skipped: true };
      const shouldRefreshPages = statusPages.length === 0 && (showLoader || existingPages.length === 0);

      if (shouldRefreshPages) {
        try {
          const pagesResponse = await fetchWithTimeout("/api/facebook/pages", { cache: "no-store" }, 6000);
          pagesJson = await readApiResult(pagesResponse);
          parsedPages = pagesJson.ok ? normalizePagesResponse(pagesJson) : [];
        } catch (pagesError) {
          pagesJson = {
            ok: false,
            message: pagesError instanceof Error ? pagesError.message : "Unable to load Facebook pages right now."
          };
        }
      }

      const fallbackPages = statusPages.length > 0 ? statusPages : existingPages;
      const effectivePageCount =
        parsedPages.length ||
        fallbackPages.length ||
        Number(statusData?.controlPanel?.connectedPageCount ?? 0) ||
        Number(statusData?.controlPanel?.selectedPagesCount ?? 0) ||
        (Array.isArray(statusData?.config?.targetPageIds) ? statusData.config.targetPageIds.length : 0);

      if (parsedPages.length > 0) {
        setPages(parsedPages);
        pagesRef.current = parsedPages;
        if (pagesJson.data?.warning || pagesJson.warning) {
          setMessage(String(pagesJson.data?.warning ?? pagesJson.warning));
        }
      } else if (fallbackPages.length > 0) {
        setPages(fallbackPages);
        pagesRef.current = fallbackPages;
        if (!pagesJson.ok && pagesJson.message && shouldRefreshPages) {
          setMessage(`Using cached Facebook pages. Live refresh issue: ${pagesJson.message}`);
        }
      } else if (pagesJson.message && effectivePageCount === 0 && shouldRefreshPages) {
        setError(pagesJson.message);
      }

      const parsedQueue = queueJson.ok ? (((queueJson.data as any)?.queue ?? []) as ShopeeQueuePreviewItem[]).slice(0, 6) : [];
      if (queueJson.ok) {
        setQueuePreview(parsedQueue);
      }

      const statusState = statusData?.controlPanel?.state;
      const shopeeApiStatus = statusData?.controlPanel?.shopeeApiStatus;
      const nextState: PanelState = !statusJson.ok
        ? "error"
        : shopeeApiStatus === "unauthorized"
          ? "unauthorized"
          : shopeeApiStatus === "mock"
            ? "mock_mode"
          : statusState === "setup_required"
          ? "setup_required"
          : effectivePageCount === 0
            ? "facebook_required"
            : "ready";
      setPanelState(nextState);
      console.info("[auto-post/control-panel] fetch completed", {
        statusOk: Boolean(statusJson.ok),
        pagesOk: Boolean(pagesJson.ok),
        parsedPagesCount: parsedPages.length,
        statusPagesCount: statusPages.length,
        effectivePageCount,
        queuePreviewCount: parsedQueue.length,
        responseKeys: pagesJson ? Object.keys(pagesJson) : [],
        shopeeApiStatus,
        state: nextState
      });
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : "Unable to load Auto Post status";
      console.error("[auto-post/control-panel] fetch failed", { message });
      setError(message);
      setPanelState("error");
    } finally {
      setLoading(false);
      loadStatusInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadStatus(true);
  }, [loadStatus]);

  useEffect(() => {
    const interval = window.setInterval(() => loadStatus(false), 4000);
    return () => window.clearInterval(interval);
  }, [loadStatus]);

  const selectedPageNames = useMemo(
    () => pages.filter((page) => config.targetPageIds.includes(page.pageId)).map((page) => page.name),
    [config.targetPageIds, pages]
  );

  function togglePage(pageId: string) {
    setConfig((current) => {
      if (current.targetPageIds.includes(pageId)) {
        return {
          ...current,
          targetPageIds: current.targetPageIds.filter((id) => id !== pageId)
        };
      }

      if (current.targetPageIds.length >= MAX_TARGET_PAGES) {
        setError(`You can select up to ${MAX_TARGET_PAGES} pages.`);
        return current;
      }

      return {
        ...current,
        targetPageIds: [...current.targetPageIds, pageId]
      };
    });
  }

  function updateShopeeCategories(nextCategories: string[]) {
    const shopeeCategories = normalizeShopeeCategories(nextCategories);
    setConfig((current) => ({
      ...current,
      shopeeCategories,
      shopeeCategory: shopeeCategories[0] ?? DEFAULT_SHOPEE_CATEGORY
    }));
  }

  function toggleShopeeCategory(category: string) {
    if (category === DEFAULT_SHOPEE_CATEGORY) {
      updateShopeeCategories([]);
      return;
    }

    const currentCategories = getConfigShopeeCategories(config);
    updateShopeeCategories(
      currentCategories.includes(category)
        ? currentCategories.filter((item) => item !== category)
        : [...currentCategories, category]
    );
  }

  function updateCaptions(value: string) {
    setConfig((current) => ({
      ...current,
      captions: value.split("\n").map((item) => item.trim()).filter(Boolean)
    }));
  }

  function updateHashtags(value: string) {
    setConfig((current) => ({
      ...current,
      hashtags: value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean)
    }));
  }

  async function saveConfig(enabledOverride?: boolean) {
    const shopeeCategories = getConfigShopeeCategories(config);
    const payload = {
      ...config,
      shopeeCategories,
      shopeeCategory: shopeeCategories[0] ?? DEFAULT_SHOPEE_CATEGORY,
      enabled: enabledOverride ?? config.enabled
    };
    const response = await fetch("/api/auto-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await readApiResult(response);
    if (!result.ok) throw new Error(result.message || "Unable to save Auto Post settings");
    setConfig(withNormalizedShopeeCategories(result.data.config));
    return result;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    try {
      if (!isValidShopeeCategories(config.shopeeCategories)) {
        throw new Error("Please select at least one valid category");
      }
      const result = await saveConfig();
      setMessage(result.message || "Settings saved");
      await loadStatus(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save Auto Post settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleStartNow() {
    setStarting(true);
    setMessage("");
    setError("");

    try {
      await saveConfig(true);
      const response = await fetch("/api/auto-post/start", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to start Auto Post");
      setMessage("Automation started");
      await loadStatus(false);
    } catch (startError) {
      setError(sanitizeAutomationError(startError instanceof Error ? startError.message : "Unable to start Auto Post"));
    } finally {
      setStarting(false);
    }
  }

  async function handlePause() {
    setPausing(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post/pause", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to pause Auto Post");
      setMessage("Auto Post paused");
      await loadStatus(false);
    } catch (pauseError) {
      setError(sanitizeAutomationError(pauseError instanceof Error ? pauseError.message : "Unable to pause Auto Post"));
    } finally {
      setPausing(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post/stop", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to stop Auto Post");
      setMessage("Auto Post stopped");
      await loadStatus(false);
    } catch (stopError) {
      setError(sanitizeAutomationError(stopError instanceof Error ? stopError.message : "Unable to stop Auto Post"));
    } finally {
      setStopping(false);
    }
  }

  const visibleState: PanelState = loading ? "loading" : panelState;
  const hasFacebookPages = pages.length > 0;
  const setupRequired = visibleState === "setup_required" || controlPanel?.affiliateConfigStatus === "setup_required";
  const displayStatus = ((controlPanel?.autoPostEngineStatus as AutoPostStatus | undefined) ?? config.autoPostStatus ?? "paused");
  const startDisabled = starting || saving || setupRequired || ["running", "posting", "retrying"].includes(displayStatus);
  const facebookRequired = visibleState === "facebook_required" || !hasFacebookPages;
  const blockingError = visibleState === "error" ? error || "Unable to load Auto Post control panel" : "";
  const missingConfig = controlPanel?.missingEnv?.length ? ` Missing: ${controlPanel.missingEnv.join(", ")}` : "";
  const lastShopeeError = controlPanel?.lastError?.message ? sanitizeText(controlPanel.lastError.message) : "";

  function renderStateBanner() {
    if (visibleState === "loading") {
      return <div className="composer-message">Loading control panel...</div>;
    }
    if (blockingError) {
      return (
        <div className="composer-message composer-message-error">
          <strong>{blockingError}</strong>
          <button className="button button-secondary" type="button" onClick={() => loadStatus(true)}>Retry</button>
        </div>
      );
    }
    if (visibleState === "unauthorized") {
      return (
        <div className="composer-message composer-message-error">
          <strong>{lastShopeeError || "Shopee rejected the request. Check partner ID, partner key, signature, timestamp, and region."}</strong>
          <button className="button button-secondary" type="button" onClick={() => loadStatus(true)}>Retry</button>
        </div>
      );
    }
    if (visibleState === "mock_mode") {
      return <div className="composer-message">Shopee mock mode is active. The system will use mock products for pipeline testing.</div>;
    }
    if (setupRequired) {
      return <div className="composer-message">Shopee Affiliate setup required.{missingConfig}</div>;
    }
    if (facebookRequired) {
      return <div className="composer-message">Connect Facebook Page first</div>;
    }
    return <div className="composer-message">Shopee Affiliate Auto Post is ready.</div>;
  }

  async function handleClearStuck() {
    setClearingStuck(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post/clear-stuck", { method: "POST" });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to clear stuck Auto Post status");
      setMessage("Cleared stuck posting status");
      await loadStatus(false);
    } catch (clearError) {
      setError(
        sanitizeAutomationError(clearError instanceof Error ? clearError.message : "Unable to clear stuck Auto Post status")
      );
    } finally {
      setClearingStuck(false);
    }
  }

  async function handleRetryPendingPages() {
    setRetryingPendingPages(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post/retry-pending-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: (config as any)._id })
      });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to retry pending page tasks");
      setMessage(result.message || "Retried pending page tasks");
      await loadStatus(false);
    } catch (retryError) {
      setError(
        sanitizeAutomationError(retryError instanceof Error ? retryError.message : "Unable to retry pending page tasks")
      );
    } finally {
      setRetryingPendingPages(false);
    }
  }

  async function handleRunCleanup() {
    setCleaningStorage(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/auto-post/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aggressive: controlPanel?.storage?.status === "critical",
          reason: controlPanel?.storage?.status === "critical" ? "critical_monitor_button" : "monitor_button"
        })
      });
      const result = await readApiResult(response);
      if (!result.ok) throw new Error(result.message || "Unable to run storage cleanup");
      const cleanup = result.data?.cleanup;
      setMessage(
        `Storage cleanup completed. Deleted ${cleanup?.deletedTotal ?? 0} records, freed about ${formatBytes(cleanup?.estimatedFreedBytes ?? 0)}.`
      );
      await loadStatus(false);
    } catch (cleanupError) {
      setError(sanitizeAutomationError(cleanupError instanceof Error ? cleanupError.message : "Unable to run storage cleanup"));
    } finally {
      setCleaningStorage(false);
    }
  }

  return (
    <div className="auto-post-minimal-layout">
      <form className="card auto-post-card auto-post-config-card" onSubmit={handleSubmit}>
        <div className="split auto-post-head auto-post-head-minimal">
          <div className="stack compact-stack">
            <div className="kicker">Config</div>
            <h3>Auto Post Setup</h3>
          </div>
          <label className="auto-post-toggle">
            <span>{config.enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Shopee Product Source
            <select
              className="select"
              value={config.shopeeSourceTag}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  contentSource: "shopee-affiliate",
                  shopeeSourceTag: event.target.value as AutoPostConfig["shopeeSourceTag"]
                }))
              }
            >
              <option value="trending">Trending products</option>
              <option value="best_selling">Best-selling products</option>
              <option value="top_search">Top searched products</option>
              <option value="best_roi">Best ROI products</option>
              <option value="manual">Manual keyword search</option>
            </select>
          </label>

          <label className="label">
            Every
            <select
              className="select"
              value={config.intervalMinutes}
              onChange={(event) => setConfig((current) => ({ ...current, intervalMinutes: Number(event.target.value) || 60 }))}
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Keyword
            <input
              className="input"
              value={config.shopeeKeyword}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeKeyword: event.target.value }))}
              placeholder="เช่น ของใช้ในบ้าน, แก้วเก็บความเย็น"
            />
          </label>

          <div className="label" ref={categoryDropdownRef}>
            Category
            <button
              type="button"
              className="select"
              aria-haspopup="listbox"
              aria-expanded={categoryDropdownOpen}
              onClick={() => setCategoryDropdownOpen((open) => !open)}
              style={{ textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
            >
              <span>{getShopeeCategorySummary(getConfigShopeeCategories(config))}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {categoryDropdownOpen ? (
              <div
                role="listbox"
                aria-label="Shopee categories"
                style={{
                  marginTop: 8,
                  border: "1px solid rgba(37, 99, 235, 0.18)",
                  borderRadius: 16,
                  background: "rgba(255, 255, 255, 0.98)",
                  boxShadow: "0 18px 45px rgba(15, 23, 42, 0.12)",
                  padding: 10,
                  maxHeight: 280,
                  overflowY: "auto",
                  zIndex: 20,
                  position: "relative"
                }}
              >
                {SHOPEE_CATEGORY_OPTIONS.map((option) => {
                  const selectedCategories = getConfigShopeeCategories(config);
                  const checked = option.value === DEFAULT_SHOPEE_CATEGORY
                    ? selectedCategories.length === 0
                    : selectedCategories.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 10,
                        cursor: "pointer",
                        color: "#18243d"
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleShopeeCategory(option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
                <div className="inline-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => updateShopeeCategories(SHOPEE_CATEGORY_OPTIONS.filter((option) => option.value !== DEFAULT_SHOPEE_CATEGORY).map((option) => option.value))}
                  >
                    Select all
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => updateShopeeCategories([])}>
                    Clear all
                  </button>
                </div>
              </div>
            ) : null}
            <span className="muted">{getShopeeCategorySummary(getConfigShopeeCategories(config))}</span>
          </div>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Caption Style
            <select
              className="select"
              value={config.shopeeCaptionStyle}
              onChange={(event) =>
                setConfig((current) => ({ ...current, shopeeCaptionStyle: event.target.value as AutoPostConfig["shopeeCaptionStyle"] }))
              }
            >
              <option value="soft_sell">Soft sell</option>
              <option value="urgency">Urgency</option>
              <option value="problem_solution">Problem-solution</option>
              <option value="review_style">Review style</option>
              <option value="deal_alert">Deal alert</option>
              <option value="lifestyle">Lifestyle</option>
            </select>
          </label>

          <label className="label">
            Tracking ID
            <input
              className="input"
              value={config.shopeeTrackingId}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeTrackingId: event.target.value }))}
              placeholder="Optional affiliate tracking id"
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Min Rating
            <input
              className="input"
              type="number"
              min="0"
              max="5"
              step="0.1"
              value={config.shopeeMinRating}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeMinRating: Number(event.target.value) || 0 }))}
              placeholder="เช่น 4.5"
            />
          </label>

          <label className="label">
            Min Sales
            <input
              className="input"
              type="number"
              min="0"
              value={config.shopeeMinSales}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeMinSales: Number(event.target.value) || 0 }))}
              placeholder="เช่น 100"
            />
          </label>
        </div>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Price Range
            <input
              className="input"
              value={`${config.shopeeMinPrice || ""}${config.shopeeMaxPrice ? `-${config.shopeeMaxPrice}` : ""}`}
              onChange={(event) => {
                const [min, max] = event.target.value.split("-").map((item) => Number(item.trim()) || 0);
                setConfig((current) => ({ ...current, shopeeMinPrice: min, shopeeMaxPrice: max ?? 0 }));
              }}
              placeholder="เช่น 100-1500"
            />
          </label>

          <label className="label">
            Min Discount %
            <input
              className="input"
              type="number"
              min="0"
              max="100"
              value={config.shopeeMinDiscountPercent}
              onChange={(event) => setConfig((current) => ({ ...current, shopeeMinDiscountPercent: Number(event.target.value) || 0 }))}
              placeholder="เช่น 20"
            />
          </label>
        </div>

        <label className="auto-post-toggle auto-post-approval-toggle">
          <span>Manual approval before publish</span>
          <input
            type="checkbox"
            checked={config.approvalMode}
            onChange={(event) => setConfig((current) => ({ ...current, approvalMode: event.target.checked }))}
          />
        </label>

        <div className="grid cols-2 auto-post-grid auto-post-grid-minimal">
          <label className="label">
            Post from
            <input
              className="input"
              type="time"
              value={config.postingWindowStart}
              onChange={(event) => setConfig((current) => ({ ...current, postingWindowStart: event.target.value }))}
            />
          </label>

          <label className="label">
            Until
            <input
              className="input"
              type="time"
              value={config.postingWindowEnd}
              onChange={(event) => setConfig((current) => ({ ...current, postingWindowEnd: event.target.value }))}
            />
          </label>
        </div>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>Facebook Pages</strong>
            <span className="muted">{selectedPageNames.length} / {MAX_TARGET_PAGES} selected</span>
          </div>
          <div className="chip-grid">
            {pages.length ? pages.map((page) => {
              const active = config.targetPageIds.includes(page.pageId);
              const disabled = !active && config.targetPageIds.length >= MAX_TARGET_PAGES;
              return (
                <button
                  key={page.pageId}
                  type="button"
                  className={`choice-chip ${active ? "active" : ""}`}
                  onClick={() => togglePage(page.pageId)}
                  disabled={disabled}
                >
                  <span>{page.name}</span>
                </button>
              );
            }) : <div className="composer-media-empty">Connect Facebook Page first</div>}
          </div>
        </div>

        <label className="label">
          Caption Mode
          <select
            className="select"
            value={config.captionStrategy}
            onChange={(event) => setConfig((current) => ({ ...current, captionStrategy: event.target.value as CaptionStrategy }))}
          >
            <option value="manual">Manual</option>
            <option value="hybrid">Manual + AI</option>
            <option value="ai">AI only (copy text from image)</option>
          </select>
        </label>

        <label className="label">
          Captions
          <textarea
            className="textarea auto-post-captions"
            value={config.captions.join("\n")}
            onChange={(event) => updateCaptions(event.target.value)}
            placeholder="One caption per line"
          />
        </label>

        <label className="label">
          Hashtags
          <textarea
            className="textarea auto-post-captions"
            value={config.hashtags.join(" ")}
            onChange={(event) => updateHashtags(event.target.value)}
            placeholder="#บ้านช้างบ้าน #แคปชั่นบ้าน #fypp"
          />
        </label>

        <label className="label">
          AI Prompt
          <input
            className="input"
            value={config.aiPrompt}
            onChange={(event) => setConfig((current) => ({ ...current, aiPrompt: event.target.value }))}
            placeholder={config.captionStrategy === "hybrid" ? "Tell AI exactly how to rewrite the image text/caption" : "Optional"}
          />
        </label>

        <div className="muted">Unique image assignment per page is handled by the in-app automation engine for each run.</div>
        <div className="muted">Auto Post ตอนนี้ใช้ Shopee Affiliate เป็นแหล่งคอนเทนต์หลัก ไม่ต้องเชื่อม Google Drive เพื่อโพสต์อัตโนมัติแล้ว</div>
        {config.captionStrategy === "ai" ? (
          <div className="muted">AI only extracts visible text from each image as-is and does not rewrite the caption.</div>
        ) : null}
        {config.captionStrategy === "hybrid" ? (
          <div className="muted">Manual + AI uses your AI Prompt like a real ChatGPT instruction and rewrites from the manual caption plus text detected in the image.</div>
        ) : null}
        <div className="muted">If you add hashtags here, the system appends them to every auto-post caption. Leave it blank to keep captions unchanged.</div>

        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>

      <section className="card auto-post-card auto-post-status-card">
        <div className="split auto-post-head auto-post-head-minimal">
          <div className="stack compact-stack">
            <div className="kicker">Status</div>
            <h3>Control & Monitor</h3>
          </div>
          <span className={`badge ${statusTone(displayStatus)}`}>{statusLabel(displayStatus)}</span>
        </div>

        {renderStateBanner()}
        {message ? <div className="composer-message">{message}</div> : null}
        {error && !blockingError ? <div className="composer-message composer-message-error">{error}</div> : null}

        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card"><span className="muted">Shopee API status</span><strong>{controlPanel?.shopeeApiStatus ?? "checking"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Affiliate config status</span><strong>{controlPanel?.affiliateConfigStatus ?? "checking"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Tracking ID</span><strong>{config.shopeeTrackingId || "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Facebook Page status</span><strong>{hasFacebookPages ? `connected (${pages.length})` : controlPanel?.facebookPageStatus ?? "missing"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Auto-post engine status</span><strong>{controlPanel?.autoPostEngineStatus ?? statusLabel(config.autoPostStatus)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last product fetch time</span><strong>{formatDateTime(controlPanel?.lastProductFetchAt ?? undefined)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last publish time</span><strong>{formatDateTime(controlPanel?.lastPublishAt ?? undefined)}</strong></div>
        </div>
        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card">
            <span className="muted">Storage used</span>
            <strong>
              {formatBytes(controlPanel?.storage?.usedBytes)} / {formatBytes(controlPanel?.storage?.limitBytes)}
            </strong>
          </div>
          <div className="auto-post-metric-card">
            <span className="muted">Storage percent</span>
            <strong>{controlPanel?.storage?.percent ?? 0}% ({controlPanel?.storage?.status ?? "checking"})</strong>
          </div>
          <div className="auto-post-metric-card">
            <span className="muted">Last cleanup</span>
            <strong>{formatDateTime(controlPanel?.storage?.lastCleanup?.at ?? undefined)}</strong>
          </div>
          <div className="auto-post-metric-card">
            <span className="muted">Cleanup deleted / freed</span>
            <strong>
              {controlPanel?.storage?.lastCleanup?.deletedCount ?? 0} / {formatBytes(controlPanel?.storage?.lastCleanup?.estimatedFreedBytes ?? 0)}
            </strong>
          </div>
        </div>
        {controlPanel?.storage?.status === "critical" ? (
          <div className="composer-message composer-message-error">
            Storage quota is nearly full. Run cleanup now before starting another auto-post job.
          </div>
        ) : controlPanel?.storage?.status === "warning" ? (
          <div className="composer-message">
            Storage is above the warning threshold. Cleanup will run before the next auto-post job.
          </div>
        ) : null}
        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card"><span className="muted">Current job id</span><strong>{controlPanel?.currentJobId ?? "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Current step</span><strong>{controlPanel?.currentStep ?? statusLabel(displayStatus)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Product attempt</span><strong>{controlPanel?.currentAttempt ? `${controlPanel.currentAttempt} / ${controlPanel.maxProductAttempts ?? 10}` : "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Skipped products</span><strong>{controlPanel?.skippedProductsCount ?? 0}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Current product</span><strong>{controlPanel?.currentProduct ? sanitizeText(controlPanel.currentProduct) : "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last skipped reason</span><strong>{controlPanel?.lastSkippedReason ? sanitizeText(controlPanel.lastSkippedReason) : "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Selected pages</span><strong>{controlPanel?.selectedPagesCount ?? config.targetPageIds.length}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Created tasks</span><strong>{controlPanel?.createdTasksCount ?? controlPanel?.pageResults?.filter((result) => result.jobId).length ?? 0}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Current page</span><strong>{controlPanel?.currentPublishingPage?.pageName ?? "-"}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Published</span><strong>{controlPanel?.publishedPagesCount ?? 0}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Failed / Pending</span><strong>{controlPanel?.failedPagesCount ?? 0} / {controlPanel?.pendingPagesCount ?? 0}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Worker heartbeat</span><strong>{formatDateTime(controlPanel?.lastWorkerHeartbeat ?? undefined)}</strong></div>
        </div>
        {controlPanel?.queueHealth === "missing_tasks" ? (
          <div className="composer-message composer-message-error">
            {sanitizeText(controlPanel.missingTasksWarning || "Missing Tasks Detected")}
            {typeof controlPanel.repairedTasksCount === "number" && controlPanel.repairedTasksCount > 0
              ? ` • Repaired ${controlPanel.repairedTasksCount} task(s)`
              : ""}
          </div>
        ) : null}
        {controlPanel?.queueHealth === "finding_valid_product" ? (
          <div className="composer-message composer-message-error">
            กำลังลองสินค้าตัวใหม่
            {controlPanel.currentAttempt ? ` (${controlPanel.currentAttempt}/${controlPanel.maxProductAttempts ?? 10})` : ""}
            {controlPanel.currentProduct ? ` • สินค้าล่าสุด: ${sanitizeText(controlPanel.currentProduct)}` : ""}
            {controlPanel.lastSkippedReason ? ` • เหตุผล: ${formatSkipReason(controlPanel.lastSkippedReason)}` : " • ยังไม่พบเหตุผลใน log ล่าสุด"}
          </div>
        ) : null}
        {controlPanel?.pageResults?.length ? (
          <div className="stack compact-stack">
            <div className="split compact-row">
              <strong>Page results</strong>
              <span className="badge badge-neutral">{controlPanel.pageResults.length}</span>
            </div>
            <div className="auto-post-log-list auto-post-log-list-minimal">
              {controlPanel.pageResults.map((result) => (
                <article key={result.jobId ?? result.pageId} className="auto-post-log-item">
                  <div className="split compact-row">
                    <strong>{sanitizeText(result.pageName)}</strong>
                    <span className={`badge ${result.status === "success" ? "badge-success" : result.status === "failed" ? "badge-warn" : "badge-neutral"}`}>
                      {result.status}
                    </span>
                  </div>
                  <div className="muted auto-post-log-meta">
                    {result.jobId ? `Job ${result.jobId}` : "Page task creation incomplete"}
                    {result.facebookPostId ? ` • Facebook post ${result.facebookPostId}` : ""}
                    {result.scheduledAt ? ` • ${formatScheduledLabel(result.scheduledAt) || `Scheduled ${formatDateTime(result.scheduledAt)}`}` : ""}
                    {result.shortAffiliateLink ? ` • Short link ${sanitizeText(result.shortAffiliateLink)}` : ""}
                    {result.errorMessage ? ` • ${sanitizeText(result.errorMessage)}` : ""}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
        {controlPanel?.missingEnv?.length ? (
          <div className="composer-message composer-message-error">
            Shopee Affiliate setup required. Missing: {controlPanel.missingEnv.join(", ")}
          </div>
        ) : null}
        {controlPanel?.lastError?.message && !setupRequired ? (
          <div className="composer-message composer-message-error">
            {sanitizeText(controlPanel.lastError.message)}
          </div>
        ) : null}

        <div className="auto-post-control-row">
          <button className="button button-secondary" type="button" onClick={handleStartNow} disabled={startDisabled}>
            {starting ? "Starting..." : "Start Now"}
          </button>
          <button className="button button-secondary" type="button" onClick={handlePause} disabled={pausing || stopping}>
            {pausing ? "Pausing..." : "Pause"}
          </button>
          <button className="button button-secondary" type="button" onClick={handleStop} disabled={stopping || pausing}>
            {stopping ? "Stopping..." : "Stop"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleClearStuck}
            disabled={clearingStuck || starting || pausing || stopping}
          >
            {clearingStuck ? "Clearing..." : "Clear stuck"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleRetryPendingPages}
            disabled={retryingPendingPages || starting || pausing || stopping}
          >
            {retryingPendingPages ? "Retrying..." : "Retry pending pages"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleRunCleanup}
            disabled={cleaningStorage || starting || pausing || stopping}
          >
            {cleaningStorage ? "Cleaning..." : "Run Cleanup Now"}
          </button>
        </div>

        <div className="grid cols-2 auto-post-metrics auto-post-metrics-minimal">
          <div className="auto-post-metric-card"><span className="muted">Last run</span><strong>{formatDateTime(config.lastRunAt)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Next run</span><strong>{formatDateTime(config.nextRunAt)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Current job</span><strong>{jobStatusLabel(config.jobStatus)}</strong></div>
          <div className="auto-post-metric-card"><span className="muted">Last error</span><strong>{lastShopeeError || sanitizeText(config.lastError) || "None"}</strong></div>
        </div>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>Affiliate Post Preview</strong>
            <span className="badge badge-neutral">{queuePreview.length}</span>
          </div>
          <div className="auto-post-log-list auto-post-log-list-minimal">
            {queuePreview.length ? queuePreview.map((item) => (
              <article key={item._id} className="auto-post-log-item">
                <div className="split compact-row">
                  <strong>{sanitizeText(item.product?.productName || item.productId)}</strong>
                  <span className="badge badge-neutral">{item.status}</span>
                </div>
                <div className="muted">
                  {item.product?.discountPrice || item.product?.productPrice
                    ? `ราคา ${item.product?.discountPrice ?? item.product?.productPrice} บาท`
                    : "รอข้อมูลราคา"}
                  {item.product?.discountPercent ? ` • ลด ${item.product.discountPercent}%` : ""}
                  {item.product?.rating ? ` • ${item.product.rating}/5` : ""}
                </div>
                {item.product?.productImageUrl ? (
                  <img
                    src={item.product.productImageUrl}
                    alt={item.product?.productName || "Shopee product preview"}
                    style={{ width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 18, marginTop: 10 }}
                  />
                ) : null}
                {item.preview?.caption ? (
                  <div className="muted auto-post-log-meta">{sanitizeText(item.preview.caption)}</div>
                ) : null}
                <div className="muted auto-post-log-meta">
                  {formatDateTime(item.scheduledAt)} • {item.preview?.imageUrls?.length ?? 0}/4 images • {item.preview?.affiliateLink || item.affiliateLink}
                </div>
              </article>
            )) : <div className="composer-media-empty">ยังไม่มีโพสต์ Shopee ในคิว Preview</div>}
          </div>
        </div>

        <div className="stack compact-stack">
          <div className="split compact-row">
            <strong>Latest activity</strong>
            <span className="badge badge-neutral">{logs.length}</span>
          </div>
          <div className="auto-post-log-list auto-post-log-list-minimal">
            {logs.length ? logs.map((log) => (
              <article key={log._id} className="auto-post-log-item">
                <div className="split compact-row">
                  <strong>{log.message}</strong>
                  <span className={`badge ${log.level === "error" ? "badge-warn" : log.level === "success" ? "badge-success" : "badge-neutral"}`}>
                    {log.level}
                  </span>
                </div>
                <div className="muted">{formatDateTime(log.createdAt)}</div>
                <div className="muted auto-post-log-meta">
                  {log.metadata?.pageId ? `Page ${String(log.metadata.pageId)}` : "System event"}
                  {logStatusSuffix(log)}
                </div>
              </article>
            )) : <div className="composer-media-empty">No logs yet.</div>}
          </div>
        </div>
      </section>
    </div>
  );
}



