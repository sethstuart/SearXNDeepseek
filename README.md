# @deepseek-ai/dsh-web-search-searxng-docker

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web search provider that runs
[SearXNG](https://github.com/searxng/searxng) in an **ephemeral local Docker container** — no API keys, no
search-provider accounts, nothing to configure beyond having Docker.

It exposes two model-facing capabilities over the same container:

- `web_search` (via the harness web seam) — text search results from SearXNG's default categories, and
- `web_search_images` (a first-class tool) — image search via SearXNG's images category, with top matches also
  saved as local files a model can present to the user.

When a model calls the harness `web_search` tool, this plugin:

1. lazily starts (or reuses) a named SearXNG container bound to loopback only,
2. queries its JSON API (`/search?format=json`) — enabled via a mounted settings overlay that also disables
   SearXNG's rate limiter for the ephemeral instance,
3. maps results into the harness source shape and returns them,
4. stops the container again after an idle window (default 60 s) or when the harness process exits.

The first search may take a while if the `searxng/searxng` image has not been pulled yet; subsequent searches in
the same idle window hit the warm container directly.

## Requirements

- Docker with a running daemon (Docker Desktop on Windows/macOS, or any compatible engine). The plugin shells out
  to the `docker` CLI — it must be on `PATH`.
- Node.js ≥ 20 (for `AbortSignal.any` / `AbortSignal.timeout`).

## Install into a profile

From this directory:

```powershell
dsh plugin --profile web add .
```

That installs the package into the profile's `node_modules`, appends it to the profile's bundle layer stack, and —
because this package declares a `dsh.bundle.patch` — activates its patch on the next boot (or immediately under
live-reload profiles). The patch does two things:

- sets `web.searchProvider: searxng-docker`, overriding the default provider, and
- mounts the plugin row exactly once.

To remove it later: `dsh plugin --profile web remove @deepseek-ai/dsh-web-search-searxng-docker`.

> **Note:** a profile's composed tree must contain the plugin row exactly once — the loader throws on duplicate
> entry ids. Installing via `dsh plugin add` keeps that invariant for you; do not also hand-add an insert row with
> id `web-search-searxng-docker`.

## Configuration

Every option can be set in the profile patch (entry config) or via environment variables; entry config wins, then
the environment, then defaults.

| Option            | Env var                              | Default             | Meaning                                                        |
| ----------------- | ------------------------------------ | ------------------- | -------------------------------------------------------------- |
| `image`           | `SEARXNG_DOCKER_IMAGE`               | `searxng/searxng`   | Docker image to run                                            |
| `port`            | `SEARXNG_DOCKER_PORT`                | `8091`              | Loopback port the container is published on                    |
| `containerName`   | `SEARXNG_DOCKER_NAME`                | `dsh-searxng-docker`| Container name (reused/recycled by this plugin)                |
| `maxResults`      | `SEARXNG_MAX_RESULTS`                | `10`                | Provider-layer result cap (the seam enforces its own bound too)|
| `language`        | `SEARXNG_LANGUAGE`                   | `all`               | SearXNG language code                                          |
| `idleTimeoutMs`   | `SEARXNG_DOCKER_IDLE_MS`             | `60000`             | Idle window before the container stops; `0` = keep alive       |
| `startTimeoutMs`  | `SEARXNG_DOCKER_START_TIMEOUT_MS`    | `300000`            | Deadline for `docker run` (covers a first-time image pull)     |
| `readyTimeoutMs`  | `SEARXNG_DOCKER_READY_TIMEOUT_MS`    | `90000`             | Deadline for `/healthz` after container creation               |
| `searchTimeoutMs` | `SEARXNG_DOCKER_SEARCH_TIMEOUT_MS`   | `60000`             | Per-search HTTP deadline                                       |
| `providerId`      | `SEARXNG_DOCKER_PROVIDER_ID`         | `searxng-docker`    | Web-seam registry id; override to take over another provider slot (e.g. `deepseek-official`) |
| `imageMaxResults` | `SEARXNG_DOCKER_IMAGE_MAX_RESULTS`   | `8`                 | Cap on image results per `web_search_images` call (1–32)     |
| `downloadImages`  | `SEARXNG_DOCKER_DOWNLOAD_IMAGES`     | `true`              | Whether `web_search_images` also saves top results locally (best-effort) |
| `imageToolTimeoutMs` | `SEARXNG_DOCKER_IMAGE_TOOL_TIMEOUT_MS` | `120000`         | Cooperative budget for the image tool call (search + downloads) |
| `registerProvider`| —                                    | `true`              | Register the web-seam search provider (`false` in compositions where a sibling entry already does) |
| `registerTool`    | —                                    | `true`              | Register the `web_search_images` tool                        |

> **Taking over an existing slot.** The web seam resolves a *configured* provider id at call time, and the
> running service samples that config once at construction — so in a profile where another search provider is
> already configured (the shipped web profile pins `searchProvider: deepseek-official`), registering under your own
> id alone will not be selected. The supported pattern is to disable the other provider's row and register under its
> id, e.g.:
>
> ```yaml
> - id: web-search-deepseek
>   disabled: true
>
> - insert:
>     - id: web-search-searxng-docker
>       name: '/abs/path/to/dsh-web-search-searxng-docker/lib/index.js' # a file, not the package directory
>       config:
>         providerId: deepseek-official
> ```

Example patch row (e.g. in a profile's `cordis.patch.yml` or an overlay):

```yaml
- id: web-search-searxng-docker
  config:
    port: 8123
    idleTimeoutMs: 0   # keep the container alive for the whole session
```

## Behavior details

- **Loopback only.** The container is published as `127.0.0.1:<port>:8080`; it is not reachable from other hosts.
- **Settings overlay.** A generated `settings.yml` (fresh random `secret_key`) is mounted read-only at
  `/etc/searxng/settings.yml`:

  ```yaml
  use_default_settings: true
  server:
    secret_key: "<random>"
    limiter: false        # ephemeral local instance — no rate limiting
  search:
    formats: [html, json] # JSON API is off by default in the official image
  ```

- **Lifecycle.** `ensureRunning` is single-flight (concurrent searches share one start), adopts a container that is
  already running under the configured name, and recycles containers that come up but never answer `/healthz`.
  The idle timer is unref'd so it never holds the harness process open; on fiber disposal the plugin stops the
  container explicitly.
- **Errors.** Failures surface as `WebError`s with machine-routable codes: `WEB_PROVIDER_ERROR` (docker missing,
  daemon down, image pull failure, readiness timeout, HTTP errors) and `WEB_ABORTED` (caller cancellation). A stopped
  Docker daemon does not make the provider "unavailable" — it fails on first search with an actionable message and
  recovers automatically once Docker is up.

## The `web_search_images` tool

The plugin also registers a model-facing image-search tool over SearXNG's images category:

- **Queries.** One call accepts 1–4 queries; results are merged round-robin (rank-interleaved) and de-duplicated by
  URL, capped at `imageMaxResults`.
- **Local copies.** When `downloadImages` is enabled (default), the top results are fetched with a browser user-agent
  plus the source page as `Referer`, validated (`content-type: image/*`, at least ~1 KB — ≥64 B for SVGs — and at most
  25 MiB) and written under the OS temp dir as `dsh-searxng-docker-<port>/images/` (e.g. `%TEMP%\dsh-searxng-docker-8091\images\img3_hasans-meat-pic.jpg` on Windows). Downloads are best-effort — a failed
  download never fails the search, it just leaves that entry without a local path. The tool's output tells the model
  which files exist so it can `present` them to the user.
- **Presentation.** In the Web GUI the call renders as a web-search card: inline image previews (markdown), the full
  result list with dimensions and source pages, and any saved local copies.

## Development

```powershell
npm install     # local dev dependencies (peer packages for tests)
npm test        # node --test unit suite (docker/fetch are faked; no daemon needed)
```

An end-to-end check against a real daemon:

```powershell
dsh --profile headless "Use web_search to look up the latest SearXNG release notes"
docker ps   # container should be gone after the idle window
```

## Community

This project is listed in the [DSH plugin category](https://github.com/deepseek-ai/deepseek-harness/discussions/2004)
(unofficial, community-maintained). A ready-to-paste post — title and body following that discussion's rules — lives at
[`docs/plugin-category-post.md`](./docs/plugin-category-post.md), with the screenshot source in
[`docs/screenshot-demo.html`](./docs/screenshot-demo.html).

## License

MIT — see [LICENSE](./LICENSE).
