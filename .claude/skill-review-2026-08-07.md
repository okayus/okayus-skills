# Skill 一斉レビュー結果（2026-08-07）

実施方法: `.claude/skill-review-rubric.md` の共通基準で 13 skill を読み取り専用サブエージェント 13 体が並列レビュー（レビュー観点: (a) 改善点 / (b) 陳腐化 / (c) 分割）。陳腐化の全所見はライブドキュメント（developers.cloudflare.com / docs.github.com / code.claude.com / changelog キャッシュ 2.1.224 / npm・GitHub API）で当日裏取り済み。裏取りできなかった疑いは断定せず `要確認` マーク。

## 総括

| skill | verdict | high | med | low |
|---|---|---|---|---|
| cloudflare-workers-e2e-playwright | **needs-update+split** | 1 | 6 | 1 |
| cloudflare-cron-to-discord | needs-update | 3※ | 3 | 4 |
| cloudflare-d1-weekly-backup-via-pr | needs-update | 2 | 2 | 3 |
| cloudflare-api-token-permissions | needs-update | 2 | 1 | 2 |
| cloudflare-workflows-for-long-tasks | needs-update | 1 | 5 | 2 |
| cloudflare-workers-deploy-skeleton | needs-update | 1 | 4 | 3 |
| cloudflare-d1-drizzle-migration | needs-update | 1 | 2 | 3 |
| cloudflare-mcp-claude-tooling | needs-update | 1 | 3 | 2 |
| claude-code-docker-sandbox | needs-update | 1 | 1 | 5 |
| cloudflare-workers-bot-scan-defense | needs-update | 0 | 2 | 5 |
| sandboxed-agent-git-relay | needs-update | 0 | 2 | 2 |
| cloudflare-workers-builds-keyless-deploy | needs-update | 0 | 1 | 3 |
| vercel-react-best-practices | **keep**（上流差分ゼロ） | 0 | 0 | 0 |

※ うち 1 件（Dashboard 手動トリガーボタンの実在）は 要確認。

high 計 13（確定 12 + 要確認 1）/ med 計 32 / low 計 35。

## 横断テーマ（複数 skill に共通する系統的問題）

1. **frontmatter の spec 上限違反 × 4 skill** — description が 1024 字超過: docker-sandbox (1071), bot-scan-defense (1144), git-relay (1173), e2e-playwright (1220。compatibility も 540 > 500)。いずれも 2026-06 作成の新しい skill で、README 表の長文説明を frontmatter に鏡写しした構造が原因。spec 準拠ローダー・`skills-ref validate` で不合格になる。`gh skill publish --dry-run` がこれを検出するかは未確認（検出しないなら手元検証の穴）。
2. **D1 Time Travel の見落とし × 2 skill** — d1-drizzle-migration / d1-weekly-backup が「D1 に PITR は無い」と断定。Time Travel（paid 30 日 / free 7 日、2023 GA）が存在し、**執筆時点から誤り**。両 skill の位置づけ文と復旧手順の書き換えが必要。
3. **cron dev エンドポイントの陳腐化 × 2 skill** — deploy-skeleton / cron-to-discord の `/__scheduled` と「vite-plugin ではローカル cron テスト不可」caveat は現行 `/cdn-cgi/handler/scheduled`（wrangler dev / vite-plugin 両対応）で不成立。cron-to-discord は description の発動条件ごと陳腐化。
4. **GitHub Actions テンプレのピン枯れ × 3 skill** — d1-weekly / keyless-deploy / deploy-skeleton: checkout@v4→v7, setup-node@v4→v7, pnpm/action-setup@v4→v6, create-pull-request@v7→v8, pnpm 9 ハードコード。
5. **wrangler v3 / vite-plugin 0.1.x 基準の陳腐化 × 3 skill** — deploy-skeleton / cron-to-discord のベースライン、e2e-playwright の `unsafe` ratelimit 前提（現行は top-level `ratelimits`）。
6. **`@cloudflare/workers-types` → `wrangler types` × 2 skill** — deploy-skeleton / workflows。現行公式推奨は生成型。
7. **sibling skill の相互参照欠落 × 5 件**（c-low）— api-token↔keyless-deploy、d1-drizzle↔d1-weekly、deploy-skeleton↔keyless-deploy、bot-scan↔keyless/git-relay ほか。
8. **セキュリティ実質 1 件** — mcp-claude-tooling の settings テンプレが `Bash(gh api:*)` を許可し、read-only 方針と矛盾（gh api は POST/DELETE 可能で deny commit/push ガードを迂回し得る）。
9. **分割候補は 1 件のみ** — e2e-playwright: sandbox/bake 部（Trap 3-4 + in-container-playwright-bake）を `playwright-e2e-in-docker-sandbox` に切り出す案。description 超過の主因もこの同居。他 12 skill は単一の呼び出し文脈で分割不要。

## 修正優先度（提案）

- **P1 誤事実・従うと壊れる**: spec 超過 4 件 / D1 PITR 2 件 / cron endpoint 2 件 / Queues「30s per message」/ 「v20 fetch behind flag」/ GH_TOKEN 欠落（Actions 内 gh 必敗）/ Queues 権限名・R2 テンプレ内容 / MCP OAuth 根拠（2.1.191 で崩壊）/ Rust 1.78 pin（edition2024 ビルド失敗）
- **P2 基盤更新**: Actions ピン一括更新 / wrangler v4 基準化 / wrangler types 化 / `gh api` 許可の除去
- **P3 要確認 6 件の追加検証**: Dashboard「Run now」ボタン / scheduled noRetry / `$metadata.trigger` filter 名 / workers-sdk #5077 の現行症状 / ruleset の plan 可用性 / memberships 権限対応
- **P4 磨き込み**: 相互参照追加 / 重複コード縮約（e2e Dockerfile・workflows クラス全文・bot-scan 設定 3 種）/ e2e 分割の実施

## 段取りメタ記録（/dandori 採用整備の効果）

採用整備①（読み取り専用レビュアー + 共通ルーブリック）: 13/13 が出力フォーマットを完全遵守。裏取り義務により 6 件が `要確認` として正しく保留され、false-stale 断定を防止。docker-sandbox の firewall/statsig 系中核主張や bot-scan の ratelimits 設定など「現行一致を確認済み」の記録も残った（次回レビューの差分起点に使える）。`.claude/agents/skill-reviewer.md` は次回セッションから subagent_type として直接使用可能（今回はセッション途中作成のため general-purpose に指示文を継いで実行）。

---

# 各 skill の所見全文

## cloudflare-api-token-permissions
- reviewed-at: 2026-08-07 / last-commit: 2026-05-06
- files-read: 1 (SKILL.md のみ・references/ なし)
- sources-checked: https://developers.cloudflare.com/fundamentals/api/reference/template/ , https://developers.cloudflare.com/fundamentals/api/reference/permissions/ , https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ , https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/ , https://developers.cloudflare.com/workers/wrangler/configuration/ , https://developers.cloudflare.com/browser-rendering/rest-api/ , https://developers.cloudflare.com/workers/ci-cd/external-cicd/ , https://code.claude.com/docs/en/skills.md , https://agentskills.io/specification
- verdict: needs-update

