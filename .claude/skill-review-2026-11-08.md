# Skill レビュー結果（2026-11-08）

実施方法: `.claude/skill-review-rubric.md` に観点 (d)「古いモデル向けの指示」を足し、2026-08-07 以降に追加されて一度もレビューしていない 10 skill を、読み取り専用のサブエージェント 10 体が並列でレビューした（観点 (a) 改善点 / (b) 陳腐化 / (c) 分割 / (d) 古いモデル向けの指示）。陳腐化の所見は当日、developers.cloudflare.com / docs.github.com / code.claude.com / changelog キャッシュ 2.1.319 / 各ライブラリの公式 docs で裏取りした。重大な所見は、反映する前に親セッションでも一次情報を確かめた（Playwright の `chromiumSandbox` の既定値、zod の `z.fromJSONSchema` の版、Cloudflare の error 1042 の原因、PreCompact の stdout、exec form、R2 の `no_check_bucket`）。

対象の skill は、レビュー前に description 短縮・1042 の訂正・圧縮指示の削除を入れたブランチ（同じ PR）の状態。snr-writing だけは、持ち主の作業コピーにある未コミットの 0.2.0 をレビューした。

## 総括

| skill | verdict | high | med | low | 今回の反映 |
|---|---|---|---|---|---|
| cloudflare-r2-private-image-upload | needs-update | 3 | 6 | 3 | high 3 件 |
| cloudflare-workers-pat-bearer-auth | needs-update+split | 2 | 4 | 5 | high 2、med 3、low 2 |
| agent-status-hub | needs-update | 1 | 2 | 7 | high 1、med 2、low 4 |
| playwright-e2e-in-docker-sandbox | needs-update | 1 | 4 | 4 | high 1 |
| sandboxed-agent-github-token-via-1password | needs-update+split | 1 ※ | 5 | 6 | high 1 |
| cloudflare-d1-keyless-host-backup | needs-update | 1 | 2 | 8 | high 1 |
| cloudflare-workers-host-synthetic-check | needs-update | 1 | 2 | 7 | なし（PR #47 と衝突するため保留） |
| cloudflare-workers-space-membership-invite | needs-update | 0 | 5 | 2 | なし |
| cloudflare-workers-passkey-auth | needs-update | 0 | 3 | 7 | なし |
| snr-writing（0.2.0） | needs-update | 0 | 1 | 4 | med 1、low 3（別 PR） |

※ 要確認（deny パターンが「効かない」のか「過剰に一致する」のかは実機の probe でしか確定しない。どちらでも意図した形を表せないので、hook に置き換えた）。

high 計 10（反映 9、保留 1）/ med 計 34 / low 計 53。

## 横断テーマ

1. **検証ログと UNVERIFIED のずれ × 5 skill**（passkey-auth / space-invite / pat-bearer-auth / r2 / token-via-1password）: 検証済みになった項目が references や本文の別の箇所で UNVERIFIED のまま残り、日付つきの検証ログが SKILL.md に入ったまま毎回読み込まれている。ログは references か README へ移し、ラベルを揃える。
2. **ホスト固有のパスの決め打ち × 2 skill**（host-synthetic-check / d1-keyless-host-backup）: systemd unit の node が mise のパス、Install の skill の置き場所が `~/.claude/skills`。mise 以外のホストや project scope では動かない。
3. **強調の多用（観点 d）× 6 skill**: 太字が 1 skill あたり 27〜50 か所、コード内にも NOT / ONLY / NEVER。曲げられない規則は CI・hook・deny に移し、強調は外すと意味が変わる箇所だけにする。
4. **description に経緯と罠の詳細 × 5 skill**: 版の注記・検証の経緯・設計値が入り、症状の文字列（エラーメッセージ）が足りない。`scripts/check-skills.py` が上限は止めるが、中身は観点 (a)4 と (d)5 で見る。
5. **drizzle の extra config の object 形式（0.36 で deprecated）× 2 skill**（space-invite / passkey-auth）。
6. **分割候補 × 2 skill**: pat-bearer-auth（受け側の PAT 実装と、送り側の配送・契約）、token-via-1password（stable-shell CI）。
7. **相互参照の欠落**: host-synthetic-check ↔ passkey-auth（RP_ID の runbook）、host-synthetic-check ↔ d1-keyless-host-backup（systemd user unit の罠）、r2 ↔ d1-keyless-host-backup、playwright-e2e-in-docker-sandbox ↔ cloudflare-workers-e2e-playwright（同名の bake 文書が両方に残っている）。

