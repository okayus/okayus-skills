# Dashboard walkthrough: connecting a repo to Workers Builds

Screen-by-screen notes for the one-time ceremony in `SKILL.md`, written so that a
browser-automation agent (Claude in Chrome, Playwright) — or a human in a hurry —
does not have to guess where a field is or what it is called. Recorded on
2026-08-23 (Screens 1-5) and 2026-09-02 (Screen 3B, the existing-Worker route) on a
**Japanese-language** dashboard; English equivalents are given
where the docs confirm them (`Root directory`, `Advanced settings`,
`Builds for non-production branches`, `Create new token`) and marked *(translated)*
where they are inferred from the Japanese label.

## Direct URLs (skip the menus)

| Purpose | URL |
|---|---|
| User API tokens list | `https://dash.cloudflare.com/profile/api-tokens` — `?search=<name>` filters the table; the first page shows 10 rows, so a new token may be off-page without the filter |
| Create a Worker from git | `https://dash.cloudflare.com/<account-id>/workers-and-pages/create` |
| A build's page | `https://dash.cloudflare.com/<account-id>/workers/services/view/<worker>/production/builds/<build-id>` (the dialog redirects here after *Deploy*) |
| Worker settings (the Builds section is on this page, right-hand nav item ビルド / *Builds*; `#builds` is appended when you click it, but loading the URL with the anchor does **not** scroll there — click the nav item) | `https://dash.cloudflare.com/<account-id>/workers/services/view/<worker>/production/settings` |

`<account-id>` is the 32-hex id from `wrangler whoami`. Logging in is the human's job —
an agent must not type credentials; hand over the tab and resume once the account home shows.

## Screen 1 — Create application

URL above → panel "Ship something new": **Continue with GitHub** / Connect GitLab /
Hello World / choose a template / upload static files. Click *Continue with GitHub*.

If the *Cloudflare Workers and Pages* GitHub App is already installed on the GitHub
account, **no GitHub authorization page appears** — you land directly on Screen 2 with
the repositories that installation can see. The scope (*All repositories* vs
*Only select repositories*) is therefore decided on GitHub, not here:
github.com → Settings → Applications → *Cloudflare Workers and Pages* → Repository access.

## Screen 2 — Select a repository (リポジトリを選択する)

Account dropdown (e.g. `okayus`) + "Search repositories…" + list. Click the repo (a ✓
appears) → **次へ / Next**. A "clone a public repo via Git URL" button also exists —
not this path.

## Screen 3 — Set up application (アプリケーションをセットアップする)

Visible without scrolling:

| Field (JA) | EN | Default | Set to |
|---|---|---|---|
| プロジェクト名 | Project name | repository name | exactly `name` from wrangler.jsonc |
| ビルド コマンド | Build command | `pnpm run build` (detected from the lockfile) | `pnpm install --frozen-lockfile && pnpm run build` |
| デプロイ コマンド | Deploy command | `npx wrangler deploy` | `pnpm exec wrangler d1 migrations apply <db> --remote && pnpm exec wrangler deploy` |
| ☑ 非本番ブランチの ビルド | Builds for non-production branches | **checked** | **uncheck** |
| Protect with Cloudflare Access (toggle) | — | off | leave off |

Then the collapsed accordion **詳細設定 / Advanced settings** (a small chevron link under
the Access toggle). It contains:

| Field (JA) | EN | Default | Set to |
|---|---|---|---|
| パス ⓘ | *Path* (translated) = **Root directory**; tooltip: "the root directory is where the commands run" | `/` | `apps/web` (select-all, type) |
| API トークン (picker) | API token | **the build token of the project you connected last** (`nyalog Workers Builds` on kokemusu), with a search box | choose **＋ 新しいトークンを作成する / Create new token** |
| → トークン名 | Token name (appears after choosing *Create new token*) | empty | `<worker> Workers Builds` |
| → blue notice "新しいトークンが自動的に作成されます" | "A new token will be created automatically" — expandable (chevron at its left) | collapsed | expand once to read the permission list that will be granted (2026-08-23: Account Settings read; Workers Scripts, KV, R2, **D1 Storage**, Vectorize, Queues, Pipelines, Containers, Cloudchamber, AI Search edit; Connectivity Directory read+bind; Workers Routes edit on all zones; User Details + Memberships read) |
| 変数名 / 変数値 (+ 暗号化) | Build variable name / value (+ encrypt) | empty | leave empty |