### findings
- [b][high] テンプレ節が陳腐化: 現行の "Edit Cloudflare Workers" テンプレは "Workers R2 Storage Write" を含む（実際の欠落は D1/Queues/Vectorize のみ）。"silently omits D1, R2, Queues, and Vectorize" は R2 について誤り、include リスト(65-71行)も "Workers R2 Storage Write, User Details Read, User Memberships Read" の 3 権限が欠落 | evidence: SKILL.md:63（+3, 22, 65-71, 77） | fix: 欠落リストから R2 を除き include リストを現行 8 権限に更新（description の同文言も修正） | source: https://developers.cloudflare.com/fundamentals/api/reference/template/（確認日 2026-08-07）
- [b][high] 権限名 `Workers Queues / Edit` は現行リファレンスに存在しない。現行名は "Queues Read" / "Queues Edit" | evidence: SKILL.md:33（+46, 78） | fix: 全 3 箇所を `Account / Queues / Edit` に改名 | source: https://developers.cloudflare.com/fundamentals/api/reference/permissions/（確認日 2026-08-07）
- [b][med] `/memberships` → `Account Settings / Read` の対応付けは現行 docs で裏付け不可: memberships は User スコープの "Memberships Read"（"Grants read access to a user's account memberships"）に紐づき、公式テンプレも "User Memberships Read" を同梱する。9106 の帰属と最小権限セット(53-59行)が誤りの可能性 | evidence: SKILL.md:30（+51, 58） | fix: `User / Memberships / Read` の要否を実トークンで検証し表を訂正 | source: https://developers.cloudflare.com/fundamentals/api/reference/permissions/ + /fundamentals/api/reference/template/ | 要確認
- [b][low] wrangler 設定キー `queues_producers` / `queues_consumers` は存在しない（正しくは `queues.producers` / `queues.consumers`） | evidence: SKILL.md:46 | fix: 表の行ラベルを `queues.producers` / `queues.consumers` binding に修正 | source: https://developers.cloudflare.com/workers/wrangler/configuration/（確認日 2026-08-07）
- [c][low] トークン自体を不要化する代替経路 `cloudflare-workers-builds-keyless-deploy`（build token の D1 Edit 欠落という同型トラップも持つ）への相互参照が Related skills に無い | evidence: SKILL.md:137-141 | fix: Related skills に 1 行追加

### notes
- `browser` binding の `Browser Rendering / Edit`(50行) は permissions リファレンス頁には未掲載だが Browser Rendering REST API 頁で "Browser Rendering - Edit" として現存確認済み（問題なし）
- 「編集ではトークン値が変わらない」(85-87行) は roll-token 頁が「roll は新値を発行し権限は維持」と述べるのみで、編集時の値維持は明文化なし。矛盾は無いため所見とせず
- frontmatter は spec 6 フィールド内に収まっており移植性の問題なし。分割は不要（単一の呼び出し文脈: CI deploy 認証失敗の診断/予防）

### pilot-verify（フィールド区分の裏取り記録）
- 両 URL を 2026-08-07 に WebFetch 済み。結論: フィールド区分は両側とも正確・訂正なし
- agentskills.io/specification の frontmatter 表（全 6 フィールド）: `name`(必須), `description`(必須), `license`, `compatibility`, `metadata`, `allowed-tools`(Experimental 注記付き)
- code.claude.com/docs/en/skills.md も spec 側を同一に確認: claude.ai アップロード / Skills API / package_skill.py で使えるのは "`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`"
- 同 docs のエラー例が spec 6 フィールドを裏付け: "Allowed properties are: allowed-tools, compatibility, description, license, metadata, name"
- Claude Code 専用（CC の frontmatter reference 表にあり spec に無い）: `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell`
- 補足: `allowed-tools` は両属（spec では Experimental、CC では turn 限定の事前許可）。CC の `name` は表示名専用（コマンド名はディレクトリ名由来）という意味差はあるがフィールド自体は spec 正式

## claude-code-docker-sandbox
- reviewed-at: 2026-08-07 / last-commit: 2026-06-15（作業ツリーの未コミット変更を含む現状をレビュー）
- files-read: 7 (SKILL.md + references/ 6 件) / sources-checked: ~/.claude/cache/changelog.md (2.1.224), https://agentskills.io/specification, https://registry.npmjs.org/@anthropic-ai/claude-code/latest, https://raw.githubusercontent.com/anthropics/claude-code/main/.devcontainer/init-firewall.sh, https://code.claude.com/docs/en/data-usage.md, https://code.claude.com/docs/en/sandboxing.md, https://code.claude.com/docs/en/permission-modes.md, https://code.claude.com/docs/en/settings.md, https://endoflife.date/api/rust.json, https://endoflife.date/api/nodejs.json, dig (statsig.anthropic.com / downloads.claude.ai)
- verdict: needs-update

### findings
- [a][high] description が 1071 文字で spec 上限 1024 超過（"Must be 1-1024 characters"）— skills-ref validate 不合格・spec 準拠エージェントで拒否されうる | evidence: SKILL.md:3 | fix: 末尾の "Covers ..." 列挙を本文に移して 1024 字以下に圧縮 | source: https://agentskills.io/specification
- [b][med] RUST_VERSION=1.78.0（2024-05）が既定のまま。現行 stable 1.97（2026-07-09）、edition2024 crate は rustc ≥1.85 必須で新規 sandbox の `cargo build` が普通に失敗する | evidence: references/Dockerfile:104 | fix: 既定を現行 stable に更新し Go と同様の「ビルド前に現行版確認」注記を追加 | source: https://endoflife.date/api/rust.json（2026-08-07 確認）
- [a][low] 完了基準「logs end with `Firewall verification passed...`」だが compose の command は firewall 後に npm i -g / jq を実行するためログ末尾はそれらの出力になる（本文とテンプレの齟齬） | evidence: SKILL.md:40（references/docker-compose.yml:68-76） | fix: "end with" → "contain" に変更
- [b][low] 「umbrella (= these three + DISABLE_TELEMETRY)」の 4 分解は現行 docs と厳密には不一致 — umbrella は feedback survey 等も止める（別途 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY が存在）。分割運用では survey が有効のまま | evidence: references/docker-compose.yml:36-37（SKILL.md:88 も同旨） | fix: 「≒」の近似と明記するか survey 無効化 env を追記 | source: https://code.claude.com/docs/en/data-usage.md（2026-08-07 確認）
- [b][low] 「Empirically the flags arrive via api.anthropic.com」の empirical 前置きは陳腐化 — feature-flag evaluation が DISABLE_TELEMETRY / umbrella で無効化されることは現行 docs に明記済みで、公式出典に置換可能 | evidence: SKILL.md:88 | fix: docs 引用に差し替えて記述を強化 | source: https://code.claude.com/docs/en/data-usage.md
- [b][low] GHC_VERSION=9.6.5 / CABAL_VERSION=3.10.3.0 / pnpm@9.15.0 の既定 pin が 2024 年世代のまま | evidence: references/Dockerfile:115-116（references/docker-compose.yml:70） | fix: 次回改修時に既定を更新 | source: 要確認（GHCup 現行 recommended 未照合）
- [a][low] references/docker-compose.override.yml が SKILL.md からリンクされていない（同内容 YAML をインライン掲載のみ）— 他 5 ファイルはすべてリンク済みで発見性に差 | evidence: SKILL.md:211-217 | fix: 他の references 同様に明示リンクを追加

### notes
- 中核主張は全件裏取りで現行一致を確認: statsig.anthropic.com の A レコード不在（dig 本日）、上流 reference の allowlist に statsig.anthropic.com/sentry.io/VS Code 域が残存かつ retry・-exist 無し（raw.githubusercontent.com main）、updater host downloads.claude.ai（changelog 2.1.116）、engines.node >=22（npm registry 2.1.224）、deny rules は bypassPermissions でも適用、enableWeakerNestedSandbox の /proc 根拠、DISABLE_FEEDBACK_COMMAND 実在。
- node:24 = Active LTS は本日時点で正（Node 26 LTS 化は 2026-10-28 予定 — その時点で Dockerfile:1 の注記どおり bump 判断）。
- 分割不要: 呼び出し文脈は「sandbox 環境の構築・運用」1 つに収束し、sandboxed-agent-git-relay / cloudflare-workers-e2e-playwright とは重複なく相互参照済み。225 行で 500 行制限内。

