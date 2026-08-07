# Migration: `ctx.waitUntil` → Cloudflare Workflows

This is the exact step-by-step that took a production worker from "post-response task gets killed at 30s and corrupts DB" to "durable execution with per-step retry".

## Symptom that triggers the migration

In `wrangler tail`:

```
POST /api/.../attachments - Ok @ ...
  (warn) waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.
```

In D1:

```sql
SELECT id, status, started_at, finished_at, error_message
FROM <table>
WHERE status = 'running' AND finished_at IS NULL;
-- → returns rows that are hours old, error_message NULL
```

That second query is the operational red flag. The `try/catch` you wrote to mark rows `failed` never executed because the runtime cancelled the Promise mid-`await`.

## Step 1 — Stop the bleeding (cleanup)

Before deploying the migration, mark stuck rows so they're not eternally "in flight". The fastest path is a SQL update against production. Take a snapshot first:

```sh
# Snapshot
wrangler d1 export <db-name> --remote \
  --output=backups/$(date -u +%Y%m%d)-pre-workflows-cleanup.sql

# Mark stuck rows failed with an unambiguous message
wrangler d1 execute <db-name> --remote --command "
  UPDATE <table>
  SET status='failed',
      error_message='waitUntil timeout (30s); migrating to Cloudflare Workflows',
      finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE status IN ('running', 'pending')
"

# Verify no stragglers
wrangler d1 execute <db-name> --remote --command "
  SELECT status, COUNT(*) FROM <table> GROUP BY status
"
```

Why `'pending'` is included: a fresh row created at `POST /attachments` time (status='pending') that the cancellation killed *before* `mark-running` ran is also stuck. You want both terminal states to be `failed` so the post-migration "re-trigger" endpoint is the only path back into running.

The `'waitUntil timeout (30s); migrating to ...'` message is intentionally specific — when you grep `error_message` later, you can tell which failures were the migration-era cleanup vs new failures.

## Step 2 — Add the Workflow class

Create `worker/lib/<job>-workflow.ts`. The class **extends** `WorkflowEntrypoint<Bindings, Params>`. Three steps + a top-level `try/catch` that runs a `mark-failed` step before re-throwing:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { jobsTable } from "../db/schema";
import type { Bindings } from "../types";

export type JobParams = { jobId: string; inputKey: string };

export class JobWorkflow extends WorkflowEntrypoint<Bindings, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const { jobId, inputKey } = event.payload;
    const db = drizzle(this.env.DB);

    await step.do("mark-running", async () => {
      const startedAt = new Date().toISOString();
      await db.update(jobsTable)
        .set({ status: "running", startedAt, updatedAt: startedAt, errorMessage: null })
        .where(eq(jobsTable.id, jobId));
    });

    try {
      const result = await step.do(
        "do-work",
        {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
          timeout: "5 minutes",
        },
        async () => {
          // I/O + heavy work in ONE step. Don't split fetch and process —
          // the bytes can't ride between steps (not JSON-serializable).
          const obj = await this.env.BUCKET.get(inputKey);
          if (!obj) throw new Error(`missing in R2: ${inputKey}`);
          const buf = await obj.arrayBuffer();
          const r = await runHeavyTask(this.env, buf);
          if (r.isErr()) throw new Error(formatError(r.error));
          return r.value; // small JSON, persisted by the runtime
        },
      );

      await step.do("persist-result", async () => {
        const finishedAt = new Date().toISOString();
        // delete-then-insert if you want full overwrite; or upsert.
        // Either way: must be idempotent (step may re-run on replay).
        await db.update(jobsTable)
          .set({ status: "succeeded", result: JSON.stringify(result), finishedAt, updatedAt: finishedAt, errorMessage: null })
          .where(eq(jobsTable.id, jobId));
      });
    } catch (e) {
      await step.do("mark-failed", async () => {
        const finishedAt = new Date().toISOString();
        await db.update(jobsTable)
          .set({
            status: "failed",
            errorMessage: e instanceof Error ? e.message : String(e),
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(jobsTable.id, jobId));
      });
      throw e; // workflow itself is also marked failed in the Dashboard
    }
  }
}
```

Notes:
- `Bindings` is your `worker/types.ts` type; the `Workflow<Params>` field for this very workflow is part of it (chicken-and-egg is fine — TS is structural)
- The retries on `do-work` give you 3 total attempts (1 + 2 retries). With 5-minute per-attempt timeout = 15 min worst case before the catch fires
- Re-throwing in the outer catch is intentional: the Dashboard records the workflow run as failed, which is more visible than "the run finished but the DB row says failed"

## Step 3 — Bind the workflow

`wrangler.jsonc`:

```jsonc
{
  // ... existing config ...
  "workflows": [
    {
      "name": "<job-name>",
      "binding": "JOB_WORKFLOW",
      "class_name": "JobWorkflow"
    }
  ]
}
```

`name` is the global Cloudflare-side identifier (per account). `binding` is the env var name (`env.JOB_WORKFLOW`). `class_name` must match the exported class.

## Step 4 — Export the class from the Worker entry

`worker/index.ts`:

```ts
import { Hono } from "hono";
// ... routes ...
const app = new Hono<Env>();
// ... app setup ...