## 今回反映したもの（high と、編集で生じた食い違い）

- r2: バックアップの推奨を `rclone sync` から `rclone copy`（＋バックアップ側の lock / lifecycle）へ。Object 権限のトークンに要る `no_check_bucket` を追加。cron の JST 換算（`0 18 * * 0` は月曜 03:00 JST）を `0 18 * * 6` に訂正。トークン作成の導線は公式ページへの参照に変えた。
- pat-bearer-auth: references の送信例を Service Binding と応答 body のログに書き換え、廃止済みの `title` を含む受け側の sketch を削って公開された契約への参照にした。`z.fromJSONSchema` は zod 4.2 からで experimental と訂正。1042 の原因を 2 つ書き、日数の食い違い（16 日 / 26 日）を直した。適用範囲の矛盾（Service Binding を「使うな」としていた箇所）を直した。パスキーとの合成を kokemusu #31 の実装で検証済みにした。description に症状の文字列を入れた。
- agent-status-hub: PreCompact の stdout は圧縮の要約への指示になる（捨てられない）。hook は exec form（`"args": []`）。matcher なしの SessionStart は fork も含む。log.md は最新 5 エントリだけ注入される。古い引用（"Claude ignores half of it" 等）と "Resume from summary" を現行の記述に差し替えた。
- playwright-e2e-in-docker-sandbox: Playwright の `chromiumSandbox` は既定で false なので、`--no-sandbox` のゲートは何もしていなかった。ホストで sandbox を効かせる書き方に替えた（UNVERIFIED: ホストでの起動は未計測）。
- token-via-1password: deny `Bash(git push * :*)` を外し、削除形の refspec を止める PreToolUse hook の例に置き換えた（hook は kokemusu で 10 通り試験済み）。
- d1-keyless-host-backup: 同じ app に 2 つ目の DB を登録すると prune が前方一致で別 DB のダンプを数える。設定で 1 app 1 DB を検証し、ダンプ名を `^<db>-\d{8}-\d{6}\.sql\.gz$` で厳密に一致させた。
- snr-writing（別 PR）: 読者モデルを 0.2.0 の対象拡大に合わせ、新しい節を文で書いた入れ子の箇条書きにし、「機械レビュー」を手段まで書いた。

## 次の PR に回すもの（優先度順）

- **P1**: host-synthetic-check の high（unit の node が mise に固定）と med 2 件（Discord webhook を unit の `Environment=` に書かせている、Install の置き場所の決め打ち）。PR #47（pipelines）を merge してから、その上で直す。
- **P2 事実の陳腐化（med）**: space-invite の drizzle-kit journal 手順（v1 で不要）と object 形式の extra config、passkey-auth の @simplewebauthn v14、r2 の decision-matrix の古い制限値と subrequest 上限、d1-keyless-host-backup の Trap 6（suspend とログアウトの混同）、token-via-1password の 1Password のレート上限（日次上限）、playwright-e2e-in-docker-sandbox の canonical な Dockerfile block（本番は variant 側）。
- **P3 構造（med）**: 検証ログを references へ（passkey / space-invite / r2 / token / pat）、UNVERIFIED ラベルの整理、pat-bearer-auth と token-via-1password の分割、playwright の bake 文書の重複解消。
- **P4 磨き込み（low）**: 強調を外す、description の経緯を本文へ、相互参照の追加、compatibility の整理、残りの low。
- **観点 (d) の未レビュー**: 2026-08-07 にレビューした 13 skill には観点 (d) をまだ当てていない。

---

# 各 skill の所見全文

レビュアーの出力をそのまま残す（行番号はレビュー時点）。

## cloudflare-r2-private-image-upload
- reviewed-at: 2026-11-08 / last-commit: 2026-09-01
- verdict: needs-update