## cloudflare-cron-to-discord
- reviewed-at: 2026-08-07 / last-commit: 2026-04-22
- files-read: 4 (SKILL.md, references/implementation.md, references/operations.md, references/testing.md) / sources-checked: https://developers.cloudflare.com/workers/configuration/cron-triggers/, https://developers.cloudflare.com/workers/vite-plugin/, https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/, https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/（旧 URL v3-to-v4 は 404 確認）, https://registry.npmjs.org/@cloudflare/vite-plugin/latest, https://registry.npmjs.org/vitest/latest, https://nodejs.org/docs/latest-v20.x/api/globals.html, WebSearch（Dashboard 手動トリガーボタン）
- verdict: needs-update

### findings
- [b][high] ローカル cron テストの現行公式手順は `/cdn-cgi/handler/scheduled`（wrangler dev と vite-plugin 双方が公開、＋wrangler dev の `s` キー）であり、「vite-plugin ではローカル cron テスト不可→skip か major bump」という本 skill の中核 caveat は現行構成では不成立 | evidence: SKILL.md:97, operations.md:234 | fix: caveat 全体を 0.1.x legacy 注記に降格し、現行 endpoint での curl 手順に書き換え | source: https://developers.cloudflare.com/workers/configuration/cron-triggers/（2026-08-07 確認）
- [b][high] 「v20 has fetch behind a flag」は事実誤り — global fetch は v18.0.0 以降フラグ不要でデフォルト有効 | evidence: testing.md:192 | fix: 「Node 22 要件は本プロジェクトの engines 由来」とだけ書き flag 記述を削除 | source: https://nodejs.org/docs/latest-v20.x/api/globals.html（2026-08-07 確認）
- [b][high] Dashboard「Triggers → "Send event" / "Run now"」ボタンは現行 cron-triggers docs に記載がなく Web 検索でも実在を確認できない — 本 skill の prod 検証・診断フロー 5 箇所（B-1/B-3/rotation/secret check/SKILL.md option 3）がこのボタン前提 | evidence: SKILL.md:103, operations.md:118 | fix: 実在を確認し、なければ次回スケジュール待ち＋`wrangler tail` ベースの手順へ差し替え | source: https://developers.cloudflare.com/workers/configuration/cron-triggers/（2026-08-07 確認）| 要確認
- [b][med] バージョン前提が陳腐化: 現行 @cloudflare/vite-plugin は 1.51.1（peer: wrangler ^4.120.0, vite ^6.1||^7||^8）で、「0.1.21 = wrangler@3.x baseline」は 2026-08 時点の新規構成では既定でない。description 自体に `@cloudflare/vite-plugin@0.1.x` が焼き込まれ発動条件も陳腐化 | evidence: SKILL.md:3, operations.md:231 | fix: 1.x/wrangler4 を既定とし 0.1.x 節は「古い skeleton の場合」に限定 | source: https://registry.npmjs.org/@cloudflare/vite-plugin/latest（2026-08-07 確認）
- [b][med] 参照 URL `workers/wrangler/migration/v3-to-v4/` は 404（リダイレクトなし）。現行は `migration/update-v3-to-v4/` | evidence: operations.md:278 | fix: URL を update-v3-to-v4 に修正 | source: https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/（2026-08-07 確認）
- [a][med] 公開 skill から作者私有の `routine-tasks` プロジェクト・その CLAUDE.md・`docs/status.md` 運用への参照が残り、第三者利用者には辿れない（移植性） | evidence: testing.md:205, operations.md:219, operations.md:253 | fix: 私有プロジェクト参照を汎用的な表現に置換
- [b][low] 「There's no retry semantics to leverage anyway」「fire-once-per-schedule」の断定は、現行 cron-triggers docs の past events に `noRetry`（"when the scheduled handler calls controller.noRetry()"）が載る点と緊張関係（ただし scheduled handler API ページには noRetry 記載なしで docs 側も不整合） | evidence: SKILL.md:42（SKILL.md:26 も） | fix: retry 仕様を確認のうえ断定を弱める | source: https://developers.cloudflare.com/workers/configuration/cron-triggers/ ＋ https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/（2026-08-07 確認）| 要確認
- [b][low] 例示 devDependency `"vitest": "^2.1.0"` は 2 メジャー遅れ（現行 4.1.10） | evidence: implementation.md:197 | fix: 例示を ^4 系へ更新 | source: https://registry.npmjs.org/vitest/latest（2026-08-07 確認）
- [a][low] compatibility は「Targets Cloudflare Workers with Hono + vitest」と謳うが、本 skill の全コードは Hono 非依存 | evidence: SKILL.md:5 | fix: Hono 言及を削除するか「skeleton 側の構成」と明記
- [a][low] operations は `0 * * * *` 回避（thundering herd）を推奨する一方、testing のテスト名は "Cron '0 * * * *' fires with minute 0 (sanity)" と `0 * * * *` 前提で不整合 | evidence: testing.md:73, operations.md:82 | fix: テスト名を推奨スケジュール（例: `15 * * * *`）に揃える

### notes
- frontmatter は spec 正式フィールドのみ（name/description/license/compatibility/metadata）で Claude Code 専用フィールド混入なし。SKILL.md 147 行・progressive disclosure と references リンクは良好
- 呼び出し文脈は「cron→Discord 配線＋その運用診断」の単一系で分割不要。前提の deploy-skeleton との役割分担も明確で c 軸所見なし
- Dashboard ボタンと retry 仕様は公式 docs の記載が薄く断定を避けて 要確認 とした（skill 側が正しい可能性も残る）

## cloudflare-d1-drizzle-migration
- reviewed-at: 2026-08-07 / last-commit: 2026-04-22
- files-read: 5 (SKILL.md + references/{runbook,phased-column-migration,d1-drizzle-kit-pitfalls,lessons}.md) / sources-checked: https://developers.cloudflare.com/d1/sql-api/foreign-keys/, https://developers.cloudflare.com/d1/reference/time-travel/, https://developers.cloudflare.com/d1/wrangler-commands/, WebSearch→github.com/drizzle-team/drizzle-orm issues #3065・#4089（drizzle-kit の PRAGMA 生成現況）
- verdict: needs-update

