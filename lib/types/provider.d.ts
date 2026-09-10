/**
 * SearXNG-Docker web search provider and result mapping.
 * @module @deepseek-ai/dsh-web-search-searxng-docker/provider
 */
import type { WebSearchProvider, WebSearchResult } from "@deepseek-ai/dsh-web";
import type { SearxngDockerRuntime } from "./docker.js";

/** One entry of the SearXNG `results` array (subset we consume). */
export interface SearxngResultItem {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
}

/** Map one SearXNG result to a harness source, or null when unusable. */
export declare function mapSearxngResult(item: unknown): WebSearchResult["sources"][number] | null;

/** Map a full SearXNG JSON response (dedupe by URL, drop malformed entries). */
export declare function mapSearxngResponse(body: { results?: unknown[] } | null | undefined): WebSearchResult;

/** Test seams for {@link SearxngDockerSearchProvider}. */
export interface SearxngDockerProviderHooks {
  fetchImpl?: typeof fetch;
  /** Register under a different web-seam provider id (e.g. take over an existing slot). */
  id?: string;
}

/** Search provider that runs SearXNG in a local Docker container. */
export declare class SearxngDockerSearchProvider implements WebSearchProvider {
  static readonly defaultId: "searxng-docker";
  readonly id: string;
  constructor(
    runtime: SearxngDockerRuntime,
    resolveOptions: () => Record<string, unknown>,
    hooks?: SearxngDockerProviderHooks,
  );
  available(): boolean;
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResult>;
}
