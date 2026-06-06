type RequestDebugInput = {
  step: string;
  url?: string;
  fn: string;
  source: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
};

function safeUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|secret|key|sign|signature|authorization|password/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return value.replace(/(access_token=)[^&\s]+/gi, "$1[redacted]");
  }
}

function getStatus(error: unknown) {
  const record = typeof error === "object" && error ? (error as Record<string, unknown>) : {};
  return typeof record.status === "number" || typeof record.status === "string" ? String(record.status) : "unknown";
}

function serializeRequestDebugError(error: unknown) {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    return {
      name: error.name,
      message: error.message,
      reason: error.message,
      stack: error.stack?.slice(0, 3000),
      status: record.status,
      code: record.code,
      type: record.type
    };
  }

  return {
    name: "UnknownError",
    message: typeof error === "string" ? error : "Unknown request failure",
    reason: typeof error === "string" ? error : "Unknown request failure"
  };
}

async function logFailedRequest(input: RequestDebugInput & {
  responseTime: number;
  status?: string | number;
  error: unknown;
}) {
  const serialized = serializeRequestDebugError(input.error);
  const payload = {
    step: input.step,
    url: safeUrl(input.url),
    status: input.status ?? getStatus(input.error),
    responseTime: input.responseTime,
    errorMessage: serialized.reason,
    FAILED_REQUEST_SOURCE: input.source,
    FAILED_URL: safeUrl(input.url),
    FAILED_FUNCTION: input.fn,
    FAILED_STATUS: input.status ?? getStatus(input.error),
    FAILED_EXCEPTION: serialized,
    ...(input.metadata ?? {})
  };

  console.error("[FAILED_REQUEST_SOURCE]", payload);

  if (input.userId) {
    try {
      const { logAction } = await import("@/lib/services/logging");
      await logAction({
        userId: input.userId,
        type: "error",
        level: "error",
        message: `FAILED_REQUEST_SOURCE: ${input.source} (${input.step})`,
        metadata: payload
      });
    } catch (logError) {
      console.warn("[request-debug] failed to persist request failure log", serializeRequestDebugError(logError));
    }
  }
}

function createRequestTraceError(input: RequestDebugInput, error: unknown) {
  const originalMessage = error instanceof Error ? error.message : String(error ?? "request failed");
  const message = [
    originalMessage,
    `at ${input.step}`,
    `(source=${input.source}, fn=${input.fn}${input.url ? `, url=${safeUrl(input.url)}` : ""})`
  ].join(" ");
  const tracedError = new Error(message);
  tracedError.name = error instanceof Error ? error.name : "RequestTraceError";
  (tracedError as Error & Record<string, unknown>).cause = error;
  (tracedError as Error & Record<string, unknown>).source = input.source;
  (tracedError as Error & Record<string, unknown>).step = input.step;
  (tracedError as Error & Record<string, unknown>).url = safeUrl(input.url);
  (tracedError as Error & Record<string, unknown>).fn = input.fn;
  return tracedError;
}

export async function traceExternalRequest<T>(
  input: RequestDebugInput,
  run: () => Promise<T>
) {
  const startedAt = Date.now();
  try {
    const result = await run();
    const status =
      typeof Response !== "undefined" && result instanceof Response
        ? result.status
        : "ok";
    console.info("[REQUEST_TRACE]", {
      step: input.step,
      url: safeUrl(input.url),
      status,
      responseTime: Date.now() - startedAt,
      source: input.source,
      fn: input.fn,
      ...(input.metadata ?? {})
    });
    return result;
  } catch (error) {
    await logFailedRequest({
      ...input,
      responseTime: Date.now() - startedAt,
      error
    });
    throw createRequestTraceError(input, error);
  }
}

export async function logExternalResponseFailure(input: RequestDebugInput & {
  responseTime: number;
  status: number;
  errorMessage: string;
}) {
  await logFailedRequest({
    ...input,
    error: new Error(input.errorMessage),
    status: input.status,
    responseTime: input.responseTime
  });
}
