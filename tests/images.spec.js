import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { WebError } from "@deepseek-ai/dsh-web";
import {
  MIN_IMAGE_BYTES,
  downloadImage,
  downloadImages,
  imagesDirFor,
  mapImageResult,
  searchImages,
  slugify,
} from "../lib/images.js";
import * as plugin from "../lib/index.js";
import { domError, fakeFetch } from "./helpers.js";

/** A runtime stand-in recording lifecycle calls. */
function makeRuntime(baseUrl = "http://127.0.0.1:18091") {
  const calls = { ensureRunning: 0, stop: 0, scheduleIdleStop: 0 };
  return {
    baseUrl,
    calls,
    async ensureRunning() {
      calls.ensureRunning++;
    },
    async stop() {
      calls.stop++;
    },
    scheduleIdleStop() {
      calls.scheduleIdleStop++;
    },
  };
}

/** Options bag for tests (port kept off the real one). */
function options(overrides = {}) {
  return {
    port: 18091,
    language: "all",
    searchTimeoutMs: 5_000,
    imageMaxResults: 8,
    downloadImages: true,
    ...overrides,
  };
}

/** A Response-like object with a content type and binary body. */
function binaryResponse(bytes, contentType = "image/jpeg", status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (key.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => "",
  };
}

const JPEG_BYTES = Buffer.alloc(MIN_IMAGE_BYTES + 128, 7); // > MIN_IMAGE_BYTES

// ── mapImageResult ────────────────────────────────────────────────────────

test("mapImageResult maps a full record", () => {
  const image = mapImageResult({
    url: "https://cdn.example.com/cat.jpg",
    title: "A cat",
    page_url: "https://example.com/post",
    thumbnail_url: "https://cdn.example.com/thumb-cat.jpg",
    width: 800,
    height: 600,
  });
  assert.deepEqual(image, {
    url: "https://cdn.example.com/cat.jpg",
    title: "A cat",
    pageUrl: "https://example.com/post",
    thumbnailUrl: "https://cdn.example.com/thumb-cat.jpg",
    width: 800,
    height: 600,
  });
});

test("mapImageResult drops entries without a usable http(s) url", () => {
  assert.equal(mapImageResult({}), null);
  assert.equal(mapImageResult(null), null);
  assert.equal(mapImageResult({ url: "relative/path.jpg" }), null);
  assert.equal(mapImageResult({ url: "ftp://example.com/x.jpg" }), null);
});

test("mapImageResult does not duplicate the page when it equals the image url", () => {
  const image = mapImageResult({ url: "https://x.example/a.jpg", page_url: "https://x.example/a.jpg" });
  assert.equal(image.pageUrl, undefined);
});

// ── searchImages ──────────────────────────────────────────────────────────

test("searchImages maps one query's results and keeps the container warm", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { url: "https://cdn.example.com/a.jpg", title: "A" },
        { url: "not-a-url" },
        { url: "https://cdn.example.com/b.png" },
      ],
    }),
  }));

  const result = await searchImages(runtime, () => options(), ["bunny"], undefined, { fetchImpl });

  assert.equal(result.images.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.images[0].url, "https://cdn.example.com/a.jpg");
  assert.equal(result.images[1].title, undefined);
  assert.equal(runtime.calls.ensureRunning, 1);
  assert.equal(runtime.calls.scheduleIdleStop, 1);
  // The request must target the images category with JSON format.
  assert.match(fetchImpl.calls[0].url, /categories=images/);
  assert.match(fetchImpl.calls[0].url, /format=json/);
});

test("searchImages merges multiple queries round-robin and dedupes by url", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch((url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes("q=first")
        ? { results: [{ url: "https://cdn.example.com/1.jpg" }, { url: "https://cdn.example.com/shared.jpg" }] }
        : { results: [{ url: "https://cdn.example.com/shared.jpg" }, { url: "https://cdn.example.com/2.jpg" }] },
  }));

  const result = await searchImages(runtime, () => options(), ["first", "second"], undefined, { fetchImpl });

  assert.deepEqual(
    result.images.map((image) => image.url),
    [
      "https://cdn.example.com/1.jpg", // rank 0 of query one
      "https://cdn.example.com/shared.jpg", // rank 0 of query two (deduped at rank 1)
      "https://cdn.example.com/2.jpg", // rank 1 of query two
    ],
  );
});

