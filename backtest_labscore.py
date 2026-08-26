#!/usr/bin/env python3
"""THE LAB - Lab Score phase 3: the backtest.

For each season Y in 2021-2025, rebuild the Lab Score as it would have
looked that August -- season Y-1 Sleeper stats, season Y FFC ADP, nflverse
roster files for team attribution, real draft capital and age curves --
then grade it against what actually happened in season Y (half-PPR finish).

Historical proxies for 2026-only inputs (documented, unavoidable):
  - No archived projections -> offense quality / QB quality / weapons /
    backfield share use PRIOR-season team fantasy points; the rookie (EST)
    path leans on ADP percentile instead of projection percentile.
  - No archived Vegas or analyst data.

Tests:
  1. BEAT-ADP: does the blended score order players better than ADP alone?
     (Spearman rank correlation with positional finish, pooled per position)
  2. SAFETY: among early picks (ADP <= 36), do high-safety players bust less?
     (bust = positional finish worse than 2x their positional ADP rank)
  3. CEILING: among late picks (ADP 84-240), do high-ceiling players hit
     more? (hit = QB/TE top-12, RB/WR top-24 positional finish)

Usage: python backtest_labscore.py           (downloads are cached in
       data/raw/backtest/, ~8 files, first run only)
"""
import csv
import datetime
import io
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CACHE = ROOT / "data" / "raw" / "backtest"
CACHE.mkdir(parents=True, exist_ok=True)
POS = ["QB", "RB", "WR", "TE"]
SEASONS = list(range(2014, 2026))  # score-years; pre-2018 uses FFC STANDARD ADP
                                   # (half-PPR ADP starts 2018 — standard is a fair
                                   # market-rank proxy, slight pass-catcher skew)
TRAIN = set(range(2014, 2023))     # weight tuning trains here...
HOLDOUT = set(range(2023, 2026))   # ...and is judged here
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def cached(name, url, is_csv=False):
    f = CACHE / name
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    print(f"  fetching {name}...")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    if is_csv:
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8", "replace"))))
        out = [{k: row.get(k) for k in ("sleeper_id", "team", "gsis_id")} for row in rows]
    else:
        out = json.loads(raw)
    f.write_text(json.dumps(out), encoding="utf-8")
    return out


def norm(name):
    n = (name or "").lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    return re.sub(r"[^a-z]", "", n)


print("Loading base data...")
players_db = json.loads((ROOT / "data" / "raw" / "players_nfl.json").read_text(encoding="utf-8"))
adp_hist = json.loads((ROOT / "data" / "raw" / "ffc_adp_hist.json").read_text(encoding="utf-8"))
nv_draft_rows = json.loads((ROOT / "data" / "raw" / "nflverse_draft.json").read_text(encoding="utf-8"))

by_name_pos = {}
for pid, p in players_db.items():
    if isinstance(p, dict) and p.get("position") in POS:
        by_name_pos.setdefault(norm(p.get("full_name")) + "|" + p["position"], pid)

dc_by_gsis, dc_by_name = {}, {}
for row in nv_draft_rows:
    e = {"round": row["r"], "pick": row["pk"], "season": row["s"]}
    if row["g"]:
        dc_by_gsis[row["g"]] = e
    dc_by_name[norm(row["n"]) + "|" + row["p"]] = e

print("Loading historical stats + rosters (cached after first run)...")
gsis_to_pid = {}
for pid_, p_ in players_db.items():
    if isinstance(p_, dict):
        g_ = (p_.get("gsis_id") or "").strip()
        if g_:
            gsis_to_pid.setdefault(g_, pid_)
stats = {}
rosters = {}
for yr in range(2012, 2026):
    if yr == 2025:
        stats[yr] = json.loads((ROOT / "data" / "raw" / "stats_2025.json").read_text(encoding="utf-8"))
    else:
        stats[yr] = cached(f"stats_{yr}.json", f"https://api.sleeper.app/v1/stats/nfl/regular/{yr}")
    rows = cached(f"roster_{yr}.json",
                  f"https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{yr}.csv",
                  is_csv=True)
    m_ = {}
    for r in rows:
        if not r.get("team"):
            continue
        team = "LAR" if r["team"] == "LA" else r["team"]
        pid_ = r.get("sleeper_id") or gsis_to_pid.get((r.get("gsis_id") or "").strip())
        if pid_:
            m_[pid_] = team
    rosters[yr] = m_

# historical positional finishes (for the career-peak pedigree signal)
fin_hist = {}
for yy, S_ in stats.items():
    ranks = {}
    for pos_ in POS:
        scored_ = sorted(((st_.get("pts_half_ppr") or 0), pid_) for pid_, st_ in S_.items()
                         if isinstance(st_, dict)
                         and (players_db.get(pid_) or {}).get("position") == pos_)
        scored_.reverse()
        for i_, (_, pid_) in enumerate(scored_):
            ranks[pid_] = i_ + 1
    fin_hist[yy] = ranks

# late-season weekly touches (weeks 13-18) for the December-role signal
weekly_late = {}  # (year, pid) -> {"tgt","att","wks"}
for yr in range(2017, 2025):
    for wk in range(13, 19):
        d = cached(f"wk_{yr}_{wk}.json",
                   f"https://api.sleeper.app/v1/stats/nfl/regular/{yr}/{wk}")
        for pid, st in (d or {}).items():
            if not isinstance(st, dict):
                continue
            tgt = st.get("rec_tgt") or 0
            att = st.get("rush_att") or 0
            if tgt or att:
                e = weekly_late.setdefault((yr, pid), {"tgt": 0, "att": 0, "wks": 0})
                e["tgt"] += tgt
                e["att"] += att
                e["wks"] += 1

