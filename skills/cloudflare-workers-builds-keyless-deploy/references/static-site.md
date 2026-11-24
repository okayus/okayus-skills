# Static-site variant: an assets-only Worker for a plain HTML repo

The main recipe assumes a pnpm monorepo with D1. A plain HTML/CSS/JS site with no
`package.json` (typically one leaving GitHub Pages) uses the same ceremony, usually
steps B, but different config, commands, watch paths and gate. Recorded on sukitooru,
2026-11-22 → 11-24: a teaching site served from the repository root (68 pages), with
a daily markdown note added by an automated PR.

## wrangler.jsonc

```jsonc
{
  "name": "<worker>",              // = the connected Worker and its workers.dev hostname; another name deploys a second Worker
  "compatibility_date": "<date>",  // the newest date your local `wrangler dev` (its bundled workerd) supports
  // Generated pages are not committed (.gitignore). `wrangler deploy` and `wrangler dev` run this
  // first, so the Workers Builds deploy command builds them too. Leave the dashboard build command empty.
  "build": { "command": "node tools/build.mjs" },
  "assets": {
    "directory": ".",              // serve the repository root; .assetsignore decides what is public
    "html_handling": "none"        // see below
  }
}
```

There is no `main`: a Worker with only static assets has no script.

### `html_handling: "none"` and `_redirects`

The default, `auto-trailing-slash`, answers `/x.html` with a 307 to `/x`. Code that
reads `location.pathname` breaks (here the `.html` suffix selected the chapter), and
every internal `.html` link costs a redirect. With `none`, each file is served at its
exact path, but a directory URL no longer returns its `index.html`. Add a 200 rule for
each directory that has one:

```
# _redirects
/ /index.html 200
/news/ /news/index.html 200
```

`/` and `/news/` then answer 200 with the index content at the same URL. wrangler never
uploads `_redirects`, `_headers` or `.assetsignore` as assets, whatever `.assetsignore`
says, and reads `_redirects` from the assets directory (wrangler 4.125.0).

### `.assetsignore` as an allowlist

Serving the root makes docs, tools, sources and config public unless excluded. Invert
`.assetsignore` (gitignore syntax) into an allowlist, then re-exclude sources that live
inside a served directory:

```
/*
!/index.html
!/assets/
!/chapters/
!/news/
/news/*.md
```

Test with requests before the first deploy. On `wrangler dev`, pages and assets must
answer 200, and `docs/`, `tools/`, `.git/`, the `.md` sources, `wrangler.jsonc` and
`_redirects` must answer 404. The file count wrangler prints at startup is not the
served set.

## Generated pages: build at deploy, never commit

- `build.command` is a wrangler custom build. It runs on `wrangler deploy` (and
  `--dry-run`) and on `wrangler dev`. The Workers Builds deploy step runs
  `wrangler deploy`, so the pages are built on Cloudflare from the committed sources.
- Keep the outputs in `.gitignore`. A PR check can reject a diff that adds them.
- A fresh clone, a worktree or a cloud agent has no generated files until it runs the
  build. Any check or written procedure that reads a generated page must build first,
  or read the sources instead. On sukitooru, a daily agent's procedure still told it to
  look up names in the generated index page, which a fresh clone lacks until the build
  step. The fix pointed the procedure at the markdown sources.
- Verified: with the outputs deleted locally, `wrangler deploy --dry-run` recreated
  them. After the cut-over the repo held no generated pages, yet every note page
  answered 200 with the generator's current title, so Workers Builds had built them.

## Workers Builds settings for this variant

| Setting | Value | Why |
|---|---|---|
| Build command | empty | the build lives in wrangler.jsonc `build` |
| Deploy command | `npx wrangler@4 deploy` | no lockfile pins wrangler, so pin the major |
| Root directory | `/` | |
| Preview builds | off | every automated branch (a daily PR) would build a preview |
| Build watch paths | the default `*`; **do not exclude `*.md`** | markdown is site content here, so the main recipe's `docs/*` + `*.md` excludes would skip content deploys. Docs-only commits then deploy too (about a minute, harmless) |
| API token | *Create new token*, as in the main recipe | |

Push → `Workers Builds: <worker>` check-run success takes about a minute (there is no
install step).

## The gate when main takes direct pushes

The main recipe's invariant (ruleset + required `ci`) assumes every change arrives by
PR. A single-author content site that pushes to `main` directly has no merge-time
gate, and Workers Builds deploys whatever lands. On sukitooru three things replace it:

- The author runs the page checks before pushing.
- Automated PRs go through a workflow that checks them with `main`'s tools and merges
  only on success (`gh pr merge --squash --match-head-commit <checked sha>`).
- The page checker also takes the live URL as its base, and the author runs it there
  after every infrastructure change.

**A merge made with `GITHUB_TOKEN` does trigger Workers Builds.** GitHub suppresses
*workflow* runs for events that `GITHUB_TOKEN` creates, but Workers Builds listens
through its own GitHub App. A workflow's `gh pr merge --squash` with `GITHUB_TOKEN` put
`Workers Builds: <worker>` success on the merge commit on 2026-11-23 and on 2026-11-24.
On 11-24 the check-run completed about a minute after the merge. So a
check-then-auto-merge workflow deploys without any PAT.

## Migrating from GitHub Pages

1. **Run both first.** Create the Worker with one local `wrangler deploy`, then connect
   it (steps B) while Pages keeps serving. Check every page on
   `<worker>.<subdomain>.workers.dev`.
2. **Declare the charset in every page.** Workers static assets answer
   `Content-Type: text/html` and `text/javascript` with no `charset` (GitHub Pages sends
   `charset=utf-8`). Each page needs `<meta charset="utf-8">`. External scripts without
   a charset are decoded in the page's encoding. Script-drawn non-ASCII text rendered
   correctly because every page already declared it.
3. **Cut over.** Disable Pages (`gh api -X DELETE repos/<owner>/<repo>/pages` → 204).
   Delete `.nojekyll`, and drop any workflow step that rebuilt Pages (`pages: write`,
   `POST repos/<owner>/<repo>/pages/builds`).
4. **Old URLs.** `<owner>.github.io/<repo>/` answers 404 once Pages is off, and nothing
   redirects it. If the old URL was shared outside the repo, put a redirect in place
   before disabling Pages.
5. **Renaming the repo keeps the connection.** After `gh repo rename`, the next push
   built and deployed (check-run success), and `github.com/<owner>/<old>` answered 301.
   Update anything that stores `owner/repo` explicitly, such as scheduled agents and
   scripts. A scheduled cloud agent repointed to the new name cloned, pushed and opened
   its PR the next morning.