### findings
- [b][high] 「D1 doesn't offer point-in-time restore at the time of writing」は事実誤り — Time Travel が常時有効の PITR（paid 30 日 / free 7 日、`wrangler d1 time-travel restore`）を提供し、docs は「restore a database prior to a failed migration or schema change」とまさに本 skill のユースケースを明記 | evidence: references/d1-drizzle-kit-pitfalls.md:67（見出し :65「the only reliable backup」も同罪） | fix: §4 を「Time Travel = 主たる PITR、export = 補完（部分復旧・長期保管用）」に書き換え | source: https://developers.cloudflare.com/d1/reference/time-travel/（2026-08-07 確認）
- [b][med] 復旧手順（step 7）に `wrangler d1 time-travel restore` の選択肢が無い — migration 失敗直後の全 DB 巻き戻しには最速の手段（ただし適用済み migration ごと戻る注記が必要）で、抽出 INSERT 復元（新スキーマ維持）との使い分けを示すべき | evidence: references/runbook.md:92 | fix: step 7 に Time Travel 代替と使い分け基準を追記 | source: https://developers.cloudflare.com/d1/reference/time-travel/（2026-08-07 確認）
- [a][med] 「safe (additive)」リスト内に未検証の著者メモ「(wait — does this rebuild? verify on a spike)」が残存 — 安全分類として提示しながら自ら疑っており、誤分類なら runbook スキップにつながる | evidence: references/d1-drizzle-kit-pitfalls.md:46 | fix: spike で検証して確定分類に移し、括弧書きメモを削除
- [a][low] SKILL.md:100 は PITR を「存在するがスコープ外」と扱う一方、pitfalls.md:67 は存在自体を否定 — 本文と references の矛盾 | evidence: SKILL.md:100 vs references/d1-drizzle-kit-pitfalls.md:67 | fix: b-high 修正時に両者を整合
- [a][low] SKILL.md の 6-step 要約（backup→audit→inspect→apply→verify→restore）と runbook.md の 8-step（audit→generate→counts→backup→…）で順序・番号が不一致、counts 記録ステップも要約から欠落（phased-column-migration.md:140 は runbook 番号を参照しており要約だけ浮いている） | evidence: SKILL.md:61-66 vs references/runbook.md:5-99 | fix: 要約の順序と番号を runbook.md に揃える
- [c][low] scope boundary の「weekly snapshots, PITR — different concern」に sibling skill `cloudflare-d1-weekly-backup-via-pr` への相互参照が無い（deploy-skeleton は参照する house style と不整合） | evidence: SKILL.md:100 | fix: 該当行に skill 名を明記

### notes
- 中核主張（D1 が `PRAGMA foreign_keys=OFF` を無視 / `defer_foreign_keys` は違反チェック遅延のみで CASCADE 発火は抑止しない / drizzle-kit が現在も当該 PRAGMA を生成）は foreign-keys docs と drizzle-orm issues #3065・#4089 で現行一致を確認済み — 陳腐化なし。
- Time Travel は 2023 年 GA のため last-commit（2026-04-22）時点でも誤りだった＝ドリフトではなく執筆時からの事実誤認。drizzle-kit の生成 SQL 形状は公式 docs に明文が無く GitHub issues での裏取りに留まる。

## cloudflare-d1-weekly-backup-via-pr
- reviewed-at: 2026-08-07 / last-commit: 2026-04-25
- files-read: 4 / sources-checked: https://developers.cloudflare.com/d1/reference/time-travel/, https://developers.cloudflare.com/d1/best-practices/import-export-data/, https://docs.github.com/en/actions/using-workflows/using-github-cli-in-workflows, https://docs.github.com/en/rest/actions/permissions?apiVersion=2022-11-28, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository, api.github.com/repos/{peter-evans/create-pull-request,actions/checkout,actions/setup-node,pnpm/action-setup}/releases/latest, skills/cloudflare-api-token-permissions/SKILL.md（観点c照合）
- verdict: needs-update

### findings
- [b][high] "D1 doesn't natively support PITR yet" は事実誤り。Time Travel は常時有効の PITR（paid 30日 / free 7日、`wrangler d1 time-travel restore`） | evidence: SKILL.md:209 | fix: Time Travel の存在を明記し、本 skill を「30日超・オフプラットフォーム・レビュー可能な長期バックアップ」と再定位 | source: https://developers.cloudflare.com/d1/reference/time-travel/ （2026-08-07 確認）
- [b][high] Discord 通知の任意ステップが `gh pr list` を `GH_TOKEN` 未設定で実行→Actions 内では必ず失敗（"you must set an environment variable called GH_TOKEN"） | evidence: references/workflow-yml-template.md:117-126 | fix: step の env に `GH_TOKEN: ${{ github.token }}` を追加 | source: https://docs.github.com/en/actions/using-workflows/using-github-cli-in-workflows （2026-08-07 確認）
- [b][med] `peter-evans/create-pull-request@v7` 指定が旧メジャー。現行 v8.1.1（2026-04-10 公開、last-commit 以前に存在） | evidence: SKILL.md:5,42,84 / references/workflow-yml-template.md:49 | fix: @v8 へ更新し入力互換を再確認（frontmatter compatibility の "@v7" 明記も更新） | source: https://api.github.com/repos/peter-evans/create-pull-request/releases/latest （2026-08-07 確認）
- [b][med] テンプレートの action ピンが軒並み旧メジャー: `actions/checkout@v4`（現行 v7.0.1）、`actions/setup-node@v4`（現行 v7.0.0）、`pnpm/action-setup@v4`（現行 v6.0.10） | evidence: references/workflow-yml-template.md:26-30 | fix: 各 action を現行メジャーへ更新 | source: https://api.github.com/repos/actions/checkout/releases/latest ほか releases/latest 3件（2026-08-07 確認）
- [b][low] Actions artifacts の「90-day retention max」は private repo では不正確（1–400日まで設定可、default 90日。本 skill の前提は private repo） | evidence: references/backup-vs-gitignore-decision.md:54 | fix: 「default 90日、private は最大400日まで延長可だが主バックアップ用途ではない」に修正 | source: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository （2026-08-07 確認）
- [b][low] "It's a misleading name — the docs explicitly say so" は現行 REST docs で裏付け不可（`can_approve_pull_request_reviews` の説明は "Whether GitHub Actions can approve pull requests." のみで creation に言及なし。挙動自体の記述は正しい） | evidence: references/gh-actions-create-pr-permission.md:49 | fix: 「docs explicitly say so」を削るか UI 設定名（create and approve）との対応として書き直す | source: https://docs.github.com/en/rest/actions/permissions?apiVersion=2022-11-28 （2026-08-07 確認）| 要確認
- [c][low] CLOUDFLARE_API_TOKEN スコープ節（7403 → `Account / D1 : Edit`）は cloudflare-api-token-permissions のエラーコード対応表と重複 | evidence: SKILL.md:160-168 | fix: 節は簡潔に残し `cloudflare-api-token-permissions` skill への相互参照を追記（line 207 の drizzle-migration 参照と同形式）

### notes
- references/workflow-yml-template.md:135-142 のサイズ検査は `stat -c%s backups/backup-weekly-*.sql` が過去バックアップ蓄積後に複数行を返し `[ -lt ]` が常に不成立→検査が無言で素通りする潜在バグ。ルーブリック 3 観点のどれにも収まらないため notes 記載。
- `wrangler d1 export --remote --output` 構文と `d1 execute --file` restore ペアは現行 docs と一致（import-export-data ページで確認）。export に必要なトークンスコープは docs 未記載のため D1:Edit 主張は未検証のまま容認。
- 分割は不要と判断: 呼び出し文脈は「週次バックアップ導入」単一で、references は全て同一文脈の下位詳細。

## cloudflare-mcp-claude-tooling
- reviewed-at: 2026-08-07 / last-commit: 2026-06-12
- files-read: 3 / sources-checked: ~/.claude/cache/changelog.md (2.1.224; entries 2.1.191, 2.1.196), https://code.claude.com/docs/en/mcp.md, https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/, https://github.com/cloudflare/mcp-server-cloudflare, https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs, live probe curl POST https://docs.mcp.cloudflare.com/mcp（無認証 initialize → HTTP 200）
- verdict: needs-update