# injury episodes + cohorts (built by build_injury_cohorts.py)
try:
    INJ_EPISODES = json.loads((CACHE / "injury_episodes.json").read_text(encoding="utf-8"))
    INJ_COHORTS = json.loads((ROOT / "data" / "injury_cohorts.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    INJ_EPISODES, INJ_COHORTS = [], {}
inj_by_py = defaultdict_inj = {}
for e_ in INJ_EPISODES:
    inj_by_py.setdefault((e_["pid"], e_["yr"]), []).append(e_)

def injury_burden(pid, Y):
    """Prior-2-season injury load, weighted by each body part's cohort
    recurrence rate and lingering-output deficit."""
    b = 0.0
    for yy in (Y - 1, Y - 2):
        for e_ in inj_by_py.get((pid, yy), []):
            c_ = INJ_COHORTS.get(e_["part"]) or {}
            recur = (c_.get("recurPct") or 10) / 100
            deficit = max(0.0, 1 - (c_.get("retPct") or 100) / 100)
            w_ = 1.0 if yy == Y - 1 else 0.5
            b += w_ * e_["n"] * (recur + deficit + 0.15 * e_["out"])
    return b

DC_VAL = {1: 1.0, 2: 0.8, 3: 0.65, 4: 0.5, 5: 0.4, 6: 0.32, 7: 0.25}
AGE_CURVE = {
    "RB": [(21, 0.85), (23, 1.0), (26, 0.97), (27, 0.83), (28, 0.76),
           (29, 0.62), (30, 0.45), (32, 0.25), (35, 0.10)],
    "WR": [(21, 0.70), (24, 1.0), (28, 1.0), (29, 0.93), (30, 0.85),
           (31, 0.70), (33, 0.45), (36, 0.15)],
    "TE": [(21, 0.45), (23, 0.75), (25, 1.0), (28, 1.0), (29, 0.92),
           (31, 0.75), (33, 0.50), (36, 0.20)],
    "QB": [(22, 0.85), (25, 1.0), (34, 1.0), (36, 0.85), (38, 0.70), (42, 0.40)],
}


def age_level(pos, age):
    pts = AGE_CURVE.get(pos)
    if not pts or age is None:
        return None
    if age <= pts[0][0]:
        return pts[0][1]
    if age >= pts[-1][0]:
        return pts[-1][1]
    for (a0, v0), (a1, v1) in zip(pts, pts[1:]):
        if a0 <= age <= a1:
            return v0 + (v1 - v0) * (age - a0) / (a1 - a0)
    return None


def ols2(rows):
    s11 = s12 = s22 = s1y = s2y = 0.0
    for x1, x2, y in rows:
        s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2
        s1y += x1 * y; s2y += x2 * y
    det = s11 * s22 - s12 * s12
    if abs(det) < 1e-9:
        return (0.0, 0.0)
    a = (s22 * s1y - s12 * s2y) / det
    b = (s11 * s2y - s12 * s1y) / det
    if b < 0:
        return (s1y / s11 if s11 else 0.0, 0.0)
    if a < 0:
        return (0.0, s2y / s22 if s22 else 0.0)
    return (a, b)


PILLARS = {
    "RB": {"opp": [("wo", .60), ("snp", .25), ("tshare", .15)],
           "tal": [("yac", .40), ("rypg", .35), ("tdluck", .25)],
           "sit": [("offq", .40), ("vaca", .30), ("bfshare", .30)]},
    "WR": {"opp": [("tshare", .40), ("ayshare", .30), ("tpg", .30)],
           "tal": [("tprr", .25), ("ypt", .25), ("rypg", .35), ("tdluck", .15)],
           "sit": [("vac", .25), ("offq", .25), ("qbq", .25), ("posshare", .25)]},
    "TE": {"opp": [("yptpa", .40), ("tshare", .35), ("tpg", .25)],
           "tal": [("rypg", .50), ("ypt", .30), ("tdluck", .20)],
           "sit": [("vac", .25), ("offq", .25), ("qbq", .25), ("posshare", .25)]},
    "QB": {"opp": [("qrypg", .50), ("papg", .20), ("qrza", .30)],
           "tal": [("pypg", .60), ("ypa", .20), ("tdluck", .20)],
           "sit": [("weapons", .55), ("offq", .45)]},
}

# per-game performance metrics of ONE season (shared by the 2-year blend)
PERF_KEYS = ("wo", "snp", "tshare", "ayshare", "yptpa", "tpg", "rypg",
             "ypt", "yac", "tprr", "qrypg", "papg", "qrza", "pypg", "ypa")


def perf(st, tt, pos):
    gp = st.get("gp") or 0
    if gp < 1:
        return None
    g = max(gp, 1)
    tgt, rzt = st.get("rec_tgt") or 0, st.get("rec_rz_tgt") or 0
    att, rza = st.get("rush_att") or 0, st.get("rush_rz_att") or 0
    m = {"gp": gp}
    m["wo"] = (0.55 * (att - rza) + 1.25 * rza + 1.45 * (tgt - rzt) + 2.25 * rzt) / g
    if st.get("tm_off_snp"):
        m["snp"] = (st.get("off_snp") or 0) / st["tm_off_snp"]
    if tt and tt["tgt"]:
        m["tshare"] = tgt / tt["tgt"]
        m["yptpa"] = (st.get("rec_yd") or 0) / tt["tgt"]
    if tt and tt["ay"]:
        m["ayshare"] = (st.get("rec_air_yd") or 0) / tt["ay"]
    m["tpg"] = tgt / g
    m["rypg"] = (st.get("rec_yd") or 0) / g
    if tgt >= 15:
        m["ypt"] = (st.get("rec_yd") or 0) / tgt
    if att >= 25:
        m["yac"] = (st.get("rush_yac") or 0) / att
    if (st.get("off_snp") or 0) >= 100:
        m["tprr"] = tgt / st["off_snp"]
    if pos == "QB":
        m["qrypg"] = (st.get("rush_yd") or 0) / g
        m["papg"] = (st.get("pass_att") or 0) / g
        m["qrza"] = (st.get("rush_rz_att") or 0) / g
        m["pypg"] = (st.get("pass_yd") or 0) / g
        m["ypa"] = st.get("pass_ypa")
    return m


def adp_pool_for(Y):
    """FFC ADP players for year Y — from the repo's history file (2020+) or
    a cached direct FFC fetch for older seasons."""
    d = adp_hist.get(str(Y))
    if not d and Y >= 2018:
        d = cached(f"ffc_{Y}.json",
                   f"https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=10&year={Y}")
    if not d:  # half-PPR ADP starts 2018; standard is the market proxy before
        d = cached(f"ffc_std_{Y}.json",
                   f"https://fantasyfootballcalculator.com/api/v1/adp/standard?teams=10&year={Y}")
    return (d or {}).get("players", [])


def build_season(Y):
    """Returns rows: {pid,pos,adp,safety,ceiling,fin,est, outcome fields}."""
    prior, S = stats[Y - 1], stats[Y]
    ros_prior, ros_now = rosters[Y - 1], rosters[Y]

    # ADP pool for year Y from FFC
    pool = []
    for e in adp_pool_for(Y):
        if e.get("position") not in POS:
            continue
        pid = by_name_pos.get(norm(e.get("name")) + "|" + e["position"])
        if pid:
            pool.append((pid, e["position"], e["adp"]))

    # prior-season team totals + vacated (departed = different team in Y)
    team_opp, team_pts = {}, {}
    for spid, st in prior.items():
        p = players_db.get(spid)
        if not isinstance(p, dict) or p.get("position") not in POS:
            continue
        t = ros_prior.get(spid)
        if not t:
            continue
        d = team_opp.setdefault(t, {"tgt": 0, "att": 0, "ay": 0, "vtgt": 0, "vatt": 0, "rz": 0})
        tp = team_pts.setdefault(t, {"all": 0.0, "qb": 0.0, "wrte": 0.0, "rb": {}})
        tgt, att, ay = st.get("rec_tgt") or 0, st.get("rush_att") or 0, st.get("rec_air_yd") or 0
        d["tgt"] += tgt; d["att"] += att; d["ay"] += ay
        d["rz"] += (st.get("rec_rz_tgt") or 0) + (st.get("rush_rz_att") or 0)
        pts = st.get("pts_half_ppr") or 0
        tp["all"] += pts
        if p["position"] == "QB":
            tp["qb"] = max(tp["qb"], pts)
        elif p["position"] == "RB":
            tp["rb"][spid] = pts
        else:
            tp["wrte"] += pts
        if ros_now.get(spid) != t:
            d["vtgt"] += tgt; d["vatt"] += att

    # position-room competition: prior-year points of everyone NOW on team T
    # at position P — a player's share of his room is his claim on its work
    grp_pts = {}
    for spid2, p2 in players_db.items():
        if not isinstance(p2, dict) or p2.get("position") not in POS:
            continue
        t2 = ros_now.get(spid2)
        if t2:
            grp_pts.setdefault((t2, p2["position"]), {})[spid2] = \
                (prior.get(spid2) or {}).get("pts_half_ppr") or 0

    # Y-2 team totals (for the 2-year metric blend's share denominators)
    prior2 = stats.get(Y - 2) or {}
    ros_prior2 = rosters.get(Y - 2) or {}
    team_opp2 = {}
    for spid, st in prior2.items():
        p = players_db.get(spid)
        if not isinstance(p, dict) or p.get("position") not in POS:
            continue
        t = ros_prior2.get(spid)
        if not t:
            continue
        d = team_opp2.setdefault(t, {"tgt": 0, "att": 0, "ay": 0})
        d["tgt"] += st.get("rec_tgt") or 0
        d["att"] += st.get("rush_att") or 0
        d["ay"] += st.get("rec_air_yd") or 0

    # xTD rates for season Y-1
    rec_r, rush_r, pass_r = [], [], []
    for spid, st in prior.items():
        p = players_db.get(spid)
        if not isinstance(p, dict) or p.get("position") not in POS:
            continue
        tgt, rzt = st.get("rec_tgt") or 0, st.get("rec_rz_tgt") or 0
        att, rza = st.get("rush_att") or 0, st.get("rush_rz_att") or 0
        pat, rzp = st.get("pass_att") or 0, st.get("pass_rz_att") or 0
        if tgt >= 15:
            rec_r.append((rzt, tgt - rzt, st.get("rec_td") or 0))
        if att >= 25:
            rush_r.append((rza, att - rza, st.get("rush_td") or 0))
        if pat >= 100:
            pass_r.append((rzp, pat - rzp, st.get("pass_td") or 0))
    RATES = {"rec": ols2(rec_r), "rush": ols2(rush_r), "pass": ols2(pass_r)}

    # raw metrics per pooled player
    raw = {}
    sept = datetime.date(Y, 9, 1)
    for pid, pos, adp in pool:
        p = players_db.get(pid) or {}
        st = prior.get(pid) or {}
        gp = st.get("gp") or 0
        t_now = ros_now.get(pid)
        t_prior = ros_prior.get(pid)
        tt = team_opp.get(t_prior)
        tgt, rzt = st.get("rec_tgt") or 0, st.get("rec_rz_tgt") or 0
        att, rza = st.get("rush_att") or 0, st.get("rush_rz_att") or 0
        m = {"gp": gp, "adp": adp}
        # 2-year weighted per-game metrics (0.65 recent / 0.35 prior) —
        # one injured or fluky season no longer defines the profile
        m1 = perf(st, tt, pos)
        st2 = prior2.get(pid) or {}
        m2 = perf(st2, team_opp2.get(ros_prior2.get(pid)), pos) if (st2.get("gp") or 0) >= 4 else None
        if m1:
            for k in PERF_KEYS:
                v1, v2 = m1.get(k), m2.get(k) if m2 else None
                if v1 is not None and v2 is not None:
                    m[k] = 0.65 * v1 + 0.35 * v2
                elif v1 is not None:
                    m[k] = v1
                elif v2 is not None:
                    m[k] = v2
        # durability: share of possible games played over the lookback
        gp2 = st2.get("gp") or 0
        m["dur"] = (gp + gp2) / 34 if m2 is not None else (gp / 17 if gp else None)
        # --- candidate hone signals ---
        # career touch odometer (RB wear): all touches on record before Y
        odo = 0
        for yy in range(2012, Y):
            so = (stats.get(yy) or {}).get(pid) or {}
            odo += (so.get("rush_att") or 0) + (so.get("rec") or 0)
        m["odo"] = -odo  # inverted: fresher legs -> higher percentile
        # career-peak pedigree: best positional finish on record before Y
        peak = min((fin_hist.get(yy, {}).get(pid, 999) for yy in range(2012, Y)), default=999)
        if peak < 999:
            m["peak"] = -peak  # inverted: better best-ever finish -> higher pct
        # TD-dependency: share of last-year points that came from TDs
        pts_prior = st.get("pts_half_ppr") or 0
        if pts_prior >= 60:
            tdp = 6 * ((st.get("rec_td") or 0) + (st.get("rush_td") or 0)) + 4 * (st.get("pass_td") or 0)
            m["tddep"] = -(tdp / pts_prior)  # inverted: less TD-reliant -> safer
        # red-zone role: his share of the team's red-zone opportunities
        if tt and tt.get("rz"):
            m["rzsh"] = (rzt + rza) / tt["rz"]
        # air yards per target (spike-week WR profile)
        if tgt >= 25:
            m["adot"] = (st.get("rec_air_yd") or 0) / tgt
        # room share: his slice of his CURRENT team's position group
        room = grp_pts.get((ros_now.get(pid), pos))
        if room:
            tot_room = sum(room.values())
            if tot_room > 0:
                m["posshare"] = (room.get(pid) or 0) / tot_room
        # --- predictive-stat candidates (research round 2) ---
        # usage trajectory: y/y target-share growth (ascending role)
        if m1 and m2 and m1.get("tshare") is not None and m2.get("tshare") is not None:
            m["tsdelta"] = m1["tshare"] - m2["tshare"]
        # December role: late-season touches/gm vs full-season touches/gm
        wl = weekly_late.get((Y - 1, pid))
        if wl and wl["wks"] >= 3 and gp >= 8:
            late_pg = (1.45 * wl["tgt"] + 0.55 * wl["att"]) / wl["wks"]
            full_pg = (1.45 * tgt + 0.55 * att) / gp
            if full_pg > 2:
                m["lategrow"] = late_pg / full_pg
        # usage-vs-output gap: weighted opportunity outran actual points
        if m1 and m1.get("wo") is not None and gp >= 6:
            m["ugap"] = m1["wo"] - (st.get("pts_half_ppr") or 0) / gp
        # unrealized air yards (WR): deep usage that hasn't converted yet
        if pos == "WR" and gp >= 6 and tgt >= 40:
            m["unrl"] = ((st.get("rec_air_yd") or 0) - (st.get("rec_yd") or 0)) / gp
        # injury burden: cohort-weighted 2-year injury load (inverted)
        m["injb"] = -injury_burden(pid, Y)
        if gp >= 1:
            a, b = RATES["rec"]
            exp = a * rzt + b * max(0, tgt - rzt)
            a, b = RATES["rush"]
            exp += a * rza + b * max(0, att - rza)
            a, b = RATES["pass"]
            exp += a * (st.get("pass_rz_att") or 0) + b * max(0, (st.get("pass_att") or 0) - (st.get("pass_rz_att") or 0))
            act = (st.get("rec_td") or 0) + (st.get("rush_td") or 0) + (st.get("pass_td") or 0)
            m["tdluck"] = -(act - exp)
        # situation (prior-year points proxies, attached by CURRENT team)
        tp = team_pts.get(t_now) or {}
        m["offq"] = tp.get("all")
        m["qbq"] = tp.get("qb")
        m["weapons"] = tp.get("wrte")
        if pos == "RB" and tp.get("rb"):
            tot = sum(tp["rb"].values())
            m["bfshare"] = (tp["rb"].get(pid) or 0) / tot if tot else None
        d2 = team_opp.get(t_now)
        if d2 and d2["tgt"]:
            m["vac"] = d2["vtgt"] / d2["tgt"]
            m["vaca"] = d2["vatt"] / d2["att"] if d2["att"] else None
        # trajectory
        bd = p.get("birth_date")
        age = None
        if bd:
            try:
                b2 = datetime.date(*map(int, bd.split("-")))
                age = (sept - b2).days / 365.25
            except ValueError:
                pass
        if age:
            lvl = age_level(pos, age)
            m["alvl"] = lvl
            m["aslp"] = age_level(pos, age + 1) - lvl if lvl is not None else None
            m["youth"] = max(0.0, min(1.0, (27 - age) / 6))
        gid = (p.get("gsis_id") or "").strip()
        dc = (dc_by_gsis.get(gid) if gid else None) or dc_by_name.get(norm(p.get("full_name")) + "|" + pos)
        m["dc"] = DC_VAL.get((dc or {}).get("round"), 0.15)
        m["exp"] = Y - dc["season"] if dc else (p.get("years_exp") or 0)
        m["adpinv"] = -adp  # EST proxy for projection (better ADP = better)
        raw[pid] = (pos, m)

    # percentiles within position
    import bisect
    pools_ = {}
    for pid, (pos, m) in raw.items():
        for k, v in m.items():
            if isinstance(v, (int, float)):
                pools_.setdefault((pos, k), []).append(v)
    for k in pools_:
        pools_[k].sort()

    def pct(pos, m, key):
        v = m.get(key)
        pool2 = pools_.get((pos, key))
        if v is None or not pool2 or len(pool2) < 5:
            return None
        lo, hi = bisect.bisect_left(pool2, v), bisect.bisect_right(pool2, v)
        return 100.0 * ((lo + hi) / 2) / len(pool2)

    def mix(parts):
        tot = sum(w for pv, w in parts if pv is not None)
        return sum(pv * w for pv, w in parts if pv is not None) / tot if tot else None

    # outcome: positional finish by season-Y half-PPR total
    fin_rank = {}
    for pos in POS:
        scored = sorted(((S.get(pid, {}).get("pts_half_ppr") or 0), pid)
                        for pid in raw if raw[pid][0] == pos)
        scored.reverse()
        for i, (_, pid) in enumerate(scored):
            fin_rank[pid] = i + 1

    rows = []
    for pid, (pos, m) in raw.items():
        P2 = PILLARS[pos]
        opp = mix([(pct(pos, m, k), w) for k, w in P2["opp"]])
        tal = mix([(pct(pos, m, k), w) for k, w in P2["tal"]])
        sit = mix([(pct(pos, m, k), w) for k, w in P2["sit"]])
        dc_p = pct(pos, m, "dc")
        trS = mix([(pct(pos, m, "alvl"), .60), (dc_p, .40)])
        trC = mix([(pct(pos, m, "aslp"), .35), (pct(pos, m, "youth"), .25),
                   (dc_p, .25), (100.0 if 1 <= m.get("exp", 0) <= 3 else 30.0, .15)])
        est = False
        shrink = min(1.0, m["gp"] / 10) if m["gp"] else 0.0
        adp_p = pct(pos, m, "adpinv")
        if m["gp"] < 4:
            est = True
            opp = mix([(adp_p, .75), (dc_p, .25)])
            tal = mix([(adp_p, .55), (dc_p, .45)])
            if opp is not None:
                opp = 50 + (opp - 50) * 0.7
            if tal is not None:
                tal = 50 + (tal - 50) * 0.7
        else:
            if opp is not None:
                opp = 50 + (opp - 50) * shrink
            if tal is not None:
                tal = 50 + (tal - 50) * shrink
        # projected-role blend feeds SAFETY only: "will he return his slot"
        # depends on the expected current role; CEILING keeps the pure
        # historical resume so contrarian late-pick signal isn't washed out
        opp_role = opp
        if not est and opp is not None and adp_p is not None:
            opp_role = 0.70 * opp + 0.30 * adp_p
        if any(v is None for v in (opp, tal, sit, trS, trC)):
            continue
        dur_p = pct(pos, m, "dur")
        # weights tuned on 2018-2022, validated on 2023-2025 holdout:
        # safety opp-heavy (+19.3 holdout bust gap vs +12.3 for the old
        # .40/.20/.18/.12/.10), ceiling opp-back (+9.3 holdout hit gap)
        safety = mix([(opp_role, .50), (tal, .15), (sit, .15), (trS, .20)])  # dur dropped by grand audit A6
        ceil_base = .35 * opp + .25 * tal + .15 * sit + .25 * trC  # grand-audit T2, 12/12 folds
        # shipped ceiling (hone combo C5): talent-over-usage gap, red-zone
        # role share, WR air-yards depth, capital-gated breakout window
        gap_v = max(0, (tal - opp)) if (tal is not None and opp is not None) else 0
        rz_p = pct(pos, m, "rzsh")
        ad_p = pct(pos, m, "adot")
        window_v = m["dc"] >= 0.65 and ((pos in ("WR", "TE") and 1 <= m.get("exp", 0) <= 3)
                                        or (pos == "RB" and m.get("exp", 0) <= 2))
        # (talent-over-usage gap REMOVED by ablation 08-26: after the ceiling
        # retune to opp .25 it fought the opportunity weight — dropping it
        # improved train +11.8->+13.7 AND holdout +9.3->+11.1)
        ceiling = (0.82 * ceil_base
                   + 0.10 * (rz_p if rz_p is not None else 50)
                   + 0.08 * ((ad_p if ad_p is not None else 50) if pos == "WR" else 50))
        if window_v:
            ceiling += 4
        # career-peak pedigree (validated: bounce-back vets are the largest
        # missed-breakout bucket -- Engram/Pitts/Wilson/Gronk pattern)
        peak_p_v = pct(pos, m, "peak")
        if peak_p_v is not None:
            ceiling = 0.90 * ceiling + 0.10 * peak_p_v
        wc = max(0.15, min(0.85, (m["adp"] - 24) / 96))
        fin = (1 - wc) * safety + wc * ceiling
        if est:
            fin = 50 + (fin - 50) * 0.75
        dcr_ok = m["dc"] >= 0.65  # drafted rounds 1-3
        rows.append({"pid": pid, "pos": pos, "adp": m["adp"], "est": est,
                     "safety": safety, "ceiling": ceiling, "ceil_base": ceil_base, "fin": fin,
                     "comp": {"opp": opp, "opp_role": opp_role, "tal": tal, "sit": sit,
                              "trS": trS, "trC": trC, "dur": dur_p,
                              "rz": rz_p, "ad": ad_p, "gapv": gap_v, "win": window_v},
                     "outcome": fin_rank.get(pid),
                     "pts": S.get(pid, {}).get("pts_half_ppr") or 0,
                     "season": Y,
                     # candidate hone signals (percentiles / flags)
                     "odo_p": pct(pos, m, "odo"), "tddep_p": pct(pos, m, "tddep"),
                     "rzsh_p": pct(pos, m, "rzsh"), "adot_p": pct(pos, m, "adot"),
                     "peak_p": pct(pos, m, "peak"),
                     "tsd_p": pct(pos, m, "tsdelta"), "lg_p": pct(pos, m, "lategrow"),
                     "ug_p": pct(pos, m, "ugap"), "un_p": pct(pos, m, "unrl"),
                     "inj_p": pct(pos, m, "injb"),
                     "gap": (tal - opp) if (tal is not None and opp is not None) else None,
                     "moved": ros_now.get(pid) is not None and ros_prior.get(pid) is not None
                              and ros_now.get(pid) != ros_prior.get(pid),
                     "window": dcr_ok and ((pos in ("WR", "TE") and 1 <= m.get("exp", 0) <= 3)
                                           or (pos == "RB" and m.get("exp", 0) <= 2))})
    return rows


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            r = (i + j) / 2 + 1
            for k2 in range(i, j + 1):
                rk[order[k2]] = r
            i = j + 1
        return rk
    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return num / (dx * dy) if dx and dy else 0.0


print("Building seasons...")
all_rows = []
for Y in SEASONS:
    rows = build_season(Y)
    all_rows.extend(rows)
    print(f"  {Y}: {len(rows)} scored players")

# adp positional rank per season/pos (for bust definition + hit thresholds)
for Y in SEASONS:
    for pos in POS:
        grp = sorted((r for r in all_rows if r["season"] == Y and r["pos"] == pos),
                     key=lambda r: r["adp"])
        for i, r in enumerate(grp):
            r["adp_pos_rank"] = i + 1

HIT_N = {"QB": 12, "TE": 12, "RB": 24, "WR": 24}

print("\n================ RESULTS (pooled all score-years) ================")
print("\n-- Test 1: rank correlation with positional finish (higher = better) --")
for pos in POS:
    grp = [r for r in all_rows if r["pos"] == pos and r["outcome"] and r["adp"] <= 240]
    s_lab = spearman([-r["fin"] for r in grp], [r["outcome"] for r in grp])
    s_adp = spearman([r["adp"] for r in grp], [r["outcome"] for r in grp])
    both = spearman([r["adp"] - (r["fin"] - 50) * 0.5 for r in grp], [r["outcome"] for r in grp])
    print(f"  {pos}: LabScore r={s_lab:.3f}   ADP r={s_adp:.3f}   ADP+Lab blend r={both:.3f}   (n={len(grp)})")

print("\n-- Test 2: SAFETY among early picks (overall ADP <= 36) --")
print("   bust = finish worse than 2x positional ADP rank AND worse than 15")
early = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
early.sort(key=lambda r: -r["safety"])
half = len(early) // 2
hi, lo = early[:half], early[half:]
bust = lambda r: r["outcome"] > 2 * r["adp_pos_rank"] and r["outcome"] > 15
print(f"  high-safety half: {sum(map(bust, hi))}/{len(hi)} busts ({100*sum(map(bust,hi))/len(hi):.0f}%)")
print(f"  low-safety half:  {sum(map(bust, lo))}/{len(lo)} busts ({100*sum(map(bust,lo))/len(lo):.0f}%)")

print("\n-- Test 3: CEILING among late picks (overall ADP 84-240) --")
print("   hit = QB/TE top-12, RB/WR top-24 positional finish")
late = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
late.sort(key=lambda r: -r["ceiling"])
half = len(late) // 2
hi, lo = late[:half], late[half:]
hit = lambda r: r["outcome"] <= HIT_N[r["pos"]]
print(f"  high-ceiling half: {sum(map(hit, hi))}/{len(hi)} hits ({100*sum(map(hit,hi))/len(hi):.0f}%)")
print(f"  low-ceiling half:  {sum(map(hit, lo))}/{len(lo)} hits ({100*sum(map(hit,lo))/len(lo):.0f}%)")

print("\n-- per-season Lab-vs-ADP correlation (all positions, ADP<=240) --")
for Y in SEASONS:
    grp = [r for r in all_rows if r["season"] == Y and r["outcome"] and r["adp"] <= 240]
    s_lab = spearman([-r["fin"] for r in grp], [r["outcome"] for r in grp])
    s_adp = spearman([r["adp"] for r in grp], [r["outcome"] for r in grp])
    print(f"  {Y}: Lab r={s_lab:.3f}  ADP r={s_adp:.3f}  (n={len(grp)})")

# biggest wins/misses for eyeballing
print("\n-- biggest Lab-over-ADP calls that HIT (late picks the score loved) --")
calls = sorted((r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]),
               key=lambda r: -r["ceiling"])[:40]
hits = [r for r in calls if hit(r)][:8]
name = lambda r: players_db.get(r["pid"], {}).get("full_name", r["pid"])
for r in hits:
    print(f"  {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} ceil {r['ceiling']:.0f} -> finished {r['pos']}{r['outcome']}")
print("-- and the score's worst whiffs (top-10 fin, early ADP, busted) --")
whiffs = sorted((r for r in all_rows if r["adp"] <= 36 and r["outcome"] and bust(r)),
                key=lambda r: -r["safety"])[:6]
for r in whiffs:
    print(f"  {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} safety {r['safety']:.0f} -> finished {r['pos']}{r['outcome']}")

print("\n================ HONE EXPERIMENTS ================")
print("goal: sharpen the safety (bust) and ceiling (hit) contrasts, not beat ADP\n")

def bust_contrast(score_fn, label):
    grp = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
    grp.sort(key=lambda r: -score_fn(r))
    h = len(grp) // 2
    q = len(grp) // 4
    bh = 100 * sum(map(bust, grp[:h])) / h
    bl = 100 * sum(map(bust, grp[h:])) / (len(grp) - h)
    bqh = 100 * sum(map(bust, grp[:q])) / q
    bql = 100 * sum(map(bust, grp[-q:])) / q
    print(f"  {label:34} halves {bh:.0f}%/{bl:.0f}% (gap {bl-bh:+.0f})   quartiles {bqh:.0f}%/{bql:.0f}% (gap {bql-bqh:+.0f})")

def hit_contrast(score_fn, label):
    grp = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
    grp.sort(key=lambda r: -score_fn(r))
    h = len(grp) // 2
    q = len(grp) // 4
    hh = 100 * sum(map(hit, grp[:h])) / h
    hl = 100 * sum(map(hit, grp[h:])) / (len(grp) - h)
    hqh = 100 * sum(map(hit, grp[:q])) / q
    hql = 100 * sum(map(hit, grp[-q:])) / q
    print(f"  {label:34} halves {hh:.0f}%/{hl:.0f}% (gap {hh-hl:+.0f})   quartiles {hqh:.0f}%/{hql:.0f}% (gap {hqh-hql:+.0f})")

nz = lambda v: 50.0 if v is None else v
print("-- SAFETY variants (bust rate, lower-better in the top group) --")
bust_contrast(lambda r: r["safety"], "S0 current")
bust_contrast(lambda r: 0.85 * r["safety"] + 0.15 * nz(r["tddep_p"]), "S1 +TD-dependency .15")
bust_contrast(lambda r: 0.85 * r["safety"] + 0.15 * nz(r["odo_p"]) if r["pos"] == "RB" else r["safety"],
              "S2 +RB odometer .15")
bust_contrast(lambda r: r["safety"] - (6 if r["moved"] else 0), "S3 moved-team -6")
bust_contrast(lambda r: (0.78 * r["safety"] + 0.12 * nz(r["tddep_p"])
                         + (0.10 * nz(r["odo_p"]) if r["pos"] == "RB" else 0.10 * r["safety"]))
              - (4 if r["moved"] else 0), "S4 combo")

print("-- CEILING variants (hit rate, higher-better in the top group) --")
hit_contrast(lambda r: r["ceil_base"], "C0 base (pre-hone)")
hit_contrast(lambda r: r["ceil_base"] + 0.20 * max(0, r["gap"] or 0), "C1 +talent-over-usage gap")
hit_contrast(lambda r: 0.85 * r["ceil_base"] + 0.15 * nz(r["rzsh_p"]), "C2 +red-zone role .15")
hit_contrast(lambda r: 0.88 * r["ceil_base"] + 0.12 * nz(r["adot_p"]) if r["pos"] == "WR" else r["ceil_base"],
             "C3 +WR aDOT .12")
hit_contrast(lambda r: r["ceil_base"] + (6 if r["window"] else 0), "C4 breakout-window +6")
hit_contrast(lambda r: r["ceiling"], "C5 combo [SHIPPED]")
hit_contrast(lambda r: 0.85 * r["ceiling"] + 0.15 * nz(r["peak_p"]), "C6 +career-peak pedigree .15")
hit_contrast(lambda r: 0.90 * r["ceiling"] + 0.10 * nz(r["peak_p"]), "C7 +career-peak pedigree .10")
print("-- research round 2: predictive-stat candidates (on top of shipped ceiling) --")
hit_contrast(lambda r: 0.88 * r["ceiling"] + 0.12 * nz(r["tsd_p"]), "E1 +target-share growth .12")
hit_contrast(lambda r: 0.88 * r["ceiling"] + 0.12 * nz(r["lg_p"]), "E2 +December role growth .12")
hit_contrast(lambda r: 0.88 * r["ceiling"] + 0.12 * nz(r["ug_p"]), "E3 +usage-vs-output gap .12")
hit_contrast(lambda r: 0.90 * r["ceiling"] + 0.10 * nz(r["un_p"]) if r["pos"] == "WR" else r["ceiling"],
             "E4 +WR unrealized air yds .10")
hit_contrast(lambda r: 0.80 * r["ceiling"] + 0.08 * nz(r["tsd_p"]) + 0.06 * nz(r["lg_p"]) + 0.06 * nz(r["ug_p"]),
             "E5 combo E1+E2+E3")

print("\n================ MISS AUTOPSY: what is the model missing? ================")
gp_out = {}  # outcome-season games played (to separate injury from wrongness)
for r in all_rows:
    gp_out[(r["season"], r["pid"])] = (stats[r["season"]].get(r["pid"]) or {}).get("gp") or 0

def traits(rows_):
    if not rows_:
        return "none"
    n = len(rows_)
    posc = {}
    for r in rows_:
        posc[r["pos"]] = posc.get(r["pos"], 0) + 1
    return (" ".join(f"{p}:{c}" for p, c in sorted(posc.items(), key=lambda x: -x[1]))
            + f" | est {100*sum(r['est'] for r in rows_)//n}%"
            + f" | moved {100*sum(bool(r['moved']) for r in rows_)//n}%"
            + f" | window {100*sum(bool(r['window']) for r in rows_)//n}%")

late_a = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
late_a.sort(key=lambda r: -r["ceiling"])
half_a = len(late_a) // 2
bot_c = late_a[half_a:]

print("\n-- A. BREAKOUTS THE MODEL MISSED (late hits in the BOTTOM half of ceiling) --")
fn = [r for r in bot_c if hit(r)]
allhits = [r for r in late_a if hit(r)]
print(f"   caught {len(allhits)-len(fn)}/{len(allhits)} of all late hits; missed {len(fn)}:  {traits(fn)}")
for r in sorted(fn, key=lambda r: r["outcome"])[:10]:
    c = r["comp"]
    weak = min((("opp", c["opp"]), ("tal", c["tal"]), ("sit", c["sit"])), key=lambda x: x[1] if x[1] is not None else 99)
    print(f"   {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} ceil {r['ceiling']:.0f}"
          f" -> {r['pos']}{r['outcome']}  (weakest: {weak[0]} {weak[1]:.0f}{', EST' if r['est'] else ''}{', moved' if r['moved'] else ''})")

print("\n-- B. FALSE ALARMS (top-QUARTILE ceiling, played 10+ games, still missed) --")
q_a = len(late_a) // 4
fp = [r for r in late_a[:q_a] if not hit(r) and gp_out[(r["season"], r["pid"])] >= 10]
print(f"   {len(fp)} of top-quartile {q_a} were healthy non-hits:  {traits(fp)}")
for r in sorted(fp, key=lambda r: -r["ceiling"])[:8]:
    print(f"   {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} ceil {r['ceiling']:.0f}"
          f" -> {r['pos']}{r['outcome']}{' EST' if r['est'] else ''}{' moved' if r['moved'] else ''}")

print("\n-- C. EARLY BUSTS: injury vs the model being wrong --")
early_a = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
early_a.sort(key=lambda r: -r["safety"])
h2 = len(early_a) // 2
for label, grp in (("high-safety half", early_a[:h2]), ("low-safety half", early_a[h2:])):
    b = [r for r in grp if bust(r)]
    inj = [r for r in b if gp_out[(r["season"], r["pid"])] < 9]
    print(f"   {label}: {len(b)} busts -> {len(inj)} injury (<9 gms), {len(b)-len(inj)} played-and-failed")
hs_perf = [r for r in early_a[:h2] if bust(r) and gp_out[(r["season"], r["pid"])] >= 9]
print("   high-safety PLAYED-AND-FAILED (true safety misses):")
for r in sorted(hs_perf, key=lambda r: -r["safety"])[:8]:
    print(f"   {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} safety {r['safety']:.0f}"
          f" -> {r['pos']}{r['outcome']}{' moved' if r['moved'] else ''}")

print("\n-- D. TOO PESSIMISTIC EARLY (bottom-half safety, finished top-5) --")
dz = [r for r in early_a[h2:] if r["outcome"] <= 5]
print(f"   {len(dz)} low-safety early picks finished top-5:  {traits(dz)}")
for r in sorted(dz, key=lambda r: r["outcome"])[:8]:
    c = r["comp"]
    weak = min((("opp", c["opp_role"]), ("tal", c["tal"]), ("sit", c["sit"]), ("dur", c["dur"])), key=lambda x: x[1] if x[1] is not None else 99)
    print(f"   {r['season']} {name(r):22} {r['pos']} adp {r['adp']:.0f} safety {r['safety']:.0f}"
          f" -> {r['pos']}{r['outcome']}  (weakest: {weak[0]} {weak[1]:.0f}{', EST' if r['est'] else ''}{', moved' if r['moved'] else ''})")

print("\n================ WEIGHT TUNING (train 2017-2022, holdout 2023-2025) ================")

def mixw(parts):
    tot = sum(w for v, w in parts if v is not None)
    return sum(v * w for v, w in parts if v is not None) / tot if tot else None

def safety_of(r, w):
    c = r["comp"]
    return mixw([(c["opp_role"], w[0]), (c["tal"], w[1]), (c["sit"], w[2]),
                 (c["trS"], w[3]), (c["dur"], w[4])])

def ceiling_of(r, w):
    c = r["comp"]
    base = mixw([(c["opp"], w[0]), (c["tal"], w[1]), (c["sit"], w[2]), (c["trC"], w[3])])
    if base is None:
        return None
    v = (0.82 * base
         + 0.10 * (c["rz"] if c["rz"] is not None else 50)
         + 0.08 * ((c["ad"] if c["ad"] is not None else 50) if r["pos"] == "WR" else 50))
    v += 4 if c["win"] else 0
    if r.get("peak_p") is not None:
        v = 0.90 * v + 0.10 * r["peak_p"]
    return v

def bust_gap(score_fn, years):
    grp = [r for r in all_rows if r["adp"] <= 36 and r["outcome"] and r["season"] in years]
    grp = [r for r in grp if score_fn(r) is not None]
    grp.sort(key=lambda r: -score_fn(r))
    h = len(grp) // 2
    return (100 * sum(map(bust, grp[h:])) / (len(grp) - h)
            - 100 * sum(map(bust, grp[:h])) / h)

def hit_gap(score_fn, years):
    grp = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"] and r["season"] in years]
    grp = [r for r in grp if score_fn(r) is not None]
    grp.sort(key=lambda r: -score_fn(r))
    h = len(grp) // 2
    return (100 * sum(map(hit, grp[:h])) / h
            - 100 * sum(map(hit, grp[h:])) / (len(grp) - h))

S_CANDS = {"current .40/.20/.18/.12/.10": (.40, .20, .18, .12, .10),
           "opp-heavy .50/.15/.15/.10/.10": (.50, .15, .15, .10, .10),
           "sit-heavy  .35/.20/.25/.10/.10": (.35, .20, .25, .10, .10),
           "traj-heavy .35/.15/.15/.25/.10": (.35, .15, .15, .25, .10),
           "dur-heavy  .35/.20/.15/.10/.20": (.35, .20, .15, .10, .20),
           "NO-dur to traj .50/.15/.15/.20/0": (.50, .15, .15, .20, .0),
           "NO-dur to opp  .55/.15/.15/.15/0": (.55, .15, .15, .15, .0),
           "half-dur .50/.15/.15/.15/.05": (.50, .15, .15, .15, .05)}
print("-- SAFETY weights: bust gap (higher = sharper), train | holdout --")
for label, w in S_CANDS.items():
    print(f"  {label:32} train {bust_gap(lambda r: safety_of(r, w), TRAIN):+.1f}"
          f"   holdout {bust_gap(lambda r: safety_of(r, w), HOLDOUT):+.1f}")

C_CANDS = {"current .15/.30/.25/.30": (.15, .30, .25, .30),
           "tal-heavy .10/.40/.20/.30": (.10, .40, .20, .30),
           "sit-heavy .10/.30/.35/.25": (.10, .30, .35, .25),
           "traj-heavy .10/.25/.25/.40": (.10, .25, .25, .40),
           "opp-back .25/.30/.20/.25": (.25, .30, .20, .25)}
print("-- CEILING weights: hit gap (higher = sharper), train | holdout --")
for label, w in C_CANDS.items():
    print(f"  {label:32} train {hit_gap(lambda r: ceiling_of(r, w), TRAIN):+.1f}"
          f"   holdout {hit_gap(lambda r: ceiling_of(r, w), HOLDOUT):+.1f}")
print("\n-- ABLATIONS: does REMOVING any component help? (train | holdout) --")
print("   safety leave-one-out (weights renormalize):")
S_W = (.50, .15, .15, .10, .10)
def safety_ab(r, drop=None, no_role=False):
    c = r["comp"]
    parts = [(c["opp"] if no_role else c["opp_role"], S_W[0]), (c["tal"], S_W[1]),
             (c["sit"], S_W[2]), (c["trS"], S_W[3]), (c["dur"], S_W[4])]
    if drop is not None:
        parts[drop] = (None, 0)
    return mixw(parts)
for label, kw in (("full safety [SHIPPED]", {}), ("- projected-role blend", {"no_role": True}),
                  ("- talent", {"drop": 1}), ("- situation", {"drop": 2}),
                  ("- trajectory", {"drop": 3}), ("- durability", {"drop": 4})):
    fn = (lambda kw2: lambda r: safety_ab(r, **kw2))(kw)
    print(f"     {label:28} train {bust_gap(fn, TRAIN):+.1f}   holdout {bust_gap(fn, HOLDOUT):+.1f}")

print("   ceiling leave-one-out:")
def ceil_ab(r, add_gap=False, no_rz=False, no_ad=False, no_win=False, no_peak=False):
    c = r["comp"]
    if any(v is None for v in (c["opp"], c["tal"], c["sit"], c["trC"])):
        return None
    base = .35 * c["opp"] + .25 * c["tal"] + .15 * c["sit"] + .25 * c["trC"]
    v = (0.82 * (base + (0.18 * (c["gapv"] or 0) if add_gap else 0))
         + 0.10 * (50 if no_rz else (c["rz"] if c["rz"] is not None else 50))
         + 0.08 * (50 if (no_ad or r["pos"] != "WR") else (c["ad"] if c["ad"] is not None else 50)))
    if c["win"] and not no_win:
        v += 4
    if not no_peak and r.get("peak_p") is not None:
        v = 0.90 * v + 0.10 * r["peak_p"]
    return v
for label, kw in (("full ceiling [SHIPPED]", {}), ("+ re-add tal-over-usage gap", {"add_gap": True}),
                  ("- red-zone role", {"no_rz": True}), ("- WR aDOT", {"no_ad": True}),
                  ("- breakout window", {"no_win": True}), ("- career-peak pedigree", {"no_peak": True})):
    fn = (lambda kw2: lambda r: ceil_ab(r, **kw2))(kw)
    print(f"     {label:28} train {hit_gap(fn, TRAIN):+.1f}   holdout {hit_gap(fn, HOLDOUT):+.1f}")

print("   injury-burden candidates (cohort-weighted 2yr load):")
for label, fn in (("S +inj .10 (from dur)", lambda r: safety_ab(r) if r["comp"]["dur"] is None else
                   mixw([(r["comp"]["opp_role"], .50), (r["comp"]["tal"], .15), (r["comp"]["sit"], .15),
                         (r["comp"]["trS"], .10), (r["comp"]["dur"], .05), (nz(r["inj_p"]), .05)])),
                  ("S +inj .10 (from opp)", lambda r: mixw([(r["comp"]["opp_role"], .40), (r["comp"]["tal"], .15),
                         (r["comp"]["sit"], .15), (r["comp"]["trS"], .10), (r["comp"]["dur"], .10), (nz(r["inj_p"]), .10)])),
                  ("S +inj replace dur", lambda r: mixw([(r["comp"]["opp_role"], .50), (r["comp"]["tal"], .15),
                         (r["comp"]["sit"], .15), (r["comp"]["trS"], .10), (nz(r["inj_p"]), .10)]))):
    print(f"     {label:28} train {bust_gap(fn, TRAIN):+.1f}   holdout {bust_gap(fn, HOLDOUT):+.1f}")

print("-- round-2 candidates, train | holdout robustness --")
nzt = lambda v: 50.0 if v is None else v
for label, fn in (("shipped ceiling", lambda r: r["ceiling"]),
                  ("E1 +ts-growth .12", lambda r: 0.88 * r["ceiling"] + 0.12 * nzt(r["tsd_p"])),
                  ("E3 +usage-gap .12", lambda r: 0.88 * r["ceiling"] + 0.12 * nzt(r["ug_p"])),
                  ("E5 combo", lambda r: 0.80 * r["ceiling"] + 0.08 * nzt(r["tsd_p"]) + 0.06 * nzt(r["lg_p"]) + 0.06 * nzt(r["ug_p"]))):
    print(f"  {label:32} train {hit_gap(fn, TRAIN):+.1f}   holdout {hit_gap(fn, HOLDOUT):+.1f}")

print("\n================ PER-POSITION MIX TUNING ================")
print("tune each position's safety/ceiling weights separately (train),")
print("judge by the POOLED contrasts on holdout vs the global mixes\n")

S_GRID = [(.50, .15, .15, .10, .10), (.60, .10, .10, .10, .10), (.40, .25, .15, .10, .10),
          (.40, .15, .25, .10, .10), (.40, .15, .15, .20, .10), (.35, .20, .20, .15, .10),
          (.50, .20, .10, .10, .10), (.45, .15, .15, .15, .10)]
C_GRID = [(.25, .30, .20, .25), (.35, .25, .15, .25), (.15, .40, .20, .25),
          (.15, .30, .30, .25), (.20, .25, .20, .35), (.30, .30, .25, .15),
          (.25, .40, .20, .15), (.10, .30, .25, .35)]

def spear_metric(fn, pos, years, lo, hi):
    grp = [r for r in all_rows if r["pos"] == pos and r["outcome"]
           and lo <= r["adp"] <= hi and r["season"] in years and fn(r) is not None]
    if len(grp) < 25:
        return None, len(grp)
    return spearman([-fn(r) for r in grp], [r["outcome"] for r in grp]), len(grp)

def hit_gap_pos(fn, pos, years):
    grp = [r for r in all_rows if r["pos"] == pos and 84 <= r["adp"] <= 240
           and r["outcome"] and r["season"] in years and fn(r) is not None]
    if len(grp) < 40:
        return None
    grp.sort(key=lambda r: -fn(r))
    h = len(grp) // 2
    return (100 * sum(map(hit, grp[:h])) / h
            - 100 * sum(map(hit, grp[h:])) / (len(grp) - h))

best_s, best_c = {}, {}
for pos in POS:
    # safety: early-pool ordering (per-pos bust samples are too thin)
    scored = []
    for w in S_GRID:
        r_, n_ = spear_metric(lambda r: safety_of(r, w), pos, TRAIN, 0, 72)
        if r_ is not None:
            scored.append((r_, w))
    best_s[pos] = max(scored)[1] if scored else (.50, .15, .15, .10, .10)
    # ceiling: per-pos late hit gap where the sample allows
    scored = []
    for w in C_GRID:
        g_ = hit_gap_pos(lambda r: ceiling_of(r, w), pos, TRAIN)
        if g_ is not None:
            scored.append((g_, w))
    best_c[pos] = max(scored)[1] if scored else (.25, .30, .20, .25)
    print(f"  {pos}: best safety {best_s[pos]}  best ceiling {best_c[pos]}")

print("\n-- pooled verdict: per-position mixes vs global (train | holdout) --")
glob_s = lambda r: safety_of(r, (.50, .15, .15, .10, .10))
pp_s = lambda r: safety_of(r, best_s[r["pos"]])
glob_c = lambda r: ceiling_of(r, (.35, .25, .15, .25))
pp_c = lambda r: ceiling_of(r, best_c[r["pos"]])
print(f"  SAFETY  global   train {bust_gap(glob_s, TRAIN):+.1f}   holdout {bust_gap(glob_s, HOLDOUT):+.1f}")
print(f"  SAFETY  per-pos  train {bust_gap(pp_s, TRAIN):+.1f}   holdout {bust_gap(pp_s, HOLDOUT):+.1f}")
print(f"  CEILING global   train {hit_gap(glob_c, TRAIN):+.1f}   holdout {hit_gap(glob_c, HOLDOUT):+.1f}")
print(f"  CEILING per-pos  train {hit_gap(pp_c, TRAIN):+.1f}   holdout {hit_gap(pp_c, HOLDOUT):+.1f}")

print("\n================ CONFIDENCE: how much should we trust these numbers? ================")
import random
rng = random.Random(42)

def gap_of(rows_, key_fn, flag_fn, top_good):
    rows_ = [r for r in rows_ if key_fn(r) is not None]
    if len(rows_) < 20:
        return None
    rows_ = sorted(rows_, key=lambda r: -key_fn(r))
    h = len(rows_) // 2
    top = 100 * sum(map(flag_fn, rows_[:h])) / h
    bot = 100 * sum(map(flag_fn, rows_[h:])) / (len(rows_) - h)
    return (bot - top) if not top_good else (top - bot)

early_all = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
late_all = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]

