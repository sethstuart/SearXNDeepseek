import assert from "node:assert/strict";
import { test } from "node:test";
import { WebError } from "@deepseek-ai/dsh-web";
import { SearxngDockerSearchProvider, mapSearxngResponse, mapSearxngResult } from "../lib/provider.js";
import { fakeFetch, jsonResponse, domError } from "./helpers.js";

const OPTIONS = {
  image: "searxng/searxng",
  port: 8091,
  containerName: "dsh-searxng-docker-test",
  maxResults: 10,
  language: "all",
  idleTimeoutMs: 60_000,
  startTimeoutMs: 300_000,
  readyTimeoutMs: 5_000,
  searchTimeoutMs: 60_000,
};

/** A runtime stand-in recording lifecycle calls. */
function fakeRuntime() {
  return {
    ensureRunningCalls: 0,
    stopCalls: 0,
    idleStops: 0,
    async ensureRunning(signal) {
      this.ensureRunningCalls += 1;
      if (signal?.aborted) throw new WebError("search aborted before SearXNG was ready", "WEB_ABORTED");
      return "http://127.0.0.1:8091";
    },
    async stop() {
      this.stopCalls += 1;
    },
    scheduleIdleStop() {
      this.idleStops += 1;
    },
  };
}

test("registers under searxng-docker by default and honors an id override", () => {
  const runtime = fakeRuntime();
  assert.equal(new SearxngDockerSearchProvider(runtime, () => OPTIONS).id, "searxng-docker");
  assert.equal(
    new SearxngDockerSearchProvider(runtime, () => OPTIONS, { id: "deepseek-official" }).id,
    "deepseek-official",
  );
});

test("available() validates the configuration without network", () => {
  const runtime = fakeRuntime();
  assert.equal(new SearxngDockerSearchProvider(runtime, () => OPTIONS).available(), true);
  assert.equal(
    new SearxngDockerSearchProvider(runtime, () => ({ ...OPTIONS, port: "not-a-port" })).available(),
    false,
  );
  assert.equal(
    new SearxngDockerSearchProvider(runtime, () => {
      throw new Error("boom");
    }).available(),
    false,
  );
});

test("search maps and de-duplicates SearXNG results", async () => {
  const runtime = fakeRuntime();
  const fetchImpl = fakeFetch((url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8091\/search\?/);
    assert.match(url, /q=deepseek\+harness/); // URLSearchParams encodes the space as +
    return jsonResponse({
      results: [
        { url: "https://example.com/a", title: "A", content: "first" },
        { url: "https://example.com/b", title: "B", content: "second", publishedDate: "2026-01-02T03:04:05Z" },
        { url: "https://example.com/a", title: "A dup", content: "duplicate" }, // dropped by URL dedupe
        { title: "no url" }, // dropped, no usable URL
        null, // dropped, malformed
      ],
    });
  });

  const provider = new SearxngDockerSearchProvider(runtime, () => OPTIONS, { fetchImpl });
  const result = await provider.search({ query: "deepseek harness", maxResults: 10 });

  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://example.com/a", "https://example.com/b"],
  );
  assert.equal(result.sources[0].title, "A");
  assert.equal(result.sources[0].snippet, "first");
  assert.equal(result.sources[1].publishedAt, "2026-01-02T03:04:05.000Z");
  // The search kept the container warm for follow-ups.
  assert.equal(runtime.idleStops, 1);
});

test("search passes a non-'all' language through", async () => {
  const runtime = fakeRuntime();
  const fetchImpl = fakeFetch((url) => {
    assert.match(url, /language=de/);
    return jsonResponse({ results: [] });
  });
  const provider = new SearxngDockerSearchProvider(runtime, () => ({ ...OPTIONS, language: "de" }), { fetchImpl });
  await provider.search({ query: "harness" });
});

test("empty query fails with WEB_PROVIDER_ERROR before touching docker", async () => {
  const runtime = fakeRuntime();
  const provider = new SearxngDockerSearchProvider(runtime, () => OPTIONS);
  await assert.rejects(
    () => provider.search({ query: "   " }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR" && /non-empty query/.test(error.message),
  );
  assert.equal(runtime.ensureRunningCalls, 0);
});

test("HTTP failure surfaces as WEB_PROVIDER_ERROR with the status", async () => {
  const runtime = fakeRuntime();
  const fetchImpl = fakeFetch(() => jsonResponse({ error: "boom" }, 503));
  const provider = new SearxngDockerSearchProvider(runtime, () => OPTIONS, { fetchImpl });

  await assert.rejects(
    () => provider.search({ query: "harness" }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR" && /HTTP 503/.test(error.message),
  );
});

test("network failure recycles the container and rethrows", async () => {
  const runtime = fakeRuntime();
  const fetchImpl = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const provider = new SearxngDockerSearchProvider(runtime, () => OPTIONS, { fetchImpl });

  await assert.rejects(
    () => provider.search({ query: "harness" }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR",
  );
  assert.equal(runtime.stopCalls, 1);
});

test("caller abort maps to WEB_ABORTED", async () => {
  const runtime = fakeRuntime();
  const controller = new AbortController();
  controller.abort();
  const provider = new SearxngDockerSearchProvider(runtime, () => OPTIONS);

  await assert.rejects(
    () => provider.search({ query: "harness" }, controller.signal),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED",
  );
});

test("mapSearxngResult normalizes a single item", () => {
  const source = mapSearxngResult({ url: " https://example.com/x ", title: " T ", content: " C ", publishedDate: "not-a-date" });
  assert.deepEqual(source, { url: "https://example.com/x", title: "T", snippet: "C" });
  assert.equal(mapSearxngResult({}), null);
});

test("mapSearxngResponse tolerates a missing results array", () => {
  assert.deepEqual(mapSearxngResponse(null), { sources: [], truncated: false });
  assert.deepEqual(mapSearxngResponse({}), { sources: [], truncated: false });
});