test("searchImages caps results and flags truncation", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [1, 2, 3, 4].map((n) => ({ url: `https://cdn.example.com/${n}.jpg` })),
    }),
  }));

  const result = await searchImages(runtime, () => options({ imageMaxResults: 2 }), ["many"], undefined, { fetchImpl });

  assert.equal(result.images.length, 2);
  assert.equal(result.truncated, true);
});

test("searchImages maps a non-ok response to WEB_PROVIDER_ERROR", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 503, text: async () => "Service Unavailable" }));

  await assert.rejects(
    searchImages(runtime, () => options(), ["bunny"], undefined, { fetchImpl }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR" && /HTTP 503/.test(error.message),
  );
});

test("searchImages maps an already-aborted signal to WEB_ABORTED before touching the container", async () => {
  const runtime = makeRuntime();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    searchImages(runtime, () => options(), ["bunny"], controller.signal, { fetchImpl: fakeFetch(() => ({ ok: true })) }),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED",
  );
  assert.equal(runtime.calls.ensureRunning, 0);
});

test("searchImages maps a mid-flight AbortError to WEB_ABORTED without recycling the container", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => {
    throw domError("AbortError");
  });

  await assert.rejects(
    searchImages(runtime, () => options(), ["bunny"], undefined, { fetchImpl }),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED",
  );
  assert.equal(runtime.calls.stop, 0);
});

test("searchImages recycles the container when the request fails at the network layer", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => {
    throw new Error("ECONNREFUSED");
  });

  await assert.rejects(
    searchImages(runtime, () => options(), ["bunny"], undefined, { fetchImpl }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR",
  );
  assert.equal(runtime.calls.stop, 1);
});

test("searchImages rejects non-JSON bodies", async () => {
  const runtime = makeRuntime();
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));

  await assert.rejects(
    searchImages(runtime, () => options(), ["bunny"], undefined, { fetchImpl }),
    (error) => error instanceof WebError && /non-JSON/.test(error.message),
  );
});

// ── downloads ─────────────────────────────────────────────────────────────

test("downloadImage saves a validated image with the right extension", async () => {
  const fetchImpl = fakeFetch(() => binaryResponse(JPEG_BYTES, "image/jpeg"));
  const opts = options();

  const path = await downloadImage({ url: "https://cdn.example.com/cat.jpg", title: "A cat" }, opts, { fetchImpl });

  assert.ok(path, "expected a local path");
  assert.match(path, /img_a-cat\.jpg$/);
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path).length, JPEG_BYTES.length);
});

test("downloadImage rejects non-image payloads and undersized bodies", async () => {
  const html = fakeFetch(() => binaryResponse(Buffer.alloc(4096), "text/html"));
  assert.equal(await downloadImage({ url: "https://cdn.example.com/page" }, options(), { fetchImpl: html }), null);

  const tiny = fakeFetch(() => binaryResponse(Buffer.alloc(MIN_IMAGE_BYTES - 1), "image/png"));
  assert.equal(await downloadImage({ url: "https://cdn.example.com/x.png" }, options(), { fetchImpl: tiny }), null);
});

test("downloadImage accepts small SVGs (text-based images have no error-page floor)", async () => {
  const body = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z"/></svg>',
  );
  assert.ok(body.length >= 64 && body.length < MIN_IMAGE_BYTES); // the case under test
  const svg = fakeFetch(() => binaryResponse(body, "image/svg+xml"));
  const path = await downloadImage({ url: "https://cdn.example.com/icon.svg", title: "Icon" }, options(), { fetchImpl: svg });
  assert.ok(path);
  assert.match(path, /img_icon\.svg$/);
});

test("downloadImage falls back to the thumbnail when the direct url fails", async () => {
  const image = {
    url: "https://cdn.example.com/missing.jpg",
    thumbnailUrl: "https://cdn.example.com/thumb.jpg",
    title: "Fallback",
  };
  const fetchImpl = fakeFetch((url) => (url.includes("thumb") ? binaryResponse(JPEG_BYTES, "image/jpeg") : { ok: false, status: 404 }));

  const path = await downloadImage(image, options(), { fetchImpl });
  assert.ok(path);
  assert.match(path, /img_fallback\.jpg$/);
});

