/**
 * DeepSeek Harness web search provider backed by an ephemeral SearXNG Docker
 * container — no API keys required.
 * @module @deepseek-ai/dsh-web-search-searxng-docker
 */
import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type { SearxngDockerSearchProvider } from "./provider.js";

/** Plugin name shown in diagnostics. */
export declare const name: "dsh-web-search-searxng-docker";

/** Services this plugin requires before `apply` runs. */
export declare const inject: readonly ["web"];

/** Resolved runtime options (config → environment → defaults). */
export interface SearxngDockerResolvedOptions {
  image: string;
  port: number;
  containerName: string;
  maxResults: number;
  language: string;
  idleTimeoutMs: number;
  startTimeoutMs: number;
  readyTimeoutMs: number;
  searchTimeoutMs: number;
  providerId: string;
}

/** Plugin configuration schema (all fields optional at the entry level). */
export declare const Config: z.ZodObject<{
  image: z.ZodDefault<z.ZodString>;
  port: z.ZodDefault<z.ZodNumber>;
  containerName: z.ZodDefault<z.ZodString>;
  maxResults: z.ZodDefault<z.ZodNumber>;
  language: z.ZodDefault<z.ZodString>;
  idleTimeoutMs: z.ZodDefault<z.ZodNumber>;
  startTimeoutMs: z.ZodDefault<z.ZodNumber>;
  readyTimeoutMs: z.ZodDefault<z.ZodNumber>;
  searchTimeoutMs: z.ZodDefault<z.ZodNumber>;
  providerId: z.ZodDefault<z.ZodString>;
}>;

/** Resolve effective options from entry config, environment, and defaults. */
export declare function resolveOptions(ctx: Context, config?: Record<string, unknown>): SearxngDockerResolvedOptions;

/** Plugin entry point: registers the provider and wires disposal cleanup. */
export declare function apply(ctx: Context, config?: Record<string, unknown>): SearxngDockerSearchProvider;
