import { logExternalResponseFailure, traceExternalRequest } from "@/lib/services/request-debug";

function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>) {
  const controller = new AbortController();

  for (const signal of signals) {
    if (!signal) continue;

    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }

    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason);
      },
      { once: true }
    );
  }

  return controller.signal;
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: {
    retries?: number;
    retryDelayMs?: number;
    retryOnStatuses?: number[];
    timeoutMs?: number;
  } = {}
) {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1200;
  const retryOnStatuses = options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504];
  const timeoutMs = options.timeoutMs ?? 15000;

  let lastError: unknown;
  const requestUrl =
    typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutController = new AbortController();
    const signal = mergeAbortSignals([init.signal, timeoutController.signal]);
    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => {
            timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    try {
      const requestStartedAt = Date.now();
      const response = await traceExternalRequest(
        {
          step: "FETCH_WITH_RETRY",
          url: requestUrl,
          fn: "fetchWithRetry",
          source: "external_http_request",
          metadata: { attempt: attempt + 1, retries: retries + 1 }
        },
        () => fetch(input, {
          ...init,
          signal
        })
      );

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
        if (!response.ok) {
          await logExternalResponseFailure({
            step: "FETCH_WITH_RETRY",
            url: requestUrl,
            fn: "fetchWithRetry",
            source: "external_http_request",
            responseTime: Date.now() - requestStartedAt,
            status: response.status,
            errorMessage: `External HTTP request returned ${response.status}`,
            metadata: { attempt: attempt + 1, retries: retries + 1 }
          });
        }
        return response;
      }

      lastError = new Error(`Retryable response status: ${response.status}`);
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const normalizedError =
        timeoutController.signal.aborted && !(init.signal?.aborted)
          ? new Error(`Request timed out after ${timeoutMs}ms`)
          : error;

      lastError = normalizedError;
      if (attempt === retries) {
        throw normalizedError;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}
