import assert from "node:assert/strict";
import { test } from "node:test";
import { WebError } from "@deepseek-ai/dsh-web";
import { SearxngDockerRuntime, CONTAINER_PORT } from "../lib/docker.js";
import { fakeSpawn, fakeFetch, jsonResponse, domError } from "./helpers.js";

const OPTIONS = {
  image: "searxng/searxng",
  port: 8091,
  containerName: "dsh-searxng-docker-test",
  idleTimeoutMs: 60_000,
  startTimeoutMs: 300_000,
  readyTimeoutMs: 5_000,
};

/** A docker fake that models inspect/rm/run against a simple in-memory state. */
function dockerWorld({ healthyAfter = 1 } = {}) {
  const world = { running: false, removed: 0, runArgs: null };
  let healthChecks = 0;

  const spawnImpl = fakeSpawn((cmd, args) => {
    assert.equal(cmd, "docker");
    if (args[0] === "inspect") return world.running ? { stdout: "true\n" } : { code: 1, stderr: "no such container\n" };
    if (args[0] === "rm") {
      world.removed += 1;
      world.running = false;
      return {};
    }
    if (args[0] === "run") {
      world.runArgs = [...args];
      world.running = true;
      return { stdout: "abc123containerid\n" };
    }
    throw new Error(`unexpected docker args: ${args.join(" ")}`);
  });

  const fetchImpl = fakeFetch((url) => {
    assert.match(url, /\/healthz$/);
    healthChecks += 1;
    if (healthChecks < healthyAfter || !world.running) throw domError("AbortError");
    return jsonResponse({ ok: true }, 200);
  });

  return { world, spawnImpl, fetchImpl };
}

test("ensureRunning starts the container with expected flags and returns the base URL", async () => {
  const { world, spawnImpl, fetchImpl } = dockerWorld();
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });

  const url = await runtime.ensureRunning();

  assert.equal(url, "http://127.0.0.1:8091");
  assert.equal(runtime.state, "ready");
  assert.ok(world.runArgs);
  // -p must publish on loopback only and map host port → container port 8080.
  const pIndex = world.runArgs.indexOf("-p");
  assert.equal(world.runArgs[pIndex + 1], `127.0.0.1:8091:${CONTAINER_PORT}`);
  // The settings overlay must be mounted read-only at the official path.
  const vIndex = world.runArgs.indexOf("-v");
  assert.match(world.runArgs[vIndex + 1], /settings\.yml:\/etc\/searxng\/settings\.yml:ro$/);
  assert.equal(world.runArgs[world.runArgs.length - 1], OPTIONS.image);
});

test("ensureRunning reuses an already-running container without docker run", async () => {
  const { world, spawnImpl, fetchImpl } = dockerWorld();
  world.running = true; // pre-existing container
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });

  await runtime.ensureRunning();

  assert.equal(world.runArgs, null);
  assert.equal(runtime.state, "ready");
});

test("concurrent ensureRunning calls share one start", async () => {
  const { world, spawnImpl, fetchImpl } = dockerWorld({ healthyAfter: 3 });
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });

  const [a, b] = await Promise.all([runtime.ensureRunning(), runtime.ensureRunning()]);

  assert.equal(a, "http://127.0.0.1:8091");
  assert.equal(b, a);
  // Exactly one `docker run` despite two callers.
  const runs = spawnImpl.calls.filter((call) => call.args[0] === "run");
  assert.equal(runs.length, 1);
});

test("stop removes the container and is idempotent", async () => {
  const { world, spawnImpl, fetchImpl } = dockerWorld();
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });
  await runtime.ensureRunning();
  const removedAfterStart = world.removed; // the fresh-start path may have recycled a stale container

  await runtime.stop();
  assert.equal(world.removed, removedAfterStart + 1);
  assert.equal(runtime.state, "idle");

  await runtime.stop(); // second stop: still one rm per call, no throw
  assert.equal(world.removed, removedAfterStart + 2);
});

test("scheduleIdleStop recycles the container after the idle window", async (t) => {
  const options = { ...OPTIONS, idleTimeoutMs: 30 };
  const { world, spawnImpl, fetchImpl } = dockerWorld();
  const runtime = new SearxngDockerRuntime(() => options, { spawnImpl, fetchImpl });
  await runtime.ensureRunning();

  runtime.scheduleIdleStop();
  t.after(async () => {
    // Give the timer a beat to fire (it is unref'd; keep the test alive explicitly).
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(world.running, false);
  });
});

test("scheduleIdleStop with idleTimeoutMs=0 keeps the container alive", async () => {
  const options = { ...OPTIONS, idleTimeoutMs: 0 };
  const { world, spawnImpl, fetchImpl } = dockerWorld();
  const runtime = new SearxngDockerRuntime(() => options, { spawnImpl, fetchImpl });
  await runtime.ensureRunning();

  runtime.scheduleIdleStop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(world.running, true);
});

test("readiness timeout recycles the container and throws WEB_PROVIDER_ERROR", async () => {
  const options = { ...OPTIONS, readyTimeoutMs: 250 };
  // healthz never answers.
  const { world, spawnImpl } = dockerWorld({ healthyAfter: Infinity });
  const fetchImpl = fakeFetch(() => {
    throw domError("AbortError");
  });
  const runtime = new SearxngDockerRuntime(() => options, { spawnImpl, fetchImpl });

  await assert.rejects(
    () => runtime.ensureRunning(),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR" && /did not become ready/.test(error.message),
  );
  // The half-started container was recycled.
  assert.equal(world.running, false);
});

test("docker CLI missing on PATH yields an actionable WEB_PROVIDER_ERROR", async () => {
  const spawnImpl = fakeSpawn(() => ({ error: Object.assign(new Error(`spawn docker ENOENT`), { code: "ENOENT" }) }));
  const fetchImpl = fakeFetch(() => jsonResponse({}, 200));
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });

  await assert.rejects(
    () => runtime.ensureRunning(),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_ERROR" && /Docker Desktop/.test(error.message),
  );
});

test("an aborted signal rejects early with WEB_ABORTED", async () => {
  const { spawnImpl, fetchImpl } = dockerWorld({ healthyAfter: Infinity });
  const runtime = new SearxngDockerRuntime(() => OPTIONS, { spawnImpl, fetchImpl });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runtime.ensureRunning(controller.signal),
    (error) => error instanceof WebError && error.code === "WEB_ABORTED",
  );
});