### findings
- [b][high] 「MCP OAuth は localhost callback 必須でコンテナ内は高摩擦」は Claude Code 2.1.191 で陳腐化 — headless 検出時は authorization URL を表示し redirect URL を貼り戻す callback 不要フロー（`--no-browser` あり）。ポート公開不要 | evidence: SKILL.md:36 | fix: docs-only の根拠を wrangler 重複側に寄せ、OAuth は「2.1.191+ なら URL 貼付で完結」と書き換え | source: ~/.claude/cache/changelog.md L814 (2.1.191) + https://code.claude.com/docs/en/mcp.md（2026-08-07 確認）
- [a][med] SKILL.md:56 "Allow only the *read* git/gh verbs" と矛盾して template が `Bash(gh api:*)` を許可 — gh api は POST/DELETE 可（PR merge・contents push 等）で deny commit/push ガードを迂回し得る | evidence: references/settings.json:35 | fix: `gh api` を削除するか read 用途の説明付き限定に絞る
- [b][med] サーバ一覧が現行ラインナップと不一致 — 統合「Cloudflare API」サーバ `https://mcp.cloudflare.com/mcp`（OAuth or API token, Code Mode）が登場済みで表に無く、blockquote の Bearer-token 助言はこのサーバが公式に担う形に | evidence: SKILL.md:27-39 | fix: 表に mcp.cloudflare.com 行を追加し、account ops が要る場合の一次候補として API-token 認証で案内 | source: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/（2026-08-07 確認）
- [b][med] grill-with-docs の複製指示 "copy SKILL.md + CONTEXT-FORMAT.md + ADR-FORMAT.md" が上流再編で実行不能 — 当該ディレクトリは現在 SKILL.md + agents/ のみ | evidence: SKILL.md:80 | fix: 「上流ディレクトリを丸ごとコピー」に変更 | source: https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs（2026-08-07 確認）
- [b][low] Verify の `claude mcp list` → "✓ Connected" 期待は 2.1.196 以降 trust 承認前だと `⏸ Pending approval` 表示（committed settings による自己承認も無効化） | evidence: SKILL.md:89 | fix: 「workspace trust 承認後に実行」の 1 行を追記 | source: ~/.claude/cache/changelog.md L739 (2.1.196) + https://code.claude.com/docs/en/mcp.md（2026-08-07 確認）
- [a][low] template の `"enableAllProjectMcpServers": false` が SKILL.md 本文で一切説明されず意図が発見不能 | evidence: references/settings.json:45 | fix: settings.json 節に「false で server ごとに個別承認させる」1 行を追加

### notes
- docs サーバ無認証は生 probe（無認証 initialize → 200）で確認。CF docs ページの auth 列は "OAuth" 表記だが実挙動と不一致で、skill の "none" 側が正
- docs-only という結論自体は wrangler 重複の根拠だけで今も成立。high 所見は結論でなく理由付けの書き換え要求
- 分割は不要と判定: 全節が「sandbox 直後の 1 回のセットアップ」という単一呼び出し文脈に収まる

## cloudflare-workers-bot-scan-defense
- reviewed-at: 2026-08-07 / last-commit: 2026-06-14
- files-read: 4（SKILL.md, references/attack-surface-audit.md, references/caveats.md, references/configuration.md）+ rubric / sources-checked: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, https://developers.cloudflare.com/workers/wrangler/configuration/, https://developers.cloudflare.com/workers/observability/logs/workers-logs/, https://developers.cloudflare.com/workers/observability/query-builder/, https://developers.cloudflare.com/fundamentals/reference/http-request-headers/, https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/, https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/（WebSearch 経由）
- verdict: needs-update

### findings
- [a][med] frontmatter description が実測 1144 字で spec 上限 1024 字を超過（互換エージェントで検証エラー/切り捨ての恐れ） | evidence: SKILL.md:3 | fix: "Covers ..." 以降の詳細列挙を本文へ移し 1024 字以内に圧縮 | source: https://agentskills.io/specification
- [b][med] "Without this block the Workers Observability dataset is **empty for your script**" と compatibility の "requires enabling per-Worker" は陳腐化 — 現行 docs は "All newly created Workers will come with the observability setting enabled by default"（wrangler config 側も enabled "Defaults to true for all new Workers"） | evidence: SKILL.md:96（+:5） | fix: 「新規 Worker は既定で有効、既存/明示 off の Worker のみ空になる」に断定を緩め、明示ブロック追加は推奨として維持 | source: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ ＋ https://developers.cloudflare.com/workers/wrangler/configuration/（確認 2026-08-07）
- [b][low] WAF Rate Limiting Rules の Dashboard 導線 "Dashboard → Security → WAF → Rate limiting rules" は旧 UI — 現行 docs は "Security rules → Create rule → Rate limiting rules" | evidence: SKILL.md:239, references/caveats.md:70 | fix: 導線表記を現行に更新（2 箇所） | source: https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/（確認 2026-08-07）
- [a][low] 存在しない `auth-brute-force` skill を 2 箇所で参照しており読者を迷子にする（repo 一覧に該当なし） | evidence: SKILL.md:33, SKILL.md:247 | fix: 「別レイヤの設計（本 repo に専用 skill なし）」等の表現に改める
- [a][low] unsafe fallback・middleware・fail-open のコード全文が SKILL.md と configuration.md に二重掲載で既に微差あり（fail-open の `message` 有無）— progressive disclosure 的には references を正本に | evidence: SKILL.md:121-186 vs references/configuration.md:59-153 | fix: SKILL.md 側は最小形＋リンクへ縮約
- [b][low] Observability の filter 名 `$metadata.trigger` が現行 docs（query-builder / workers-logs）で確認できず — Dashboard UI 由来の名称で照合不能 | evidence: SKILL.md:203-205, references/caveats.md:51 | fix: 現行 Dashboard で filter 名を実機確認し表記を更新 | source: https://developers.cloudflare.com/workers/observability/query-builder/（確認 2026-08-07） | 要確認
- [c][low] credential-free 検証節は cloudflare-workers-builds-keyless-deploy / sandboxed-agent-git-relay と文脈が接続するのに相互参照が無い（重複ではなく発見性の問題、分割不要） | evidence: SKILL.md:216-224 | fix: 両 skill 名を明示クロスリンク

### notes
- 中核事実は全て現行一致を確認（2026-08-07）: top-level `ratelimits`・wrangler 4.36.0+・`period` 10|60・`namespace_id` 正整数文字列・eventually consistent/per-location の文言・`limit({key})`→`{success}`・GA（changelog 2025-09-19、"Existing deployments using the unsafe binding will continue to function" で v3 fallback 記述とも整合）・True-Client-IP Enterprise 限定・`limits.cpu_ms`・`not_found_handling`/`run_worker_first`。
- 呼び出し文脈は「新規公開 Worker のボットスキャン対策」単一で 260 行 — 分割不要。verdict は med 2 件（description 超過・observability 既定値変化)の修正を要する点のみで needs-update。

## cloudflare-workers-builds-keyless-deploy
- reviewed-at: 2026-08-07 / last-commit: 2026-06-12
- files-read: 3 / sources-checked: developers.cloudflare.com/workers/ci-cd/builds/{,configuration/,limits-and-pricing/,build-branches/,git-integration/github-integration/}, developers.cloudflare.com/workers/configuration/previews/, developers.cloudflare.com/workers/wrangler/configuration/, docs.github.com/.../trigger-a-workflow, docs.github.com/.../about-rulesets, docs.github.com/.../creating-rulesets-for-a-repository, api.github.com/apps/github-actions, github.com/cloudflare/workers-sdk/issues/5077, github.com/cloudflare/workers-sdk/discussions/11434 (via WebSearch), github.com/pnpm/action-setup, github.com/actions/checkout
- verdict: needs-update

