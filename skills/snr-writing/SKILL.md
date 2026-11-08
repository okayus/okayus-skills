---
name: snr-writing
description: Reader model and compression criteria for Japanese explanations, answers, self-review / acceptance write-ups, and code comments, aimed at a reader who prefers established terminology and asks about anything unfamiliar. Use when the requester asks to explain a concept or a book chapter, answer a technical question, write a self-review / acceptance document, or write or rewrite code comments (JSDoc, inline comments) and commit messages, and whenever they say "S/N", "圧縮して" or "短く". Lowers extraneous cognitive load without dumbing down the subject. Not for book or article manuscripts, which follow their medium's own style guide.
license: MIT
compatibility: Designed for Claude Code (or similar products).
metadata:
  author: okayus
  version: "0.2.0"
---

# 読者に合わせて圧縮する

## 読者

読者は、この文章を依頼した本人である。
定着した用語で受け取り、知らない語は自分で質問する。
下げるのは外在性負荷だけである。題材の内在性負荷は下げない（認知負荷理論）。
初学者向けの足場は、この読者には熟達者逆転効果で負荷になる。

## 基準

- シグナル/ノイズ比。一文を外しても読者の理解や判断が変わらないなら、その文は書かない。
- 可逆圧縮。定着した用語は可逆圧縮、言い換えや噛み砕きは非可逆。説明の道具として使う用語には定義を添えない。説明の対象である用語だけを説明する。対象の構成要素は対象に含める。正式名称で書く。
- 冗長性効果。同じ情報を本文と表、本文と用語表、本文と図のように二つの形で出さない。一つの形を選ぶ。読者の手元にある図やアニメーションも一つの形に数え、本文で描き直さない。
- 結論先行。答え、判定、差分を最初の文に置く。根拠はその後に置く。
- 形は情報の形に従う。並列は表か箇条書き、手順は番号付き、論証は地の文。
- データインク比。太字と記号は、外すと意味が変わる箇所にだけ使う。
- 一文一義。圧縮するのは文の数であって文法ではない。主語と述語を省かない。表のセルは断片でよい。箇条書きは文で書く。
- 確信度の較正。言い切りの強さを根拠に合わせ、実測・出典・推測を書き分ける。

## コードコメント

読者は、落ちたとき・直すときにそのファイルを開く保守者である。経緯を知りたいときは git log を引く。

- 残す。コードが依存する不変条件と、それが成り立つ版の範囲（例: Element Plus 2.14 の select は automatic-dropdown なしではフォーカスで開かない）。コードから読み取れない「なぜそうしたか」。
- 削る。旧版との比較や変更の経緯はコミットメッセージへ。コードや expect のメッセージの言い直し。同じ趣旨の定型文の繰り返し（ファイル内に既にあれば書かない）。入れ子の丸括弧。
- 目安。追加差分でコメント行がコード行を超えたら見直す。圧縮したあとは事実関係を機械レビューで確かめる（「閉じていても」を「閉じても」に縮めて意味がずれた例がある）。
- コミットメッセージは逆で、経緯と判断の根拠を書く場所である。

## 原稿との関係

書籍や記事の原稿には、その媒体の文章規範を優先する。この skill は会話の解説、検収文書、コードコメントとコミットメッセージに使う。