A yellow box under the picker — "This API token is missing the following permissions:
`email_routing_account_rule_read`, `email_routing_rule_write`" — refers to the
pre-selected default token and is noise unless the Worker uses Email Routing.

**Searching the picker for a token you created in My Profile returns "No labels found."**
(2026-08-23). Only dash-generated `<project> Workers Builds` tokens are listed.

Bottom bar: **戻る / Back** · **デプロイ / Deploy**. *Deploy* creates the Worker and starts
the first build immediately — there is no confirmation step.

## Screen 3B — 既存 Worker: リポジトリに接続 (Connect a repository)

Reached from Screen 5's *Git リポジトリ* card via **接続 / Connect** when the Worker
already exists. This is the route to use whenever `wrangler deployments list` prints
anything — the Create-an-app wizard refuses a name already in use (red inline error
under プロジェクト名: 「この名前のプロジェクトはすでに存在します。別の名前を選択してください」).
The rejection is client-side validation: nothing is created, no orphan token.

Modal titled **リポジトリに接続** / "Git プロバイダーからリポジトリを選択":

| Field (JA) | Default | Set to |
|---|---|---|
| Git アカウント | your GitHub account | leave |
| リポジトリ | **pre-filled** with the repo matching the Worker | leave (verify) |
| 本番ブランチ | **pre-filled** `main` | leave (verify) |
| ☑ プレビュービルドを有効化 | **ticked** | **untick** — the 非本番ブランチのデプロイ コマンド field disappears when it is really off, which is the reliable tell |
| ビルド コマンド | `読み込み中...` for a second, then `pnpm run build` | wait for it to load, then `pnpm install --frozen-lockfile && pnpm run build` |
| デプロイ コマンド | `npx wrangler deploy` | `pnpm exec wrangler d1 migrations apply <db> --remote && pnpm exec wrangler deploy` |
| 詳細設定 → パス | `/` | `apps/web` (the package dir) |
| 詳細設定 → API トークン | **another project's build token** | **新しいトークンを作成する — it is the FIRST entry here**, not the last as in the wizard |
| 詳細設定 → トークン名 | **pre-filled** `Workers Builds - YYYY-MM-DD HH:MM` | overwrite with `<worker> Workers Builds` |
| 詳細設定 → 変数名 / 変数値 | empty | leave |
| 詳細設定 → ビルド キャッシュ (toggle) | off | leave |

There is **no project-name field** — that is the difference that makes this route work.
Bottom bar: **キャンセル** · **接続**.

After 接続 the page returns to Screen 5 with a blue notice
「Git リポジトリにコミットをプッシュして最初のビルドを開始できるようになりました」 —
**no build is started**. The first build is whatever you push next, and it posts a real
`Workers Builds: <worker>` check-run.

## Screen 4 — Build page (ビルド #xxxxxxxx)

- A modal "Worker が稼働中です。Workers Paid でさらに活用できます" (upsell) covers the page
  → **あとで / Later**.
- Badge row: `main` + **手動で展開** (*manually deployed*) — this first build is a manual
  build and posts **no** GitHub check-run.
- Panel **ビルドの設定 / Build settings** (collapsible): ビルド コマンド, デプロイ コマンド,
  **ルート ディレクトリ / Root directory**, **ビルド トークン / Build token** (the token name),
  ビルド変数. This is the cheapest place to confirm what was actually saved.
- Stage bar: 初期化中 (initialising, ≈ 50 s) → クローン作成中 (clone) → インストール中
  (install) → ビルド中 (build) → デプロイ中 (deploy: migrations + `wrangler deploy`).
  Green ✓ per stage; a failed stage shows the log tail below.
- Buttons: ビルドをキャンセルする (cancel, while running) · ログをダウンロード / ビルドログをコピー
  (download / copy log). The page has **no** "retry" while the build is green.

## Screen 5 — Settings → ビルド / Builds

Cards in order, each saved via the bottom toast **未保存の変更 → 破棄 / 保存** (*unsaved
changes → discard / save*):

