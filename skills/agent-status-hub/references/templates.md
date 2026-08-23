# Templates (as deployed on kokemusu, 2026-08-23)

Copy these verbatim, then adjust the phase text. Headings in `status.md` are Japanese because the
author's repositories are; they are the only thing `check-status.sh` pins literally — translate both
together if you need English headings.

## `docs/status.md`

```markdown
# いま（status hub）

<!-- 上限 40 行 / 3 KB。見出し 4 つは固定。終わった項目は消して docs/log.md の先頭へ（取り消し線は禁止）。
     8 行を超える節は docs/plans/<topic>.md に切り出す。更新は /handoff。
     セッション開始時に .claude/hooks/session-start.sh がこのファイルを注入する。 -->

## フェーズ

**Phase 0 完了（2026-08-23）→ Phase 1 MVP の着手前。** 本番 `https://<worker>.<subdomain>.workers.dev` は歩く骨格でロジック = ゼロ。

## 次の 3 手

1. <the concrete task the next session starts with>
2. <second>
3. <third, or "decide X when it becomes necessary (roadmap.md)">

## 詰まり・人手待ち

- なし。

## 進行中 PR

- なし。
```

## `docs/log.md`

```markdown
# ログ（追記専用・新しい順）

1 行 = 1 節目（PR の merge・ADR・人手作業の完了・本番の状態変化）。`- YYYY-MM-DD 何を（#PR / ADR / skill）`。
自動ロードはされない。必要なら `head -20 docs/log.md`。作業中の試行錯誤は書かない（git log と PR にある）。

- 2026-08-23 進捗管理を status hub 化: `docs/status.md`（40 行上限）+ `docs/log.md` + SessionStart hook + `/handoff` + CI の上限検査（#6）
- 2026-08-23 Workers Builds 接続完了。本番 `/health` 200（skill `cloudflare-workers-builds-keyless-deploy` 0.3.0）
```

## `.claude/hooks/session-start.sh`

```bash
#!/usr/bin/env bash
# SessionStart hook: セッション開始・再開・/clear・compact 後に「いま」を注入する。
# SessionStart の stdout はそのまま Claude のコンテキストに入る（PreCompact / Stop の stdout は捨てられる）。
# ホスト（CLAUDE_PROJECT_DIR=リポ）でもコンテナ（/workspace）でも同じに動く。失敗してもセッションは止めない。
set -u
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || exit 0

if [ -f docs/status.md ]; then
  echo "=== docs/status.md（いまのハブ。終わった項目は /handoff で docs/log.md へ）==="
  cat docs/status.md
fi
if [ -f docs/log.md ]; then
  echo
  echo "=== docs/log.md（直近 5 行。全体は head -20 docs/log.md）==="
  grep -m 5 '^- ' docs/log.md
fi
echo
echo "=== git（branch / 直近 5 commit）==="
git rev-parse --abbrev-ref HEAD 2>/dev/null
git log --oneline -5 2>/dev/null
exit 0
```

## `.claude/hooks/check-status.sh`

```bash
#!/usr/bin/env bash
# docs/status.md の上限検査（/handoff と CI が呼ぶ）: 40 行 / 3000 bytes / 取り消し線なし / 見出しは固定 4 つ。
set -u
f="${1:-docs/status.md}"
max_lines=40
max_bytes=3000
fail=0
[ -f "$f" ] || { echo "NG: $f が無い"; exit 1; }
lines=$(wc -l <"$f")
bytes=$(wc -c <"$f")
[ "$lines" -le "$max_lines" ] || { echo "NG: $f は $lines 行（上限 $max_lines）。終わった項目は docs/log.md へ、長い節は docs/plans/ へ"; fail=1; }
[ "$bytes" -le "$max_bytes" ] || { echo "NG: $f は $bytes bytes（上限 $max_bytes）"; fail=1; }
if grep -n '~~' "$f"; then echo "NG: 取り消し線は禁止。完了項目は消して docs/log.md へ"; fail=1; fi
expected=$'## フェーズ\n## 次の 3 手\n## 詰まり・人手待ち\n## 進行中 PR'
actual=$(grep '^## ' "$f")
if [ "$actual" != "$expected" ]; then
  echo "NG: 見出しは固定 4 つ（## フェーズ / ## 次の 3 手 / ## 詰まり・人手待ち / ## 進行中 PR）。現在:"
  echo "$actual"
  fail=1
