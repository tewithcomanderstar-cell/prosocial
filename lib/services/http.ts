export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: {
    retries?: number;
    retryDelayMs?: number;
    retryOnStatuses?: number[];
  } = {}
) {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1200;
  const retryOnStatuses = options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504];

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
        return response;
      }

      lastError = new Error(`Retryable response status: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}
