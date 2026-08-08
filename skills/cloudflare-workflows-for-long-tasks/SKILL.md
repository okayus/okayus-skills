---
name: cloudflare-workflows-for-long-tasks
description: Migrate a Cloudflare Worker post-response task off `ctx.waitUntil()` onto a `WorkflowEntrypoint` when the task can exceed the 30-second `waitUntil` wall-clock cap (Vision LLM inference, third-party API with slow tails, multi-step orchestration). Use when you see "waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled" in `wrangler tail`, or when DB rows get stuck in an in-progress state because the runtime killed the task before the catch block ran. Covers the exact `wrangler.jsonc` workflows binding, the `WorkflowEntrypoint` class export pattern alongside the default `fetch` handler, the `step.do()` retry / persist / serializable-output rules, the production cleanup runbook for rows orphaned in `running`/`pending` status, and the gotchas (the `Workflow<Params>` type is a global — via `wrangler types` or workers-types — not a `cloudflare:workers` import; bytes can't ride the wire between steps).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers (Free or Paid) with `wrangler@^4` (worker types via `wrangler types`, or the older `@cloudflare/workers-types@4.20240000+`), Hono / D1 / R2 stacks. Assumes you already have a deployed Worker that uses `ctx.waitUntil()` for a post-response task and have hit (or are about to hit) the 30s wall-clock limit. Workflows are available on Workers Free and Paid — no separate contract.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare Workflows for Long Tasks

Replace a `ctx.waitUntil(longJob())` call with a Cloudflare Workflow when the job can exceed 30 seconds. Workflows give durable execution (minutes / hours / weeks), per-step retry, and persistent state — so a half-completed job never silently disappears.

**Prerequisite**: a working Worker that already does `ctx.waitUntil(...)` for some post-response work, and you've either hit the 30s cap in production or are designing a job that obviously will (Vision LLM, large file processing, external API with slow tails).

## When to use

- A `ctx.waitUntil()` task is being **killed** mid-run with `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled`
- DB rows get stuck in `running` / `pending` because the kill is abrupt — your `try/catch` for marking them `failed` never runs
- A long task needs **automatic retry** (e.g., flaky third-party API), and you don't want to hand-roll exponential backoff inside a 30s budget
- A job has natural **steps** that you want to checkpoint individually (download → transform → upload → notify), so a partial failure doesn't redo finished steps
- You want a UI to **inspect** the in-flight job (Cloudflare Dashboard shows each step's status; `step.do()` outputs are durably persisted by the Workflows runtime)

Do **not** use for:
- Tasks that genuinely fit in 30 seconds — `ctx.waitUntil()` is simpler, no extra binding, no class export
- Fan-out / queue-style work — use **Cloudflare Queues** (a consumer invocation gets up to 15 min wall clock, 30s CPU by default / 5 min max — see [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)). Pick Queues for many small independent jobs, Workflows for one durable multi-step job with checkpoints
- Real-time streaming responses to a client — Workflows run **after** the response is sent; for streaming use SSE / WebSockets directly in the fetch handler

## The 30s ceiling — and why it's worse than you'd expect

`ctx.waitUntil()` extends the Worker lifetime up to **30 seconds total** ([docs](https://developers.cloudflare.com/workers/runtime-apis/context/)). Paid plan does not change this. When the budget runs out:

1. The runtime **cancels** any in-flight Promise. Your code does not get a `try/catch`-able rejection — it just stops mid-`await`.
2. Any DB row you flipped to `running` to record "I started" stays `running` **forever**, because the catch branch that would flip it to `failed` never runs.
3. `wrangler tail` shows a single warning line: `(warn) waitUntil() tasks did not complete within the allowed time...`. No stack, no step-level breakdown, no clue about whether the task was 1 second from finishing or hung from byte one.

**This silently turns operational bugs into data corruption** — every retry attempt creates another orphan, and you can't tell from the data whether the task is in flight or dead.

This is the migration trigger. If you're hitting it: fix forward to Workflows, don't just add a longer timeout (there is no longer timeout).

## The migration: waitUntil → Workflow

Three artefacts change. The domain logic does not.

```
Before                                After
──────                                ─────
fetch handler                         fetch handler
  └─ ctx.waitUntil(runJob(env, id))    └─ env.MY_WORKFLOW.create({ params: { id } })
                                         (returns immediately, durable from here)

worker/lib/job.ts                     worker/lib/job-workflow.ts (new file)
  export async function runJob(...) {   export class JobWorkflow
    update(running)                       extends WorkflowEntrypoint<Bindings, Params> {
    try {                                 async run(event, step) {
      doWork()                              await step.do("mark-running", ...)
      update(succeeded)                     try {
    } catch (e) {                             const x = await step.do(
      update(failed)                            "do-work",
    }                                           { retries: { limit: 2, ... }, timeout: "5 min" },
  }                                             async () => doWork()
                                              )
                                              await step.do("persist-result", ...)
                                            } catch (e) {
                                              await step.do("mark-failed", ...)
                                              throw e
                                            }
                                         }
                                       }
```

The "before" file gets **deleted**; its body becomes the body of three `step.do()` calls. The fetch-handler call site changes from `ctx.waitUntil(runJob(...))` to `env.MY_WORKFLOW.create({ params: ... })`.

Full step-by-step migration guide in [references/migration-pattern.md](references/migration-pattern.md), including the production cleanup SQL for rows you orphaned before the migration.

## Core deliverables

1. `worker/lib/<job>-workflow.ts` — the `WorkflowEntrypoint` class with `run(event, step)`. Steps split as: `mark-running` → real work (with retries config) → `persist-result`, plus `mark-failed` in the catch
2. `wrangler.jsonc` — `workflows[]` array entry mapping a binding name to a `class_name`
3. `worker/index.ts` — `export { JobWorkflow }` alongside `export default app` (Hono / fetch handler)
4. `worker/types.ts` — Bindings gets `MY_WORKFLOW: Workflow<JobParams>` (`Workflow` is a **global**, no import)
5. Fetch handler call site — replace `ctx.waitUntil(runJob(env, ...))` with `await env.MY_WORKFLOW.create({ params: ... })`
6. Old `runJob` file deleted
7. Cleanup SQL run against production: `UPDATE <table> SET status='failed', error_message='waitUntil timeout (30s); migrating to Workflows', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('running', 'pending')`

Full source for each file in [references/implementation.md](references/implementation.md).

## The `step.do()` rules you must internalise

A `step.do(name, [config], async () => ...)` block is **not** a normal `await`. The runtime treats it as a checkpoint:

1. **Idempotency.** A step may be re-executed on retry or replay. Don't write code that double-counts (e.g., `INSERT` without an `ON CONFLICT` clause, increment counters, send emails). Use upserts and idempotency keys.
2. **Serializable outputs only.** The return value of the callback is persisted as JSON. `ArrayBuffer`, `Uint8Array`, `Date`, `Map`, class instances → all fail or get mangled. If you fetch bytes (R2 object, image), **process them in the same step** that fetched them — don't pass bytes between steps. Pass the small structured result instead.
3. **Throwing triggers retry.** If the callback throws, the step is retried up to `config.retries.limit` with `config.retries.backoff`. Past the limit, the throw propagates out of the workflow's `run()` method. So your error path needs a top-level `try/catch` to mark the row `failed`, then re-throw so the Workflow run itself is also recorded as failed.
4. **`config.timeout` is per attempt.** A `timeout: "5 minutes"` with `retries.limit: 2` means up to 15 minutes total wall-clock. Set both deliberately.

The third pitfall — bytes between steps — has tripped projects that intuit "split fetch and analyse into separate steps". Don't. Combine I/O + analysis in one step, return only the small JSON result.

More worked examples in [references/pitfalls.md](references/pitfalls.md).

## The `Workflow<Params>` type is a global, not an import

```ts
// ❌ This fails: Module '"cloudflare:workers"' has no exported member 'Workflow'.
import type { Workflow } from "cloudflare:workers";

// ✅ Correct: Workflow is a global type — generated into worker-configuration.d.ts
//    by `wrangler types` (or declared by the older @cloudflare/workers-types package),
//    exactly like Ai / D1Database / R2Bucket / Fetcher. No import needed once the
//    tsconfig picks up the generated file (or the package).
type Bindings = {
  MY_WORKFLOW: Workflow<MyParams>;
};
```

`WorkflowEntrypoint` / `WorkflowEvent` / `WorkflowStep` **do** come from `cloudflare:workers` (those are runtime values), but the binding **type** does not. This bites once per project; expect it.

## Diagnosing the production scenario you're probably in

If you're reading this because rows are stuck and you don't know why, the symptom matrix:

| `status` column | `error_message` | What happened |
|---|---|---|
| `running`, `finished_at = NULL`, hours old | `NULL` | `ctx.waitUntil()` cancellation. The catch branch never ran. **Fix forward to Workflows.** |
| `running`, `finished_at = NULL`, < 5 min old | `NULL` | Either still in flight (wait) or just got killed (will stay forever). Check `wrangler tail` for a "did not complete within the allowed time" warning |
| `failed`, `error_message: "..."` | populated | Caught error path ran. Read the message, fix the underlying error |
| `succeeded`, no values | populated or NULL | Job ran but produced no output — check the analyzer / builder logic, not the runtime |

Once on Workflows, the equivalent stuck case becomes a row with `status='running'` whose Workflow has been visibly retrying or marked failed in the Cloudflare Dashboard — much easier to diagnose.

## Production cleanup runbook (one-time, before deploying the migration)

```sh
# 1. Snapshot before mutating
wrangler d1 export <db-name> --remote --output=backups/$(date -u +%Y%m%d)-pre-workflows-cleanup.sql

# 2. Mark all stuck rows failed (so they're retryable via your re-trigger endpoint after migration)
wrangler d1 execute <db-name> --remote --command "
  UPDATE <table>
  SET status='failed',
      error_message='waitUntil timeout (30s); migrating to Cloudflare Workflows',
      finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE status IN ('running', 'pending')
"

# 3. Confirm no remaining stragglers
wrangler d1 execute <db-name> --remote --command "
  SELECT status, COUNT(*) FROM <table> GROUP BY status
"
```

Keep the export file in `backups/` (gitignored) for at least one release cycle. Full runbook in [references/migration-pattern.md](references/migration-pattern.md).

## Scope boundary

This skill does **NOT** cover:

- **Workers AI input shapes / model selection** — Workflows give you durable execution and visibility into errors, but the analyzer logic itself is orthogonal. If you migrate to Workflows and the inner work still fails, fix it in the analyzer, not in the workflow plumbing
- **Cloudflare Queues** — different abstraction (batch consumer; 15 min wall clock per invocation, CPU 30s default / 5 min max). Use Queues when you have many small jobs that fan out, Workflows when you have one durable job per request
- **Workflow signal events / external triggers** — `step.waitForEvent` exists, but skeleton migration doesn't need it; cover it when you actually need approval / webhook gates
- **Local Workflow emulation** — `wrangler dev` emulates Workflows locally (v3.89+); what is *not* supported is `--remote` / remote bindings. This skill still assumes final verification against a deployed Worker — local dev can trigger `env.MY_WORKFLOW.create()` and run steps in the emulator, but production observability (Dashboard instances) only exists deployed
- **Hono `c.executionCtx` vs Workers raw `ctx`** — the migration replaces `c.executionCtx.waitUntil(...)` (or `ctx.waitUntil(...)`) with `c.env.MY_WORKFLOW.create(...)` either way; whichever framework you use, the call site change is the same

## References

- [migration-pattern.md](references/migration-pattern.md) — step-by-step migration walkthrough, before/after diff for a typical fetch handler, production cleanup SQL with `wrangler d1` commands, and the post-migration verification flow
- [implementation.md](references/implementation.md) — full source of a `WorkflowEntrypoint` class with the three-step pattern + try/catch failure step, the `wrangler.jsonc` `workflows[]` block, the `worker/index.ts` export shape, and the `Bindings` type addition
- [pitfalls.md](references/pitfalls.md) — six gotchas observed in real migrations: stuck-row corruption, `cloudflare:workers` vs global `Workflow` type, bytes between steps, idempotency in `step.do`, `timeout` × `retries` math, and where Workflow logs vs Worker fetch logs surface in `wrangler tail` / Dashboard
