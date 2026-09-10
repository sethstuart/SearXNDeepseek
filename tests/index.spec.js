import assert from "node:assert/strict";
import { test } from "node:test";
import * as plugin from "../lib/index.js";

/** A minimal cordis-context stand-in capturing the seam calls we make. */
function makeCtx() {
  const ctx = {
    registeredProviders: [],
    registeredTools: [],
    effectDisposers: [],
    get(name) {
      return this[name]; // no launchEnvironment slot → snapshot falls back to process.env
    },
    web: {
      registerSearchProvider(provider) {
        ctx.registeredProviders.push(provider);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        ctx.registeredTools.push(definition);
        return () => {};
      },
    },
    effect(execute, label) {
      const disposer = execute();
      ctx.effectDisposers.push({ label, disposer });
      return () => {};
    },
    logger: (name) => ({ info() {}, warn() {}, error() {} }),
  };
  return ctx;
}

test("exports the expected plugin shape", () => {
  assert.equal(plugin.name, "dsh-web-search-searxng-docker");
  assert.deepEqual(plugin.inject, ["web", "tools"]);
  assert.equal(typeof plugin.apply, "function");
  assert.ok(plugin.Config);
});

test("apply registers a searxng-docker provider and wires disposal", () => {
  const ctx = makeCtx();
  const provider = plugin.apply(ctx, {});

  assert.equal(ctx.registeredProviders.length, 1);
  assert.equal(provider.id, "searxng-docker");
  assert.equal(typeof provider.available(), "boolean");
  // One disposal effect registered for container teardown.
  assert.equal(ctx.effectDisposers.length, 1);
  assert.match(ctx.effectDisposers[0].label, /searxng-docker/);

  // Invoking the disposer must not throw (docker may be absent in CI).
  ctx.effectDisposers.forEach(({ disposer }) => void disposer());
});

test("apply registers the web_search_images tool", () => {
  const ctx = makeCtx();
  plugin.apply(ctx, {});

  assert.equal(ctx.registeredTools.length, 1);
  const tool = ctx.registeredTools[0];
  assert.equal(tool.name, "web_search_images");
  assert.match(tool.description, /images/i);
  assert.ok(typeof tool.execute === "function");
  assert.equal(tool.isConcurrencySafe({ queries: ["bunny"] }), true);

  // presentCall renders a generic search card titled by the queries.
  const call = tool.presentCall({ queries: ["a", "b"] });
  assert.equal(call.card, "generic");
  assert.equal(call.title, "a, b");
});

test("apply honors registerProvider/registerTool flags", () => {
  // Tool-only placement (e.g. inside an agent preset where the provider is
  // already registered at host level) must not double-register the provider.
  const toolOnly = makeCtx();
  assert.equal(plugin.apply(toolOnly, { registerProvider: false }), undefined);
  assert.equal(toolOnly.registeredProviders.length, 0);
  assert.equal(toolOnly.registeredTools.length, 1);

  // Provider-only placement keeps the old behavior.
  const providerOnly = makeCtx();
  const provider = plugin.apply(providerOnly, { registerTool: false });
  assert.equal(provider.id, "searxng-docker");
  assert.equal(providerOnly.registeredTools.length, 0);
});

test("resolveOptions prefers entry config over environment and defaults", () => {
  const ctx = makeCtx();
  process.env.SEARXNG_DOCKER_PORT = "9999";
  process.env.SEARXNG_LANGUAGE = "fr";
  try {
    // Config wins.
    assert.equal(plugin.resolveOptions(ctx, { port: 8123 }).port, 8123);
    // Environment fills gaps config leaves open.
    const fromEnv = plugin.resolveOptions(ctx, {});
    assert.equal(fromEnv.port, 9999);
    assert.equal(fromEnv.language, "fr");
    // Defaults fill the rest.
    assert.equal(fromEnv.image, "searxng/searxng");
    assert.equal(fromEnv.containerName, "dsh-searxng-docker");
    assert.equal(fromEnv.idleTimeoutMs, 60_000);
  } finally {
    delete process.env.SEARXNG_DOCKER_PORT;
    delete process.env.SEARXNG_LANGUAGE;
  }
});

test("resolveOptions coerces garbage env values back to defaults", () => {
  const ctx = makeCtx();
  process.env.SEARXNG_DOCKER_PORT = "not-a-number";
  try {
    assert.equal(plugin.resolveOptions(ctx, {}).port, 8091);
  } finally {
    delete process.env.SEARXNG_DOCKER_PORT;
  }
});

test("Config schema validates and defaults a full config", () => {
  const result = plugin.Config["~standard"].validate({});
  assert.equal(result.issues, undefined);
  assert.equal(result.value.port, 8091);
  assert.equal(result.value.image, "searxng/searxng");

  const bad = plugin.Config["~standard"].validate({ port: -3 });
  assert.ok(bad.issues?.length > 0);
});
