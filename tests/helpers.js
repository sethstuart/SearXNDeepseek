/**
 * Shared fakes for unit tests: a child_process.spawn stand-in and a fetch stand-in.
 */
import { EventEmitter } from "node:events";

/**
 * Build a fake `spawn` whose behavior is driven by `impl(cmd, args)`.
 *
 * `impl` may return `{ code?, stdout?, stderr? }`, or throw / return
 * `{ error: Error }` to simulate spawn failure (e.g. ENOENT).
 * @param impl - per-call handler.
 * @returns a drop-in replacement for child_process.spawn.
 */
export function fakeSpawn(impl) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd: String(cmd), args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => {
      killed = true;
    };
    queueMicrotask(() => {
      let result;
      try {
        result = impl(cmd, args);
      } catch (error) {
        process.nextTick(() => child.emit("error", error));
        return;
      }
      if (result?.error) {
        process.nextTick(() => child.emit("error", result.error));
        return;
      }
      process.nextTick(() => {
        if (killed) {
          child.emit("close", 1);
          return;
        }
        const stdout = result?.stdout ?? "";
        const stderr = result?.stderr ?? "";
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", result?.code ?? 0);
      });
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Build a fake `fetch` driven by `handler(url, options)`.
 * @param handler - returns a Response-like object or throws.
 * @returns a drop-in replacement for global fetch.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = (url, options) => {
    calls.push({ url: String(url), options });
    return handler(url, options);
  };
  fn.calls = calls;
  return fn;
}

/** A minimal Response-like object for fake fetch handlers. */
export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A DOMException with the given name (e.g. "AbortError", "TimeoutError"). */
export function domError(name) {
  return new DOMException(`signal ${name.toLowerCase()}ed`, name);
}
