#!/usr/bin/env python3
"""Fail on em dashes in tracked files.

An em dash is one of the clearest tells that a line of text was written by a
model and never reread, so this repo does not ship them. The rule covers the
Groq prompts too: an em dash in a prompt teaches the model to answer with one,
and those answers go out to real people as contact-form replies.

Usage:
    scripts/no-emdash.py            # check, exit 1 if any are found
    scripts/no-emdash.py --fix      # rewrite them, then review the diff

--fix substitutes a comma. That is a placeholder, not a judgement: a sentence
built around an em dash usually wants a colon, a period, or nothing at all.
Read the diff and pick the punctuation the sentence actually needs.
"""

import argparse
import subprocess
import sys
from pathlib import Path

# U+2014 EM DASH and U+2015 HORIZONTAL BAR, which renders identically.
# U+2013 EN DASH is deliberately allowed: it is correct in numeric ranges.
BANNED = {"—": "em dash", "―": "horizontal bar"}

# Paths that are allowed to keep them, with the reason.
EXCLUDE = {
    "scripts/no-emdash.py",  # has to contain the characters it bans
}


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    for name in out.split(b"\0"):
        if not name:
            continue
        path = Path(name.decode())
        if str(path) in EXCLUDE or not path.is_file():
            continue
        yield path


def read_text(path):
    """Return the file's text, or None if it is binary or not UTF-8."""
    raw = path.read_bytes()
    if b"\0" in raw:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def find(text):
    for lineno, line in enumerate(text.splitlines(), 1):
        for col, ch in enumerate(line, 1):
            if ch in BANNED:
                yield lineno, col, BANNED[ch], line.strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fix", action="store_true", help="rewrite as a comma")
    args = ap.parse_args()

    hits = 0
    fixed_files = 0

    for path in tracked_files():
        text = read_text(path)
        if text is None:
            continue
        found = list(find(text))
        if not found:
            continue
        hits += len(found)

        if args.fix:
            for ch in BANNED:
                # Collapse the spaces around it too, so "a — b" becomes "a, b"
                # rather than "a , b".
                text = text.replace(f" {ch} ", ", ").replace(ch, ",")
            path.write_text(text, encoding="utf-8")
            fixed_files += 1
        else:
            for lineno, col, label, context in found:
                print(f"{path}:{lineno}:{col}: {label}")
                print(f"    {context}")

    if args.fix:
        print(f"Rewrote {hits} occurrence(s) across {fixed_files} file(s).")
        print("A comma is a placeholder. Review the diff and pick the right mark.")
        return 0

    if hits:
        print(f"\n{hits} em dash(es) found. Run scripts/no-emdash.py --fix, "
              f"then reword each one.", file=sys.stderr)
        return 1

    print("No em dashes found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
