#!/usr/bin/env python3
"""One-time PFR scrape: offensive coordinator per team per season 2012-2025.
Polite rate (3.2s/page), resume-safe (progress saved after every page).
Output: data/raw/backtest/oc_history.json  {year: {TEAM: "OC Name"}}
"""
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "raw" / "backtest" / "oc_history.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"}

# PFR team codes -> our (Sleeper) codes
PFR = {"buf": "BUF", "mia": "MIA", "nwe": "NE", "nyj": "NYJ", "rav": "BAL",
       "cin": "CIN", "cle": "CLE", "pit": "PIT", "htx": "HOU", "clt": "IND",
       "jax": "JAX", "oti": "TEN", "den": "DEN", "kan": "KC", "rai": "LV",
       "sdg": "LAC", "crd": "ARI", "ram": "LAR", "sfo": "SF", "sea": "SEA",
       "dal": "DAL", "nyg": "NYG", "phi": "PHI", "was": "WAS", "chi": "CHI",
       "det": "DET", "gnb": "GB", "min": "MIN", "atl": "ATL", "car": "CAR",
       "nor": "NO", "tam": "TB"}

oc = {}
if OUT.exists():
    oc = json.loads(OUT.read_text(encoding="utf-8"))

todo = [(y, code, team) for y in range(2012, 2026) for code, team in PFR.items()
        if str(y) not in oc or team not in oc.get(str(y), {})]
print(f"{len(todo)} pages to fetch")
fails = 0
for i, (y, code, team) in enumerate(todo):
    url = f"https://www.pro-football-reference.com/teams/{code}/{y}.htm"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "replace")
        m = re.search(r"Offensive Coordinator[s]?:</strong>\s*(?:<a[^>]*>)?([^<\n]+)", html)
        name = m.group(1).strip() if m else ""
        oc.setdefault(str(y), {})[team] = name
        OUT.write_text(json.dumps(oc), encoding="utf-8")
        if i % 20 == 0:
            print(f"  {i}/{len(todo)} ({y} {team}: {name})", flush=True)
    except Exception as e:
        fails += 1
        print(f"  FAIL {y} {team}: {e}", flush=True)
        if fails > 30:
            print("too many failures, stopping")
            break
        time.sleep(20)
    time.sleep(3.2)
n = sum(len(v) for v in oc.values())
print(f"done: {n} team-seasons captured, {fails} failures")
