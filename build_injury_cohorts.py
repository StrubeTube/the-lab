#!/usr/bin/env python3
"""THE LAB - injury cohort builder (Alex's spec, Fantasy-Footballers style).

From nflverse weekly injury reports (2018-2024) + Sleeper weekly scoring:
  1. Detect injury EPISODES per skill player: consecutive weeks listed with
     the same primary body part.
  2. Build COHORTS per body part: how many games do players actually miss,
     how much of their pre-injury output do they produce in the 3 games
     after returning, and how often does the same body part recur within a
     year.
  3. Save data/injury_cohorts.json for compute.py + the player card.

Run ad hoc to refresh (downloads cache in data/raw/backtest/).
"""
import csv
import json
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
CACHE = ROOT / "data" / "raw" / "backtest"
POS = {"QB", "RB", "WR", "TE"}
YEARS = range(2018, 2026)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def cached_text(name, url):
    f = CACHE / name
    if not f.exists():
        print(f"  fetching {name}...")
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            f.write_bytes(r.read())
    return f.read_text(encoding="utf-8", errors="replace")


def cached_json(name, url):
    f = CACHE / name
    if not f.exists():
        print(f"  fetching {name}...")
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            f.write_bytes(r.read())
    return json.loads(f.read_text(encoding="utf-8"))


print("Loading players + weekly data...")
players_db = json.loads((ROOT / "data" / "raw" / "players_nfl.json").read_text(encoding="utf-8"))
gsis_to_pid = {}
for pid, p in players_db.items():
    if isinstance(p, dict) and p.get("position") in POS:
        g = (p.get("gsis_id") or "").strip()
        if g:
            gsis_to_pid[g] = pid

# weekly half-PPR points for every (year, week)
wk_pts = {}  # (yr, wk) -> {pid: pts}
for yr in YEARS:
    for wk in range(1, 19):
        if yr < 2021 and wk == 18:
            continue  # 17-game era started 2021
        d = cached_json(f"wk_{yr}_{wk}.json",
                        f"https://api.sleeper.app/v1/stats/nfl/regular/{yr}/{wk}")
        wk_pts[(yr, wk)] = {pid: (st.get("pts_half_ppr") or 0)
                            for pid, st in (d or {}).items() if isinstance(st, dict)}

# normalize the body-part vocabulary a little
PART_MAP = {"Hamstring": "Hamstring", "Knee": "Knee", "Ankle": "Ankle",
            "Shoulder": "Shoulder", "Concussion": "Concussion", "Groin": "Groin",
            "Calf": "Calf", "Foot": "Foot", "Back": "Back", "Hip": "Hip",
            "Quadricep": "Quad", "Quad": "Quad", "Thigh": "Quad",
            "Toe": "Toe", "Wrist": "Hand", "Hand": "Hand", "Finger": "Hand",
            "Thumb": "Hand", "Ribs": "Ribs", "Rib": "Ribs", "Chest": "Ribs",
            "Achilles": "Achilles", "Oblique": "Oblique", "Elbow": "Arm",
            "Forearm": "Arm", "Biceps": "Arm", "Triceps": "Arm", "Pectoral": "Pectoral",
            "Heel": "Foot", "Shin": "Shin", "Fibula": "Shin", "Neck": "Neck",
            "Abdomen": "Oblique", "Core": "Oblique", "Hernia": "Oblique"}

print("Detecting injury episodes...")
listed = defaultdict(dict)  # (pid, yr) -> {wk: (part, status)}
for yr in YEARS:
    txt = cached_text(f"injuries_{yr}.csv",
                      f"https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{yr}.csv")
    import io
    for row in csv.DictReader(io.StringIO(txt)):
        if row.get("game_type") not in ("REG", ""):
            continue
        pid = gsis_to_pid.get((row.get("gsis_id") or "").strip())
        if not pid:
            continue
        part_raw = (row.get("report_primary_injury") or row.get("practice_primary_injury") or "").strip()
        part = PART_MAP.get(part_raw)
        if not part:
            continue
        try:
            wk = int(row["week"])
        except (ValueError, KeyError):
            continue
        listed[(pid, yr)][wk] = (part, (row.get("report_status") or "").strip())