fi
[ "$fail" -eq 0 ] && echo "OK: $f は $lines 行 / $bytes bytes"
exit "$fail"
```

## `.claude/settings.json` (committed, shared) — add under the top-level object

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh", "timeout": 10 }
      ]
    }
  ]
}
```

No `matcher` → fires on `startup`, `resume`, `clear` and `compact`. Put it in `.claude/settings.json`, not
`settings.local.json`: the container sees only what is in the repo.

## `.github/workflows/ci.yml` — first step after checkout

```yaml
      - name: Status hub size check (docs/status.md ≤ 40 lines / 3 KB, fixed headings)
        run: bash .claude/hooks/check-status.sh docs/status.md
```

## `.claude/skills/handoff/SKILL.md`

```markdown
---
name: handoff
description: セッションの区切りで進捗を書き戻す。docs/status.md を「いま」だけに書き換え、完了した節目を docs/log.md の先頭へ 1 行で移し、上限（40 行 / 3 KB・見出し 4 つ固定）を検査して commit する。ユーザが /handoff と打ったときだけ実行する。
disable-model-invocation: true
argument-hint: "[一言メモ（任意）]"
---

ユーザからの一言メモ: $ARGUMENTS（空なら無視）。

## 手順（この順で。省略しない）

1. **現状把握**: `git status -sb`、`git log --oneline -10`、`gh pr list --state open`（使えない環境なら飛ばす）、`docs/status.md`、`head -10 docs/log.md` を読む。このセッションで「終わったこと / 残ったこと / 詰まったこと」を 3 行で整理する。
2. **`docs/log.md`**: 終わった節目を**先頭に** 1 行ずつ足す（`- YYYY-MM-DD 何を（#PR / ADR / skill）`）。既存行は編集しない。節目 = PR の merge・ADR・人手作業の完了・本番の状態変化。作業中の試行錯誤は書かない。
3. **`docs/status.md` を書き換える**（追記しない）: 見出し 4 つ（フェーズ / 次の 3 手 / 詰まり・人手待ち / 進行中 PR）は固定のまま、中身を現在の状態に置き換える。完了項目は消す（取り消し線は禁止）。8 行を超える節は `docs/plans/<topic>.md` に切り出して 1 行のポインタにする。「次の 3 手」の 1 手目は、次のセッションが最初に着手する具体的な作業にする。
4. **`docs/plans/`** の完了した計画は削除する（結論は ADR か log の 1 行に残っている前提）。`docs/roadmap.md` はチェックボックスだけ更新し、経緯は書かない。
5. `bash .claude/hooks/check-status.sh` を実行し、OK になるまで 3 を直す。
6. **commit**: 現在のブランチが `main` なら `claude/handoff-YYYY-MM-DD` を切ってから、`docs(status): <要約>` で commit する。push と PR はユーザに確認してから（CLAUDE.md の git 規約どおり）。
7. 最後に「次セッションの出発点」（status.md「次の 3 手」の 1 手目）を 1 行で報告する。

## 書かないもの

- `CLAUDE.md` に進捗・履歴（規約だけ）
- `docs/status.md` に完了項目・経緯・調査結果（plans / ADR / log へ）
- `docs/log.md` に作業中の細かい出来事（git log と PR にある）
```

## CLAUDE.md — the section that replaces "next actions"

```markdown
このファイルは**規約と目次だけ**。進捗と次の一手は `docs/status.md`（SessionStart hook が自動注入）、履歴は `docs/log.md` と git、決定は `docs/adr/` と `CONTEXT.md`。**ここに進捗・履歴・完了報告を書かない。**

## 進捗の持ち方（status hub）

- `docs/status.md` = いまのハブ。**40 行 / 3 KB 上限**、見出しは「フェーズ / 次の 3 手 / 詰まり・人手待ち / 進行中 PR」の 4 つ固定。終わった項目は消して `docs/log.md` の先頭へ 1 行（取り消し線は禁止）。8 行を超える節は `docs/plans/<topic>.md` に切り出し、完了したら削除。
- セッションの区切りでユーザが `/handoff` を打つ（書き換え → log → `.claude/hooks/check-status.sh` → commit）。CI も同じ検査を走らせる。
- `/compact` するときは、変更したファイル一覧と「次の 3 手」の 1 手目を必ず要約に残す。
```
