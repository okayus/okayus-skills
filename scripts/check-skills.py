#!/usr/bin/env python3
"""skills/*/SKILL.md の frontmatter を Agent Skills spec の上限で検査する（標準ライブラリだけで動く）。

plain scalar の ": " と " #" も止める。Claude Code は読めても、厳密な YAML パーサを使うエージェントでは
frontmatter ごと読めず、description が空になる。PyYAML があれば safe_load でも確かめる。
出典: https://agentskills.io/specification
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "skills"
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(.*)$")
BLOCK_INDICATORS = {">", "|", ">-", "|-", ">+", "|+"}


def frontmatter(text):
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    return None if end == -1 else text[4:end]


def top_level(fm):
    """トップレベルのキー → (書式, 値)。入れ子の map（metadata など）は値を None にする。"""
    lines = fm.split("\n")
    out = {}
    i = 0
    while i < len(lines):
        m = KEY_RE.match(lines[i])
        i += 1
        if not m:
            continue
        key, raw = m.group(1), m.group(2).strip()
        cont = []
        while i < len(lines) and (lines[i][:1] in (" ", "\t") or lines[i] == ""):
            cont.append(lines[i].strip())
            i += 1
        rest = [c for c in cont if c]
        if raw in BLOCK_INDICATORS:
            out[key] = ("block", (" " if raw[0] == ">" else "\n").join(rest))
        elif raw == "":
            out[key] = ("map", None)
        elif raw[0] == '"':
            body = " ".join([raw] + rest)[1:].removesuffix('"')
            out[key] = ("quoted", body.replace('\\"', '"').replace("\\\\", "\\"))
        elif raw[0] == "'":
            body = " ".join([raw] + rest)[1:].removesuffix("'")
            out[key] = ("quoted", body.replace("''", "'"))
        else:
            out[key] = ("plain", " ".join([raw] + rest))
    return out


def check(skill_dir, yaml):
    path = skill_dir / "SKILL.md"
    if not path.is_file():
        return ["SKILL.md がない"]
    text = path.read_text(encoding="utf-8")
    fm = frontmatter(text)
    if fm is None:
        return ["frontmatter（--- で囲んだ YAML）がない"]
    kv = top_level(fm)
    errs = []

    name = kv.get("name", (None, None))[1]
    if not name:
        errs.append("name がない")
    elif name != skill_dir.name:
        errs.append(f"name {name!r} がディレクトリ名と違う")
    elif len(name) > 64 or not NAME_RE.match(name):
        errs.append(f"name {name!r} は 64 字以内の小文字英数とハイフンにする")

    desc = kv.get("description", (None, None))[1]
    if not desc:
        errs.append("description がない")
    elif len(desc) > 1024:
        errs.append(f"description が {len(desc)} 字（上限 1,024）")

    comp = kv.get("compatibility", (None, None))[1]
    if comp is not None and len(comp) > 500:
        errs.append(f"compatibility が {len(comp)} 字（上限 500）")

    for key, (style, value) in kv.items():
        if style == "plain" and (": " in value or " #" in value or value.endswith(":")):
            errs.append(f"{key} の plain scalar に ': ' か ' #' がある（厳密な YAML では読めない。言い換えるか引用符で囲む）")

    if yaml is not None and not errs:
        try:
            yaml.safe_load(fm)
        except yaml.YAMLError as e:
            errs.append(f"YAML として読めない: {str(e).splitlines()[0]}")

    lines = text.count("\n") + 1
    if lines > 500:
        errs.append(f"SKILL.md が {lines} 行（spec の推奨は 500 行以内）")
    return errs


def main():
    try:
        import yaml
    except ImportError:
        yaml = None
    dirs = sorted(d for d in ROOT.iterdir() if d.is_dir())
    failures = [(d.name, e) for d in dirs for e in check(d, yaml)]
    for name, err in failures:
        print(f"NG {name}: {err}")
    if failures:
        sys.exit(1)
    print(f"OK: {len(dirs)} skills")


if __name__ == "__main__":
    main()
