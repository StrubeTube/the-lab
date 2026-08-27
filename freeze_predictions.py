#!/usr/bin/env python3
"""LAB_OVERHAUL P1: freeze the 2026 Lab predictions BEFORE the season.

Snapshots every scored player's Lab outputs + ADP into
data/predictions_2026.json. This file is the pre-registered, untainted
holdout: 12 backtest seasons have been re-mined across many research
rounds, but this file is graded exactly once, in January 2027, by
score_predictions.py — with metrics fixed here, now, before any 2026
game is played. Do not regenerate after Sep 4 (draft week); git history
is the audit trail.
"""
import datetime
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
players = json.loads((ROOT / "docs" / "data" / "players.json").read_text(encoding="utf-8"))

out = {
    "frozen": datetime.date.today().isoformat(),
    "commit": subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True).stdout.strip(),
    "metrics_preregistered": {
        "early_bust": "ADP<=36: bust = pos finish > 2x pos-ADP-rank AND >15; "
                      "gap = bust% of low-safety half minus high-safety half",
        "late_hit": "ADP 84-240: hit = QB/TE top-12, RB/WR top-24; "
                    "gap = hit% of high-ceiling half minus low-ceiling half",
        "ordering": "within-position Spearman of sc vs final pos finish, "
                    "and of ADP vs finish (the market yardstick)",
    },
    "players": [],
}
for e in players:
    lab = e.get("lab") or {}
    if lab.get("sc") is None:
        continue
    out["players"].append({
        "id": e["id"], "name": e["name"], "pos": e["pos"], "team": e.get("team"),
        "adp": e.get("adp"), "proj": e.get("proj"),
        "sc": lab.get("sc"), "sfty": lab.get("sfty"), "ceil": lab.get("ceil"),
        "wc": lab.get("wc"), "ed": lab.get("ed"),
        "kg": lab.get("kg"), "kl": lab.get("kl"), "est": lab.get("est", 0),
    })
p = ROOT / "data" / "predictions_2026.json"
p.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"froze {len(out['players'])} players at commit {out['commit']} -> {p}")