### findings
- [a][high] バックアップの保護範囲の記述が references 自身と矛盾する。decision-matrix は `rclone sync` が 'app bugs, accidental deletes, a wiped bucket' を防ぐと書くが、'sync mirrors deletions too' なので誤って消したものや空になったバケットも次の実行で反映される | evidence: references/decision-matrix.md:52; SKILL.md:141; references/e2e-and-ops.md:136,145 | fix: `rclone copy` とバックアップ側の bucket lock か lifecycle に変える（反映済み）
- [b][high] Object 権限のトークンなのに `no_check_bucket` が無い。トークン作成の導線も現行と違う | evidence: references/e2e-and-ops.md:121,136-142 | fix: `RCLONE_CONFIG_R2_NO_CHECK_BUCKET: "true"`（反映済み）、導線は公式ページへの参照に（反映済み） | source: https://developers.cloudflare.com/r2/examples/rclone/ | 要確認: 1 本のトークンでバケットごとに権限を分けられるか
- [b][high] `0 18 * * 0` は月曜 03:00 JST で、'Sunday 03:00 JST' ではない | evidence: references/e2e-and-ops.md:129 | fix: `0 18 * * 6`（反映済み）
- [a][med] parent テーブルを作り直す migration で attachments の行が全件 CASCADE で消える警告に、SKILL.md からたどり着けない | evidence: references/worker-routes.md:89; SKILL.md:83 | fix: pitfalls に 1 行加え、cloudflare-d1-drizzle-migration を参照させる
- [a][med] L105 / L137 の unverified 表記が VERIFIED の記述と食い違う。L119 の `canvas.toBlob("image/jpeg", 0.85)` は callback が抜けている | evidence: SKILL.md:105,119,137 | fix: 'verified 2026-09-01 in matatabetai (local)' に直し、`toBlob(cb, "image/jpeg", 0.85)` と書く
- [b][med] bucket_name を省くと deploy 時にバケットが作られる自動プロビジョニングに触れていない | evidence: SKILL.md:69; references/e2e-and-ops.md:152 | source: https://developers.cloudflare.com/workers/wrangler/configuration/ | 要確認
- [b][med] subrequest 上限の前提が古い（内部サービスへの subrequest は Free で 1,000 の別枠） | evidence: SKILL.md:58,113,170; references/worker-routes.md:332-334 | source: https://developers.cloudflare.com/workers/platform/limits/ | 要確認
- [a][med] 検証ログ（L160-175）と write-back 手順（L43, L162）が本文にあり、pitfalls 14 件のうち 11 件が本文の繰り返し | evidence: SKILL.md:43,143-158,160-175 | fix: ログは references へ、pitfalls は本文に無い項目に絞る
- [b][med] decision-matrix の一部が古い（Worker size の圧縮後上限は廃止、Enterprise 上限、ローカルで動かない binding、Images binding の URL 移動、control-origin-access との矛盾） | evidence: references/decision-matrix.md:17,18,19,21,33; references/thumbnails-and-images-binding.md:30
- [b][low] '`step.do()` outputs must be JSON' は現行と合わない（1 MiB まで永続化、大きいバイナリは ReadableStream） | evidence: SKILL.md:153 | source: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- [c][low] D1 バックアップの参照先に cloudflare-d1-keyless-host-backup が無い | evidence: SKILL.md:141,184
- [d][low] 太字が約 50 か所、コード内に NEVER / THROWS / ONLY、description に 'PRIVATE' と検証日 | evidence: SKILL.md:3,13,51,58,89,104

## cloudflare-workers-pat-bearer-auth
- reviewed-at: 2026-11-08 / last-commit: 2026-09-21
- verdict: needs-update+split

