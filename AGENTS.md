# AGENTS.md — Strappy

Context for AI agents working on this repo. Read this first to avoid
re-deriving setup. (`AGENTS.md` is the agent-native doc for the
AltivecIntelligence toolchain; it is symlinked as `CLAUDE.md` / `GEMINI.md`
inside the image.)

## What this project is

A Node.js + TypeScript web server that watches GitHub repos for new issues,
new same-repo pull requests, and whitelisted replies on same-repo PRs, then
runs **ISO 9001-inspired job process maps** (steps with explicit, typed inputs
and outputs) backed by an LLM. Three processes exist today: **process-issue**
(implement a whitelisted user's new issue, open a PR, review it — **one-shot**:
it fires only when the issue is created; success closes the issue, failure
posts the report and closes it as not planned, and comments on an issue never
re-trigger anything),
**process-pull-request** (review a whitelisted user's PR once, when it opens —
only when its head branch lives in the same repo, never a fork — and post the
verdict as a PR comment), and **process-pull-request-comment** (when a
whitelisted user REPLIES on any same-repo PR — whoever authored it, Strappy's
own `strappy/…` PRs included — security-screen the thread, implement the
feedback on the PR's head branch, push, and reply with what changed). A reply
always means "change the code": the review job fires only at PR creation, the
reply job owns every later whitelisted comment. Each job declares its full
firing contract as a typed **`TriggerSpec`** (subject, activation, conditions,
failure policy, seeded inputs — the `*Trigger()` builders in
`src/jobs/process*Job.ts`); the poller derives its watchers from the spec
(`watcherFor`), `validateTriggerPartition` proves the two PR triggers'
activations partition the shared per-PR ledger row, and the dashboard renders
the conditions on each process map's trigger card.

LLM access goes through **[pi.dev](https://pi.dev)** (the `@earendil-works/pi-*`
packages, used as an **SDK / library — not the CLI**) talking to
**[OpenRouter](https://openrouter.ai)**, so we can run models from multiple
providers behind one OpenAI-compatible endpoint.

> Status: web server + dashboard + LLM seam + SQLite persistence + GitHub issue
> poller + scheduler + tests are implemented. Live OpenRouter/GitHub mutation
> verification still needs real credentials.

## Environment / where things live

- Repo root (host-mounted): **`/repo/strappy-git`** — git origin
  `git@github.com:jeffreybergier/Strappy-git.git`.
- Runs inside the `ghcr.io/jeffreybergier/altivec-intelligence:latest` container
  (macOS host runs Docker Desktop). Node v22, npm 11.
- The repo is bind-mounted into the container at `/repo/strappy-git`
  (`.:/repo/strappy-git`). **Files written there persist on the Mac host.**
- ⚠️ **Past gotcha (fixed):** `compose.yml` `working_dir` was once set to a
  path that didn't match the bind-mount, so it had no host backing — files
  written there vanished. Always keep `working_dir` == the bind-mount target
  (`/repo/strappy-git`).

## Commands

Local (inside the container shell):

| Command | What it does |
|---|---|
| `npm run dev` | Hot-reloading dev server (`tsx watch`) on `0.0.0.0:3000` |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the compiled server (`node dist/server.js`) |
| `npm run typecheck` | `tsc --noEmit` (strict; also checks `*.test.ts`) |
| `npm test` | Node built-in test runner: `node --import tsx --test "src/**/*.test.ts"` |

From the host, in the repo root:

| Command | What it does |
|---|---|
| `./bin/strappy` | Read sensitive values from 1Password and start the dashboard on port 3000 |
| `docker compose run --rm test` | Run the test suite once; exits with the test result code |
| `docker compose run --rm altivec-intelligence` | Interactive AI CLI chooser |
| `docker compose run --rm shell "<cmd>"` | One-off command in the toolchain shell |

`compose.yml` services: `altivec-intelligence`, `shell`, `test`, plus the
profiled `altivec-sdk` helper. The authenticated server deliberately runs
through `bin/strappy`, not Compose.

## How OpenRouter + pi.dev is wired

- `config/models.json` declares an `openrouter` provider — an OpenAI-compatible
  endpoint (`api: "openai-completions"`, `baseUrl:
  "https://openrouter.ai/api/v1"`, `apiKey: "$OPENROUTER_API_KEY"`) and a list
  of selected models. Pi resolves `$OPENROUTER_API_KEY` from the environment.
- `src/llm/pi.ts` is the **single LLM seam**: `runStructured(...)` returns the
  model's submit-tool values plus a full `LlmExecution`; LLM-backed step kinds
  call this through `src/jobs/llmKind.ts` / `src/jobs/securityKind.ts`.
  - `AuthStorage.create()` resolves credentials; `ModelRegistry.create(auth,
    config.modelsPath)` loads built-in + custom models from the **repo-local**
    `config/models.json`; `modelRegistry.find(provider, id)` resolves the model.
  - Session: `createAgentSession({ model, tools: [], authStorage,
    modelRegistry, sessionManager: SessionManager.inMemory() })`, then
    `session.subscribe(event => …)` (accumulate `event.assistantMessageEvent.delta`
    when `event.type === "message_update"` and
    `event.assistantMessageEvent.type === "text_delta"`; finish on
    `event.type === "agent_end"`) and `session.prompt(text)`.
- Default, review, and security models are selected in `config/runtime.json`.
  Add model declarations in `config/models.json`
  (any [OpenRouter model id](https://openrouter.ai/models)).
- ⚠️ **Not yet verified end-to-end:** the LLM seam typechecks against the real
  Pi SDK types but no live OpenRouter call has been made (needs a key). Verify
  this once `OPENROUTER_API_KEY` is available.

## How persistence (SQLite) is wired

- Jobs, process steps, typed inputs/outputs, and runs persist to a **local
  SQLite file** via Node's **built-in `node:sqlite`** (`DatabaseSync`) — no npm
  dependency, no native build. It's synchronous, so the store stays synchronous.
- File path: `config.dbPath`, loaded from `storage.dbPath` in
  `config/runtime.json` (currently **`data/strappy.sqlite`**)
  (resolved from `process.cwd()`). The whole **`data/` dir is gitignored** along
  with `*.sqlite`/`-wal`/`-shm` — runtime data is never checked in. `data/` is
  created on demand; the DB is **seeded from `seed.ts` only when empty**
  (idempotent), so deleting the file just regenerates the sample jobs.
- Schema lives in `src/jobs/schema.ts` (one `CREATE TABLE IF NOT EXISTS` block):
  `jobs → process_steps → step_io` (inputs + outputs in one table keyed by a
  `direction` column) and `job_runs → step_runs`. Ordered relations carry an
  explicit `position` column so `ORDER BY` round-trips step/IO order. Composite
  FKs cascade; `PRAGMA foreign_keys = ON` + WAL are set on open.
- `src/jobs/db.ts` is the **data-access seam**: `openDatabase()`,
  `seedDatabase()`, hydrating reads (`readJobs/readJob/readRuns`) and inserts.
  Row coercion is strict — it throws on unexpected column shapes/statuses.
- `src/jobs/sqliteStore.ts` (`SqliteJobStore`) implements the shared
  `JobReadStore` interface (same read surface as the in-memory `JobStore`, so
  routes accept either) and adds `saveJob()` / `recordRun()` write methods — the
  persistence seam the scheduler calls to record real `JobRun`s.

## Configuration

`config/runtime.json` holds all committed, non-sensitive preferences and is
strictly validated at startup. `bin/strappy` reads only these named 1Password
fields and passes them to Docker without creating an environment file:

- `GITHUB_TOKEN`
- `OPENROUTER_API_KEY`
- `STRAPPY_USER_WHITELIST`
- `STRAPPY_GIT_NAME`
- `STRAPPY_GIT_EMAIL`

The GitHub token, whitelist, and commit identity are captured and removed from
`process.env` at startup. Pi must re-resolve the OpenRouter key for API calls,
so the LLM bash tool explicitly removes all five fields from child
environments. An absent or empty whitelist remains fail-closed. Booting with
real 1Password values starts the live poller and may claim real issues or PRs;
tests do not use the launcher.

## Project structure

```
config/runtime.json    committed non-sensitive runtime preferences
config/models.json     OpenRouter provider + model declarations (pi.dev format)
bin/strappy            authenticated 1Password + Docker server launcher
compose.yml            Docker services: altivec-intelligence, shell, test, SDK helper
prompts/               static step system prompts: implement-issue, code-review,
                       review-pull-request, update-pull-request, security-check,
                       personality; guidance.json holds every per-field model
                       guidance string, one section per step prompt
src/
  config.ts            strict env loading (throws on missing/invalid)
  logger.ts            namespaced logger -> [Scope.method]
  server.ts            Express bootstrap; wires store + TriggerPoller watchers
  github/
    client.ts          Octokit wrapper (issues, PRs, comments, branch rules)
    git.ts             shallow clone/branch/checkout/commit/push (token redacted)
    poller.ts          TriggerPoller: watchers derived from each job's
                       TriggerSpec (watcherFor; branch conditions compile to
                       feed filters) over
                       one ledger + sequential queue; issueSource /
                       pullRequestSource / pullRequestReplySource
    recovery.ts        boot-time crash recovery: marks runs abandoned by a dead
                       server "interrupted", stamps the ledger, reports on the
                       thread (claim kept — retry is the explicit re-run path)
  jobs/
    types.ts           ISO 9001 types: Job, TriggerSpec (subject/activation/
                       conditions/failure policy), ProcessStep, StepIO, JobRun, StepRun
    processIssueJob.ts        the process-issue job graph + issue trigger contract
    processPullRequestJob.ts  the process-pull-request job graph + PR trigger contract
    processPullRequestCommentJob.ts  the reply-triggered branch-update job graph
    failureHandler.ts  shared failure-comment contract (numberKey: issue vs PR)
    trigger.ts         TriggerSpec helpers: validate (shape / watched-job policy /
                       partition), describe (dashboard), serialize/parse (SQLite)
    seed.ts            job registry (all three processes) + empty seed runs
    scheduler.ts       runJob: two-scope value threading, run recording
    stepKinds.ts       StepKindRegistry + stubs for every kind
    githubKinds.ts     live registry: git/GitHub/LLM-backed step executors
    llmKind.ts         llm step kind (Pi runStructured + derived outputs)
    securityKind.ts    security.scan step kind (prompt-injection gate)
    validateJobGraph.ts / validateJobRegistry.ts  static contract checks
    store.ts           in-memory JobStore + JobReadStore/TriggerLedger/TriggerAdmin
                       interfaces (TriggerAdmin: run->ledger lookup + claim release)
    schema.ts          SQLite DDL (jobs, process_steps, step_io, *_runs)
    db.ts              node:sqlite data-access: open/seed/sync/read/insert
    sqliteStore.ts     SqliteJobStore (JobReadStore + saveJob/recordRun + ledger)
  routes/
    dashboard.ts       GET /  (server-rendered EJS)
    api.ts             GET /api/jobs|/api/jobs/:id|/api/runs (JSON);
                       POST /api/runs/retry?id=<runId> releases a failed/
                       interrupted run's trigger claim (reopening a closed
                       issue) so the poller re-runs it next tick
  llm/
    pi.ts              pi.dev + OpenRouter integration (runStructured) — the LLM seam
views/dashboard.ejs    Bootstrap 3 (CDN) dashboard rendering the process maps
```
(`*.test.ts` siblings cover each module; tests use Node's built-in runner.)

## The ISO 9001 process-map model

A `Job` is a process of ordered `ProcessStep`s. Every step declares typed
`inputs` and `outputs` (`StepIO[]`), so one step's output contract feeds the
next step's input — the foundation for a traceable scheduler. A `JobRun` (with
per-step `StepRun`s) records an execution. The scheduler threads step outputs
into later inputs and persists live/final run state through `SqliteJobStore`.

## Conventions this codebase follows

- TypeScript **ESM + `NodeNext`** module resolution → relative imports use `.js`
  extensions in `.ts` source (e.g. `import { config } from "./config.js"`).
  This is required, not a typo.
- **Strict TS** (`strict`, `noUncheckedIndexedAccess`). Functions validate args
  and **throw on invalid input or missing dependencies** (strict init).
- Functions stay **short**; avoid nesting deeper than 2 levels; **minimal
  comments**; **2-space** indentation.
- **Namespaced logging** via `createLogger(scope)` → `[Scope.method] message`.
- Wrap async / complex logic in `try/catch`.
- Path resolution uses `process.cwd()` (views, `config/models.json`), so the app
  **must be run from the repo root** (the compose `working_dir`).
- Tests use Node's built-in runner (`node:test` + `node:assert/strict`), no
  extra test deps; run through the `tsx` loader. Node 22's `--test` glob +
  loader propagation to child processes is what makes `*.test.ts` run.

## Verified working

- `npm install` clean; `npm run typecheck` clean (incl. `*.test.ts`).
- `npm test` → 319 passing.
- The poller's PR listing (`listOpenPullRequests`) verified live read-only
  against the real repos (returned 0 open PRs; nothing mutated).
- Dashboard boots, binds `0.0.0.0:3000`, `GET /` returns 200, renders the
  seeded process maps **served from SQLite**; `GET /api/jobs` / `/api/runs`
  return JSON hydrated from `data/strappy.sqlite` (auto-created + seeded; the
  file is gitignored — `git check-ignore` confirms).
- The dashboard container is launched by `bin/strappy`; Compose remains for
  interactive tooling and tests.
- **Lifecycle verified live** (2026-06-11, throwaway `/tmp` DB): SIGTERM drains
  (in-flight job keeps running up to `server.shutdownTimeoutMs`), a second SIGTERM
  exits immediately; a run abandoned mid-LLM-call was marked "interrupted" with
  its ledger row stamped on the next boot (comment skipped — booted tokenless).
- `POST /api/runs/retry` answers 400/404/409 correctly over HTTP; the
  release-claim + reopen-issue flow is covered by unit tests with a fake client.

## Next steps / open items

1. **Live-verify** the LLM seam against OpenRouter once a key is set.
2. Optional tidy-up: `*.test.ts` under `src/` get emitted to `dist/` on build
   (inert, gitignored). Add a `tsconfig.build.json` that excludes tests if a
   clean `dist/` is wanted.

## House rules

- Do **not** commit or push unless explicitly asked.
- Prefer debug builds; only do release builds when asked.
- Keep changes small and incremental (Kaizen).
