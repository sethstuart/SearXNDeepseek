# Ready-to-paste post for the DSH plugin category (discussion #2004)

Rules followed: one project · real DSH integration · title format `DSH | Project Name | One-line description` ·
project URL + intro + screenshots + integration details · clearly labeled unofficial.

Paste everything below the line into a new discussion in
[deepseek-ai/deepseek-harness → Discussions → Plugin Category](https://github.com/deepseek-ai/deepseek-harness/discussions/2004).

---

**Title:** `DSH | dsh-web-search-searxng-docker | Keyless web & image search via an ephemeral SearXNG Docker container`

> Unofficial project, independently developed and maintained by community members.
> 非官方项目，由社区成员独立开发和维护。

**Project URL:** https://github.com/sethstuart/SearXNDeepseek

**Introduction:**

A DeepSeek Harness plugin that gives models web search with **no API keys and no provider accounts**. It runs
[SearXNG](https://github.com/searxng/searxng) — a privacy-focused metasearch engine — in an ephemeral local Docker
container bound to loopback only. The container starts lazily on the first search, is reused while active, and stops
itself after a 60-second idle window (or when the harness process exits). All you need installed is Docker.

It ships two model-facing capabilities over that one container:

- **`web_search`** — plugs into the harness web seam as a `WebSearchProvider`, so the built-in search tool works
  keyless out of the box;
- **`web_search_images`** — a first-class tool over SearXNG's images category (1–4 queries per call, rank-interleaved
  results), which also saves top matches as local files a model can `present` to the user.

Everything is configurable via profile patch or environment variables (image, port, idle window, timeouts, result
caps…), and the whole thing is MIT-licensed with a hermetic unit suite (47 tests, no daemon needed).

**How it integrates with DSH:**

- Cordis plugin (`apply(ctx, config)`) injected into profiles via `dsh plugin --profile web add .` or a hand-written
  patch row; hot-reloadable under live-reload profiles.
- Registers a `WebSearchProvider` on the harness **web seam** (can take over an existing provider slot, e.g.
  `deepseek-official`, so no profile reconfiguration is needed).
- Registers the `web_search_images` tool through the standard **tools registry**, with GUI presentation meta — it
  renders as a web-search card with inline image previews and local-copy paths in the Web GUI.
- Container lifecycle is fiber-scoped: single-flight start, adoption of already-running containers, health-gated
  readiness, unref'd idle timer (never holds the process open), explicit stop on disposal.

**Screenshots:**

`web_search_images` result card as rendered for a model call ("cute bunny rabbit") — inline preview, ranked results,
and best-effort local copies:

![web_search_images result card](https://raw.githubusercontent.com/sethstuart/SearXNDeepseek/main/docs/screenshot-web-search-images.png)