print("-- bootstrap 90% confidence intervals (1000 resamples of players) --")
for label, pool2, key_fn, flag_fn, top_good in (
        ("safety bust-gap", early_all, lambda r: r["safety"], bust, False),
        ("ceiling hit-gap", late_all, lambda r: r["ceiling"], hit, True)):
    point = gap_of(pool2, key_fn, flag_fn, top_good)
    sims = []
    for _ in range(1000):
        sample = [pool2[rng.randrange(len(pool2))] for _ in range(len(pool2))]
        g = gap_of(sample, key_fn, flag_fn, top_good)
        if g is not None:
            sims.append(g)
    sims.sort()
    lo5, hi95 = sims[int(0.05 * len(sims))], sims[int(0.95 * len(sims))]
    print(f"  {label:18} point {point:+5.1f}   90% CI [{lo5:+5.1f}, {hi95:+5.1f}]"
          f"   {'EXCLUDES zero' if lo5 > 0 else 'includes zero — could be noise'}")

print("-- per-season sign consistency (does the effect show up season by season?) --")
for label, pool2, key_fn, flag_fn, top_good in (
        ("safety bust-gap", early_all, lambda r: r["safety"], bust, False),
        ("ceiling hit-gap", late_all, lambda r: r["ceiling"], hit, True)):
    signs = []
    line = []
    for Y in SEASONS:
        g = gap_of([r for r in pool2 if r["season"] == Y], key_fn, flag_fn, top_good)
        if g is None:
            continue
        signs.append(g > 0)
        line.append(f"{Y}:{g:+.0f}")
    print(f"  {label:18} positive in {sum(signs)}/{len(signs)} seasons   " + " ".join(line))

