# Implementation reference

Drop-in source for the four files that change in the migration. Substitute your domain names (`Job` → your job, `JOB_WORKFLOW` → your binding, `jobsTable` → your table).

## `worker/lib/<job>-workflow.ts` (new)

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { jobsTable } from "../db/schema";
import type { Bindings } from "../types";

export type JobParams = {
  jobId: string;
  // Whatever you need to pass into run(); must be JSON-serializable.
  inputKey: string;
};

// Long-running blood-test analysis (or whatever the job is). Splits into:
//   1. mark-running       — DB-only, idempotent
//   2. do-work            — I/O + heavy task in ONE step (bytes can't cross steps)
//   3. persist-result     — DB-only, idempotent
//   On any throw inside the try, the catch runs `mark-failed` (DB-only) then
//   re-throws so the Workflow Dashboard records the run as failed.
export class JobWorkflow extends WorkflowEntrypoint<Bindings, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const { jobId, inputKey } = event.payload;
    const db = drizzle(this.env.DB);

    await step.do("mark-running", async () => {
      const startedAt = new Date().toISOString();
      await db
        .update(jobsTable)
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
          const obj = await this.env.BUCKET.get(inputKey);
          if (obj === null) {
            throw new Error(`object missing in R2: ${inputKey}`);
          }
          const buffer = await obj.arrayBuffer();

          // Heavy work — Vision LLM call, image processing, etc.
          const r = await runHeavyWork(this.env, buffer);
          if (r.isErr()) {
            // Throwing causes step retry (limit-bound). Past the limit it
            // propagates to the outer catch.
            throw new Error(formatError(r.error));
          }

          // The return value is persisted as JSON. Keep it small and
          // serializable — no ArrayBuffer, no Uint8Array, no Date instances,
          // no class instances. Plain objects, primitives, arrays only.
          return {
            items: r.value.items,
            modelName: r.value.modelName,
            rawResponseExcerpt: r.value.raw.slice(0, 500),
          };
        },
      );

      await step.do("persist-result", async () => {
        const finishedAt = new Date().toISOString();
        // Idempotent: this step may replay. Use upsert / delete-then-insert /
        // INSERT ... ON CONFLICT, never bare INSERT.
        await db
          .update(jobsTable)
          .set({
            status: "succeeded",
            result: JSON.stringify(result),
            modelName: result.modelName,
            finishedAt,
            updatedAt: finishedAt,
            errorMessage: null,
          })
          .where(eq(jobsTable.id, jobId));
      });
    } catch (e) {
      await step.do("mark-failed", async () => {
        const finishedAt = new Date().toISOString();
        await db
          .update(jobsTable)
          .set({
            status: "failed",
            errorMessage: e instanceof Error ? e.message : String(e),
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(jobsTable.id, jobId));
      });
      throw e; // also mark the Workflow run itself as failed
    }
  }
}
```

## `wrangler.jsonc` addition

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "your-worker",
  "main": "./worker/index.ts",
  // ... existing fields (compatibility_date, vars, ai, d1_databases, r2_buckets, etc) ...

  "workflows": [
    {
      "name": "job-workflow",
      "binding": "JOB_WORKFLOW",
      "class_name": "JobWorkflow"
    }
  ]
}
```

- `name`: account-wide identifier of the Workflow class. Pick something unique per project.
- `binding`: the env-var name (`env.JOB_WORKFLOW.create(...)`).
- `class_name`: must match the exported symbol exactly.

## `worker/index.ts` (changed)

```ts
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { someRoutes } from "./routes/some";
import type { Env } from "./types";

const app = new Hono<Env>();
app.use("*", secureHeaders({ /* ... */ }));
// ... wire routes ...

export type AppType = typeof app;
export default app;

// Workflows: re-export the class alongside the default app.
// `class_name` in wrangler.jsonc → "JobWorkflow"; the runtime resolves it
// against this module's exports.
export { JobWorkflow } from "./lib/job-workflow";
```

## `worker/types.ts` (changed)

```ts
import type { JobParams } from "./lib/job-workflow";

// Workflow / Ai / D1Database / R2Bucket / Fetcher / etc are GLOBALS declared
// by @cloudflare/workers-types. Do NOT `import { Workflow } from "cloudflare:workers"`
// — that fails with "Module 'cloudflare:workers' has no exported member 'Workflow'".
//
// Your tsconfig.worker.json should already have:
//   "types": ["@cloudflare/workers-types"]
// which makes the globals visible.
export type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  JOB_WORKFLOW: Workflow<JobParams>;
  // ... other bindings, vars, secrets ...
};

export type Variables = {
  userId: string;
  // ...
};

export type Env = { Bindings: Bindings; Variables: Variables };
```

## Fetch handler call site

Hono example:

```ts
// Before:
// c.executionCtx.waitUntil(runJob(c.env, jobId, inputKey));

// After:
await c.env.JOB_WORKFLOW.create({
  params: { jobId, inputKey },
});
```

Plain Workers example:

```ts
// Before:
// ctx.waitUntil(runJob(env, jobId, inputKey));

// After:
await env.JOB_WORKFLOW.create({
  params: { jobId, inputKey },
});
```

`create()` returns an instance handle (`{ id }`). For most cases you don't need the id — you persisted `jobId` in your own row, the workflow updates that row, and the user polls / observes via your own API.

If you do want to surface progress to the client, pass the workflow instance id back and expose a `GET /jobs/:id` endpoint that joins your row with `env.JOB_WORKFLOW.get(instanceId).status()` — the workflow runtime exposes its own progress state too.

## Optional: a `tsconfig.worker.json` reminder

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ESNext", "WebWorker"],
    "types": ["./worker-configuration.d.ts"], // ← generated by `wrangler types`; Workflow / Ai / D1Database visible here
    "noEmit": true
  },
  "include": ["worker"]
}
```

The `types` line is what makes `Workflow<Params>` resolve as a global without an import — via the `wrangler types`-generated `worker-configuration.d.ts` (current official recommendation; re-run after binding changes), or the older `@cloudflare/workers-types` package. If neither is wired, you'll get the misleading "no exported member 'Workflow'" error on the binding line and try to fix it with an import that doesn't work.

## File deletions

- `worker/lib/<job>.ts` — the file with the old `runJob` function. Delete entirely. Its body is now distributed across the three `step.do()` calls in the workflow class.

If `runJob` was tested by unit tests that mocked I/O, those tests **don't carry over** — the workflow's I/O paths are integration territory now. Pure helper functions (formatters, parsers, validators) stay in their own files and keep their unit tests.
