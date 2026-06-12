# Branch ruleset: "main is always CI-green" (the gate Workers Builds doesn't provide)

Workers Builds deploys on push to the production branch regardless of GitHub CI
results. The compensating control is a **repository ruleset** on the default branch:
PR required + required status check + no force pushes + **no bypass actors** (even
the repo owner/admin cannot push main directly — `current_user_can_bypass: "never"`).

Free plan note: ruleset *enforcement* is free on **public** repos; private repos
need a paid plan. Decide visibility before relying on this gate.

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
        "required_review_thread_resolution": false
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
- `strict_required_status_checks_policy: false` = branch need not be up to date
  with main before merge (fine solo; consider `true`/merge queue for busy repos).
- Companion setting worth enabling (merged-branch hygiene, esp. with a relay
  re-scanning local branches):

```bash
gh api -X PATCH repos/<owner>/<repo> -f delete_branch_on_merge=true
```
