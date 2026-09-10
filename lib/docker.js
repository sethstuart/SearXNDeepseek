/**
 * Ephemeral SearXNG container lifecycle for DeepSeek Harness web search.
 *
 * The runtime owns one named Docker container that serves the SearXNG JSON API:
 * - `ensureRunning(signal)` — single-flight start (or reuse) of the container,
 *   polling `/healthz` until it answers; safe to call concurrently and on every
 *   search.
 * - `scheduleIdleStop()` — arms a timer that stops the container after the last
 *   search goes quiet (disabled with `idleTimeoutMs: 0`).
 * - `stop()` — idempotent teardown (`docker rm -f`), also used when the owning
 *   plugin fiber is disposed.
 *
 * No API keys are involved anywhere: SearXNG aggregates public metasearch
 * engines, and this instance runs locally with its rate limiter disabled.
 * @module @deepseek-ai/dsh-web-search-searxng-docker/docker
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebError } from "@deepseek-ai/dsh-web";

/** Port SearXNG listens on inside the official `searxng/searxng` image. */
export const CONTAINER_PORT = 8080;

/** How long a single docker CLI call may run before it is killed (ms). */
const DOCKER_CALL_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for the container to become healthy (ms). */
const HEALTH_POLL_INTERVAL_MS = 500;

/** Per-attempt timeout for one `/healthz` probe (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * Trim a docker CLI output blob to its tail for error messages.
 * @param text - the raw stdout/stderr text.
 * @param length - maximum characters to keep.
 * @returns the trimmed, single-line tail of `text`.
 */
function tail(text, length) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `…${clean.slice(clean.length - length)}` : clean;
}

/**
 * Build the abort error thrown when a caller's signal fires.
 * @returns a `WEB_ABORTED` web error.
 */
function abortError() {
  return new WebError("search aborted before SearXNG was ready", "WEB_ABORTED");
}

/**
 * Throw if the signal is already aborted.
 * @param signal - optional caller cancellation signal.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Await `promise` but reject early with a `WEB_ABORTED` error when `signal`
 * fires; the underlying work keeps running to completion in the background.
 * @param promise - the in-flight work.
 * @param signal - optional caller cancellation signal.
 * @returns a promise settling like `promise`, or rejecting on abort.
 */
export function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One ephemeral SearXNG container, managed by name.
 *
 * `resolveOptions` is a thunk so configuration may change between searches
 * (live settings reload) without rebuilding the runtime; every docker call
 * reads fresh options at use time.
 */
export class SearxngDockerRuntime {
  #state = "idle"; // idle | starting | ready
  #startPromise = null;
  #stopTimer = null;

  /**
   * @param resolveOptions - thunk returning the current runtime options (image, port, containerName, timeouts).
   * @param hooks - optional test seams: `log`, `spawnImpl` (child_process.spawn), `fetchImpl` (global fetch).
   */
  constructor(resolveOptions, hooks = {}) {
    this.resolveOptions = resolveOptions;
    this.log = hooks.log ?? (() => {});
    this.spawnImpl = hooks.spawnImpl ?? spawn;
    this.fetchImpl = hooks.fetchImpl ?? fetch;
  }

  /** Current lifecycle state: `idle`, `starting`, or `ready`. */
  get state() {
    return this.#state;
  }

  /** Base URL of the local SearXNG instance (bound to loopback only). */
  get baseUrl() {
    const options = this.resolveOptions();
    return `http://127.0.0.1:${options.port}`;
  }

  /**
   * Ensure the container is running and healthy, returning its base URL.
   *
   * Concurrent calls share one in-flight start. A previously started container
   * that is still answering `/healthz` is reused without any docker call.
   * @param signal - optional caller cancellation signal (early exit only; an in-flight start keeps running).
   * @returns the base URL, e.g. `http://127.0.0.1:8091`.
   */
  async ensureRunning(signal) {
    throwIfAborted(signal);
    const options = this.resolveOptions();
    if (this.#state === "ready" && (await this.#healthy(options))) return this.baseUrl;

    if (!this.#startPromise) {
      this.#startPromise = this.#start(options).finally(() => {
        this.#startPromise = null;
      });
    }
    const url = await withAbort(this.#startPromise, signal);
    throwIfAborted(signal);
    return url;
  }

  /**
   * Stop the container (idempotent) and clear any pending idle-stop timer.
   * A missing or already-removed container is not an error.
   */
  async stop() {
    if (this.#stopTimer !== null) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    const options = this.resolveOptions();
    this.#state = "idle";
    try {
      await this.#docker(["rm", "-f", options.containerName], DOCKER_CALL_TIMEOUT_MS);
      this.log(`stopped container ${options.containerName}`);
    } catch (error) {
      // `docker rm -f` on a missing container is the expected no-op path.
      if (!(error instanceof WebError && /exited with code 1/.test(error.message))) {
        this.log(`stop: docker rm failed: ${error?.message ?? error}`);
      }
    }
  }

  /**
   * (Re)arm the idle-stop timer after a search. With `idleTimeoutMs` of zero
   * the container stays alive until explicit stop or process exit.
   */
  scheduleIdleStop() {
    if (this.#stopTimer !== null) clearTimeout(this.#stopTimer);
    const options = this.resolveOptions();
    if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return;
    this.#stopTimer = setTimeout(() => {
      this.#stopTimer = null;
      void this.stop().catch((error) => this.log(`idle stop failed: ${error?.message ?? error}`));
    }, options.idleTimeoutMs);
    // Never hold the process open just for the idle timer.
    this.#stopTimer.unref?.();
  }