test("downloadImage returns null when every candidate fails", async () => {
  const failing = fakeFetch(() => {
    throw new Error("ECONNRESET");
  });
  const image = { url: "https://cdn.example.com/a.jpg", thumbnailUrl: "https://cdn.example.com/b.jpg" };
  assert.equal(await downloadImage(image, options(), { fetchImpl: failing }), null);
});

test("downloadImages aligns results with inputs and isolates failures", async () => {
  const images = [
    { url: "https://cdn.example.com/good.jpg", title: "Good" },
    { url: "https://cdn.example.com/bad.jpg", title: "Bad" },
  ];
  const fetchImpl = fakeFetch((url) => (url.includes("good") ? binaryResponse(JPEG_BYTES, "image/jpeg") : { ok: false, status: 404 }));

  const paths = await downloadImages(images, options(), { fetchImpl });
  assert.equal(paths.length, 2);
  assert.ok(paths[0]);
  assert.equal(paths[1], null);
});

test("imagesDirFor is scoped per published port", () => {
  const dir = imagesDirFor(options());
  assert.match(dir, /dsh-searxng-docker-18091[/\\]images$/);
});

// ── slugify ───────────────────────────────────────────────────────────────

test("slugify normalizes titles and survives empty input", () => {
  assert.equal(slugify("Hasan's Meat Pic!!"), "hasans-meat-pic");
  assert.equal(slugify("   "), "image");
  assert.ok(slugify("a".repeat(200)).length <= 48);
});

// ── tool-level integration (no docker) ────────────────────────────────────

test("web_search_images execute returns content, sources and local copies", async () => {
  const runtime = makeRuntime();
  const searchFetch = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { url: "https://cdn.example.com/bunny.jpg", title: "Bunny rabbit eating", page_url: "https://commons.example/wiki/File:Bunny", width: 1024, height: 576 },
        { url: "https://cdn.example.com/rabbit.png", title: "Rabbit" },
      ],
    }),
  }));
  const downloadFetch = fakeFetch(() => binaryResponse(JPEG_BYTES, "image/jpeg"));

  // Route search calls (JSON) and download calls (binary) through one fake.
  const fetchImpl = (url, opts) =>
    String(url).includes("/search?") ? searchFetch(url, opts) : downloadFetch(url, opts);

  const tool = plugin.createImageTool(runtime, () => options(), undefined, { fetchImpl });
  const result = await tool.execute({ queries: ["cute bunny", "cute bunny"] }, { signal: undefined });

  assert.equal(result.truncated, false);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, "https://cdn.example.com/bunny.jpg");
  assert.match(result.sources[0].snippet, /1024x576/);
  assert.match(result.sources[0].snippet, /commons\.example/);

  // Model-facing text: notice, previews, structured list, local copies.
  assert.match(result.content, /External web content follows/);
  assert.match(result.content, /!\[Bunny rabbit eating\]\(https:\/\/cdn\.example\.com\/bunny\.jpg\)/);
  assert.match(result.content, /local copy: .+img1_bunny-rabbit-eating\.jpg/);

  // The local copies really exist on disk.
  const localPaths = [...result.content.matchAll(/local copy: (.+)/g)].map((m) => m[1].trim());
  assert.equal(localPaths.length, 2);
  for (const path of localPaths) assert.ok(existsSync(path), `missing ${path}`);

  // presentResult renders a web search card with the same sources.
  const view = tool.presentResult({ queries: ["cute bunny"] }, { isError: false, meta: tool.output.presentationMeta({}, result) });
  assert.equal(view.card, "web");
  assert.equal(view.kind, "search");
  assert.equal(view.sources.length, 2);
});

test("web_search_images rejects empty and oversized query lists", async () => {
  const runtime = makeRuntime();
  const tool = plugin.createImageTool(runtime, () => options());

  await assert.rejects(tool.execute({ queries: ["   "] }, {}), (error) => error instanceof WebError && /non-empty/.test(error.message));
  await assert.rejects(
    tool.execute({ queries: ["a", "b", "c", "d", "e"] }, {}),
    (error) => error instanceof WebError && /at most 4/.test(error.message),
  );
});
