# Pitfalls

Six things that cost real time on a real migration, in rough order of how soon you'll trip on them.

## 1. Stuck-row corruption is the canary, but you have to know to look

The user-visible symptom of `ctx.waitUntil` cancellation is **nothing** — the request returned 2xx, the client moved on, the worker logs say `Ok`. Only `wrangler tail` mentions it, and only with a single line:

```
(warn) waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.
```

If you don't `tail` you don't see this. Your DB rows quietly accumulate `status='running'` with `finished_at=NULL`. Hours later when you finally query, you can't tell whether the job is in flight or dead.

**Lesson**: when you write `ctx.waitUntil(longJob())`, immediately add a query you can run later:

```sql
SELECT COUNT(*) FROM <table>
WHERE status = 'running'
  AND finished_at IS NULL
  AND started_at < datetime('now', '-10 minutes');
```

Anything > 0 is operational corruption. Wire it into a monitor or a periodic check **before** you discover it the hard way. (Or just migrate to Workflows preemptively if the inner work could exceed 30s.)

## 2. `Workflow<Params>` is a global, not a `cloudflare:workers` import

The error message is misleading:

```
worker/types.ts(1,15): error TS2305: Module '"cloudflare:workers"' has no exported member 'Workflow'.
```

The natural reaction is "the runtime is missing the export, maybe I need a newer `@cloudflare/workers-types`". It's not — `Workflow<Params>` is declared as a global in `@cloudflare/workers-types`, the same way `Ai` / `D1Database` / `R2Bucket` / `Fetcher` are. **Don't import it.** Reference it directly:

```ts
// ✗ Wrong
import type { Workflow } from "cloudflare:workers";

// ✓ Right
type Bindings = {
  MY_WORKFLOW: Workflow<MyParams>;
};
```

The runtime classes / events / steps **do** come from `cloudflare:workers`:

```ts
// ✓ These are runtime imports, correct
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
```

The split is "binding type = global, runtime values = `cloudflare:workers` module".

## 3. Bytes can't ride between steps

Tempting structure:

```ts
const buffer = await step.do("fetch-image", async () => {
  const obj = await this.env.BUCKET.get(key);
  return await obj!.arrayBuffer(); // ← will not survive the step boundary
});

const result = await step.do("analyse", async () => {
  return await analyse(buffer); // ← buffer here is wrong
});
```

The runtime persists step outputs as JSON. `ArrayBuffer` and `Uint8Array` either fail the serialize or get mangled. By the time `analyse` runs, `buffer` is not what you fetched.