export default app;

// Workflows class export — sits next to the default export.
// class_name in wrangler.jsonc must match.
export { JobWorkflow } from "./lib/job-workflow";
```

The runtime looks up the class by name on the Worker module's exports.

## Step 5 — Type the binding

`worker/types.ts`:

```ts
// NO IMPORT for Workflow — it's a global from @cloudflare/workers-types
import type { JobParams } from "./lib/job-workflow";

export type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JOB_WORKFLOW: Workflow<JobParams>;
  // ...
};
```

If you `import type { Workflow } from "cloudflare:workers"` you get:

```
Module '"cloudflare:workers"' has no exported member 'Workflow'.
```

Hour-of-confusion territory. The class entry / event / step types come from `cloudflare:workers`; the binding type is global.

## Step 6 — Replace the call site

Wherever you had:

```ts
c.executionCtx.waitUntil(runJob(c.env, jobId, inputKey));
```

becomes:

```ts
await c.env.JOB_WORKFLOW.create({
  params: { jobId, inputKey },
});
```

`create()` returns immediately with an instance handle. The fetch handler's `Response` goes out, then the workflow continues independently — same UX as `waitUntil`, durable underneath.

## Step 7 — Delete the old file

`worker/lib/job.ts` (the `runJob` function file) → delete. Its body is now distributed across the three `step.do()` calls in the workflow.

## Step 8 — Local verify, then deploy

```sh
pnpm vp check                 # format + lint
pnpm exec tsc -p tsconfig.worker.json   # typecheck — the Workflow generic flows through here
pnpm vp build
# unit tests (vitest) for any pure code reused unchanged
pnpm test
```

CI green → merge → `deploy.yml` (or your equivalent) registers the workflow class with Cloudflare on first deploy.

**On first deploy with a new workflow binding, deploy can take ~30s longer than usual.** That's expected (Cloudflare provisions the workflow service). Subsequent deploys are normal speed.

## Step 9 — Verify in production

Trigger the path that calls `env.JOB_WORKFLOW.create(...)`. Then in three places:

1. **D1**: `SELECT status, started_at, finished_at, error_message FROM <table> ORDER BY created_at DESC LIMIT 5` — watch `pending` → `running` → `succeeded` (or `failed` with a meaningful message)
2. **`wrangler tail`**: the Worker fetch handler logs are here. Note: **per-step Workflow logs do NOT appear in `wrangler tail`** — they're separate. The fetch handler logs you'll see are the `POST /...` line and any `console.log` you added. Step-level diagnostics live in:
3. **Cloudflare Dashboard → Workers & Pages → your worker → Workflows tab**: each instance shows the step-by-step state, retries, and the persisted output of each step. This is where you debug "the workflow exists but a specific step is failing"

If the row sits at `status='running'` for longer than `(timeout × (retries.limit + 1))`, something is wrong — probably the `do-work` step itself isn't completing. The Dashboard is your single best diagnostic tool here.

## Step 10 — Re-run the cleanup-marked failures (optional)

If the cleanup in Step 1 marked legitimate retryable jobs as `failed`, you may want to re-trigger them. Either:

- Add a UI / endpoint that calls `POST /<resource>/analyze` (or whatever your re-trigger pattern is) per failed row
- Or query D1 for cleanup-flagged rows and re-create workflows for each:

```sh
wrangler d1 execute <db-name> --remote --command "
  SELECT id FROM <table>
  WHERE error_message LIKE 'waitUntil timeout (30s)%'
"
# then call the re-trigger endpoint for each id
```

Keep this script local; once run, delete it. Don't commit "one-time migration tools" to the repo unless you reasonably expect to run them again.

## Anti-patterns to avoid during migration

- **"Just bump the timeout."** There is no longer timeout. `ctx.waitUntil` is hard-capped at 30s.
- **"Retry on the client side."** The post-response task started, the client doesn't know its status, retrying triggers a duplicate row and exacerbates the corruption. Fix the runtime path.
- **"Add a heartbeat from the task that the watchdog kills if stale."** Building durable execution from `ctx.waitUntil` primitives is a bad direction. Workflows is the durable execution primitive.
- **"Move to a queue first."** Queues solve fan-out, not durability. A consumer invocation's 15-minute wall clock may well cover your task, but you get no per-step checkpointing, no per-step retry, and a failure restarts the work from zero — the original stuck-row problem just moves. Workflows is the durable-execution primitive.
