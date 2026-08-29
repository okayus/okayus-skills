# Branch ruleset: "main is always CI-green" (the gate Workers Builds doesn't provide)

Workers Builds deploys on push to the production branch regardless of GitHub CI
results. The compensating control is a **repository ruleset** on the default branch:
PR required + required status check + no force pushes + **no bypass actors** (even
the repo owner/admin cannot push main directly — `current_user_can_bypass: "never"`).

Plan note (verified 2026-08-08): ruleset *enforcement* is free on **public** repos.
On **private** repos it needs personal Pro / org Team or above — on a Free plan you
can *create* the ruleset but it is **not enforced** (the UI warns "won't be enforced
... until you upgrade"). Decide visibility before relying on this gate.

```bash
gh api repos/<owner>/<repo>/rulesets -X POST --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "require_extra_approval_for_unattributed_changes": false
    }},
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "ci", "integration_id": 15368 } ]
    }}
  ],
  "bypass_actors": []
}
JSON
```

Notes:

- `integration_id: 15368` pins the `ci` check to the **GitHub Actions app**, so no
  other integration can fake a passing "ci" status.
- `required_approving_review_count: 0` suits a solo repo: merging is the human
  review. Raise it for teams.
- `require_extra_approval_for_unattributed_changes: false` is spelled out because
  GitHub defaults it to **true** when the key is omitted (seen in the create
  response, 2026-08-29). A sandbox agent's commits are usually *unattributed*
  (a made-up `…@users.noreply.github.com` that maps to no account), and on a solo
  repo nobody can supply an "extra approval" for the owner's own PR. Observed on
  matatabetai: with the default `true` such a PR still auto-merged at 0 approvals,
  so the default did not bite — but the explicit `false` keeps that from depending
  on GitHub's semantics.
- `strict_required_status_checks_policy: false` = branch need not be up to date
  with main before merge (fine solo; consider `true`/merge queue for busy repos).
- Companion setting worth enabling (merged-branch hygiene, esp. with a relay
  re-scanning local branches):

```bash
gh api -X PATCH repos/<owner>/<repo> -f delete_branch_on_merge=true
```