Workarounds people try (and shouldn't):
- Convert to `Array.from(new Uint8Array(...))` so it's plain `number[]`. Works for *tiny* payloads but a 2 MB image becomes a 16 MB JSON array — slow to serialize, expensive to persist, and the next step has to undo it.
- Re-fetch from R2 in the second step. Doubles the I/O cost; race condition if the object is deleted between steps.

**Right answer**: combine I/O and processing in **one step**. The step's output is the small structured result (parsed values, extracted fields, etc.):

```ts
const result = await step.do("fetch-and-analyse", { /* retries, timeout */ }, async () => {
  const obj = await this.env.BUCKET.get(key);
  if (!obj) throw new Error("missing");
  const buffer = await obj.arrayBuffer();
  const r = await analyse(buffer);
  return r; // small JSON-serializable object
});
```

You lose nothing — retries on this combined step still re-fetch from R2 and re-run analysis, which is what you want.

## 4. Idempotency in `step.do` is non-optional

A step can re-execute on retry or replay. If the body has external side effects, you'll observe them multiple times.

Cases that bite:
- `INSERT INTO ...` (duplicate rows on retry) — use upsert / `INSERT ... ON CONFLICT` / `delete-then-insert` patterns
- Counter increments (`UPDATE ... SET count = count + 1`) — use absolute writes from a known input
- Sending email / Discord / Slack notifications — wrap the side-effecting call with a deduplication check or accept that retries may double-send
- File writes to R2 with `put` — same key is fine (idempotent overwrite), but unique-suffixed keys per attempt leak storage

The DB pattern that works for "persist N rows from a parent analysis":

```ts
await step.do("persist-values", async () => {
  // 1. delete prior children for this parent (idempotent — same outcome each replay)
  await db.delete(values).where(eq(values.parentId, parentId));
  // 2. insert from the persisted result of the previous step
  if (result.items.length > 0) {
    await db.insert(values).values(result.items.map(/* ... */));
  }
  // 3. flip parent state (idempotent — same status each replay)
  await db.update(parents)
    .set({ status: "succeeded", finishedAt: now })
    .where(eq(parents.id, parentId));
});
```

This step can re-run any number of times with the same outcome.

## 5. `timeout × retries` math is tractable but easy to get wrong

```ts
await step.do(
  "do-work",
  {
    retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
    timeout: "5 minutes",
  },
  ...
);
```

What this means:
- **First attempt** runs with a 5-minute timeout
- If it throws, wait 10s (exponential backoff is on subsequent retries)
- **Second attempt** runs with a 5-minute timeout. If throws, wait ~20s
- **Third attempt** runs with a 5-minute timeout. If throws, propagates to outer catch
- Total worst case: 15 min compute + ~30s backoff = **~15.5 min before mark-failed**

If you want a tighter SLO, lower `timeout`. If you want fewer retries (faster failure), lower `limit`. There's no "total budget" knob — it's per-attempt × attempts.

For interactive flows where the user is waiting on a poll loop, prefer:
- `timeout: "60 seconds"`
- `retries: { limit: 1, delay: "5 seconds" }`

For background batch jobs:
- `timeout: "10 minutes"`
- `retries: { limit: 3, backoff: "exponential" }`

Pick deliberately based on how long the user will tolerate `status='running'` in the UI.

## 6. Workflow logs do NOT appear in `wrangler tail`

`wrangler tail` shows the **fetch handler** logs. Per-step Workflow execution is a separate component, with its own log surface:

| Log type | Where it appears |
|---|---|
| `console.log` from a `fetch` handler | `wrangler tail` |
| Errors thrown from a `fetch` handler | `wrangler tail` (as `(error)` lines) |
| `console.log` from inside `step.do(...)` | **Not in `wrangler tail`**. Cloudflare Dashboard → your Worker → Workflows tab → instance detail |
| Step retries / failures | Dashboard, per instance |
| Workflow status (running / errored / complete) | Dashboard + your own DB row, if you wrote one |

When debugging a hung workflow:

1. **D1 first** — `SELECT status, error_message FROM <table> WHERE id = ?`. If `status='failed'`, error_message tells you what threw.
2. **Dashboard second** — Workflows tab shows step-by-step execution. If a step is stuck, this is where you see "still running attempt 2 of 3, started 8 minutes ago".
3. **`wrangler tail` for the fetch entry** — confirms the workflow was kicked off (the `POST` line) but won't show step internals.

The mistake to avoid: spending 10 minutes staring at `wrangler tail` waiting for step logs that will never appear there.

---

## Bonus: the AI binding gotcha that motivates this whole skill

If you're using Workers AI with a vision model, `env.AI.run(...)` calls can take 30-120+ seconds. The exact input shape for `@cf/google/gemma-3-12b-it` (and similar vision models) is **not fully documented** as of this writing — LLaVA-style (`prompt` + `image: number[]`) and OpenAI-compat messages format both exist in the wild.

If you call it from `ctx.waitUntil`:
- Wrong input shape → call hangs (no error returned), 30s cancellation, stuck row
- Right input shape but slow → 30s cancellation anyway, stuck row

Migrating to Workflows doesn't fix the input shape problem, but it **converts silent corruption into visible failure**: step retries surface the throw, the catch runs, the row gets `error_message='...'` you can read. Then you fix the shape. Then everything works.

This is the canonical reason to reach for this skill, but the pattern applies to any post-response work that exceeds 30s — long Stripe / Slack / external API tails, large file processing, multi-step orchestration.
