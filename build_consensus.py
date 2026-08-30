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
from pathlib import Path

ROOT = Path(__file__).parent
lists = json.loads((ROOT / "data" / "analyst_lists.json").read_text(encoding="utf-8"))

out = {}
for pos, srcs in lists["positional"].items():
    ranks = {}
    for src, names in srcs.items():
        seen = set()
        r = 0
        for name in names:
            if name in seen:
                continue  # duplicate rows in a source
            seen.add(name)
            r += 1
            ranks.setdefault(name, {})[src] = r
    out[pos] = [
        {"name": name, "avg": round(sum(rr.values()) / len(rr), 2),
         "n": len(rr), "ranks": rr}
        for name, rr in ranks.items()
    ]
    out[pos].sort(key=lambda x: x["avg"])
    print(f"{pos}: {len(out[pos])} players from {len(srcs)} sources; "
          f"top 3: {[x['name'] for x in out[pos][:3]]}")

ovr_ranks = {}
for src, pairs in lists["overall"].items():
    seen = set()
    for r, name in pairs:
        if name in seen:
            continue
        seen.add(name)
        ovr_ranks.setdefault(name, {})[src] = r
out["OVR"] = [
    {"name": name, "avg": round(sum(rr.values()) / len(rr), 2),
     "n": len(rr), "ranks": rr}
    for name, rr in ovr_ranks.items()
]
out["OVR"].sort(key=lambda x: x["avg"])
print(f"OVR: {len(out['OVR'])} players from {len(lists['overall'])} sources; "
      f"top 3: {[x['name'] for x in out['OVR'][:3]]}")

dest = ROOT / "data" / "consensus_ranks.json"
dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"wrote {dest}")