### findings
- [a][high] references の送信例が 1042 で届かなかった構成（workers.dev への global fetch、"logs status only"）のまま | evidence: references/routes-and-client.md:235-247 | fix: Service Binding と応答 body のログに（反映済み）
- [b][high] "zod ≥ 4.1 has `z.fromJSONSchema`" は誤り。v4.2.0 で追加され、experimental | evidence: SKILL.md:229 | source: https://github.com/colinhacks/zod/releases/tag/v4.2.0, https://zod.dev/json-schema（反映済み）
- [a][med] 適用範囲が description と 1042 節に矛盾（"Do not use for: Worker-to-Worker calls inside one account" と表の "Service binding ✗"） | evidence: SKILL.md:32,43 | fix: 反映済み
- [a][med] 受け側の sketch が廃止済みの `title` を必須にし、`z.object`・deprecated な `z.string().datetime()` を使い、契約を skill に書いている | evidence: references/routes-and-client.md:249-271 | fix: 公開された契約への参照に置き換え（反映済み）
- [a][med] kokemusu は本番で PAT を受けているのに "planned" と UNVERIFIED が残る | evidence: SKILL.md:15,126,277; references/pat-and-middleware.md:291,302 | fix: kokemusu の実装（#31）で書き戻し（反映済み）
- [c][med] 独立した呼び出し文脈が 3 つ同居（受け側の PAT 実装、送り側の配送、リポジトリをまたぐ契約） | fix: `cloudflare-workers-app-to-app-push` を切り出す案
- [b][low] 1042 の説明が docs より狭い（workers.dev route が無効な場合も 1042） | evidence: SKILL.md:158,160,171 | source: https://developers.cloudflare.com/workers/observability/errors/（反映済み）
- [b][low] IP キーの rate limit は docs が非推奨、`ratelimits` は wrangler ≥ 4.36.0 | evidence: SKILL.md:247; references/ops-and-testing.md:53-67
- [a][low] 1042 の経緯と契約テストのコード全文は references へ。"16 days" が 09-05→10-01 と食い違う | evidence: SKILL.md:162-173,206-221,231-241 | fix: 日数は反映済み、移動は保留
- [d][low] 太字約 50 か所、コード内の全大文字 | evidence: SKILL.md:13,17,52-54,90,248,252
- [d][low] description に解決策の詳細、症状の文字列が無い | evidence: SKILL.md:3 | fix: 反映済み

## agent-status-hub
- reviewed-at: 2026-11-08 / last-commit: 2026-08-23
- verdict: needs-update

### findings
- [b][high] PreCompact の stdout を「捨てられる」としているが、現行は圧縮の要約への指示になる | evidence: references/claude-code-facts.md:26, references/templates.md:52, SKILL.md:93 | source: https://code.claude.com/docs/en/hooks（反映済み）
- [b][med] hook の command が引用符なしの shell form。docs はパスの placeholder に exec form（`"args": []`）を勧める | evidence: references/templates.md:108, SKILL.md:74, references/claude-code-facts.md:27（反映済み）
- [b][med] best-practices の引用 "Claude ignores half of it" 等が現行ページに無い | evidence: references/claude-code-facts.md:7-8（反映済み）
- [a][low] log.md を "never auto-loaded" とする記述が、hook が最新 5 エントリを注入する実装と矛盾（反映済み）
- [a][low] matcher なしの発火元に fork が抜けている（反映済み）
- [d][low] SKILL.md とテンプレートの強調が多い | evidence: SKILL.md:13,56,83; references/templates.md:137,140,157,161
- [a][low] 作者リポジトリの実測表と検証記録が本文の約 1/4 | evidence: SKILL.md:15,24-39,95-101
- [b][low] "Resume from summary" は現行 docs に無い（反映済み）
- [b][low] auto memory を "not for progress tracking" としているが、現行は project の種類を保存し得る（反映済み）
- [a][low] `grill-with-docs` に出典リンクが無い | evidence: SKILL.md:50

## playwright-e2e-in-docker-sandbox
- reviewed-at: 2026-11-08 / last-commit: 2026-09-02
- verdict: needs-update

### findings
- [b][high] `--no-sandbox` ゲートの前提が誤り。Playwright の `chromiumSandbox` は既定で false | evidence: SKILL.md:50-51,102-108; references/in-container-playwright-bake.md:131-145 | source: https://playwright.dev/docs/api/class-browsertype（反映済み）
- [a][med] "canonical copy" の Dockerfile block が、本番 2 プロジェクトの検証済み variant と違う。確認手順も canonical でしか成り立たない | evidence: SKILL.md:67-84,93-100; references/in-container-playwright-bake.md:28-54,68-99,147-157
- [a][med] SKILL.md が reference の大半を再掲し、計測値が食い違っている | evidence: SKILL.md:122-125 vs references/in-container-playwright-bake.md:173-176
- [c][med] cloudflare-workers-e2e-playwright にも同名の references/in-container-playwright-bake.md が残っている | 要確認
- [d][med] 版の pin の一致を強調だけで守らせている | fix: build arg を package.json から導出するか、CI で一致を検査する
- [b][low] `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` の根拠が現行 docs と合わない | source: https://playwright.dev/docs/library
- [a][low] "main skill" がどの skill か書かれていない
- [d][low] 太字が約 27 か所
- [d][low] description に原因・対処・版の注記