### findings
- [b][med] ci-yml.md テンプレの action pin が現行メジャーから乖離（checkout@v4→現行 v7、pnpm/action-setup@v4→現行 v6、pnpm 9.15.0 ハードコードは pnpm 現行 11 系・packageManager 参照推奨と不整合） | evidence: references/ci-yml.md:28-32 | fix: checkout@v7 に上げ、pnpm は version ハードコードをやめ packageManager 参照（pnpm≥11 は pnpm/setup）へ | source: https://github.com/actions/checkout, https://github.com/pnpm/action-setup
- [b][low] 引用 issue workers-sdk #5077（d1 migrations silent fail）は closed — 現行 wrangler ではエラー表示が改善済みの可能性があり「fail silently / opaquely」の症状描写が古い恐れ（default token に D1 Edit が無い罠自体は現行 docs で確認済み） | evidence: SKILL.md:54 | fix: 現行 wrangler で再現確認し「(closed)」注記か症状文言を緩和 | source: https://github.com/cloudflare/workers-sdk/issues/5077 | 要確認
- [b][low] 「ruleset enforcement is free on public repos; private repos need a paid plan」の plan 可用性記述 — 現行 about-rulesets / creating-rulesets には repo レベルの plan・visibility 可用性の明文が見当たらず（Team/Enterprise 言及は org ruleset 文脈のみ）、裏取り不能 | evidence: references/ruleset.md:8-9 | fix: GitHub docs の availability 記載を再確認し出典つきで文言更新 | source: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets | 要確認
- [b][low] 「As of 2026-06」「Verified against live docs 2026-06-10」の鮮度スタンプ — OIDC 不在は 2026-08-07 時点も現行どおり（workers-sdk discussion #11434 が open な feature request のまま、external-cicd docs も apiToken のみ）なので内容は正・日付のみ更新 | evidence: SKILL.md:15 | fix: verified 日付を更新し discussion #11434 を出典に明記 | source: https://github.com/cloudflare/workers-sdk/discussions/11434

### notes
- コア主張は全て 2026-08-07 の現行 docs と一致を確認: default build token のスコープに D1 なし（KV/R2/Scripts/Routes のみ）、preview_database_id は wrangler dev 限定→uploaded preview 版が本番 D1 共有、push トリガーで CI 非待機、Free 3,000 min/1 並列/20 min、Branch control の「Builds for non-production branches」、check run 送信、GitHub Actions app id 15368。
- references/ci-yml.md:47-49 の「GITHUB_TOKEN 作成 PR は Approve workflows to run ゲートに掛かる」は現行 GitHub docs が明記（pull_request イベントは approval-required 状態の run を生成）— 正確なので所見にせず。
- frontmatter は spec 正式フィールドのみ・80 行・単一呼び出し文脈のため (a)(c) 所見なし。

## cloudflare-workers-deploy-skeleton
- reviewed-at: 2026-08-07 / last-commit: 2026-04-22
- files-read: 10 / sources-checked: https://developers.cloudflare.com/workers/wrangler/configuration/, https://developers.cloudflare.com/workers/static-assets/routing/worker-script/, https://developers.cloudflare.com/workers/configuration/cron-triggers/, https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/, https://developers.cloudflare.com/workers/languages/typescript/, https://developers.cloudflare.com/workers/vite-plugin/, https://github.com/actions/checkout/releases, https://github.com/actions/setup-node/releases, https://github.com/pnpm/action-setup/releases
- verdict: needs-update

### findings
- [b][high] dev の Cron テスト endpoint `/__scheduled` は旧仕様 — 現行 docs は `/cdn-cgi/handler/scheduled`（wrangler dev 8787 / vite-plugin 5173 両対応）のみ記載 | evidence: references/pitfalls.md:86-98（同旨 references/tsconfig-and-vite.md:68, SKILL.md:81） | fix: pitfall #5 を現行 endpoint 名に書き直し「vite-plugin は未対応」前提を撤回 | source: https://developers.cloudflare.com/workers/configuration/cron-triggers/ (2026-08-07)
- [b][med] 新規 project の baseline を `wrangler@^3.100.0`+`@cloudflare/vite-plugin@^0.1.0` とするのは陳腐化 — 現行メジャーは wrangler v4（migration guide 最終更新 2026-04-23） | evidence: references/wrangler-template.md:25,32,38 | fix: wrangler@^4 + vite-plugin@^1 を既定にし 3.x/0.1.x は互換注記へ降格 | source: https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/ (2026-08-07)
- [b][med] `actions/checkout@v4`・`actions/setup-node@v4` は現行最新メジャー v7 に対し 3 世代遅れ | evidence: references/gh-actions-template.md:25,29 | fix: 両方 v7 へ更新 | source: https://github.com/actions/checkout/releases, https://github.com/actions/setup-node/releases (2026-08-07)
- [b][med] `pnpm/action-setup@v4` は現行最新メジャー v6 | evidence: references/gh-actions-template.md:26 | fix: v6 へ更新 | source: https://github.com/pnpm/action-setup/releases (2026-08-07)
- [b][med] `@cloudflare/workers-types` 依存 + tsconfig `types` 指定は現行推奨と乖離 — Worker 本体は `wrangler types` 生成が公式推奨（workers-types 自体は非推奨ではない） | evidence: references/wrangler-template.md:26, references/tsconfig-and-vite.md:25,34 | fix: `wrangler types` で worker-configuration.d.ts を生成する手順へ差し替え | source: https://developers.cloudflare.com/workers/languages/typescript/ (2026-08-07)
- [b][low] テンプレ固定値の経年（`compatibility_date: "2025-03-28"`, `pnpm@9.15.0`, node 22）が新規 project 生成時にそのままコピーされる | evidence: references/wrangler-template.md:47, references/setup-order.md:69-71 | fix: 「生成時に当日日付・現行 LTS/メジャーへ置換」の指示に変更 | source: https://developers.cloudflare.com/workers/wrangler/configuration/ | 要確認（pnpm/node の現行版は未照合）
- [a][low] SKILL.md の L3 スニペットが `res` 未定義の擬似コード（worker-template の完全形と字面不一致、コピーすると壊れる） | evidence: SKILL.md:45 | fix: 表内は要約に留め「full code in worker-template.md」と明示
- [c][low] GH Actions + API トークン型 deploy は `cloudflare-workers-builds-keyless-deploy`（トークンレス代替）と選択関係だが相互参照が無い | evidence: SKILL.md:83-90 | fix: scope boundary 節に keyless-deploy skill への 1 行参照を追加

### notes
- wrangler.jsonc の主要キー（assets.run_worker_first / not_found_handling / migrations_dir / triggers.crons / $schema）は現行 config reference と全一致 — 設定キー自体の陳腐化なし。boolean `run_worker_first` も非推奨化されていない
- vite-plugin docs ページはバージョン詳細を非掲載のため、baseline 陳腐化の裏取りは wrangler v4 migration guide を根拠にした
- checkout/setup-node のリリース日は GitHub の相対表記由来で年の取り違え可能性があるが、最新メジャーが v7 である点はリリース一覧の並びから確実

## cloudflare-workers-e2e-playwright
- reviewed-at: 2026-08-07 / last-commit: 2026-06-15
- files-read: 8 / sources-checked: https://agentskills.io/specification, https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, https://developers.cloudflare.com/workers/wrangler/commands/workers/, https://developers.cloudflare.com/workers/static-assets/binding/, npm registry (`@cloudflare/vite-plugin` → 1.51.1), skills/cloudflare-workers-bot-scan-defense/SKILL.md（重複判定）
- verdict: needs-update+split