print("-- leave-one-season-out: does the WEIGHT-TUNING PROCEDURE itself hold up? --")
picks_count = {}
loso_tuned, loso_current = [], []
for hold in SEASONS:
    rest = set(SEASONS) - {hold}
    best = max(S_CANDS.items(),
               key=lambda kv: bust_gap(lambda r: safety_of(r, kv[1]), rest))
    picks_count[best[0]] = picks_count.get(best[0], 0) + 1
    g_t = gap_of([r for r in early_all if r["season"] == hold],
                 lambda r: safety_of(r, best[1]), bust, False)
    g_c = gap_of([r for r in early_all if r["season"] == hold],
                 lambda r: safety_of(r, (.50, .15, .15, .10, .10)), bust, False)
    if g_t is not None and g_c is not None:
        loso_tuned.append(g_t)
        loso_current.append(g_c)
print(f"  fold-tuned safety mean bust-gap {sum(loso_tuned)/len(loso_tuned):+.1f} vs"
      f" shipped-weights mean {sum(loso_current)/len(loso_current):+.1f} across {len(loso_tuned)} folds")
print(f"  weight set chosen per fold: {picks_count}")

print("\n================ WHERE DOES EACH SIGNAL PAY? (ramp audit) ================")
print("bust gap by SAFETY and hit gap by CEILING, per ADP band — does the wc")
print("ramp give each band the lens that actually discriminates there?\n")
BANDS = [(1, 24), (25, 48), (49, 84), (85, 140), (141, 240)]
for lo, hi in BANDS:
    grp = [r for r in all_rows if lo <= r["adp"] <= hi and r["outcome"]]
    if len(grp) < 60:
        continue
    gs = sorted(grp, key=lambda r: -r["safety"])
    h = len(gs) // 2
    bg = (100 * sum(map(bust, gs[h:])) / (len(gs) - h) - 100 * sum(map(bust, gs[:h])) / h)
    gc = sorted(grp, key=lambda r: -r["ceiling"])
    hg = (100 * sum(map(hit, gc[:h])) / h - 100 * sum(map(hit, gc[h:])) / (len(gc) - h))
    wc_lo = max(0.15, min(0.85, (lo - 24) / 96))
    wc_hi = max(0.15, min(0.85, (hi - 24) / 96))
    print(f"  ADP {lo:3}-{hi:3} (n={len(grp):3}): safety bust-gap {bg:+5.1f}   ceiling hit-gap {hg:+5.1f}"
          f"   [current wc {wc_lo:.2f}-{wc_hi:.2f}]")

