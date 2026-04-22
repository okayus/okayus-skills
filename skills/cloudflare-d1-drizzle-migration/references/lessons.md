# Meta-level lessons

The mechanical runbook ([runbook.md](runbook.md)) and the pitfalls list ([d1-drizzle-kit-pitfalls.md](d1-drizzle-kit-pitfalls.md)) protect you from this *specific* trap. The lessons below are the abstractions that protect you from analogous traps in other stacks.

Each was paid for by a production near-miss. Keep them in your PR-planning checklist.

## 1. Local-vs-production semantics parity is a hypothesis, not a guarantee

**What happened**: Local (miniflare SQLite) respected `PRAGMA foreign_keys=OFF`. Production (Cloudflare D1) did not. Local tests passed, production deleted 1257 rows.

**The generalized lesson**: "Same technology" ≠ "same behavior." Two runtimes with the same SQL dialect can diverge on transaction semantics, PRAGMA handling, isolation levels, timeout behavior, extension availability. The fact that local passes a test tells you the *code* is correct on *that runtime*; it does not tell you the code is correct on the production runtime.

**Analogous traps to watch for**:

| Stack | Where local and prod diverge |
|---|---|
| SQLite (miniflare) vs Cloudflare D1 | PRAGMA handling, statement-level vs connection-level settings |
| SQLite vs Postgres | Transaction isolation, `LIKE` case sensitivity, JSON handling |
| Local Redis vs ElastiCache | Cluster mode constraints, eviction behavior under memory pressure |
| Docker Postgres vs RDS | Extension availability, connection pooling behavior, fsync timing |
| Local S3 (minio) vs real S3 | Consistency guarantees, rate limits, signature v2/v4 differences |
| `fetch` in Node vs in Workers | Streaming behavior, HTTP/2 support, header casing |

**Action for future PRs**: When your change touches migrations, transactions, PRAGMAs, connection pooling, async semantics, or any cross-runtime primitive, explicitly ask: *what divergence between local and production could silently pass local tests and break prod?* Consult the runtime's docs for known non-compliance. Consider a staging environment that uses the same runtime as prod if the cost justifies it.

## 2. E2E tests have a structural blind spot for destructive side-effects

**What happened**: The nyalog e2e suite has 6 tests covering the critical path + security headers + cross-space IDOR. None of them checked "the 1255 historical toilet records that existed before the test started still exist after the migration." That's not a bug in the tests — it's a category they don't cover.

**The generalized lesson**: E2E tests create their own fixtures. They verify that *new* data works correctly. They do not verify that *pre-existing* data is preserved. The structural assumption of most e2e frameworks is "set up fresh state, run scenario, teardown" — which is the wrong shape for catching destructive migration side-effects.

**What tests *can* cover**:

- Code correctness (given these inputs, get these outputs)
- Feature behavior (the user can do X and Y works)
- Regression (the thing that broke last time still works)
- Boundary correctness (the cross-space IDOR 404 pattern)

**What tests *cannot* cover (practically)**:

- "This migration did not delete any existing data"
- "This deploy did not change the behavior of any production row"
- "The production DB at t+1 minute is still consistent with t-1 minute"

**Action for future PRs**: For destructive operations (schema changes, bulk UPDATEs, backfills, index rebuilds), don't rely on tests. Use operational controls:

- Pre-operation snapshot (backup / count query)
- Post-operation verification (same count query, compared to pre)
- Alerting on unexpected row count changes in prod
- A human-reviewed PR description that states what will change and by how much

The test suite is not the safety net here. The runbook is.

## 3. Design review must ask "what does this PR destroy?" not just "what does it build?"

**What happened**: The PR #37 plan and body focused on the *target change*: "flip `cats.space_id` to NOT NULL." It didn't mention the mechanism ("SQLite will rebuild the cats table") or the mechanism's side effect ("which fires CASCADE on toilet_records"). The cascade FK was one `grep -n onDelete schema.ts` away, which would have taken 5 seconds, but wasn't done because "this PR is about cats."

**The generalized lesson**: When you plan a PR, your mental model focuses on the lines you're adding. But production incidents come from the lines you're *not* looking at — the ones that indirectly respond to your change. A discipline of "what else touches this table / this function / this env var" needs to be explicit, because the lines-you're-adding frame doesn't surface them.

**Questions to add to PR planning templates**:

- **Schema PRs**: `grep onDelete <schema>` and `grep references <schema>` — what FKs touch this table? What will happen on DROP / rebuild / type change?
- **Auth/middleware PRs**: `grep c.get\(\"<var>\"\) routes/` — where is this variable consumed? Does my change silently skip the consumer?
- **Config/env PRs**: `grep <ENV_VAR>` — who reads it? What breaks if it's missing or has the wrong shape?
- **Dependency bumps**: The changelog for the bumped version — any breaking change or deprecation affecting code I don't own?

**Action for future PRs**: Before writing the PR body, do a 1-minute "what does this destroy?" audit. If the answer is "nothing, just additive," say so explicitly in the PR body — that's evidence you actually looked. If the answer is "possibly X," that's the most important thing to document and mitigate before review.

## Why abstract these lessons at all?

The specific D1 trap will never bite this project again — it's documented in CLAUDE.md, in ADR-005 Addendum, and in this skill. But the author is going to touch a Postgres DB eventually, or a different NoSQL store, or a third-party API with its own consistency model. The *specific* lesson won't transfer. The *abstract* lesson will.

A runbook prevents the repeat. A meta-lesson prevents the analog.
