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
      const response = await fetch(input, {
        ...init,
        signal
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
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