print("\n-- ramp variants judged by LEAGUE-VALUE objective (train | holdout):")
print("   early bust gap (blend, ADP<=36) + mid+late hit gap (blend, 25-240)")
def blend_of(r, a0, span, flat=None):
    wcv = flat if flat is not None else max(0.15, min(0.85, (r["adp"] - a0) / span))
    return (1 - wcv) * r["safety"] + wcv * r["ceiling"]
def league_value(a0, span, years, flat=None):
    fn = lambda r: blend_of(r, a0, span, flat)
    early_g = [r for r in all_rows if r["adp"] <= 36 and r["outcome"] and r["season"] in years]
    early_g.sort(key=lambda r: -fn(r))
    h = len(early_g) // 2
    bg = (100 * sum(map(bust, early_g[h:])) / (len(early_g) - h)
          - 100 * sum(map(bust, early_g[:h])) / h)
    mid_g = [r for r in all_rows if 25 <= r["adp"] <= 240 and r["outcome"] and r["season"] in years]
    mid_g.sort(key=lambda r: -fn(r))
    h2 = len(mid_g) // 2
    hg = (100 * sum(map(hit, mid_g[:h2])) / h2 - 100 * sum(map(hit, mid_g[h2:])) / (len(mid_g) - h2))
    return bg, hg