### findings
- [a][high] frontmatter が spec 上限超過: description 1220 字（上限 1024）・compatibility 540 字（上限 500）で `skills-ref validate` 不合格、spec 準拠ローダーで拒否されうる | evidence: SKILL.md:3,5 | fix: 症状列挙を本文「When to use」へ移し description ≤1024 / compatibility ≤500 に圧縮 | source: https://agentskills.io/specification（2026-08-07）
- [b][med] Trap 3 が wrangler 3.x の `unsafe` 形のみ前提だが、現行 wrangler は 4.36.0+ でトップレベル `ratelimits` キーが正式形 — v4 ネイティブ設定の project では `delete cfg.unsafe` が何も strip しない | evidence: SKILL.md:235-244, references/in-container-playwright-bake.md:124-141 | fix: `delete cfg.ratelimits` を併記し版数分岐を注記（bot-scan-defense と整合させる）| source: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/（2026-08-07）| 要確認（ネイティブ binding が credential-free ローカル dev で同様に hang するかは docs 未記載）
- [b][med] Trap 1 の症状記述（「initial `/` は動き reload だけ壊れる」）が `@cloudflare/vite-plugin@0.1.x` 固定 — 現行は 1.51.1 で、reference 側にはある「newer versions では initial load も壊れる」ヘッジが SKILL.md 本文に無い（診断ミスリード。修正法自体は不変） | evidence: SKILL.md:64（cf. references/csp-vs-vite-hmr-preamble.md:52）| fix: SKILL.md:64 に 1.x では初回ロードから発火しうる旨を 1 文追加 | source: npm registry `@cloudflare/vite-plugin@1.51.1`（2026-08-07）
- [a][med] `--persist-to` の値が不整合: Trap 2 の根拠（migrations と同じ `.wrangler/state` に固定せよ）に対し Trap 4 の snippet は無説明で `.wrangler/state-e2e` — 後者を逐語コピーすると seed/migrate 側も同 path にしない限り Trap 2 の空 DB が再発 | evidence: SKILL.md:255・references/in-container-playwright-bake.md:165 vs SKILL.md:38,82-88 | fix: path を統一するか「dev-reset/seed も同じ --persist-to を渡す」を 1 行明記
- [c][med] 独立した呼び出し文脈が 2 つ: (i) e2e wiring 本体（traps 1-2 ＋ auth seams ＋ scope）と (ii) sandbox/credential-free 実行（bake ＋ traps 3-4。`claude-code-docker-sandbox` 前提で、traps 3/4 は e2e 無関係の「credential-free `wrangler dev` が hang する」調査でも必要なのに description の e2e 文脈に埋没）— description 上限超過(所見1)の主因もこの同居 | evidence: SKILL.md:173-261, references/in-container-playwright-bake.md 全体 | fix: 新 skill `playwright-e2e-in-docker-sandbox`（desc 案: Bake Chromium at image-build time for zero-egress e2e inside claude-code-docker-sandbox; covers the two credential-free `wrangler dev` hangs — ratelimit binding remote proxy and `localhost` dual-stack bind）へ切り出し、本体 description は traps 1-2 ＋ WebAuthn/OAuth seam ＋ 3-spec scope に縮小
- [a][med] references/oauth-seeded-session-seam.md が「see the security-headers scope note in the main skill」と scheme 分岐 CSP（http では dev CSP）を参照するが、SKILL.md にその注記が存在せず、かつ本文 security-headers 節（L160）の「expected CSP を検証」と緊張する dangling 参照 | evidence: references/oauth-seeded-session-seam.md:93-96 vs SKILL.md:154-162 | fix: SKILL.md の security headers 節に http/https で CSP が分岐する場合の注記を追加するか参照文を削除
- [a][med] playwright-config-recipe.md（「full template」と紹介）が後付け内容と矛盾: deliverable 必須の DEVCONTAINER-gated `--no-sandbox` が無い、`baseURL: localhost`（Trap 4 は「127.0.0.1 end to end」）、`e2e:install` は bake ルール（runtime CDN blocked）と衝突 | evidence: references/playwright-config-recipe.md:47,59,72,102 vs SKILL.md:46,216,246-252 | fix: recipe に sandbox variant 節または bake reference への分岐ポインタを追記
- [a][low] Dockerfile block が SKILL.md:190-208 と references/in-container-playwright-bake.md:30-54 にほぼ逐語重複し、既に drift（`mkdir -p /ms-playwright` は reference のみ）— progressive disclosure 違反 | evidence: SKILL.md:190-208 | fix: SKILL.md 側は要点 3 行＋リンクに縮約し全文は reference のみに置く

### notes
- split は僅差判定: sandbox 利用者には同一セットアップ作業内で連続するが、非 sandbox 読者に約 90 行が dead weight で、description 圧縮も切り出しなしでは 1024 字に収まりにくい
- Trap 2 の「--persist-to 既定が config-relative」という中核主張自体は docs 未記載の経験則 — 現行 docs（--persist-to/--ip 記述）と矛盾しないことのみ確認、反証なし
- bot-scan-defense との関係は重複でなく隣接（deploy 検証 vs dev hang）で相互参照済み — 統合不要

## cloudflare-workflows-for-long-tasks
- reviewed-at: 2026-08-07 / last-commit: 2026-05-07
- files-read: 4 (SKILL.md, references/implementation.md, references/migration-pattern.md, references/pitfalls.md)
- sources-checked: https://developers.cloudflare.com/workers/runtime-apis/context/ / https://developers.cloudflare.com/queues/platform/limits/ / https://developers.cloudflare.com/workflows/build/workers-api/ / https://developers.cloudflare.com/workflows/reference/limits/ / https://developers.cloudflare.com/workers/languages/typescript/ / https://developers.cloudflare.com/workflows/build/local-development/ / https://developers.cloudflare.com/workers/wrangler/configuration/ / https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ / https://developers.cloudflare.com/workflows/observability/metrics-analytics/ / https://developers.cloudflare.com/workers/wrangler/commands/workflows/ / https://developers.cloudflare.com/workflows/ （404: workflows/platform/limits/, workflows/reference/how-workflows-works/）
- verdict: needs-update

