/**
 * `WebSearchProvider` backed by an ephemeral SearXNG Docker container.
 *
 * The provider is registered with the harness web seam (`ctx.web`) and is
 * selected via `web.searchProvider: searxng-docker`. Each search lazily starts
 * (or reuses) a local SearXNG container, queries its JSON API, maps results to
 * the normalized source shape, and arms an idle-stop timer so the container is
 * recycled after use. No API keys are required at any layer.
 * @module @deepseek-ai/dsh-web-search-searxng-docker/provider
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { throwIfAborted } from "./docker.js";

/** Browser-like user agent; SearXNG engines treat it as a normal client. */
// Kept in sync with the BROWSER_UA constant in images.js (downloads use the same identity).
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Map one SearXNG JSON result to the harness source shape.
 * @param item - one entry of the SearXNG `results` array.
 * @returns a normalized source, or null when it has no usable URL.
 */
export function mapSearxngResult(item) {
  if (!item || typeof item !== "object") return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!url) return null;

  const source = { url };
  if (typeof item.title === "string" && item.title.trim()) source.title = item.title.trim();
  if (typeof item.content === "string" && item.content.trim()) source.snippet = item.content.trim();
  if (typeof item.publishedDate === "string" && item.publishedDate) {
    const parsed = Date.parse(item.publishedDate);
    if (!Number.isNaN(parsed)) source.publishedAt = new Date(parsed).toISOString();
  }
  return source;
}

/**
 * Map a full SearXNG JSON response to the harness search result, dropping
 * malformed entries and de-duplicating by URL (first occurrence wins).
 * @param body - parsed `GET /search?format=json` response.
 * @returns normalized `{ sources, truncated }`.
 */
export function mapSearxngResponse(body) {
  const raw = Array.isArray(body?.results) ? body.results : [];
  const seen = new Set();
  const sources = [];
  for (const item of raw) {
    const source = mapSearxngResult(item);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return { sources, truncated: false };
}

/**
 * Search provider that runs SearXNG in a local Docker container.
 */
export class SearxngDockerSearchProvider {
  /** Default registry id for this provider. */
  static defaultId = "searxng-docker";

  /** Registry id used with `ctx.web` (set in the constructor). */
  id;

  /**
   * @param runtime - the shared `SearxngDockerRuntime` owning the container lifecycle.
   * @param resolveOptions - thunk returning current options (maxResults, language, searchTimeoutMs).
   * @param hooks - optional seams: `fetchImpl`, and `id` to register under a
   *   different web-seam provider id (e.g. taking over an existing slot).
   */
  constructor(runtime, resolveOptions, hooks = {}) {
    this.runtime = runtime;
    this.resolveOptions = resolveOptions;
    this.fetchImpl = hooks.fetchImpl ?? fetch;
    this.id = hooks.id || SearxngDockerSearchProvider.defaultId;
  }

  /**
   * Cheap local usability check (no network): the configuration must be sane.
   * Docker daemon availability is judged lazily at search time so that a
   * stopped daemon does not make the provider "unavailable" — it just fails
   * with an actionable error on first use and recovers when Docker starts.
   */
  available() {
    try {
      const options = this.resolveOptions();
      return (
        Number.isInteger(options.port) &&
        options.port > 0 &&
        options.port < 65_536 &&
        typeof options.image === "string" &&
        options.image.length > 0 &&
        typeof options.containerName === "string" &&
        options.containerName.length > 0
      );
    } catch {
      return false;
    }
  }

  /**
   * Run one search through the local SearXNG instance.
   * @param request - `{ query, maxResults? }` from the web seam.
   * @param signal - optional cancellation signal.
   * @returns normalized sources (the seam enforces `maxResults`).
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    throwIfAborted(signal);

    const query = typeof request?.query === "string" ? request.query.trim() : "";
    if (!query) {
      throw new WebError("web_search requires a non-empty query", "WEB_PROVIDER_ERROR");
    }

    // Lazily start (or reuse) the container; this is where Docker problems surface.
    const baseUrl = await this.runtime.ensureRunning(signal);

    const params = new URLSearchParams({ q: query, format: "json" });
    if (options.language && options.language !== "all") params.set("language", options.language);
    const url = `${baseUrl}/search?${params.toString()}`;

    // Combine caller cancellation with a hard per-request deadline.
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(options.searchTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
        },
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new WebError("search aborted", "WEB_ABORTED");
      }
      // The container may have died between the health probe and this request;
      // recycle it so the next search starts clean.
      await this.runtime.stop().catch(() => {});
      if (error?.name === "TimeoutError") {
        throw new WebError(
          `SearXNG search timed out after ${options.searchTimeoutMs}ms`,
          "WEB_PROVIDER_ERROR",
          { cause: error },
        );
      }
      throw error instanceof WebError ? error : new WebError(
        `SearXNG request failed: ${error?.message ?? error}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new WebError(
        `SearXNG search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        "WEB_PROVIDER_ERROR",
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new WebError("SearXNG returned a non-JSON response", "WEB_PROVIDER_ERROR", { cause: error });
    }

    const result = mapSearxngResponse(body);
    // Keep the container warm for follow-up searches; recycle after idle.
    this.runtime.scheduleIdleStop();
    return result;
  }
}
