# Implementation: source code

Full source for `time.ts`, `discord.ts`, `cron.ts`, and the `types.ts` diff. Copy-ready.

## `worker/time.ts` — pure UTC→JST conversion

```ts
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type JstParts = {
  year: number;
  month: number;  // 1-12
  day: number;    // 1-31
  hours: number;  // 0-23
  minutes: number; // 0-59
};

export function toJstParts(utc: Date): JstParts {
  const jst = new Date(utc.getTime() + JST_OFFSET_MS);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hours: jst.getUTCHours(),
    minutes: jst.getUTCMinutes(),
  };
}

export function formatJst(parts: JstParts): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hours)}:${pad(parts.minutes)} JST`;
}
```

### Why `getUTC*()` and offset addition (not `Date#getHours()`)

`Date#getHours()` returns the hour in the **local timezone of the environment running the code**. In Workers this happens to be UTC, but in `vitest run` on CI it depends on `TZ`, and on a developer's laptop it could be anything. Using `getHours()` makes your tests pass/fail depending on the environment's locale setting — terrible.

`getUTC*()` always returns UTC. Adding `JST_OFFSET_MS` to the Unix time and then reading back as UTC gives you JST values, regardless of the execution environment's TZ.

### Adapting to other timezones

JST has no DST and is a fixed +9 from UTC. For timezones with DST (e.g., US/Eastern, Europe/Berlin):

- You cannot use a fixed offset; DST changes twice a year
- Use `Intl.DateTimeFormat` with a `timeZone` option, or a library like `date-fns-tz`
- `Intl` is available in Workers runtime

Example for America/New_York:

```ts
export function toNycParts(utc: Date): JstParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hours: get("hour"), minutes: get("minute"),
  };
}
```

## `worker/discord.ts` — build (pure) + post (boundary)

```ts
import { formatJst, toJstParts } from "./time";

export type DiscordPayload = {
  content: string;
  // Discord webhook accepts more fields (embeds, username, avatar_url, etc.).
  // Add them as the domain requires — skeleton uses `content` only.
};

export function buildSkeletonMessage(now: Date): DiscordPayload {
  const jst = formatJst(toJstParts(now));
  return {
    content: `[<project-name>] cron fired at ${jst} (skeleton)`,
  };
}

export async function postToDiscord(
  webhookUrl: string,
  payload: DiscordPayload,
): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(
        "[discord] non-2xx response",
        res.status,
        await res.text().catch(() => "<no body>"),
      );
    }
  } catch (err) {
    console.error("[discord] fetch failed", err);
  }
}
```

### Design decisions

- **`buildSkeletonMessage` is pure**. Takes `now` as a parameter — does not read system clock. This keeps unit tests deterministic
- **`postToDiscord` never throws**. Two kinds of failures are caught and logged:
  - Non-2xx response from Discord (webhook revoked, rate-limited, bad payload)
  - Fetch rejection (DNS failure, TLS error, timeout)
- **No retry logic**. Workers Cron runs on a schedule; missing one notification is acceptable. Retries would mask real issues (a persistently bad webhook) while consuming request budget
- **No structured Result type**. Deferred. The swallow-and-log pattern is sufficient for skeleton; when richer error semantics are needed, introduce `neverthrow` or a discriminated union then

### Naming convention

Rename `buildSkeletonMessage` when you replace it:

- Skeleton: `buildSkeletonMessage(now: Date): DiscordPayload`
- Next phase: `buildNotificationMessage(tasks: Task[], now: Date): DiscordPayload` (or whatever the domain inputs are)

Rename the function to match its actual behavior. Don't let `buildSkeletonMessage` linger after it's no longer a skeleton.

## `worker/cron.ts` — wiring

```ts
import { buildSkeletonMessage, postToDiscord } from "./discord";
import type { Bindings } from "./types";

export async function runScheduled(
  event: ScheduledController,
  env: Bindings,
): Promise<void> {
  const now = new Date(event.scheduledTime);
  console.log("[cron] fired at", now.toISOString());
  const payload = buildSkeletonMessage(now);
  await postToDiscord(env.DISCORD_WEBHOOK_URL, payload);
}
```

### Why `console.log`

Gives you a log line in `wrangler tail` at every fire, which is the primary signal that Cron is actually firing on schedule. Keep this log even after you flesh out the logic — it's the "is Cron alive?" heartbeat.

### Why no try/catch here

`postToDiscord` guarantees it doesn't throw (see above). So `cron.ts` doesn't need to catch. If you add more side effects later (e.g., write back to D1), wrap each in a throw-less helper, don't try/catch here.

## `worker/types.ts` — Bindings addition

Add one field:

```diff
 export type Bindings = {
   DB: D1Database;
   ASSETS: Fetcher;
   RP_ID: string;
   ORIGIN: string;
+  DISCORD_WEBHOOK_URL: string;
 };
```

**Do NOT** redeclare `type Bindings` in `worker/index.ts` or `worker/cron.ts`. Every worker file imports from `./types`.

## `.dev.vars.example` update

Add a comment clarifying the dev/prod discipline:

```
# Discord Webhook URL
# Development webhook — must be a DIFFERENT channel from production.
# Production URL is injected via `wrangler secret put DISCORD_WEBHOOK_URL`.
DISCORD_WEBHOOK_URL=
```

Keep the value empty in `.example`. The real URL goes in `.dev.vars` (gitignored).

## `package.json` scripts (add test)

In `packages/web/package.json`:

```diff
 "scripts": {
   "dev": "vite dev",
   "build": "vite build",
   "deploy": "pnpm build && wrangler deploy",
   "check": "tsc --noEmit",
+  "test": "vitest run",
+  "test:watch": "vitest",
   "db:migrate": "wrangler d1 migrations apply <db-name> --local",
   "db:migrate:prod": "wrangler d1 migrations apply <db-name> --remote"
 },
 "devDependencies": {
   ...
+  "vitest": "^4.0.0"
 }
```

Root `package.json`:

```diff
 "scripts": {
   ...
+  "test": "pnpm --filter @<scope>/web test"
 }
```

See [testing.md](testing.md) for `vitest.config.ts` and test files.