## sandboxed-agent-github-token-via-1password
- reviewed-at: 2026-11-08 / last-commit: 2026-08-30
- verdict: needs-update+split

### findings
- [b][high] deny `Bash(git push * :*)` は末尾の `:*` が旧来の前方一致の書式として読まれ、削除形の refspec を止めるルールになっていない | evidence: references/compose-and-git-wiring.md:226, SKILL.md:70 | source: https://code.claude.com/docs/en/permissions | 要確認 | fix: PreToolUse hook に置き換え（反映済み）
- [a][med] opt-in merge を allow ルールで書いているが、bypassPermissions では allow が効かない | evidence: SKILL.md:149,171,211; references/rulesets-and-policy.md:31 | fix: `--auto` なしの merge を止める PreToolUse hook（kokemusu の guard-pr-merge.sh が実例）
- [b][med] service-account 変種の予算がアカウント単位の日次上限を考慮していない | evidence: references/service-account-variant.md:29,40 | source: https://www.1password.dev/service-accounts/rate-limits
- [a][med] 検証済み（2026-08-30, #17）なのに UNVERIFIED が残る | evidence: SKILL.md:174; references/rulesets-and-policy.md:34
- [a][med] SKILL.md の約 110 行が版の履歴・検証ログ・旧変種の診断。`op run` の説明が 5〜6 回繰り返される
- [c][med] 「workflows gap → stable-shell CI」を独立した skill に切り出す案
- [b][low] `Bash(git push *main)` は main で終わるブランチ名も拒否する
- [b][low] "current `gh` is v2.98.0" は古い
- [b][low] `require_extra_approval_for_unattributed_changes` の解釈が API の定義と違う
- [a][low] service-account 変種の注入方法が 0.1.x の名残
- [c][low] 配線リファレンスが sandbox skill の `command:` を丸ごと複製し、`pnpm@9.15.0` を固定している
- [d][low] 太字と全大文字が多い

## cloudflare-d1-keyless-host-backup
- reviewed-at: 2026-11-08 / last-commit: 2026-09-20
- verdict: needs-update

### findings
- [a][high] 1 つの app に複数の DB を登録すると、prune が前方一致で別 DB のダンプを数え、shrink 比較と bookmark も app だけで引く | evidence: SKILL.md:67, scripts/d1-backup.mjs:137,162,186-193, scripts/d1-bookmark.mjs:22 | fix: 1 app 1 DB の検証と、ダンプ名の厳密一致（反映済み）
- [a][med] service が mise の node パスを決め打ち | evidence: systemd/d1-backup.service:8-9
- [b][med] Trap 6 の "a machine that sleeps would never fire" は suspend とログアウトの混同 | source: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- [b][low] D1 export の数値は JavaScript の 52 bit 精度に影響される | source: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- [b][low] node:sqlite の DatabaseSync は v26.11.0 で Database に改名（DEP0210）
- [a][low] Install が skill の置き場所を `~/.claude/skills` に決め打ち
- [a][low] FK が循環するスキーマは並べ替えられない限界が SKILL.md から読めない
- [b][low] `wrangler login --use-keyring` を前提にしていない | 要確認
- [d][low] description の "Ships …" と "Covers …" は発動の判断に要らない（反映: description を短縮済み）
- [c][low] dump からの復元と systemd user unit の罠を sibling と相互参照 | 要確認
- [b][low] Trap 1 の "assume the same" は docs の引用に置き換えられる

## cloudflare-workers-host-synthetic-check
- reviewed-at: 2026-11-08 / last-commit: 2026-09-20（PR #47 が未 merge のため main の版をレビュー）
- verdict: needs-update