  /**
   * One `/healthz` probe against the local instance.
   * @param options - current runtime options (for the port).
   * @returns true when the endpoint answers HTTP 200.
   */
  async #healthy(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, { signal: controller.signal });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Poll `/healthz` until the instance answers or the readiness deadline passes.
   * @param options - current runtime options (for readyTimeoutMs).
   * @returns once healthy.
   */
  async #waitForReady(options) {
    const deadline = Date.now() + options.readyTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (await this.#healthy(options)) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new WebError(
      `SearXNG container did not become ready within ${options.readyTimeoutMs}ms`,
      "WEB_PROVIDER_ERROR",
      { cause: lastError },
    );
  }

  /**
   * Start (or adopt) the named container and wait for readiness.
   * @param options - current runtime options.
   * @returns the base URL once healthy.
   */
  async #start(options) {
    this.#state = "starting";
    const name = options.containerName;

    // Adopt a container that is already running (e.g. started by another harness process).
    let running = false;
    try {
      const { stdout } = await this.#docker(["inspect", "--format", "{{.State.Running}}", name], DOCKER_CALL_TIMEOUT_MS);
      running = stdout.trim() === "true";
    } catch {
      // Container does not exist (or docker failed) — fall through to a fresh start.
    }

    if (running) {
      this.log(`container ${name} already running; waiting for readiness`);
      try {
        await this.#waitForReady(options);
      } catch (error) {
        // A pre-existing container that never becomes healthy is ours to recycle.
        await this.stop();
        throw error;
      }
      this.#state = "ready";
      return this.baseUrl;
    }

    try {
      await this.#docker(["rm", "-f", name], DOCKER_CALL_TIMEOUT_MS);
    } catch {
      // Missing container — nothing to remove.
    }

    const settingsPath = this.#writeSettings(options);
    this.log(`starting container ${name} from image ${options.image}`);
    try {
      await this.#docker(
        [
          "run", "-d",
          "--name", name,
          "--restart", "no",
          "-p", `127.0.0.1:${options.port}:${CONTAINER_PORT}`,
          "-v", `${settingsPath}:/etc/searxng/settings.yml:ro`,
          options.image,
        ],
        // The first run may pull the image; allow a long deadline for that.
        options.startTimeoutMs,
      );
    } catch (error) {
      this.#state = "idle";
      throw error instanceof WebError ? error : new WebError(
        `failed to start SearXNG container: ${error?.message ?? error}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }

    try {
      await this.#waitForReady(options);
    } catch (error) {
      // Recycle a container that came up but never served.
      await this.stop();
      throw error;
    }

    this.#state = "ready";
    return this.baseUrl;
  }

  /**
   * Write the SearXNG settings overlay enabling the JSON API and disabling the
   * rate limiter (an ephemeral, loopback-only instance needs neither).
   * @param options - current runtime options.
   * @returns absolute path of the mounted `settings.yml`.
   */
  #writeSettings(options) {
    const dir = join(tmpdir(), `dsh-searxng-docker-${options.port}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.yml");
    writeFileSync(
      path,
      [
        "use_default_settings: true",
        "server:",
        `  secret_key: "${randomBytes(32).toString("hex")}"`,
        "  limiter: false",
        "search:",
        "  formats:",
        "    - html",
        "    - json",
        "",
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  /**
   * Run one docker CLI command, collecting output.
   * @param args - docker arguments (e.g. `["run", "-d", ...]`).
   * @param timeoutMs - kill deadline for the call.
   * @returns stdout/stderr on exit code zero.
   */
  #docker(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl("docker", args);
      } catch (error) {
        reject(new WebError(`failed to launch docker CLI: ${error?.message ?? error}`, "WEB_PROVIDER_ERROR", { cause: error }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        const hint = error.code === "ENOENT"
          ? " — docker CLI not found on PATH; install Docker and start Docker Desktop"
          : "";
        reject(new WebError(`failed to run docker ${args[0]}${hint}: ${error.message}`, "WEB_PROVIDER_ERROR", { cause: error }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = tail(stderr || stdout, 400);
        reject(new WebError(
          timedOut
            ? `docker ${args[0]} timed out after ${timeoutMs}ms`
            : `docker ${args[0]} exited with code ${code}${detail ? `: ${detail}` : ""}`,
          "WEB_PROVIDER_ERROR",
        ));
      });
    });
  }
}