RAMP_V = [("current (adp-24)/96, .5@72", 24, 96, None),
          ("earlier  (adp-12)/60, .5@42", 12, 60, None),
          ("mid      (adp-24)/60, .5@54", 24, 60, None),
          ("steep    (adp-24)/48, .5@48", 24, 48, None),
          ("later    (adp-48)/96, .5@96", 48, 96, None),
          ("flat 0.5 everywhere", 0, 1, 0.5)]
for label, a0, span, flat in RAMP_V:
    tb, th = league_value(a0, span, TRAIN, flat)
    hb, hh = league_value(a0, span, HOLDOUT, flat)
    print(f"  {label:28} train bust {tb:+5.1f} hit {th:+5.1f} (sum {tb+th:+5.1f})"
          f"   holdout bust {hb:+5.1f} hit {hh:+5.1f} (sum {hb+hh:+5.1f})")

print("\n-- wc ramp calibration: mean within-position Spearman of the blend --")
RAMPS = [("(adp-24)/96  [current]", 24, 96), ("(adp-12)/72", 12, 72),
         ("(adp-36)/120", 36, 120), ("(adp-0)/120", 0, 120),
         ("(adp-48)/96", 48, 96), ("flat 0.5", None, None), ("flat 0.85 (all ceiling)", None, 0.85)]