1. **Git リポジトリ** — `okayus/<repo>` chip, 管理 (manage) · 接続を解除 (disconnect — don't).
2. **ビルド構成 / Build configuration** — ビルド コマンド, デプロイ コマンド, ルート ディレクトリ.
3. **ブランチ コントロール / Branch control** — プロダクション ブランチ (`main`) ·
   ☐ 非本番ブランチのビルド.
4. **監視パスを構築する / Build watch paths** — パスを含む (*include*, chip `*` preset) ·
   パスを除外する (*exclude*). The grey `node_modules/**, .git/` in the exclude box is
   **placeholder text, not a value**. Type `docs/*`, Enter (becomes a chip), type `*.md`,
   Enter, then **保存** on the toast.
5. **API トークン** — same picker as the dialog.
6. **変数とシークレット / Variables and secrets** — "no build variables configured" + 追加.
7. **デプロイ フック / Deploy hooks**.

## Screen 6 — My Profile → API tokens (only if you really need a hand-made user token)

Not needed for the keyless ceremony any more (see *Dropped step* in `SKILL.md`). Needed
for e.g. the Builds REST API (`Workers Builds Configuration: Edit`, user token only).

- `https://dash.cloudflare.com/profile/api-tokens` → **トークンを作成する / Create Token**
  (top right, blue). The grey **ドキュメント / Documentation** button sits immediately to
  its left and opens a new tab — a coordinate click after a viewport resize hits it.
- **カスタム トークンを作成する → 始める / Create Custom Token → Get started**.
- 権限 / Permissions rows: scope dropdown (アカウント / ゾーン / ユーザー = Account / Zone /
  User) · permission dropdown (searchable) · level (読み取り / 編集 = Read / Edit).
  **The permission search box does not take IME/Japanese input** — type an ASCII prefix
  (`Workers`, `D1`) and pick from the list, or click the option via its accessibility
  ref. Labels seen: `Workers スクリプト` (Workers Scripts), `D1`, `アカウント設定`
  (Account Settings), `ユーザーの詳細` (User Details), `メンバーシップ` (Memberships),
  `Workers Builds 構成` (Workers Builds Configuration).
- アカウント リソース / Account Resources: 含む (Include) → your account, not
  すべてのアカウント (All accounts). IP filtering and TTL: leave empty.
- **概要に進む / Continue to summary** → check the one-line summary → **トークンを作成する
  / Create Token**. The next screen shows the **token value once**: do not screenshot,
  do not read it out, navigate straight to `/profile/api-tokens?search=<name>` and only
  confirm the row exists. To delete an orphan: row ⋯ menu → delete.

## Browser-agent notes (Claude in Chrome, 2026-08-23 and 2026-09-02)

- The browser may run on a different machine from the terminal (Chrome on a Mac mini,
  CLI on Ubuntu). Everything the ceremony touches is server-side state, so that is fine;
  use the **browser host's** modifier keys (`cmd+a` on macOS) for select-all.
- The dashboard viewport changed width between screenshots (1200 → 1414 px). Coordinates
  from an earlier screenshot then land on a neighbour (the *Documentation* button instead
  of *Create Token*). Re-screenshot or click by element ref after any layout change.
- react-select fields: click the box, type an ASCII fragment, click the option. Chip
  fields (watch paths): type, Enter.
- `find`/accessibility refs are the robust way to hit options whose label is Japanese
  (`アカウント設定`) when typing is unreliable.
- Dropdowns that still show the prior value after a click (e.g. the picker's pre-selected
  token) are a sign the click opened the list but nothing was chosen — screenshot before
  moving on.
- **`form_input` on the React tick-boxes reports success and does not stick.** "Checkbox unchecked (previous: true)" came back, and the box was still ticked on the next screenshot (the 非本番ブランチのデプロイ コマンド field was still rendered). Text inputs and textareas set fine that way; **tick-boxes need a real `left_click`**. Screenshot after every tick-box.
- Element refs go stale when an accordion expands or a modal re-renders — a click by `ref` then silently lands at the viewport origin (the cursor in the screenshot is the tell). Re-run `find` after any expand/collapse, or click by coordinate from a screenshot taken *after* it.
- The dash re-scales the viewport repeatedly during the wizard (1512 → 1853 → 1568 px wide in one run), so a coordinate from two screenshots ago misses. Screenshot immediately before each click.
- `Page.captureScreenshot` occasionally times out at 30 s mid-wizard; just wait 3 s and screenshot again — the page is fine.
- Do not *Retry* a failing build repeatedly while changing settings; capture the log tail
  (ビルドログをコピー) and stop. One retry after a token fix is the limit.
- Never screenshot or read the API-token value screen; the skill's whole point is that
  the value never leaves Cloudflare.
