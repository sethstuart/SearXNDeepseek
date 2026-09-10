/**
 * Image search over the ephemeral SearXNG container, plus best-effort local
 * downloads of the top results.
 *
 * `searchImages` queries SearXNG's `images` category (JSON API) for one or
 * more queries and merges them into a single deduplicated, capped list.
 * `downloadImage(s)` then fetches each result's direct file URL (falling back
 * to its thumbnail), validates that the bytes are actually an image of a sane
 * size, and saves them under `<tmpdir>/dsh-searxng-docker-<port>/images/` so
 * callers can present local copies. Downloads never throw: a failed fetch or
 * a non-image payload simply yields `null` for that result.
 * @module @deepseek-ai/dsh-web-search-searxng-docker/images
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebError } from "@deepseek-ai/dsh-web";
import { throwIfAborted } from "./docker.js";

// Kept in sync with BROWSER_UA in provider.js (inlined rather than imported so
// this module stays loadable against a cached copy of provider.js under live reload).
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Below this size a payload is almost certainly an error page or placeholder. */
export const MIN_IMAGE_BYTES = 1024;

/** Above this size the download is treated as corrupt or misreported. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Per-image download deadline (ms). */
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Content-type → file extension for the local copy. */
const CONTENT_TYPE_EXT = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
  ["image/svg+xml", ".svg"],
]);

/**
 * Map one SearXNG `images`-category result to a normalized image record.
 * @param item - one entry of the SearXNG `results` array.
 * @returns `{ url, title?, pageUrl?, thumbnailUrl?, width?, height? }`, or null
 *   when the entry has no usable http(s) URL.
 */
export function mapImageResult(item) {
  if (!item || typeof item !== "object") return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  const image = { url };
  if (typeof item.title === "string" && item.title.trim()) image.title = item.title.trim();
  for (const [source, target] of [["page_url", "pageUrl"], ["thumbnail_url", "thumbnailUrl"]]) {
    const value = typeof item[source] === "string" ? item[source].trim() : "";
    if ((value.startsWith("http://") || value.startsWith("https://")) && value !== url) image[target] = value;
  }
  for (const key of ["width", "height"]) {
    const n = Number(item[key]);
    if (Number.isInteger(n) && n > 0) image[key] = n;
  }
  return image;
}

/**
 * Run one or more image searches against the local SearXNG instance.
 *
 * Queries run sequentially through the shared container (SearXNG is a single
 * upstream process); results are merged round-robin, deduplicated by URL
 * (first occurrence wins), and capped at `imageMaxResults`.
 * @param runtime - the shared `SearxngDockerRuntime` owning the container.
 * @param resolveOptions - thunk returning current options (port, language, timeouts, imageMaxResults).
 * @param queries - validated non-empty query strings.
 * @param signal - optional caller cancellation signal.
 * @param hooks - optional test seams: `fetchImpl`.
 * @returns `{ images, truncated }` with normalized image records.
 */
export async function searchImages(runtime, resolveOptions, queries, signal, hooks = {}) {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  throwIfAborted(signal);
  const options = resolveOptions();

  // Lazily start (or reuse) the container; this is where Docker problems surface.
  await runtime.ensureRunning(signal);

  const perQuery = [];
  for (const query of queries) {
    const params = new URLSearchParams({ q: query, categories: "images", format: "json" });
    if (options.language && options.language !== "all") params.set("language", options.language);
    const url = `${runtime.baseUrl}/search?${params.toString()}`;

    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(options.searchTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      response = await fetchImpl(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new WebError("image search aborted", "WEB_ABORTED");
      }
      // The container may have died between the health probe and this request;
      // recycle it so the next search starts clean.
      await runtime.stop().catch(() => {});
      if (error?.name === "TimeoutError") {
        throw new WebError(
          `SearXNG image search timed out after ${options.searchTimeoutMs}ms`,
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
        `SearXNG image search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        "WEB_PROVIDER_ERROR",
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new WebError("SearXNG returned a non-JSON response", "WEB_PROVIDER_ERROR", { cause: error });
    }
    perQuery.push(body);
  }

  // Map each query's results, then merge round-robin with dedupe and cap.
  const mapped = perQuery.map((body) => {
    const raw = Array.isArray(body?.results) ? body.results : [];
    const out = [];
    for (const item of raw) {
      const image = mapImageResult(item);
      if (image) out.push(image);
    }
    return out;
  });

  const maxResults = options.imageMaxResults;
  const seen = new Set();
  const images = [];
  let truncated = false;
  const deepest = mapped.reduce((max, arr) => Math.max(max, arr.length), 0);
  merge: for (let rank = 0; rank < deepest; rank++) {
    for (const list of mapped) {
      const image = list[rank];
      if (!image || seen.has(image.url)) continue;
      seen.add(image.url);
      if (images.length === maxResults) {
        truncated = true;
        break merge;
      }
      images.push(image);
    }
  }

  // Keep the container warm for follow-up searches; recycle after idle.
  runtime.scheduleIdleStop();
  return { images, truncated };
}

/** Directory local image copies are saved under (per published port). */
export function imagesDirFor(options) {
  return join(tmpdir(), `dsh-searxng-docker-${options.port}`, "images");
}

/**
 * Reduce arbitrary text to a short filesystem-safe slug.
 * @param text - the title or URL to slugify.
 * @returns a lowercase hyphen-separated slug (never empty).
 */
export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/['’]/g, "") // drop apostrophes so words stay whole ("hasan's" → "hasans")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "image";
}

/**
 * Best-effort download of one image result. Tries the direct file URL first,
 * then the thumbnail; validates content type and size before writing.
 * @param image - a normalized image record from {@link mapImageResult}.
 * @param options - current runtime options (port for the destination dir).
 * @param hooks - optional seams: `fetchImpl`, `prefix` (filename prefix, e.g. `img1`).
 * @returns the local file path on success, or null when no candidate worked.
 */
export async function downloadImage(image, options, hooks = {}) {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const candidates = [image.url, image.thumbnailUrl].filter(Boolean);

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            "User-Agent": BROWSER_UA,
            ...(image.pageUrl ? { Referer: image.pageUrl } : {}),
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) continue;
      const contentType = String(response.headers?.get?.("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!contentType.startsWith("image/")) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      // SVGs are text: a 600-byte icon is legitimate, so the error-page floor
      // (tuned for raster payloads) does not apply to them.
      const minBytes = contentType === "image/svg+xml" ? 64 : MIN_IMAGE_BYTES;
      if (buffer.length < minBytes || buffer.length > MAX_IMAGE_BYTES) continue;

      const ext = CONTENT_TYPE_EXT.get(contentType) ?? ".img";
      const dir = imagesDirFor(options);
      mkdirSync(dir, { recursive: true });
      const base = `${hooks.prefix ?? "img"}_${slugify(image.title ?? url)}`;
      const path = join(dir, `${base}${ext}`);
      writeFileSync(path, buffer);
      return path;
    } catch {
      // Best-effort by contract: try the next candidate (or give up).
    }
  }
  return null;
}

/**
 * Download every image concurrently (best-effort each).
 * @param images - normalized image records.
 * @param options - current runtime options.
 * @param hooks - optional seams: `fetchImpl`.
 * @returns local paths aligned with `images` (`null` where a download failed).
 */
export async function downloadImages(images, options, hooks = {}) {
  const settled = await Promise.allSettled(
    images.map((image, index) => downloadImage(image, options, { ...hooks, prefix: `img${index + 1}` })),
  );
  return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
}