for label, a0, span in RAMPS:
    rs = []
    for pos in POS:
        grp = [r for r in all_rows if r["pos"] == pos and r["outcome"] and r["adp"] <= 240]
        fins = []
        for r in grp:
            if a0 is None:
                wcv = span if span else 0.5
            else:
                wcv = max(0.15, min(0.85, (r["adp"] - a0) / span))
            fins.append((1 - wcv) * r["safety"] + wcv * r["ceiling"])
        rs.append(spearman([-f for f in fins], [r["outcome"] for r in grp]))
    print(f"  {label:26} mean r={sum(rs)/len(rs):.3f}   " +
          " ".join(f"{p}={v:.3f}" for p, v in zip(POS, rs)))


# ================= GRAND AUDIT (run: python backtest_labscore.py audit) ====
# Re-tests EVERYTHING ever considered, on all 12 seasons, under five
# validation schemes. Decision rule (pre-registered in GRAND_AUDIT.md):
# change the shipped model only if mean delta > +1.5 AND positive in >=4/5
# schemes. See GRAND_AUDIT.md for the full inventory.
import sys
if "audit" in sys.argv:
    print("\n" + "=" * 22 + " GRAND AUDIT (see GRAND_AUDIT.md) " + "=" * 22)
    ODD = {y for y in SEASONS if y % 2 == 1}
    EVEN = {y for y in SEASONS if y % 2 == 0}
    SCHEMES = [("FWD", set(range(2014, 2022)), set(range(2022, 2026))),
               ("REV", set(range(2022, 2026)), set(range(2014, 2022))),
               ("ODD", EVEN, ODD), ("EVEN", ODD, EVEN)]

    def eval_fixed(metric_fn, fn):
        """metric on each scheme's TEST side + LOSO mean, for a fixed rule."""
        vals = [metric_fn(fn, test) for _, _, test in SCHEMES]
        loso = [metric_fn(fn, {y}) for y in SEASONS]
        loso = [v for v in loso if v is not None]
        vals.append(sum(loso) / len(loso))
        return vals

    def eval_tuned(metric_fn, cands, of_fn):
        """per scheme: pick best cand on TRAIN, evaluate on TEST; LOSO same."""
        vals = []
        for _, train, test in SCHEMES:
            best = max(cands, key=lambda w: metric_fn(lambda r: of_fn(r, w), train) or -99)
            vals.append(metric_fn(lambda r: of_fn(r, best), test))
        loso = []
        for y in SEASONS:
            rest = set(SEASONS) - {y}
            best = max(cands, key=lambda w: metric_fn(lambda r: of_fn(r, w), rest) or -99)
            v = metric_fn(lambda r: of_fn(r, best), {y})
            if v is not None:
                loso.append(v)
        vals.append(sum(loso) / len(loso))
        return vals

    def eval_tuned_perpos(metric_fn, cands, of_fn):
        """per scheme: pick best cand PER POSITION on train, apply combined."""
        vals = []

        def make_fn(bp):
            return lambda r: of_fn(r, bp[r["pos"]])

        def pos_metric(metric_fn, w, pos, years, of_fn):
            return metric_fn(lambda r: of_fn(r, w) if r["pos"] == pos else None, years)

        for _, train, test in SCHEMES:
            bp = {}
            for pos in POS:
                bp[pos] = max(cands, key=lambda w: pos_metric(metric_fn, w, pos, train, of_fn) or -99)
            vals.append(metric_fn(make_fn(bp), test))
        loso = []
        for y in SEASONS:
            rest = set(SEASONS) - {y}
            bp = {}
            for pos in POS:
                bp[pos] = max(cands, key=lambda w: pos_metric(metric_fn, w, pos, rest, of_fn) or -99)
            v = metric_fn(make_fn(bp), {y})
            if v is not None:
                loso.append(v)
        vals.append(sum(loso) / len(loso))
        return vals

    def bust_metric(fn, years):
        grp = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]
               and r["season"] in years and fn(r) is not None]
        if len(grp) < 16:
            return None
        grp.sort(key=lambda r: -fn(r))
        h = len(grp) // 2
        return (100 * sum(map(bust, grp[h:])) / (len(grp) - h)
                - 100 * sum(map(bust, grp[:h])) / h)

    def hit_metric(fn, years):
        grp = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]
               and r["season"] in years and fn(r) is not None]
        if len(grp) < 30:
            return None
        grp.sort(key=lambda r: -fn(r))
        h = len(grp) // 2
        return (100 * sum(map(hit, grp[:h])) / h
                - 100 * sum(map(hit, grp[h:])) / (len(grp) - h))

    def verdict(deltas, base_row):
        ds = [v - b for v, b in zip(deltas, base_row)]
        mean = sum(ds) / len(ds)
        pos_n = sum(1 for d in ds if d > 0)
        ok = mean > 1.5 and pos_n >= 4
        return mean, pos_n, ok

    def report(title, base_label, base_vals, variants):
        print("\n-- " + title + " --")
        hdr = "variant"
        print(f"   {hdr:34} {'FWD':>6} {'REV':>6} {'ODD':>6} {'EVEN':>6} {'LOSO':>6}   mean-d  verdict")
        print(f"   {base_label:34} " + " ".join(f"{v:+6.1f}" for v in base_vals) + "   (baseline)")
        for label, vals in variants:
            mean, pos_n, ok = verdict(vals, base_vals)
            v = "CHANGE MODEL <<<" if ok else "no change"
            print(f"   {label:34} " + " ".join(f"{x:+6.1f}" for x in vals)
                  + f"   {mean:+6.1f}  {v}")

    nzA = lambda v: 50.0 if v is None else v
    S_SHIP = (.50, .15, .15, .20, .0)

    # ---------- SAFETY family ----------
    base_s = eval_fixed(bust_metric, lambda r: safety_of(r, S_SHIP))
    sv = []
    sv.append(("A1 remove role-blend", eval_fixed(bust_metric, lambda r: safety_ab(r, no_role=True))))
    for lbl, di in (("A2 remove talent", 1), ("A3 remove situation", 2),
                    ("A4 remove trajectory", 3), ("A5 remove durability", 4)):
        sv.append((lbl, eval_fixed(bust_metric, (lambda d: lambda r: safety_ab(r, drop=d))(di))))
    sv.append(("A6 dur weight -> trajectory", eval_fixed(bust_metric, lambda r: safety_of(r, (.50, .15, .15, .20, .0)))))
    sv.append(("A7 +TD-dependency .15", eval_fixed(bust_metric, lambda r: 0.85 * safety_of(r, S_SHIP) + 0.15 * nzA(r["tddep_p"]))))
    sv.append(("A8 +RB odometer .15", eval_fixed(bust_metric, lambda r: 0.85 * safety_of(r, S_SHIP) + 0.15 * nzA(r["odo_p"]) if r["pos"] == "RB" else safety_of(r, S_SHIP))))
    sv.append(("A9 moved-team -6", eval_fixed(bust_metric, lambda r: safety_of(r, S_SHIP) - (6 if r["moved"] else 0))))
    sv.append(("A10 +injury burden .10", eval_fixed(bust_metric, lambda r: 0.90 * safety_of(r, S_SHIP) + 0.10 * nzA(r["inj_p"]))))
    sv.append(("A11 injury replaces durability", eval_fixed(bust_metric, lambda r: mixw([(r["comp"]["opp_role"], .50), (r["comp"]["tal"], .15), (r["comp"]["sit"], .15), (r["comp"]["trS"], .10), (nzA(r["inj_p"]), .10)]))))
    sv.append(("T1 grid-tuned per split", eval_tuned(bust_metric, list(S_CANDS.values()), safety_of)))
    sv.append(("P1 per-position tuned", eval_tuned_perpos(bust_metric, list(S_CANDS.values()), safety_of)))
    report("SAFETY (bust gap, ADP<=36)", "B0 shipped safety", base_s, sv)

    # ---------- CEILING family ----------
    cship = lambda r: ceiling_of(r, (.35, .25, .15, .25))
    base_c = eval_fixed(hit_metric, cship)
    cv = []
    cv.append(("D1 re-add tal-over-usage gap", eval_fixed(hit_metric, lambda r: ceil_ab(r, add_gap=True))))
    cv.append(("D2 remove red-zone role", eval_fixed(hit_metric, lambda r: ceil_ab(r, no_rz=True))))
    cv.append(("D3 remove WR aDOT", eval_fixed(hit_metric, lambda r: ceil_ab(r, no_ad=True))))
    cv.append(("D4 remove breakout window", eval_fixed(hit_metric, lambda r: ceil_ab(r, no_win=True))))
    cv.append(("D5 remove pedigree", eval_fixed(hit_metric, lambda r: ceil_ab(r, no_peak=True))))
    cv.append(("D6 +ts-growth .12", eval_fixed(hit_metric, lambda r: 0.88 * cship(r) + 0.12 * nzA(r["tsd_p"]))))
    cv.append(("D7 +December role .12", eval_fixed(hit_metric, lambda r: 0.88 * cship(r) + 0.12 * nzA(r["lg_p"]))))
    cv.append(("D8 +usage-gap .12", eval_fixed(hit_metric, lambda r: 0.88 * cship(r) + 0.12 * nzA(r["ug_p"]))))
    cv.append(("D9 +WR unrealized air .10", eval_fixed(hit_metric, lambda r: 0.90 * cship(r) + 0.10 * nzA(r["un_p"]) if r["pos"] == "WR" else cship(r))))
    cv.append(("D10 round-2 combo", eval_fixed(hit_metric, lambda r: 0.80 * cship(r) + 0.08 * nzA(r["tsd_p"]) + 0.06 * nzA(r["lg_p"]) + 0.06 * nzA(r["ug_p"]))))
    cv.append(("T2 grid-tuned per split", eval_tuned(hit_metric, C_GRID, ceiling_of)))
    cv.append(("P2 per-position tuned", eval_tuned_perpos(hit_metric, C_GRID, ceiling_of)))
    report("CEILING (hit gap, ADP 84-240)", "C0 shipped ceiling", base_c, cv)

    # ---------- RAMP family ----------
    def lv_metric(params, years):
        a0, span, flat = params
        b, h = league_value(a0, span, years, flat)
        return b + h
    base_r = [lv_metric((24, 96, None), test) for _, _, test in SCHEMES]
    base_r.append(sum(lv_metric((24, 96, None), {y}) for y in SEASONS) / len(SEASONS))
    rv = []
    for label, a0, span, flat in [("R1 .5@42", 12, 60, None), ("R2 .5@54", 24, 60, None),
                                  ("R3 steep .5@48", 24, 48, None), ("R4 later .5@96", 48, 96, None),
                                  ("R5 flat 0.5", 0, 1, 0.5)]:
        vals = [lv_metric((a0, span, flat), test) for _, _, test in SCHEMES]
        vals.append(sum(lv_metric((a0, span, flat), {y}) for y in SEASONS) / len(SEASONS))
        rv.append((label, vals))
    report("RAMP (league-value = early bust gap + 25-240 hit gap)", "R0 shipped (adp-24)/96", base_r, rv)

    print("\n-- which ceiling base weights does tuning pick per LOSO fold? --")
    picks = {}
    for y in SEASONS:
        rest = set(SEASONS) - {y}
        best = max(C_GRID, key=lambda w: hit_metric(lambda r: ceiling_of(r, w), rest) or -99)
        picks[best] = picks.get(best, 0) + 1
    for w, n in sorted(picks.items(), key=lambda x: -x[1]):
        print(f"   {w}: {n}/12 folds")
