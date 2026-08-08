# Skill レビュールーブリック（okayus-skills）

レビュアー subagent が 1 skill をレビューするときの共通基準。この基準以外の観点で所見を出さない。

## 前提

- 対象リポジトリ: `/home/okayu/indie-development/okayus-skills`（公開 repo。Claude Code 以外の Agent Skills 互換エージェントでも使われる前提 = agentskills.io spec 準拠が必須）
- レビュー日と対象 skill の最終コミット日は起動プロンプトで渡される
- skill の**全ファイル**（SKILL.md と references/ 以下すべて）を Read してから判定する。references を読まずに所見を出さない
- **ファイルの編集・作成は一切禁止**（読み取り専用レビュー）

## 観点 (a) 改善点 — skill authoring ベストプラクティスとの差分

1. SKILL.md は 500 行以下か（出典: https://code.claude.com/docs/en/skills.md）
2. progressive disclosure: SKILL.md は本質だけに絞れているか。長い手順・コード全文・診断詳細は references/ に置かれ、SKILL.md から明示的にリンクされているか。逆に references/ にしか無い致命的な注意が SKILL.md から発見不能になっていないか
3. frontmatter: Agent Skills spec のフィールドのみ使っているか。Claude Code 専用フィールドが混ざっていたら移植性の問題として指摘（正確なフィールド区分は起動プロンプトの「検証済みフィールド区分」を正とする）
4. description: 第三者視点で「いつ発動すべきか」が判る具体性があるか（症状・エラーメッセージ・ユースケースのトリガー語を含むか）
5. SKILL.md 本文と references/ のテンプレート・コードが矛盾していないか

## 観点 (b) 陳腐化 — 上流変化との照合

照合先マトリクス（skill の記述種別ごとに必ずここを確認する）:

| 記述の種別 | 照合先 |
|---|---|
| Cloudflare 製品仕様（wrangler 設定キー・製品名・制限値・API・料金境界） | https://developers.cloudflare.com の現行ページを WebFetch |
| Claude Code の挙動・設定・CLI に言及する記述 | ローカル changelog キャッシュ `~/.claude/cache/changelog.md` を Read（+必要なら https://code.claude.com/docs/ ） |
| GitHub Actions / gh CLI / GitHub App の仕様 | https://docs.github.com の現行ページ |
| 外部 vendored コンテンツ | 上流リポジトリとの sync 確認（専用手順、通常レビュー対象外） |

**裏取りルール（最重要）**: 陳腐化の所見には (1) skill 内の該当記述の file:line、(2) 現行仕様の出典 URL、(3) 確認日を必ず添える。裏取りできなかった疑いは断定せず `要確認` マークを付ける。**現行仕様を確認せずに「古いはず」と書くことを禁止する。** バージョン番号・製品名・URL・設定キー名・デフォルト値は特に重点的に照合する。

## 観点 (c) 分割

- 判定基準は行数ではなく**独立した呼び出し文脈の数**: description / 本文が「別々のタイミングで別々の目的で参照される話題」を複数抱えていないか。抱えている場合、どこで切るか（分割後の各 skill の name / description 案を 1 行ずつ）を提案する
- 500 行超過は自動的に分割候補
- 逆パターンも見る: 他 skill と明らかに重複していて統合・相互参照すべき内容（リポジトリの skill 一覧は起動プロンプトで渡される）

## 出力フォーマット（これ以外を返さない・全体で最大 120 行）

```
## <skill-name>
- reviewed-at: <日付> / last-commit: <日付>
- files-read: <数> / sources-checked: <照合した URL・パスのリスト>
- verdict: keep | needs-update | split-candidate | needs-update+split

### findings
- [a|b|c][high|med|low] <所見 1 行> | evidence: <file:line> | fix: <1 行修正案> | source: <URL>（b 軸は必須）| 要確認（該当時のみ）
（1 件 1 行厳守・重要度順・最大 12 件。所見の無い軸は書かない）

### notes
（任意・3 行以内。判定に迷った点だけ）
```

- 所見の日本語は簡潔に。skill 原文の引用は英語のまま
- severity 基準: **high** = 従うと壊れる・動かない・事実が誤り / **med** = 非効率・移植性問題・発見性欠如 / **low** = 磨き込み
