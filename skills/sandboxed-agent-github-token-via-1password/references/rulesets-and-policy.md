# Rulesets, merge policy, threat model, runbooks, migrating off the relay

## The rulesets (server side — this is the boundary)

**`main`**: use the JSON in `cloudflare-workers-builds-keyless-deploy/references/ruleset.md` verbatim — `deletion` + `non_fast_forward` + `pull_request` (0 required reviews) + `required_status_checks` (`ci`, pinned to the GitHub Actions app) + **`bypass_actors: []`**. The last item is what makes a token minted on *your* account unable to push `main`: a fine-grained PAT "has the same capabilities … that the owner of the token has", so any bypass you grant yourself is the token's too. Enforcement is free on public repos; on a private repo it needs Pro / Team (the keyless skill's plan note).

**Optional — no force push anywhere** (`~ALL`): stops a compromised sandbox from rewriting *other* pushed branches (a human's WIP branch, another agent's PR). Merges and branch deletions stay allowed.

```bash
gh api repos/<owner>/<repo>/rulesets -X POST --input - <<'JSON'
{
  "name": "no-force-push-anywhere",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" } ],
  "bypass_actors": []
}
JSON
```

Companion: `gh api -X PATCH repos/<owner>/<repo> -f delete_branch_on_merge=true` (no relay reaps branches now).

## Merge policy — pick one and write it into `CLAUDE.md`

| Policy | Settings | Guarantee |
|---|---|---|
| **Human merges** (default) | `deny: Bash(gh pr merge *)`, `deny: Bash(gh api *)` | the well-behaved agent stops at "PR open, CI green"; a *compromised* sandbox could still merge via the API — see threat model |
| **Agent may request a merge** | `allow: Bash(gh pr merge --auto --squash *)`; repo setting *Allow auto-merge* on | `--auto` merges only after the ruleset's required checks pass; the request is visible in the PR timeline — the `Relay-Merge: yes` semantics without the relay |
| Required review | `required_approving_review_count: 1` | **don't** on a solo repo: the token is you, you can't approve your own PR, nobody can merge |

## Threat model — what changes vs the relay

| Capability of a compromised sandbox | relay | this skill | mitigation here |
|---|---|---|---|
| Push to non-protected branches | only `claude/*`, never force (relay policy) | any branch, force unless the `~ALL` ruleset | `~ALL` `non_fast_forward`; branch hygiene |
| Push to `main` | impossible (no credential) | rejected by the ruleset | `bypass_actors: []` |
| Open PRs | relay does, for `claude/*` | yes, as you | review before merge |
| Merge a CI-green PR | only with the trailer, by the relay | **yes** (`contents: write` covers the merge API; the `gh pr merge` / `gh api` denies bind only the cooperative agent) | strong required checks; short expiry; revoke on suspicion; if unacceptable → keep the relay |
| Edit workflow files | rejected (App lacks `workflows`) | rejected (token lacks `workflows`) | — |
| Reach other repos / gists / packages | no | no (one selected repo; packages unsupported) | — |
| Persist beyond the container | no | no (env only; expiry) | never `gh auth login` in the container |
| Exfiltrate the token | nothing to exfiltrate | possible through allowed egress | the token is worth one repo for ≤ 90 days |

The honest summary: **the relay keeps policy outside the boundary; this skill keeps policy in GitHub's rulesets and the token's scope, and keeps *convention* in Claude Code rules.** Choose by which failure you can live with.

## Runbooks

**Rotate (scheduled, every 90 days)**

1. GitHub → Settings → Developer settings → Fine-grained tokens → the token → *Regenerate token* (same scopes) → copy.
2. `op item edit "github-pat-<repo>-sandbox" 'credential=<new>' 'expires=<new date>'`.
3. `./up.sh` — compose sees a changed env value and recreates the container (UNVERIFIED: confirm it recreates rather than reports "up-to-date"; if not, `./up.sh --force-recreate`).
4. In-container `gh auth status` → OK. Calendar reminder for the next date.

**Expired token (symptom first)**: `git push` → `remote: Invalid username or token` / `401`; `gh` → `HTTP 401`. `op item get "github-pat-<repo>-sandbox" --fields label=expires` → past date → rotate.

**Revoke (incident)**

1. GitHub → the token → *Delete*. Instant; nothing in the container can refresh it.
2. `docker compose down` (the env copy dies with the container).
3. Audit: `gh api repos/<o>/<r>/events --jq '.[] | select(.type | test("Push|PullRequest")) | {type, actor: .actor.login, created_at}'` from the **host** (your normal `gh` login), recent branches `gh api repos/<o>/<r>/branches --jq '.[].name'`, merged PRs.
4. Mint a new token only after the cause is understood.

**Lost the token value but it's still valid**: nothing to recover — regenerate; the only copy was supposed to be 1Password.

## Migrating off `sandboxed-agent-git-relay`

1. `systemctl --user disable --now <project>-relay.timer` — keep the unit files and `~/.config/<project>-relay/` (App key) as the revert path for a month.
2. Leave the GitHub App installed but idle (it can't act without the relay minting tokens); delete it once you're sure.
3. `.claude/settings.json`: remove `Bash(curl -s https://api.github.com/*)` (gh works now) and the blanket `Bash(git push:*)` deny; add the allow / deny lists from `compose-and-git-wiring.md`.
4. `CLAUDE.md`: replace the relay paragraph (`claude/*` + `Relay-Merge: yes` trailer + unauthenticated curl) with the token paragraph; decide the merge policy.
5. Reap local `claude/*` branches the relay used to delete: `git fetch --prune && git branch --merged main | grep '^  claude/' | xargs -r git branch -d`.
6. The relay's `isTipAlreadyMerged` / squash-residue machinery is simply gone — nothing replaces it because nothing polls.
7. Run the E2E in `SKILL.md`; record the differences in *Unverified claims*.

Revert = stop using `./up.sh` (plain `docker compose up -d` → tokenless container), restore the old settings, `systemctl --user enable --now` the timer.
