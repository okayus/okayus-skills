# Testing: vitest setup and test files

vitest config + ten tests (6 time + 4 discord) covering the pure builders and the fetch-mocked boundary.

## `packages/web/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts"],
  },
});
```

### Why `vitest.config.ts` separate from `vite.config.ts`

Vitest can reuse `vite.config.ts` by default, but:

- `vite.config.ts` includes `@cloudflare/vite-plugin`, which spins up workerd/Wrangler-adjacent scaffolding in dev
- That scaffolding interferes with the test runtime (tries to bind ports, read `.dev.vars`, etc.)
- Keeping a separate `vitest.config.ts` opts out of those side effects

Trust signal: your tests run fast and don't emit "Cloudflare binding setup…" log noise at test startup.

### Why `environment: "node"` (not `"jsdom"`)

- The code under test is Worker code (Node-compatible runtime)
- `globalThis.fetch` is available in Node 22+ (required by this project's `engines`)
- `"jsdom"` shoves `window`/`document` globals in, which is irrelevant and makes fetch-mocking awkward

### Why `include: ["worker/**/*.test.ts"]`

Tests live alongside implementation (`worker/time.test.ts` next to `worker/time.ts`). `include` scopes vitest to the Worker code and skips `src/**` (React code) — no tests there yet in skeleton.

## `packages/web/worker/time.test.ts`

```ts
import { describe, expect, test } from "vitest";
import { formatJst, toJstParts } from "./time";

describe("toJstParts", () => {
  test("UTC 00:00 → JST 09:00 (same day)", () => {
    const utc = new Date("2026-04-22T00:00:00Z");
    expect(toJstParts(utc)).toEqual({
      year: 2026, month: 4, day: 22, hours: 9, minutes: 0,
    });
  });

  test("UTC 15:00 → JST next-day 00:00 (date rollover)", () => {
    const utc = new Date("2026-04-22T15:00:00Z");
    expect(toJstParts(utc)).toEqual({
      year: 2026, month: 4, day: 23, hours: 0, minutes: 0,
    });
  });

  test("UTC last-day-of-month 15:00 → JST next month 1st 00:00", () => {
    const utc = new Date("2026-04-30T15:00:00Z");
    expect(toJstParts(utc)).toEqual({
      year: 2026, month: 5, day: 1, hours: 0, minutes: 0,
    });
  });

  test("UTC New Year's Eve 15:00 → JST next year 00:00", () => {
    const utc = new Date("2026-12-31T15:00:00Z");
    expect(toJstParts(utc)).toEqual({
      year: 2027, month: 1, day: 1, hours: 0, minutes: 0,
    });
  });

  test("Cron '15 * * * *' fires with minute 15 (sanity)", () => {
    const utc = new Date("2026-04-22T07:15:00Z");
    expect(toJstParts(utc).minutes).toBe(15);
  });
});

describe("formatJst", () => {
  test("zero-pads month, day, hour, minute", () => {
    expect(
      formatJst({ year: 2026, month: 4, day: 1, hours: 7, minutes: 5 }),
    ).toBe("2026-04-01 07:05 JST");
  });
});
```

### Why these boundary cases

- **Same-day**: normal case
- **Date rollover (UTC 15→JST 00 next day)**: the most common source of off-by-one-day bugs in TZ code
- **Month rollover**: catches bugs that worked on 30-day months but not 31-day (or February)
- **Year rollover**: catches bugs in year-wrap logic
- **Zero-padding**: the string format is what gets rendered in Discord — visual regressions matter

## `packages/web/worker/discord.test.ts`

```ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildSkeletonMessage, postToDiscord } from "./discord";

describe("buildSkeletonMessage", () => {
  test("includes JST time in skeleton string", () => {
    const now = new Date("2026-04-22T22:00:00Z");  // JST next day 07:00
    const payload = buildSkeletonMessage(now);
    expect(payload.content).toBe(
      "[<project-name>] cron fired at 2026-04-23 07:00 JST (skeleton)",
    );
  });
});

describe("postToDiscord", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("POSTs to webhook URL on happy path (2xx)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await postToDiscord("https://example/webhook", { content: "hi" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example/webhook",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("non-2xx does NOT throw; logs to console.error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      postToDiscord("https://example/webhook", { content: "x" }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  test("fetch rejection does NOT throw; logs to console.error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      postToDiscord("https://example/webhook", { content: "x" }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
```

### Why `vi.spyOn(globalThis, "fetch")`

`globalThis.fetch` is Node 22's global fetch, which is what Workers runtime also provides. Spying at `globalThis` works in both:

- Node test runtime: intercepts the global fetch
- Tests don't actually hit the network, so no DNS / rate-limit / flakiness concerns

`afterEach(() => vi.restoreAllMocks())` resets spies between tests. Otherwise mocks leak between tests and later ones fail in weird ways.

### Why `mockImplementation(() => {})` on console.error

Without this, the `console.error` call from the code-under-test actually writes to the test runner's output, polluting it. Silencing it while asserting it was called gives clean output.

### Why assert each failure mode separately

- Non-2xx and fetch rejection have different `catch` paths in `postToDiscord`:
  - Non-2xx: the fetch resolves, but `res.ok` is false → outer if-block fires
  - Rejection: fetch promise rejects → outer try/catch fires
- Both must not throw. Covering only one misses regressions in the other

## Running the tests

```bash
pnpm test
# or
pnpm --filter @<scope>/web test
```

Expected:

```
 ✓ worker/time.test.ts (6 tests)
 ✓ worker/discord.test.ts (4 tests)

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

If it fails at `spyOn(globalThis, "fetch")` with "Cannot redefine property":

```bash
node --version
# Must be v22.x or higher (this stack's engines requirement).
# Note: global fetch itself is flag-free since Node 18 — the constraint is the
# project baseline, not fetch availability.
```

If you see "CommonJS/ESM mismatch" errors, check that `packages/web/package.json` has `"type": "module"`.

## Integration test?

No. The skeleton does not integration-test Cron → real Discord. Reasons:

- Would require a throwaway webhook URL in CI, exposing a secret
- Flaky (Discord rate-limits, network blips)
- The vitest mocks cover the contract; production verification is done manually via `wrangler tail` post-deploy

When you graduate out of skeleton, consider Playwright e2e for the UI and keep Cron out of e2e — see the `cloudflare-workers-e2e-playwright` skill's test-scope philosophy.