episodes = []  # {pid, yr, part, wk0, wk1, out (games ruled Out), n_listed}
for (pid, yr), weeks in listed.items():
    for part in {v[0] for v in weeks.values()}:
        wks = sorted(w for w, v in weeks.items() if v[0] == part)
        run = []
        for w in wks:
            if run and w - run[-1] > 2:  # gap of >2 clean weeks ends an episode
                episodes.append({"pid": pid, "yr": yr, "part": part, "wk0": run[0], "wk1": run[-1],
                                 "out": sum(1 for x in run if weeks[x][1] == "Out"), "n": len(run)})
                run = []
            run.append(w)
        if run:
            episodes.append({"pid": pid, "yr": yr, "part": part, "wk0": run[0], "wk1": run[-1],
                             "out": sum(1 for x in run if weeks[x][1] == "Out"), "n": len(run)})
print(f"  {len(episodes)} episodes across {len(YEARS)} seasons")

print("Building cohorts...")
coh = defaultdict(lambda: {"n": 0, "out": [], "ret": [], "recur": 0, "recur_n": 0})
by_player_part = defaultdict(list)
for e in episodes:
    by_player_part[(e["pid"], e["part"])].append(e)

def ppg(pid, yr, w0, w1):
    """Mean half-PPR points over weeks [w0, w1] in games actually played."""
    vals = []
    for w in range(max(1, w0), min(19, w1 + 1)):
        v = wk_pts.get((yr, w), {}).get(pid)
        if v is not None and v > 0:
            vals.append(v)
    return sum(vals) / len(vals) if len(vals) >= 2 else None

for e in episodes:
    c = coh[e["part"]]
    c["n"] += 1
    c["out"].append(e["out"])
    # return trajectory: 3 games after the episode vs the pre-injury baseline
    base = ppg(e["pid"], e["yr"], e["wk0"] - 6, e["wk0"] - 1)
    ret = ppg(e["pid"], e["yr"], e["wk1"] + 1, e["wk1"] + 3)
    if base and ret and base >= 5:
        c["ret"].append(ret / base)
    # recurrence: same part, new episode within ~1 year
    c["recur_n"] += 1
    for e2 in by_player_part[(e["pid"], e["part"])]:
        if e2 is e:
            continue
        later = (e2["yr"] == e["yr"] and e2["wk0"] > e["wk1"] + 2) or \
                (e2["yr"] == e["yr"] + 1 and e2["wk0"] <= e["wk0"])
        if later:
            c["recur"] += 1
            break

out = {}
for part, c in sorted(coh.items(), key=lambda x: -x[1]["n"]):
    if c["n"] < 30:
        continue
    out[part] = {
        "n": c["n"],
        "avgOut": round(sum(c["out"]) / len(c["out"]), 2),
        "retPct": round(100 * sum(c["ret"]) / len(c["ret"]), 1) if c["ret"] else None,
        "retN": len(c["ret"]),
        "recurPct": round(100 * c["recur"] / c["recur_n"], 1) if c["recur_n"] else None,
    }
    print(f"  {part:11} n={out[part]['n']:4}  avg games Out {out[part]['avgOut']:>5}  "
          f"return output {out[part]['retPct']}% of baseline (n={out[part]['retN']})  "
          f"recurs within a year {out[part]['recurPct']}%")

dest = ROOT / "data" / "injury_cohorts.json"
dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"wrote {dest}")

# raw episodes for the backtest's injury-burden feature + player-card context
epi_dest = CACHE / "injury_episodes.json"
epi_dest.write_text(json.dumps(episodes), encoding="utf-8")
print(f"wrote {epi_dest} ({len(episodes)} episodes)")

# recent per-player episodes (last 2 seasons) for the player card
recent = {}
for e in episodes:
    if e["yr"] >= 2024:
        recent.setdefault(e["pid"], []).append({"y": e["yr"], "p": e["part"], "n": e["n"], "o": e["out"]})
rec_dest = ROOT / "data" / "injury_recent.json"
rec_dest.write_text(json.dumps(recent), encoding="utf-8")
print(f"wrote {rec_dest} ({len(recent)} players)")
print(f"wrote {epi_dest} ({len(episodes)} episodes)")