### findings
- [b][high] Queues consumer「still bound by 30s per message」は誤り — 現行は invocation あたり wall clock 15 分・CPU 30s デフォルト（5 分まで設定可）で per-message 制限なし | evidence: SKILL.md:27（同旨 SKILL.md:160, references/migration-pattern.md:259） | fix: 「Queues は fan-out 向き・Workflows は durable 多段ジョブ向き」と duration 以外の軸で書き分け、15 min/CPU 30s の現行値に更新 | source: https://developers.cloudflare.com/queues/platform/limits/（2026-08-07 確認）
- [b][med] 型手順が `@cloudflare/workers-types` 前提だが、現行 docs は「`wrangler types` 生成型を推奨（package は非推奨ではないがライブラリ用途向け）」 | evidence: SKILL.md:102-116, references/implementation.md:209-227, frontmatter compatibility（SKILL.md:5） | fix: `wrangler types` → worker-configuration.d.ts を第一経路として追記（`Workflow` がグローバルで import 不要という核は両経路で有効） | source: https://developers.cloudflare.com/workers/languages/typescript/（2026-08-07 確認）
- [b][med] 「step.do() outputs are persisted to D1-backed storage」の D1-backed は現行 docs に記載が見つからず（landing は "persist state" のみ、how-workflows-works は 404 で一次確認不能） | evidence: SKILL.md:23 | fix: 「durably persisted by the Workflows runtime」等の実装非依存表現に言い換え | source: https://developers.cloudflare.com/workflows/（2026-08-07 確認・記載なし） | 要確認
- [b][med] Dashboard 導線「Workers & Pages → your worker → Workflows tab」が現行と不一致 — docs はアカウント直下の Workflows ページ（deep link /:account/workers/workflows）へ誘導 | evidence: references/migration-pattern.md:233, references/pitfalls.md:163 | fix: 「Dashboard の Workflows ページ → 対象 workflow → instance」に更新 | source: https://developers.cloudflare.com/workflows/observability/metrics-analytics/（2026-08-07 確認）
- [b][med] 「step 内 log は Dashboard のみ」は不完全 — `wrangler workflows instances describe [NAME] [ID]` が logs / retries / errors / step output を CLI で表示する | evidence: references/pitfalls.md:157-173, references/migration-pattern.md:232-235 | fix: デバッグ triage に `wrangler workflows instances describe` を追加（tail に出ない事実自体は維持でよい） | source: https://developers.cloudflare.com/workers/wrangler/commands/workflows/（2026-08-07 確認）
- [a][med] `pnpm vp check` / `pnpm vp build` / `vp dev` はレビュー元プロジェクト固有の script エイリアスで、読者環境では実行不能（skill 内に定義・説明なし） | evidence: references/migration-pattern.md:215-221, SKILL.md:162 | fix: 汎用コマンド（`tsc -p`, 各自の lint/build script, `wrangler dev`）へ置換
- [b][low] 「local Workflow emulation — limited」は粗い — 現行は `wrangler dev`（v3.89+）でエミュレーション対応、非対応なのは `--remote` / remote bindings | evidence: SKILL.md:162 | fix: 制約を「emulated・`--remote` 不可」と具体化 | source: https://developers.cloudflare.com/workflows/build/local-development/（2026-08-07 確認）
- [a][low] WorkflowEntrypoint クラス全文（約 60 行）が implementation.md と migration-pattern.md に二重掲載され drift リスク | evidence: references/implementation.md:7-105, references/migration-pattern.md:58-122 | fix: migration-pattern.md 側は差分要点＋implementation.md へのリンクに縮約

### notes
- 正確性確認済みで所見不要: waitUntil 30s 上限、`timeout` per-attempt と retries 書式・15 分計算、workflows[] の name/binding/class_name、Free+Paid 可用性、`create({params})` API、`Workflow` グローバル型。
- 観点 c: 単一の呼び出し文脈（waitUntil→Workflows 移行）で分割不要。repo 内 13 skill と重複なし（Queues/AI は明示的に scope 外宣言済み）。

## sandboxed-agent-git-relay
- reviewed-at: 2026-08-07 / last-commit: 2026-06-13
- files-read: 4 / sources-checked: https://agentskills.io/specification, https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app, https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app, https://docs.github.com/en/rest/pulls/pulls, https://docs.github.com/en/rest/apps/apps, https://docs.github.com/en/actions/using-workflows/triggering-a-workflow, https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, https://code.claude.com/docs/en/permissions.md, https://cli.github.com/manual/, ~/.claude/cache/changelog.md, (local) skills/cloudflare-workers-builds-keyless-deploy/references/ruleset.md 存在確認
- verdict: needs-update

### findings
- [a][med] description が 1173 字で spec 上限 1024 字を超過（skills-ref validate 不合格・他エージェントで切り捨てリスク） | evidence: SKILL.md:3 | fix: "Covers ..." 以降の失敗事例列挙を本文へ移し 1024 字以内に圧縮 | source: https://agentskills.io/specification（2026-08-07 確認）
- [a][med] E2E step 4 の根拠 "(no diff vs main)" が本 skill 自身の squash 分析と矛盾（squash 後は three-dot diff 非空のまま。実際のスキップは isTipAlreadyMerged 経由） | evidence: SKILL.md:141（vs SKILL.md:100-102, references/relay-mjs.md:125-128） | fix: "(isTipAlreadyMerged が squash 残渣を清掃)" に書き換え、または merge commit 方式前提と明記
- [b][low] JWT の iss は現行 docs で「client ID 推奨（App ID も引き続き有効）」だが、skill は Client ID を "not needed for this relay" と記載し App ID を使用 | evidence: references/github-app-setup.md:50（+ github-app-setup.md:67, relay-mjs.md:54） | fix: 「現在は client ID が iss 推奨・App ID も可」の注記を ID 表に追加 | source: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app（2026-08-07 確認）
- [a][low] SKILL.md step 1 のインライン権限チェックリストに Workflows 権限の注意（`.github/workflows/**` を含む push が拒否される）が無く reference にのみ存在、step 1 は reference 未リンク | evidence: SKILL.md:53 vs references/github-app-setup.md:11-13 | fix: step 1 に「agent が workflows を触るなら Workflows: RW 追加（詳細は references/github-app-setup.md）」を 1 句追加

### notes
- 重点照合した GitHub 記述は現行 docs と一致を確認: installation token 1h + repositories/permissions down-scope、JWT 10min/iat−60s、merge の 405/409/sha/squash、GITHUB_TOKEN 起点 PR の approval-required 状態、未認証 60 req/h。deny-in-bypassPermissions も permissions doc のモデル（bypass はプロンプト省略、deny はルール評価で遮断）と整合し矛盾なし。
- relay-mjs.md の credential-helper 方式は origin が HTTPS URL である前提（SSH remote だとユーザー鍵でサイレントに push され App を迂回）だが、ルーブリック外の観点のため所見化せず。
- 観点 c: 呼び出し文脈は「host relay の構築・運用」単一で分割不要。claude-code-docker-sandbox / cloudflare-workers-builds-keyless-deploy との役割分担は相互参照済みで重複なし。

## vercel-react-best-practices（上流 sync 専用チェック）
- reviewed-at: 2026-08-07 / last-commit: 2026-06-13
- files-read: 3（SKILL.md 冒頭・SOURCE.md・metadata.json ＋ rules/ 全 72 ファイル名をローカル/上流で突き合わせ。vendored のため全文精読は対象外） / sources-checked:
  - https://api.github.com/repos/vercel-labs/agent-skills/compare/f8a72b9603728bb92a217a879b7e62e43ad76c81...main
  - https://api.github.com/repos/vercel-labs/agent-skills/commits?path=skills/react-best-practices&since=2026-06-13T00:00:00Z
  - https://github.com/vercel-labs/agent-skills/commits/main/skills/react-best-practices
  - https://api.github.com/repos/vercel-labs/agent-skills/contents/skills/react-best-practices/rules?ref=main
- verdict: keep

### findings
（[b] 所見なし — 上流 sync 差分ゼロ）

### notes
- 上流特定: SOURCE.md:7-10 に明記（vercel-labs/agent-skills / path `skills/react-best-practices` / commit `f8a72b9` / 2026-06-13 vendor）。リポジトリ全体は vendor 時点から 21 commits ahead（HEAD `565c0c0`, 2026-07-23）だが、path フィルタ付き commits API（since=2026-06-13）は空配列 = 対象 path への変更ゼロ。
- 対象 path の最新変更は `dc8367e`（2026-04-14「update example」）で vendor 日より前。上流 HEAD の rules/ は 72 ファイルでローカルと名前が 1:1 完全一致（追加・削除・rename なし）。
- 次回 sync 確認も同じ since 付き commits API 1 発で判定可能（確認日: 2026-08-07）。
- vendor 手順が SOURCE.md に自己完結で記録されており上流追跡性は良好。SKILL.md の「70 rules」表記も上流 rules/（70 ルール + `_template.md` + `_sections.md`）と現時点で整合。
