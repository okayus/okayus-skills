# GitHub Actions: "not permitted to create or approve pull requests"

## The error

```
##[error]GitHub Actions is not permitted to create or approve pull requests. - https://docs.github.com/rest/pulls/pulls#create-a-pull-request
```

You see this on the first invocation of any workflow that uses `peter-evans/create-pull-request`, `gh pr create` (with the workflow's GITHUB_TOKEN), or any other PR-creating step.

## Why this default exists

GitHub introduced the per-repo "allow Actions to create PRs" setting in 2022 to prevent supply-chain attacks where a malicious dependency or compromised workflow could mass-open PRs (which then might be auto-merged, or could harvest reviewer attention to slip in malicious changes elsewhere).

The default is **off** for new repos. The workflow YAML's `permissions:` block can grant `pull-requests: write` to the GITHUB_TOKEN, but that's only one of two gates. The repo setting is the second, independent gate.

This is **security-by-default** reasoning: a workflow accidentally pushed to a repo can't escalate to PR creation without an explicit human action (the setting flip).

## When to flip it

For personal-scale projects where:
- The repo is private (or public but you trust your own workflows)
- You want backup / dependency-update / release-PR workflows to work
- You don't depend on third-party actions you haven't audited

→ Flip the setting once, document it, move on. The risk is low and the friction of every backup workflow failing on first run is high.

For team / enterprise repos:
- Audit each PR-creating workflow before flipping
- Consider whether the workflow could be triggered maliciously (via PR from a fork, etc.)
- Document the policy in your team's repo-bootstrap checklist

## How to flip via web UI

Settings → Actions → General → Workflow permissions section:
- ☐ Read and write permissions (you may or may not want this — orthogonal to PRs)
- ☑ **Allow GitHub Actions to create and approve pull requests** ← this is the one

The two checkboxes are independent. The first one ("read and write") affects what the GITHUB_TOKEN can do by default; the second specifically controls PR creation. You only need the second checked for backup workflows.

## How to flip via CLI

```bash
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -F default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Note: `can_approve_pull_request_reviews` is the API field name. Despite the name, this controls **both** approval and creation. It's a misleading name — the docs explicitly say so. Don't worry, you're not granting auto-approval rights to anything by enabling this; the `permissions:` block in each workflow controls actual capabilities.

`default_workflow_permissions` is the orthogonal "read vs write" knob. Keep it `read` (the default) unless you have a reason to change it. Workflows that need write permissions specify them explicitly per-job.

Verify the flip:

```bash
gh api repos/<owner>/<repo>/actions/permissions/workflow
# {"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}
```

## How to know if you've already flipped it

Run a workflow that tries to create a PR. If it fails with the "not permitted" message, the setting is off. If it succeeds, it's on.

You can also just `gh api` the URL above without any modification action — the GET returns the current state.

## Common confusion: "I added permissions: pull-requests: write, why is it still failing?"

The workflow's `permissions:` block and the repo's "allow create PR" setting are **independent gates**. Both must allow it.

```yaml
# This alone is NOT enough.
permissions:
  contents: write
  pull-requests: write
```

You also need the repo setting flipped. The error message names the repo setting as the blocker, not the permissions block, but the message is easy to misread when you've just been editing the YAML.

If in doubt, run:

```bash
gh api repos/<owner>/<repo>/actions/permissions/workflow
```

If `can_approve_pull_request_reviews: false`, that's your problem regardless of what the YAML says.

## Triggering on fork PRs (special case — you probably don't need this)

If you want a workflow that opens PRs in response to PRs from forks (e.g., translation bots, auto-fixers), the rules get stricter. The GITHUB_TOKEN on a fork-triggered workflow has read-only permissions by default, regardless of repo settings, because forks are untrusted.

The mitigation is `pull_request_target` event + careful handling. This is out of scope for backup workflows (which run on cron + manual dispatch, both trusted). Mentioned only so you know to look elsewhere if your use case is "automate PRs in response to fork PRs".

## Generalizable lesson

**Cloud / SaaS providers often have multiple independent permission gates that all need to align**. A workflow's `permissions:` block, a repo's settings, an org's policies, and a user's PAT scopes are four independent layers. The error message usually names only the layer that failed first, which can be misleading when fixing one layer doesn't fix the whole.

When debugging "I gave it permission, why is it still denied?", enumerate every gate the request passes through. For GitHub Actions creating PRs, that's:

1. Repo: "Allow Actions to create PRs" setting → must be true
2. Job: `permissions:` block → must include `pull-requests: write` and `contents: write`
3. Trigger event: must be a trusted event (cron / push / workflow_dispatch — yes; pull_request from fork — no, by default)

Same reasoning applies to GCP IAM (project + folder + org policies), AWS (IAM user policy + resource policy + SCP), Cloudflare API tokens (account scope + zone scope + token scope), etc. When one layer says no, check all of them.
