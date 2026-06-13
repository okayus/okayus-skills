# Vendored skill (not authored here)

This skill is **vendored** — copied verbatim from an upstream repository. Do not
hand-edit the other files in this directory; local edits are lost on the next
update and cause drift from upstream.

- Upstream: https://github.com/vercel-labs/agent-skills
- Upstream path: `skills/react-best-practices`
- Upstream commit: `f8a72b9603728bb92a217a879b7e62e43ad76c81`
- Vendored on: 2026-06-13
- License: MIT (declared in SKILL.md frontmatter; the upstream repo has no
  top-level LICENSE file)

## Updating

Re-copy from a newer upstream commit and bump the hash above:

```sh
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/vercel-labs/agent-skills.git "$TMP"
# from the okayus-skills repo root:
rm -rf skills/vercel-react-best-practices/{AGENTS.md,README.md,SKILL.md,metadata.json,rules}
cp -r "$TMP/skills/react-best-practices/." skills/vercel-react-best-practices/
rm -rf "$TMP"
# keep this SOURCE.md; it is not part of the upstream skill
```
