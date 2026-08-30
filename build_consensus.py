#!/usr/bin/env python3
"""THE LAB - analyst consensus builder.

Reads the analyst lists from data/analyst_lists.json and averages them into
data/consensus_ranks.json, which compute.py merges into players.json
(positional -> `cr`/`crs`, overall "OVR" -> `ocr`/`ocrs`).

Sources: Joel Smyth (Yahoo), Flock Fantasy (Mason Dodd), The Fantasy
Footballers. A "vegas" source is computed live in compute.py from BettingPros
prop lines and never appears here. (FantasyPros removed 2026-08-25 per Alex.)

To update the lists, run the `update-analysts` skill (fetches Flock
automatically; Joel and the Footballers are read from their pages), or
edit data/analyst_lists.json by hand, then rerun:
    python build_consensus.py && python compute.py

analyst_lists.json shape:
  positional: {QB|RB|WR|TE: {src: [name, ...]}}          # dense 1..N order
  overall:    {src: [[rank, name], ...]}                 # explicit ranks; K/DST
              rows are skipped upstream but keep their original rank numbers
"""
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent
lists = json.loads((ROOT / "data" / "analyst_lists.json").read_text(encoding="utf-8"))


_ALIAS_PATH = ROOT / "data" / "name_aliases.json"
NAME_ALIASES = {k: v for k, v in json.loads(
    _ALIAS_PATH.read_text(encoding="utf-8")).items() if not k.startswith("_")} \
    if _ALIAS_PATH.exists() else {}


def norm(name):
    """Must match compute.py's norm() exactly — that is what merges these rows
    into the player pool. Grouping on the raw string instead used to split one
    player across spellings ("De'Von Achane" vs "Devon Achane", "James Cook III"
    vs "James Cook"); compute.py then matched both to the same player and the
    second assignment silently discarded the first one's sources."""
    n = re.sub(r"[^a-z ]", "", (name or "").lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    n = re.sub(r"\s+", " ", n).strip()
    return NAME_ALIASES.get(n, n)


def display(variants):
    """Most-used spelling wins; ties go to the fullest one (keeps the suffix)."""
    c = Counter(variants)
    return max(c, key=lambda s: (c[s], len(s)))


def collapse(pairs_by_src):
    """{src: [(rank, raw), ...]} -> ({normkey: {src: rank}}, {normkey: [raw]})"""
    ranks, variants = {}, {}
    for src, pairs in pairs_by_src.items():
        seen = set()
        for r, raw in pairs:
            k = norm(raw)
            if not k or k in seen:
                continue  # duplicate rows in a source
            seen.add(k)
            ranks.setdefault(k, {})[src] = r
            variants.setdefault(k, []).append(raw)
    return ranks, variants


out = {}
for pos, srcs in lists["positional"].items():
    # dense lists: rank is position in the list, counted after collapsing
    dense = {}
    for src, names in srcs.items():
        seen, r, rows = set(), 0, []
        for name in names:
            k = norm(name)
            if not k or k in seen:
                continue
            seen.add(k)
            r += 1
            rows.append((r, name))
        dense[src] = rows
    ranks, variants = collapse(dense)
    out[pos] = [
        {"name": display(variants[k]), "avg": round(sum(rr.values()) / len(rr), 2),
         "n": len(rr), "ranks": rr}
        for k, rr in ranks.items()
    ]
    out[pos].sort(key=lambda x: x["avg"])
    merged = sum(1 for k in variants if len(set(variants[k])) > 1)
    print(f"{pos}: {len(out[pos])} players from {len(srcs)} sources"
          f"{f' ({merged} spelling merges)' if merged else ''}; "
          f"top 3: {[x['name'] for x in out[pos][:3]]}")

ovr_ranks, ovr_variants = collapse(
    {src: [(r, name) for r, name in pairs] for src, pairs in lists["overall"].items()})
out["OVR"] = [
    {"name": display(ovr_variants[k]), "avg": round(sum(rr.values()) / len(rr), 2),
     "n": len(rr), "ranks": rr}
    for k, rr in ovr_ranks.items()
]
out["OVR"].sort(key=lambda x: x["avg"])
_m = sum(1 for k in ovr_variants if len(set(ovr_variants[k])) > 1)
print(f"OVR: {len(out['OVR'])} players from {len(lists['overall'])} sources"
      f"{f' ({_m} spelling merges)' if _m else ''}; "
      f"top 3: {[x['name'] for x in out['OVR'][:3]]}")

dest = ROOT / "data" / "consensus_ranks.json"
dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"wrote {dest}")
