#!/usr/bin/env python3
"""LAB_OVERHAUL P1: grade the frozen 2026 predictions. RUN IN JANUARY 2027.

Reads data/predictions_2026.json (frozen pre-season) and 2026 final
half-PPR positional finishes from the Sleeper season stats, then reports
EXACTLY the pre-registered metrics — early bust gap by safety, late hit
gap by ceiling, within-position Spearman of sc vs finish (with ADP as
the market yardstick). No other numbers, no re-slicing: this is the one
untainted out-of-sample test, spent once.
"""
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
P = json.loads((ROOT / "data" / "predictions_2026.json").read_text(encoding="utf-8"))
print(f"frozen {P['frozen']} @ {P['commit']} — {len(P['players'])} players")

stats = json.loads(urllib.request.urlopen(
    "https://api.sleeper.app/v1/stats/nfl/regular/2026", timeout=60).read())

# final half-PPR points, then positional finish ranks. Sleeper's
# pos_rank_half_ppr is used when present; otherwise rank within the
# frozen pool by points (identical treatment for every player).
pos_pts = {pid: st["pts_half_ppr"] for pid, st in stats.items()
           if isinstance(st, dict) and st.get("pts_half_ppr") is not None}
rows = [dict(r) for r in P["players"]]
sleeper_rank = {pid: st.get("pos_rank_half_ppr") for pid, st in stats.items()
                if isinstance(st, dict)}
pool_rank = {}
for pos in {r["pos"] for r in rows}:
    ranked = sorted((r for r in rows if r["pos"] == pos),
                    key=lambda x: -(pos_pts.get(x["id"]) or 0))
    for i, r in enumerate(ranked):
        pool_rank[r["id"]] = i + 1
for r in rows:
    r["finish"] = sleeper_rank.get(r["id"]) or pool_rank.get(r["id"])
    r["pts"] = pos_pts.get(r["id"]) or 0

def spearman(pairs):
    n = len(pairs)
    if n < 8:
        return None
    def rank(v):
        s = sorted(range(n), key=lambda i: v[i])
        out = [0.0] * n
        for i, j in enumerate(s):
            out[j] = i
        return out
    a = rank([p[0] for p in pairs]); b = rank([p[1] for p in pairs])
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    return num / (da * db) if da and db else None

# ---- pre-registered metric 1: early bust gap by safety ----
adp_rank = {}
for pos in {r["pos"] for r in rows}:
    ps = sorted((r for r in rows if r["pos"] == pos and r["adp"]), key=lambda x: x["adp"])
    for i, r in enumerate(ps):
        adp_rank[r["id"]] = i + 1
early = [r for r in rows if (r["adp"] or 999) <= 36 and r["finish"]]
def bust(r):
    return r["finish"] > 2 * adp_rank.get(r["id"], 99) and r["finish"] > 15
early.sort(key=lambda r: -(r["sfty"] or 0))
h = len(early) // 2
if h:
    hi = 100 * sum(map(bust, early[:h])) / h
    lo = 100 * sum(map(bust, early[h:])) / (len(early) - h)
    print(f"EARLY BUST GAP by safety: high-half {hi:.0f}% vs low-half {lo:.0f}%  (gap {lo-hi:+.1f})")

# ---- pre-registered metric 2: late hit gap by ceiling ----
late = [r for r in rows if 84 <= (r["adp"] or 0) <= 240 and r["finish"]]
def hit(r):
    return r["finish"] <= (12 if r["pos"] in ("QB", "TE") else 24)
late.sort(key=lambda r: -(r["ceil"] or 0))
h = len(late) // 2
if h:
    hi = 100 * sum(map(hit, late[:h])) / h
    lo = 100 * sum(map(hit, late[h:])) / (len(late) - h)
    print(f"LATE HIT GAP by ceiling: high-half {hi:.0f}% vs low-half {lo:.0f}%  (gap {hi-lo:+.1f})")

# ---- pre-registered metric 3: ordering vs the market ----
for pos in sorted({r["pos"] for r in rows}):
    sub = [r for r in rows if r["pos"] == pos and r["finish"] and r["sc"] is not None and r["adp"]]
    s_lab = spearman([(-r["sc"], r["finish"]) for r in sub])
    s_adp = spearman([(r["adp"], r["finish"]) for r in sub])
    if s_lab is not None:
        print(f"  {pos}: Spearman lab {s_lab:+.3f} vs ADP {s_adp:+.3f}  (n={len(sub)})")
