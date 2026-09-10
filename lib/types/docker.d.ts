/**
 * Ephemeral SearXNG container lifecycle.
 * @module @deepseek-ai/dsh-web-search-searxng-docker/docker
 */
import type { WebError } from "@deepseek-ai/dsh-web";

/** Port SearXNG listens on inside the official `searxng/searxng` image. */
export declare const CONTAINER_PORT: 8080;

/** Throw if the signal is already aborted (throws a `WEB_ABORTED` WebError). */
export declare function throwIfAborted(signal?: AbortSignal): void;

/** Await `promise`, rejecting early with `WEB_ABORTED` when `signal` fires. */
export declare function withAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T>;

/** Lifecycle state of the managed container. */
export type SearxngDockerState = "idle" | "starting" | "ready";

/** Runtime options consumed by {@link SearxngDockerRuntime}. */
export interface SearxngDockerOptions {
  image: string;
  port: number;
  containerName: string;
  idleTimeoutMs: number;
  startTimeoutMs: number;
  readyTimeoutMs: number;
}

/** Test seams for {@link SearxngDockerRuntime}. */
export interface SearxngDockerHooks {
  log?: (message: string) => void;
  spawnImpl?: typeof import("node:child_process").spawn;
  fetchImpl?: typeof fetch;
}

/** One ephemeral SearXNG container, managed by name. */
export declare class SearxngDockerRuntime {
  constructor(resolveOptions: () => SearxngDockerOptions, hooks?: SearxngDockerHooks);
  /** Current lifecycle state. */
  readonly state: SearxngDockerState;
  /** Base URL of the local instance (loopback only). */
  readonly baseUrl: string;
  /** Ensure the container is running and healthy; returns its base URL. */
  ensureRunning(signal?: AbortSignal): Promise<string>;
  /** Stop the container (idempotent) and clear any idle-stop timer. */
  stop(): Promise<void>;
  /** (Re)arm the idle-stop timer after a search. */
  scheduleIdleStop(): void;
}