### findings
- [a][high] unit の node のパスが mise に固定（`%h/.local/share/mise/installs/node/lts/bin/node`）。mise 以外のホストでは起動しない | evidence: systemd/app-check.service:6, SKILL.md:5,37 | fix: Install で `node -p process.execPath` に置き換える。OnFailure= で通知
- [a][med] Discord webhook URL（秘密）を unit の `Environment=` に書かせ、unit は 644 で置かれる。"credential-free" と矛盾 | evidence: SKILL.md:60,37,3,5 | source: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
- [a][med] Install が `~/.claude/skills/...` に固定 | evidence: SKILL.md:31
- [a][low] passkeyBegin は POST `{}` 固定で rpId が無ければ FAIL。前提が SKILL.md に無い
- [b][low] WebAuthn L3 の Related Origin Requests に触れていない | source: https://www.w3.org/TR/webauthn-3/
- [d][low] description に経緯と罠の列挙
- [c][low] RP_ID の runbook が passkey-auth と重複、相互参照なし
- [c][low] systemd user unit の罠が d1-keyless-host-backup と重複、相互参照なし
- [a][low] `install -m 644 … ~/.config/systemd/user/` はディレクトリが無いと失敗
- [b][low] compatibility の "Node 20+" は EOL

## cloudflare-workers-space-membership-invite
- reviewed-at: 2026-11-08 / last-commit: 2026-09-20
- verdict: needs-update

### findings
- [a][med] 2026-08-30 に検証済みへ昇格した 3 件が references で UNVERIFIED のまま | evidence: SKILL.md:109,186,189,191 vs references/invite-flow.md:268, references/middleware.md:206,266
- [b][med] drizzle-kit の journal 後付け手順は v0 のレイアウト前提（v1 は不要） | evidence: SKILL.md:193 | source: https://orm.drizzle.team/docs/v0-v1-changes
- [b][med] meals・tags・mealTags が object 形式の extra config（drizzle-orm 0.36 で deprecated） | evidence: references/schema.md:91-93,107-109,123-126
- [a][med] 本文に検証ログ（11 行）、そこにしか無い知見がある | evidence: SKILL.md:184-194,140-150
- [d][med] description に経緯と罠の詳細、約 1,000 字 | evidence: SKILL.md:3
- [c][low] `INITIAL_REGISTRATION_TOKEN` の手順を passkey skill と二重管理 | evidence: references/ops.md:12-16
- [a][low] compatibility に実装方針 | evidence: SKILL.md:5

## cloudflare-workers-passkey-auth
- reviewed-at: 2026-11-08 / last-commit: 2026-09-20
- verdict: needs-update

### findings
- [a][med] 推奨の `type Bindings = Env & {...}` がテンプレートと食い違い、そのまま入れると型が循環参照 | evidence: SKILL.md:187, references/session-and-challenge.md:10-30 | source: https://developers.cloudflare.com/workers/languages/typescript/
- [b][med] @simplewebauthn の現行は v14.1.x（最低ランタイムの引き上げ、`sendSignal()` 等）。skill は v13 前提 | source: https://simplewebauthn.dev/docs/packages/server
- [a][med] 日付つきの検証ログ 27 行が SKILL.md に入り、実用知見が埋もれている | evidence: SKILL.md:62,171-197
- [a][low] 本文の検証結果がテンプレートに反映されていない（clearCookie、counter の純関数、aud の検証）
- [a][low] 古い参照と UNVERIFIED マーカー | evidence: SKILL.md:124; references/client-flow.md:86-87
- [b][low] Rate Limiting docs は IP キーを非推奨、共有 NAT の影響 | source: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- [d][low] description に版の注記・設計値・原因
- [d][low] 曲げられない規則を強調表記で守らせている
- [b][low] schema テンプレートが object 形式の extra config | 要確認
- [a][low] `.dev.vars.example` を "keys only" としているが値が入っている

## snr-writing（0.2.0）
- reviewed-at: 2026-11-08 / last-commit: 2026-10-01
- verdict: needs-update

### findings
- [a][med] 読者モデルが 0.2.0 の対象拡大に追随していない（反映済み、別 PR）
- [a][low] 新設節が自分の基準（箇条書きは文で書く）に反する（反映済み）
- [a][low] 「機械レビュー」の手段が読み取れない（反映済み）
- [a][low] description と見出しに commit messages が無い（反映済み）
- [a][low] compatibility 'Designed for Claude Code (or similar products).' は不要（全 skill 共通の書式なので見送り）
