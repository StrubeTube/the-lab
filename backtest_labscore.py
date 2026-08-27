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

# situation-change data (research round 3): player trades + OC history
_tr_f = CACHE / "player_trades.csv"
if not _tr_f.exists():
    print("  fetching player_trades.csv...")
    _req = urllib.request.Request(
        "https://raw.githubusercontent.com/leesharpe/nfldata/master/data/trades.csv", headers=UA)
    with urllib.request.urlopen(_req, timeout=120) as _r:
        _tr_f.write_bytes(_r.read())
TRADED = {}  # season -> set of norm(player name) traded before the season
for row in csv.DictReader(io.StringIO(_tr_f.read_text(encoding="utf-8", errors="replace"))):
    nm = row.get("pfr_name")
    if not nm:
        continue
    try:
        yr_ = int(row["season"])
    except (ValueError, KeyError):
        continue
    dt = row.get("trade_date") or ""
    if dt and dt[5:7] in ("09", "10", "11", "12"):
        continue  # in-season trade: post-draft, not August-knowable
    TRADED.setdefault(yr_, set()).add(norm(nm))

try:
    OC_HIST = json.loads((CACHE / "oc_history.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    OC_HIST = {}

# head-coach history (nfldata games; new HC = strongest free proxy for a
# play-caller change — true OC history has no free structured source)
try:
    _hc_raw = json.loads((CACHE / "hc_history.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    _hc_raw = {}
_TC = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
HC_HIST = {y: {_TC.get(t, t): c for t, c in v.items()} for y, v in _hc_raw.items()}

def hc_changed(team, Y):
    a2 = (HC_HIST.get(str(Y)) or {}).get(team)
    b2 = (HC_HIST.get(str(Y - 1)) or {}).get(team)
    if not a2 or not b2:
        return None
    return a2 != b2

def oc_changed(team, Y):
    a = (OC_HIST.get(str(Y)) or {}).get(team)
    b = (OC_HIST.get(str(Y - 1)) or {}).get(team)
    if not a or not b:
        return None
    return a != b

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

# combine athleticism (round-4 ceiling tests): speed score = wt * 200 /
# forty^4 (Barwis), static per player, joined norm(name)|pos
SPD_MAP = {}
try:
    _cf = CACHE / "combine.csv"
    if not _cf.exists():
        print("  fetching combine.csv...")
        _rq = urllib.request.Request(
            "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv",
            headers=UA)
        with urllib.request.urlopen(_rq, timeout=120) as _resp:
            _cf.write_bytes(_resp.read())
    _cmb = list(csv.DictReader(io.StringIO(_cf.read_text(encoding="utf-8"))))
    for _r in _cmb:
        try:
            _w, _f = float(_r.get("wt") or 0), float(_r.get("forty") or 0)
        except ValueError:
            continue
        if _w and _f and _r.get("pos") in ("QB", "RB", "WR", "TE"):
            SPD_MAP[norm(_r.get("player_name")) + "|" + _r["pos"]] = _w * 200 / (_f ** 4)
except Exception as _e:
    print("combine load failed (speed-score tests degrade):", _e)

# ---- overhaul feature layer (LAB_OVERHAUL.md, 2026-08-27) ----
# combine athletic extras: burst (vertical + broad), agility (3-cone +
# shuttle, inverted), BMI — same norm(name)|pos join as speed score
ATH_MAP = {}
try:
    _cmb2 = list(csv.DictReader(io.StringIO((CACHE / "combine.csv").read_text(encoding="utf-8"))))
    def _fnum(x):
        try:
            return float(x) if x not in (None, "") else None
        except ValueError:
            return None
    for _r in _cmb2:
        if _r.get("pos") not in ("QB", "RB", "WR", "TE"):
            continue
        _k = norm(_r.get("player_name")) + "|" + _r["pos"]
        _vert, _brd = _fnum(_r.get("vertical")), _fnum(_r.get("broad_jump"))
        _cone, _sh = _fnum(_r.get("cone")), _fnum(_r.get("shuttle"))
        _wt2, _ht = _fnum(_r.get("wt")), _r.get("ht") or ""
        _hin = None
        if "-" in _ht:
            try:
                _ft, _in = _ht.split("-")
                _hin = int(_ft) * 12 + int(_in)
            except ValueError:
                pass
        _d = ATH_MAP.setdefault(_k, {})
        if _vert is not None and _brd is not None:
            _d["burst"] = _vert + _brd / 3.0
        if _cone is not None and _sh is not None:
            _d["agil"] = -(_cone + _sh)
        if _wt2 is not None and _hin:
            _d["bmi"] = 703.0 * _wt2 / (_hin ** 2)
except OSError:
    pass

# nflverse season player stats (EPA / CPOE / WOPR / RACR / PACR), 2012+,
# keyed by gsis id — the efficiency layer Sleeper box scores can't see
PSTATS = {}
for _y in range(2012, 2026):
    _pf = CACHE / f"pstats_{_y}.json"
    if _pf.exists():
        PSTATS[_y] = json.loads(_pf.read_text(encoding="utf-8"))
        continue
    print(f"  fetching stats_player_reg_{_y}.csv...")
    try:
        _rq = urllib.request.Request(
            f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{_y}.csv",
            headers=UA)
        with urllib.request.urlopen(_rq, timeout=120) as _resp:
            _prow = list(csv.DictReader(io.StringIO(_resp.read().decode("utf-8", "replace"))))
    except Exception as _e:
        print(f"  pstats {_y} failed: {_e}")
        PSTATS[_y] = {}
        continue
    _out = {}
    for _r in _prow:
        _g = _r.get("player_id")
        if not _g:
            continue
        _e2 = {}
        for _k2 in ("games", "passing_epa", "passing_cpoe", "pacr", "rushing_epa",
                    "receiving_epa", "racr", "target_share", "air_yards_share", "wopr"):
            try:
                _v2 = _r.get(_k2)
                _e2[_k2] = float(_v2) if _v2 not in (None, "") else None
            except ValueError:
                _e2[_k2] = None
        _out[_g] = _e2
    PSTATS[_y] = _out
    _pf.write_text(json.dumps(_out), encoding="utf-8")

# full prior-season weekly points (boom rate / consistency), 2013+
WEEKPTS = {}
for _y in range(2013, 2025):
    for _w in range(1, 19 if _y >= 2021 else 18):
        _d3 = cached(f"wk_{_y}_{_w}.json",
                     f"https://api.sleeper.app/v1/stats/nfl/regular/{_y}/{_w}")
        for _pid, _st in (_d3 or {}).items():
            if (isinstance(_st, dict) and _st.get("pts_half_ppr") is not None
                    and (_st.get("gp") or _st.get("off_snp") or _st.get("rec_tgt")
                         or _st.get("rush_att") or _st.get("pass_att"))):
                WEEKPTS.setdefault((_y, _pid), []).append(_st["pts_half_ppr"])

# every candidate percentile the ML retest sees (order = report order)
FEAT_KEYS = ["wo", "snp", "tshare", "ayshare", "yptpa", "tpg", "rypg", "ypt", "yac",
             "tprr", "qrypg", "papg", "qrza", "pypg", "ypa", "tdluck", "offq", "qbq",
             "weapons", "bfshare", "posshare", "vac", "vaca", "alvl", "aslp", "youth",
             "odo", "peak", "tddep", "rzsh", "adot", "tsdelta", "lategrow", "ugap",
             "unrl", "injb", "dur", "dc", "spd", "btk", "burst", "agil", "bmi",
             "dage", "pepa", "cpoe", "pacr", "ruepa", "repa", "racr", "wopr",
             "boomr", "wkcv", "adpinv"]
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

    # situation-change context (round 3): each team's primary passer last
    # year, whether he is still there, and the best QB now in the building
    prim_qb = {}   # team -> (pid, prior pass_att, prior pts)
    for spid, st in prior.items():
        p = players_db.get(spid)
        if not isinstance(p, dict) or p.get("position") != "QB":
            continue
        t = ros_prior.get(spid)
        att_ = st.get("pass_att") or 0
        if t and att_ > (prim_qb.get(t) or (None, 0, 0))[1]:
            prim_qb[t] = (spid, att_, st.get("pts_half_ppr") or 0)
    best_qb_now = {}  # team -> best prior-season pts among QBs on the roster NOW
    for spid, p in players_db.items():
        if not isinstance(p, dict) or p.get("position") != "QB":
            continue
        t = ros_now.get(spid)
        if t:
            pts_ = (prior.get(spid) or {}).get("pts_half_ppr") or 0
            if pts_ > best_qb_now.get(t, 0):
                best_qb_now[t] = pts_

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
        # --- ceiling-fix candidates (round 4) ---
        # athleticism: combine speed score, static career trait
        sp = SPD_MAP.get(norm(p.get("full_name")) + "|" + pos)
        if sp is not None:
            m["spd"] = sp
        # broken-tackle rate, 2-yr blend (Sleeper carries rush_btkl 2016+;
        # earlier prior-seasons stay None — a missing field pre-2016 is
        # unknown, not zero)
        bt1 = ((st.get("rush_btkl") or 0) / att) if (att >= 50 and Y - 1 >= 2016) else None
        att2_ = st2.get("rush_att") or 0
        bt2 = ((st2.get("rush_btkl") or 0) / att2_) if (att2_ >= 50 and Y - 2 >= 2016) else None
        if bt1 is not None and bt2 is not None:
            m["btk"] = 0.65 * bt1 + 0.35 * bt2
        elif bt1 is not None or bt2 is not None:
            m["btk"] = bt1 if bt1 is not None else bt2
        # --- overhaul feature layer (LAB_OVERHAUL.md) ---
        ath = ATH_MAP.get(norm(p.get("full_name")) + "|" + pos) or {}
        for k2 in ("burst", "agil", "bmi"):
            if ath.get(k2) is not None:
                m[k2] = ath[k2]
        if dc and age:
            m["dage"] = -(age - (Y - dc["season"]))  # age AT draft, younger = higher
        ps1 = PSTATS.get(Y - 1, {}).get(gid) or {}
        ps2 = PSTATS.get(Y - 2, {}).get(gid) or {}
        for kk, sk, perg in (("pepa", "passing_epa", 1), ("ruepa", "rushing_epa", 1),
                             ("repa", "receiving_epa", 1), ("cpoe", "passing_cpoe", 0),
                             ("pacr", "pacr", 0), ("racr", "racr", 0), ("wopr", "wopr", 0)):
            def _pv(d):
                v = d.get(sk)
                if v is None:
                    return None
                if perg:
                    g2 = d.get("games") or 0
                    return v / g2 if g2 else None
                return v
            v1, v2 = _pv(ps1), _pv(ps2)
            if v1 is not None and v2 is not None:
                m[kk] = 0.65 * v1 + 0.35 * v2
            elif v1 is not None or v2 is not None:
                m[kk] = v1 if v1 is not None else v2
        wpts = WEEKPTS.get((Y - 1, pid))
        if wpts and len(wpts) >= 6:
            mean_w = sum(wpts) / len(wpts)
            m["boomr"] = sum(1 for x in wpts if x >= 15) / len(wpts)
            if mean_w > 4:
                sd = (sum((x - mean_w) ** 2 for x in wpts) / len(wpts)) ** 0.5
                m["wkcv"] = -(sd / mean_w)
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
        # LAB_OVERHAUL P0 parity: the two shipped ML-retest winners are now
        # part of the baseline every future test compares against
        dage_pv = pct(pos, m, "dage")
        safety = 0.85 * safety + 0.15 * (dage_pv if dage_pv is not None else 50)
        pacr_pv = pct(pos, m, "pacr")
        ceiling = 0.85 * ceiling + 0.15 * (pacr_pv if pacr_pv is not None else 50)
        # P3 parity: continuous-outcome winners (see LAB_OVERHAUL Phase 2)
        bf_pv = pct(pos, m, "bfshare")
        ts_pv = pct(pos, m, "tshare")
        ceiling = (0.614 * ceiling + 0.258 * (bf_pv if bf_pv is not None else 50)
                   + 0.128 * (ts_pv if ts_pv is not None else 50))
        qz_pv = pct(pos, m, "qrza")
        safety = 0.7225 * safety + 0.2775 * (qz_pv if qz_pv is not None else 50)
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
                     # -- situation-change fields (round 3) --
                     # traded (vs walked in free agency / was cut)
                     "traded": (ros_now.get(pid) is not None and ros_prior.get(pid) is not None
                                and ros_now.get(pid) != ros_prior.get(pid)
                                and norm((players_db.get(pid) or {}).get("full_name")) in TRADED.get(Y, set())),
                     # his CURRENT team's primary passer departed + up/downgrade size
                     "qbchg": (lambda t: t is not None and t in prim_qb
                               and ros_now.get(prim_qb[t][0]) != t)(ros_now.get(pid)),
                     "qbdelta": (lambda t: (best_qb_now.get(t, 0) - prim_qb[t][2])
                                 if (t is not None and t in prim_qb and ros_now.get(prim_qb[t][0]) != t)
                                 else None)(ros_now.get(pid)),
                     # his CURRENT team's pass-rate delta Y-1 vs Y-2 (scheme drift)
                     "prd": (lambda t: ((lambda a, b: (a["tgt"] / max(1, a["tgt"] + a["att"])
                                                      - b["tgt"] / max(1, b["tgt"] + b["att"]))
                                        if (a and b and a["tgt"] and b["tgt"]) else None)(
                         team_opp.get(t), team_opp2.get(t))))(ros_now.get(pid)),
                     "occhg": oc_changed(ros_now.get(pid), Y) if ros_now.get(pid) else None,
                     "hcchg": hc_changed(ros_now.get(pid), Y) if ros_now.get(pid) else None,
                     # -- full feature-percentile library (ML retest) --
                     "feat": {k2: pct(pos, m, k2) for k2 in FEAT_KEYS},
                     # -- ceiling-fix fields (round 4) --
                     "spd_p": pct(pos, m, "spd"), "btk_p": pct(pos, m, "btk"),
                     "vaca_p": pct(pos, m, "vaca"), "adp_pp": adp_p,
                     "exp": m.get("exp", 0),
                     "win4": m["dc"] >= 0.5 and ((pos in ("WR", "TE") and 1 <= m.get("exp", 0) <= 3)
                                                 or (pos == "RB" and m.get("exp", 0) <= 2)),
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


# ============ SITUATION-CHANGE TESTS (python backtest_labscore.py sittest) ==
# Research round 3 (Alex): QB change + destination quality, pass-rate drift,
# trade-vs-FA typing, OC changes (when the PFR scrape has run). Same
# pre-registered rule as the grand audit: mean delta > +1.5 AND >=4/5 schemes.
if "sittest" in sys.argv:
    print("\n" + "=" * 18 + " SITUATION-CHANGE TESTS (round 3) " + "=" * 18)
    ODD3 = {y for y in SEASONS if y % 2 == 1}
    EVEN3 = {y for y in SEASONS if y % 2 == 0}
    SCH3 = [("FWD", set(range(2022, 2026))), ("REV", set(range(2014, 2022))),
            ("ODD", ODD3), ("EVEN", EVEN3)]

    def bust3(fn, years):
        grp = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]
               and r["season"] in years and fn(r) is not None]
        if len(grp) < 16:
            return None
        grp.sort(key=lambda r: -fn(r))
        h = len(grp) // 2
        return (100 * sum(map(bust, grp[h:])) / (len(grp) - h)
                - 100 * sum(map(bust, grp[:h])) / h)

    def hit3(fn, years):
        grp = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]
               and r["season"] in years and fn(r) is not None]
        if len(grp) < 30:
            return None
        grp.sort(key=lambda r: -fn(r))
        h = len(grp) // 2
        return (100 * sum(map(hit, grp[:h])) / h
                - 100 * sum(map(hit, grp[h:])) / (len(grp) - h))

    def evalrow(metric, fn):
        vals = [metric(fn, test) for _, test in SCH3]
        loso = [metric(fn, {y}) for y in SEASONS]
        loso = [v for v in loso if v is not None]
        vals.append(sum(loso) / len(loso))
        return vals

    def show(title, base_vals, variants):
        print("\n-- " + title + " --")
        print(f"   {'variant':36} {'FWD':>6} {'REV':>6} {'ODD':>6} {'EVEN':>6} {'LOSO':>6}   mean-d  verdict")
        print(f"   {'baseline (shipped)':36} " + " ".join(f"{v:+6.1f}" for v in base_vals))
        for label, vals in variants:
            ds = [v - b for v, b in zip(vals, base_vals)]
            mean = sum(ds) / len(ds)
            ok = mean > 1.5 and sum(1 for d in ds if d > 0) >= 4
            print(f"   {label:36} " + " ".join(f"{x:+6.1f}" for x in vals)
                  + f"   {mean:+6.1f}  {'PASSES RULE <<<' if ok else 'no'}")

    clampv = lambda v, lo, hi: max(lo, min(hi, v))
    n_qb = sum(1 for r in all_rows if r["qbchg"])
    n_tr = sum(1 for r in all_rows if r["traded"])
    n_mv = sum(1 for r in all_rows if r["moved"])
    n_oc = sum(1 for r in all_rows if r["occhg"] is not None)
    n_occ = sum(1 for r in all_rows if r["occhg"])
    n_hc = sum(1 for r in all_rows if r.get("hcchg"))
    print(f"coverage: qb-change rows {n_qb}, moved {n_mv} (traded {n_tr}), "
          f"OC data on {n_oc} rows ({n_occ} with a new OC), "
          f"new-HC rows {n_hc}")

    S_SHIP3 = (.50, .15, .15, .20, .0)
    S3 = lambda r: safety_of(r, S_SHIP3)
    C3 = lambda r: ceiling_of(r, (.35, .25, .15, .25))
    wrte = lambda r: r["pos"] in ("WR", "TE")

    base_s3 = evalrow(bust3, S3)
    sv3 = [
        ("Q1 QB-departed -6 (WR/TE)", evalrow(bust3, lambda r: S3(r) - (6 if r["qbchg"] and wrte(r) else 0))),
        ("Q2 QB up/downgrade scaled (WR/TE)", evalrow(bust3, lambda r: S3(r) + (clampv((r["qbdelta"] or 0) / 40, -8, 8) if r["qbchg"] and wrte(r) else 0))),
        ("I1 pass-rate instability penalty", evalrow(bust3, lambda r: S3(r) - min(10, 250 * abs(r["prd"] or 0)))),
        ("F1 FA/cut mover -6 (traded exempt)", evalrow(bust3, lambda r: S3(r) - (6 if r["moved"] and not r["traded"] else 0))),
        ("T1 traded-for +4 (role secured)", evalrow(bust3, lambda r: S3(r) + (4 if r["traded"] else 0))),
        ("O1 new-OC -5", evalrow(bust3, lambda r: S3(r) - (5 if r["occhg"] else 0))),
        ("H1 new-HEAD-COACH -5", evalrow(bust3, lambda r: S3(r) - (5 if r["hcchg"] else 0))),
    ]
    show("SAFETY variants (bust gap, ADP<=36)", base_s3, sv3)

    base_c3 = evalrow(hit3, C3)
    cv3 = [
        ("Q3 QB up/downgrade scaled (WR/TE)", evalrow(hit3, lambda r: C3(r) + (clampv((r["qbdelta"] or 0) / 40, -8, 8) if r["qbchg"] and wrte(r) else 0))),
        ("P1 pass-rate-rise boost (WR/TE)", evalrow(hit3, lambda r: C3(r) + (clampv((r["prd"] or 0) * 150, -6, 6) if wrte(r) else 0))),
        ("T2 traded-for +5", evalrow(hit3, lambda r: C3(r) + (5 if r["traded"] else 0))),
        ("O2 new-OC +5 (upheaval = upside)", evalrow(hit3, lambda r: C3(r) + (5 if r["occhg"] else 0))),
        ("O3 new-OC -5 (continuity = upside)", evalrow(hit3, lambda r: C3(r) - (5 if r["occhg"] else 0))),
        ("H2 new-HEAD-COACH +5", evalrow(hit3, lambda r: C3(r) + (5 if r["hcchg"] else 0))),
        ("H3 new-HEAD-COACH -5", evalrow(hit3, lambda r: C3(r) - (5 if r["hcchg"] else 0))),
    ]
    show("CEILING variants (hit gap, ADP 84-240)", base_c3, cv3)


# ============== CEILING-FIX TESTS (round 4: the Tuten autopsy) ==============
# run: python backtest_labscore.py ceiltest
# Alex 08-27: consensus calls Tuten an all-ceiling play; our ceiling is
# resume-based and blind to athleticism, path-to-volume, and magnitude.
# Candidates judged on the SAME pre-registered rule as the grand audit
# (mean delta > +1.5 AND >=4/5 schemes positive) on the standard hit
# objective. A second table rescores everything on a MAGNITUDE objective
# (hit12: QB/TE top-6, RB/WR top-12 = league-winner seasons) —
# exploratory and reported, not ruled. ROLE uses the ADP-percentile
# projection proxy (partially circular — same caveat as the v56 blend).
if "ceiltest" in sys.argv:
    print("\n" + "=" * 20 + " CEILING-FIX TESTS (round 4) " + "=" * 20)
    ODD4 = {y for y in SEASONS if y % 2 == 1}
    EVEN4 = {y for y in SEASONS if y % 2 == 0}
    SCH4 = [("FWD", set(range(2014, 2022)), set(range(2022, 2026))),
            ("REV", set(range(2022, 2026)), set(range(2014, 2022))),
            ("ODD", EVEN4, ODD4), ("EVEN", ODD4, EVEN4)]
    nz4 = lambda v: 50.0 if v is None else v

    def hit_metric4(fn, years, hfn):
        grp = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]
               and r["season"] in years and fn(r) is not None]
        if len(grp) < 30:
            return None
        grp.sort(key=lambda r: -fn(r))
        h = len(grp) // 2
        return (100 * sum(map(hfn, grp[:h])) / h
                - 100 * sum(map(hfn, grp[h:])) / (len(grp) - h))

    def eval4(fn, hfn):
        vals = [hit_metric4(fn, test, hfn) for _, _, test in SCH4]
        loso = [v for v in (hit_metric4(fn, {y}, hfn) for y in SEASONS) if v is not None]
        vals.append(sum(loso) / len(loso))
        return vals

    def report4(title, base_vals, variants):
        print("\n-- " + title + " --")
        print(f"   {'variant':38} {'FWD':>6} {'REV':>6} {'ODD':>6} {'EVEN':>6} {'LOSO':>6}   mean-d  verdict")
        print(f"   {'SHIPPED ceiling':38} " + " ".join(f"{v:+6.1f}" for v in base_vals) + "   (baseline)")
        for label, vals in variants:
            ds = [v - b for v, b in zip(vals, base_vals)]
            mean = sum(ds) / len(ds)
            pos_n = sum(1 for d in ds if d > 0)
            vd = "CHANGE MODEL <<<" if (mean > 1.5 and pos_n >= 4) else "no change"
            print(f"   {label:38} " + " ".join(f"{x:+6.1f}" for x in vals) + f"   {mean:+6.1f}  {vd}")

    W4T2 = (.35, .25, .15, .25)

    def ceil_full(r, opp=None, tal=None, win=None):
        c = r["comp"]
        opp = c["opp"] if opp is None else opp
        tal = c["tal"] if tal is None else tal
        win = c["win"] if win is None else win
        base = mixw([(opp, W4T2[0]), (tal, W4T2[1]), (c["sit"], W4T2[2]), (c["trC"], W4T2[3])])
        if base is None:
            return None
        v = (0.82 * base + 0.10 * nz4(c["rz"])
             + 0.08 * (nz4(c["ad"]) if r["pos"] == "WR" else 50))
        if win:
            v += 4
        if r.get("peak_p") is not None:
            v = 0.90 * v + 0.10 * r["peak_p"]
        return v

    def v_ath_rb(r):
        v = ceil_full(r)
        return None if v is None else (0.90 * v + 0.10 * nz4(r["spd_p"]) if r["pos"] == "RB" else v)

    def v_ath_all(r):
        v = ceil_full(r)
        return None if v is None else 0.90 * v + 0.10 * nz4(r["spd_p"])

    def v_ath_tal(r):
        if r["pos"] == "RB" and r["spd_p"] is not None and r["comp"]["tal"] is not None:
            return ceil_full(r, tal=0.85 * r["comp"]["tal"] + 0.15 * r["spd_p"])
        return ceil_full(r)

    def v_btk(r):
        if r["pos"] == "RB" and r["btk_p"] is not None and r["comp"]["tal"] is not None:
            return ceil_full(r, tal=0.85 * r["comp"]["tal"] + 0.15 * r["btk_p"])
        return ceil_full(r)

    def v_w4(r):
        return ceil_full(r, win=r["win4"])

    def v_role(r):
        c = r["comp"]
        if (r["pos"] == "RB" and r["exp"] <= 2 and (r["vaca_p"] or 0) >= 65
                and c["opp"] is not None and r["adp_pp"] is not None):
            return ceil_full(r, opp=0.60 * c["opp"] + 0.40 * r["adp_pp"])
        return ceil_full(r)

    cover_spd = sum(1 for r in all_rows if r["spd_p"] is not None)
    cover_btk = sum(1 for r in all_rows if r["btk_p"] is not None)
    gate_role = sum(1 for r in all_rows if r["pos"] == "RB" and r["exp"] <= 2 and (r["vaca_p"] or 0) >= 65)
    gate_w4 = sum(1 for r in all_rows if r["win4"] and not r["comp"]["win"])
    print(f"coverage: speed score {cover_spd}/{len(all_rows)} rows · broken-tackle {cover_btk}"
          f" · ROLE gate hits {gate_role} · rows the R4 window newly reaches {gate_w4}")

    hit_mag = lambda r: r["outcome"] <= (6 if r["pos"] in ("QB", "TE") else 12)

    VARS = [("F1 +speed score .10 (RB only)", v_ath_rb),
            ("F2 +speed score .10 (all pos)", v_ath_all),
            ("F3 speed into RB talent .15", v_ath_tal),
            ("F4 broken-tackle rate into RB tal", v_btk),
            ("F5 window loosened to R4 capital", v_w4),
            ("F6 role-proxy blend (blocked RBs)", v_role)]

    base_std = eval4(ceil_full, hit)
    report4("STANDARD OBJECTIVE (QB/TE top-12, RB/WR top-24) — the ruled test", base_std,
            [(lbl, eval4(fn, hit)) for lbl, fn in VARS])
    base_mag = eval4(ceil_full, hit_mag)
    report4("MAGNITUDE OBJECTIVE (QB/TE top-6, RB/WR top-12) — exploratory", base_mag,
            [(lbl, eval4(fn, hit_mag)) for lbl, fn in VARS])


# ==================== ML RETEST (LAB_OVERHAUL.md, 2026-08-27) ====================
# run: python backtest_labscore.py mltest
# The full-overhaul analysis: univariate screen of every feature ever
# collected, L1-regularized logistic + gradient-boosting ORACLES (LOSO by
# season, never shipped directly), the weight-system question, and the
# forward-stepwise combosearch that is the only path to shipping changes
# (grand-audit rule: mean delta > +1.5 AND >=4/5 schemes).
if "mltest" in sys.argv:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import HistGradientBoostingClassifier

    print("\n" + "=" * 22 + " ML RETEST (LAB_OVERHAUL.md) " + "=" * 22)
    ODD5 = {y for y in SEASONS if y % 2 == 1}
    EVEN5 = {y for y in SEASONS if y % 2 == 0}
    SCH5 = [("FWD", set(range(2022, 2026))), ("REV", set(range(2014, 2022))),
            ("ODD", ODD5), ("EVEN", EVEN5)]

    late = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
    early = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
    print(f"pools: late {len(late)} rows ({sum(map(hit, late))} hits) | "
          f"early {len(early)} rows ({sum(map(bust, early))} busts)")

    def matrix(rows_, keys):
        X = np.full((len(rows_), len(keys)), np.nan)
        for i, r in enumerate(rows_):
            for j, k in enumerate(keys):
                v = r["feat"].get(k)
                if v is not None:
                    X[i, j] = v
        return X

    def gap_vec(scores, rows_, mask, flag, invert=False):
        sub = [(scores[i], rows_[i]) for i in range(len(rows_))
               if mask[i] and scores[i] is not None and not np.isnan(scores[i])]
        if len(sub) < 30:
            return None
        sub.sort(key=lambda t: -t[0])
        h = len(sub) // 2
        top = 100.0 * sum(flag(r) for _, r in sub[:h]) / h
        bot = 100.0 * sum(flag(r) for _, r in sub[h:]) / (len(sub) - h)
        return (bot - top) if invert else (top - bot)

    def eval_vec(scores, rows_, flag, invert=False):
        seas = np.array([r["season"] for r in rows_])
        vals = [gap_vec(scores, rows_, np.isin(seas, list(test)), flag, invert)
                for _, test in SCH5]
        loso = [v for v in (gap_vec(scores, rows_, seas == y, flag, invert)
                            for y in SEASONS) if v is not None]
        vals.append(sum(loso) / len(loso) if loso else None)
        return vals

    def fmt5(vals):
        return " ".join("  none" if v is None else f"{v:+6.1f}" for v in vals)

    # ---------------- 1. UNIVARIATE SCREEN ----------------
    print("\n---- 1. UNIVARIATE SCREEN (each feature alone; LOSO-mean gap, % folds positive) ----")
    Xl_all = matrix(late, FEAT_KEYS)
    Xe_all = matrix(early, FEAT_KEYS)
    seas_l = np.array([r["season"] for r in late])
    seas_e = np.array([r["season"] for r in early])
    uni = []
    for j, k in enumerate(FEAT_KEYS):
        cov = 100.0 * np.mean(~np.isnan(Xl_all[:, j]))
        hg = [gap_vec(Xl_all[:, j], late, seas_l == y, hit) for y in SEASONS]
        hg = [v for v in hg if v is not None]
        bg = [gap_vec(Xe_all[:, j], early, seas_e == y, bust, invert=True) for y in SEASONS]
        bg = [v for v in bg if v is not None]
        uni.append((k, cov,
                    sum(hg) / len(hg) if hg else None, 100.0 * sum(1 for v in hg if v > 0) / len(hg) if hg else 0,
                    sum(bg) / len(bg) if bg else None, 100.0 * sum(1 for v in bg if v > 0) / len(bg) if bg else 0))
    uni.sort(key=lambda t: -(t[2] if t[2] is not None else -99))
    print(f"   {'feature':10} {'cov%':>5} | {'hit-gap':>8} {'stab%':>6} | {'bust-gap':>8} {'stab%':>6}")
    for k, cov, h_, hs, b_, bs in uni:
        hh = "   n/a" if h_ is None else f"{h_:+6.1f}"
        bb = "   n/a" if b_ is None else f"{b_:+6.1f}"
        print(f"   {k:10} {cov:5.0f} | {hh:>8} {hs:5.0f}% | {bb:>8} {bs:5.0f}%")

    # ---------------- 2/3. MODEL ORACLES (LOSO OOS) ----------------
    KEYS_NM = [k for k in FEAT_KEYS if k != "adpinv"]   # market-free set

    def prep(X):
        Z = X.copy()
        Z[np.isnan(Z)] = 50.0
        return (Z - 50.0) / 29.0

    def loso_probs(X, y, seas, make):
        p = np.full(len(y), np.nan)
        for yy in SEASONS:
            tr, te = seas != yy, seas == yy
            if te.sum() == 0 or len(set(y[tr])) < 2:
                continue
            mdl = make()
            mdl.fit(X[tr], y[tr])
            p[te] = mdl.predict_proba(X[te])[:, 1]
        return p

    def l1_stability(X, y, seas, C):
        nz = np.zeros(X.shape[1])
        coefs = np.zeros(X.shape[1])
        n = 0
        for yy in SEASONS:
            tr = seas != yy
            if len(set(y[tr])) < 2:
                continue
            mdl = LogisticRegression(penalty="l1", C=C, solver="liblinear", max_iter=2000)
            mdl.fit(prep(X)[tr], y[tr])
            nz += (np.abs(mdl.coef_[0]) > 1e-6)
            coefs += mdl.coef_[0]
            n += 1
        return nz / n, coefs / n

    y_l = np.array([1 if hit(r) else 0 for r in late])
    y_e = np.array([1 if bust(r) else 0 for r in early])
    Xl_nm = matrix(late, KEYS_NM)
    Xe_nm = matrix(early, KEYS_NM)

    def gbm():
        return HistGradientBoostingClassifier(max_iter=300, max_depth=3,
                                              learning_rate=0.06,
                                              min_samples_leaf=40, random_state=7)

    print("\n---- 2. L1 LOGISTIC (market-free, LOSO OOS; 3 regularization strengths) ----")
    l1_late = {}
    for C in (0.03, 0.1, 0.3):
        pl = loso_probs(prep(Xl_nm), y_l, seas_l, lambda: LogisticRegression(
            penalty="l1", C=C, solver="liblinear", max_iter=2000))
        l1_late[C] = pl
        print(f"   C={C:<5} late hit-gap  {fmt5(eval_vec(pl, late, hit))}")
    l1_early = {}
    for C in (0.03, 0.1, 0.3):
        pe = loso_probs(prep(Xe_nm), y_e, seas_e, lambda: LogisticRegression(
            penalty="l1", C=C, solver="liblinear", max_iter=2000))
        l1_early[C] = pe
        print(f"   C={C:<5} early bust-gap {fmt5(eval_vec(pe, early, bust, invert=False))}"
              "   (bust prob ranks: HIGH score = high bust risk)")

    print("\n   L1 feature survival (C=0.1, % of 12 folds selected, mean coef) — CEILING model:")
    frac, mc = l1_stability(Xl_nm, y_l, seas_l, 0.1)
    order = np.argsort(-frac)
    for j in order[:14]:
        if frac[j] > 0:
            print(f"     {KEYS_NM[j]:10} {100*frac[j]:4.0f}%  coef {mc[j]:+.3f}")
    print("   — BUST model (positive coef = MORE bust risk):")
    frac_e, mc_e = l1_stability(Xe_nm, y_e, seas_e, 0.1)
    order = np.argsort(-frac_e)
    for j in order[:14]:
        if frac_e[j] > 0:
            print(f"     {KEYS_NM[j]:10} {100*frac_e[j]:4.0f}%  coef {mc_e[j]:+.3f}")

    print("\n---- 3. GRADIENT-BOOSTING ORACLE (market-free, LOSO OOS) ----")
    gb_l = loso_probs(Xl_nm, y_l, seas_l, gbm)
    gb_e = loso_probs(Xe_nm, y_e, seas_e, gbm)
    print(f"   GBM late hit-gap   {fmt5(eval_vec(gb_l, late, hit))}")
    print(f"   GBM early bust-gap {fmt5(eval_vec(gb_e, early, bust))} (ranked by bust prob)")
    # market-aware versions (adpinv included) for reference
    gb_lm = loso_probs(matrix(late, FEAT_KEYS), y_l, seas_l, gbm)
    print(f"   GBM +market late   {fmt5(eval_vec(gb_lm, late, hit))}")
    # permutation importance averaged over held-out seasons
    from sklearn.inspection import permutation_importance
    imp = np.zeros(len(KEYS_NM))
    nf = 0
    for yy in SEASONS:
        tr, te = seas_l != yy, seas_l == yy
        if te.sum() < 25 or len(set(y_l[tr])) < 2:
            continue
        mdl = gbm()
        mdl.fit(Xl_nm[tr], y_l[tr])
        pi = permutation_importance(mdl, Xl_nm[te], y_l[te], n_repeats=5,
                                    random_state=7, scoring="roc_auc")
        imp += pi.importances_mean
        nf += 1
    imp /= max(nf, 1)
    print("   GBM permutation importance (held-out seasons, top 14):")
    for j in np.argsort(-imp)[:14]:
        print(f"     {KEYS_NM[j]:10} {imp[j]:+.4f}")

    # ---------------- 4. THE WEIGHT-SYSTEM QUESTION ----------------
    print("\n---- 4. WEIGHT SYSTEM: shipped vs equal-weight vs learned (all same rows) ----")
    ship_l = np.array([r["ceiling"] for r in late], dtype=float)
    eq_l = np.array([np.nanmean([v for v in (r["comp"]["opp"], r["comp"]["tal"],
                                             r["comp"]["sit"], r["comp"]["trC"]) if v is not None])
                     for r in late])
    print("   CEILING side (late-pool hit gap, 5 schemes):")
    print(f"     shipped hand-tuned      {fmt5(eval_vec(ship_l, late, hit))}")
    print(f"     equal-weight pillars    {fmt5(eval_vec(eq_l, late, hit))}")
    print(f"     L1 logistic (C=0.1)     {fmt5(eval_vec(l1_late[0.1], late, hit))}")
    print(f"     GBM oracle              {fmt5(eval_vec(gb_l, late, hit))}")
    ship_e = np.array([r["safety"] for r in early], dtype=float)
    eq_e = np.array([np.nanmean([v for v in (r["comp"]["opp_role"], r["comp"]["tal"],
                                             r["comp"]["sit"], r["comp"]["trS"]) if v is not None])
                     for r in early])
    inv = lambda p: np.where(np.isnan(p), np.nan, -p)   # safety ranks LOW bust prob first
    print("   SAFETY side (early-pool bust gap, 5 schemes; positive = fewer busts up top):")
    print(f"     shipped hand-tuned      {fmt5(eval_vec(ship_e, early, bust, invert=True))}")
    print(f"     equal-weight pillars    {fmt5(eval_vec(eq_e, early, bust, invert=True))}")
    print(f"     L1 logistic (C=0.1)     {fmt5(eval_vec(inv(l1_early[0.1]), early, bust, invert=True))}")
    print(f"     GBM oracle              {fmt5(eval_vec(inv(gb_e), early, bust, invert=True))}")

    # ---------------- 5. FORWARD STEPWISE (combosearch — the shippable path) ----------------
    print("\n---- 5. FORWARD STEPWISE under the 5-scheme rule ----")

    def rule_eval(fn, rows_, flag, invert=False):
        scores = np.array([fn(r) if fn(r) is not None else np.nan for r in rows_], dtype=float)
        return eval_vec(scores, rows_, flag, invert)

    def passes(vals, base_vals):
        ds = [v - b for v, b in zip(vals, base_vals) if v is not None and b is not None]
        if len(ds) < 5:
            return None, 0, False
        mean = sum(ds) / len(ds)
        pos_n = sum(1 for d in ds if d > 0)
        return mean, pos_n, (mean > 1.5 and pos_n >= 4)

    def stepwise(side, rows_, flag, invert, base_fn):
        base_vals = rule_eval(base_fn, rows_, flag, invert)
        cur_fn, cur_vals, chosen = base_fn, base_vals, []
        print(f"   {side}: baseline {fmt5(base_vals)}")
        for step in range(4):
            best = None
            for k in KEYS_NM:
                for w in (0.10, 0.15):
                    def cand(r, _k=k, _w=w, _f=cur_fn):
                        v = _f(r)
                        if v is None:
                            return None
                        fv = r["feat"].get(_k)
                        return (1 - _w) * v + _w * (fv if fv is not None else 50)
                    vals = rule_eval(cand, rows_, flag, invert)
                    mean, pos_n, ok = passes(vals, cur_vals)
                    if ok and (best is None or mean > best[0]):
                        best = (mean, pos_n, k, w, cand, vals)
            if best is None:
                print(f"   {side}: step {step + 1} — nothing passes the rule. STOP.")
                break
            mean, pos_n, k, w, cand, vals = best
            chosen.append((k, w))
            cur_fn, cur_vals = cand, vals
            print(f"   {side}: ADOPTED +{k} w={w} (mean {mean:+.1f}, {pos_n}/5)  -> {fmt5(vals)}")
        if not chosen:
            print(f"   {side}: shipped formula survives the full library. No combination passes.")
        return chosen

    stepwise("CEILING", late, hit, False, lambda r: r["ceiling"])
    stepwise("SAFETY ", early, bust, True, lambda r: r["safety"])

    # from-scratch greedy rebuild (no rule — what would a fresh build pick?)
    print("\n   From-scratch greedy (LOSO objective, informational only):")
    for side, rows_, flag, invert in (("CEILING", late, hit, False), ("SAFETY ", early, bust, True)):
        sel = []
        cur = None
        for _ in range(8):
            best = None
            for k in KEYS_NM:
                if k in sel:
                    continue
                def cand2(r, _keys=sel + [k]):
                    vs = [r["feat"].get(x) for x in _keys]
                    vs = [v for v in vs if v is not None]
                    return sum(vs) / len(vs) if vs else None
                v = rule_eval(cand2, rows_, flag, invert)[4]
                if v is not None and (best is None or v > best[0]):
                    best = (v, k)
            if best is None or (cur is not None and best[0] < cur + 0.3):
                break
            cur, _k = best
            sel.append(_k)
        print(f"   {side}: {' + '.join(sel)}   (LOSO {cur:+.1f})")

# ---- confirmation pass for the two stepwise winners (appended temp) ----
if "confirm" in sys.argv:
    import random as _rnd
    print("\n==== CONFIRMATION: bootstrap + per-season for stepwise winners ====")
    late = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
    early = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
    nzc = lambda v: 50.0 if v is None else v

    def ceil_pacr(r):
        v = r["ceiling"]
        return None if v is None else 0.85 * v + 0.15 * nzc(r["feat"].get("pacr"))

    def saf_dage(r):
        v = r["safety"]
        return None if v is None else 0.85 * v + 0.15 * nzc(r["feat"].get("dage"))

    def gap_rows(rows_, fn, flag, invert=False):
        sub = [(fn(r), r) for r in rows_ if fn(r) is not None]
        if len(sub) < 20:
            return None
        sub.sort(key=lambda t: -t[0])
        h = len(sub) // 2
        top = 100.0 * sum(flag(r) for _, r in sub[:h]) / h
        bot = 100.0 * sum(flag(r) for _, r in sub[h:]) / (len(sub) - h)
        return (bot - top) if invert else (top - bot)

    for name, rows_, base_fn, var_fn, flag, invert in (
            ("CEILING +pacr", late, lambda r: r["ceiling"], ceil_pacr, hit, False),
            ("SAFETY +dage", early, lambda r: r["safety"], saf_dage, bust, True)):
        base_g = gap_rows(rows_, base_fn, flag, invert)
        var_g = gap_rows(rows_, var_fn, flag, invert)
        _rnd.seed(7)
        deltas = []
        for _ in range(1000):
            samp = [rows_[_rnd.randrange(len(rows_))] for _ in range(len(rows_))]
            b, v = gap_rows(samp, base_fn, flag, invert), gap_rows(samp, var_fn, flag, invert)
            if b is not None and v is not None:
                deltas.append(v - b)
        deltas.sort()
        lo, hi = deltas[50], deltas[949]
        yrs_pos = 0
        yrs_tot = 0
        for y in SEASONS:
            yr = [r for r in rows_ if r["season"] == y]
            b, v = gap_rows(yr, base_fn, flag, invert), gap_rows(yr, var_fn, flag, invert)
            if b is not None and v is not None:
                yrs_tot += 1
                if v >= b:
                    yrs_pos += 1
        print(f"{name}: pooled {base_g:+.1f} -> {var_g:+.1f} (delta {var_g-base_g:+.1f}), "
              f"bootstrap 90% CI [{lo:+.1f}, {hi:+.1f}], seasons better-or-equal {yrs_pos}/{yrs_tot}")

    # combined final state
    both_c = gap_rows(late, ceil_pacr, hit)
    both_s = gap_rows(early, saf_dage, bust, invert=True)
    print(f"FINAL (both adopted): ceiling pooled hit-gap {both_c:+.1f} | safety pooled bust-gap {both_s:+.1f}")
    # who moves in 2025 (sanity: which late QBs does pacr promote/demote)
    qbs = [(r["feat"].get("pacr"), r["pid"]) for r in late if r["season"] == 2025 and r["pos"] == "QB"]
    print("2025 late-QB pacr percentiles (pid):", sorted([q for q in qbs if q[0] is not None], reverse=True)[:6])

# ---- position-awareness oracle check (Alex 08-27: "did we test by position?") ----
if "postest" in sys.argv:
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingClassifier
    print("\n==== POSITION-AWARENESS CHECK: GBM oracle with vs without position ====")
    late = [r for r in all_rows if 84 <= r["adp"] <= 240 and r["outcome"]]
    early = [r for r in all_rows if r["adp"] <= 36 and r["outcome"]]
    KEYS_NM = [k for k in FEAT_KEYS if k != "adpinv"]

    def matrix(rows_, keys, with_pos):
        X = np.full((len(rows_), len(keys) + (4 if with_pos else 0)), np.nan)
        for i, r in enumerate(rows_):
            for j, k in enumerate(keys):
                v = r["feat"].get(k)
                if v is not None:
                    X[i, j] = v
            if with_pos:
                for pj, pp in enumerate(("QB", "RB", "WR", "TE")):
                    X[i, len(keys) + pj] = 1.0 if r["pos"] == pp else 0.0
        return X

    def gap_vec(scores, rows_, mask, flag, invert=False):
        sub = [(scores[i], rows_[i]) for i in range(len(rows_))
               if mask[i] and not np.isnan(scores[i])]
        if len(sub) < 30:
            return None
        sub.sort(key=lambda t: -t[0])
        h = len(sub) // 2
        top = 100.0 * sum(flag(r) for _, r in sub[:h]) / h
        bot = 100.0 * sum(flag(r) for _, r in sub[h:]) / (len(sub) - h)
        return (bot - top) if invert else (top - bot)

    def loso(X, y, seas):
        p = np.full(len(y), np.nan)
        for yy in SEASONS:
            tr, te = seas != yy, seas == yy
            if te.sum() == 0 or len(set(y[tr])) < 2:
                continue
            mdl = HistGradientBoostingClassifier(max_iter=300, max_depth=3,
                                                 learning_rate=0.06,
                                                 min_samples_leaf=40, random_state=7)
            mdl.fit(X[tr], y[tr])
            p[te] = mdl.predict_proba(X[te])[:, 1]
        return p

    for name, rows_, flag, invert in (("CEILING/late-hit", late, hit, False),
                                      ("SAFETY/early-bust", early, bust, True)):
        y = np.array([1 if flag(r) else 0 for r in rows_])
        seas = np.array([r["season"] for r in rows_])
        for wp in (False, True):
            X = matrix(rows_, KEYS_NM, wp)
            p = loso(X, y, seas)
            sc = p if not invert else -p
            per_y = [gap_vec(sc, rows_, seas == yy, flag, invert) for yy in SEASONS]
            per_y = [v for v in per_y if v is not None]
            pooled = gap_vec(sc, rows_, np.ones(len(rows_), bool), flag, invert)
            print(f"  {name:18} {'WITH position' if wp else 'no position  '}: "
                  f"LOSO-mean {sum(per_y)/len(per_y):+.1f}  pooled {pooled:+.1f}")
        # per-position OOS gaps for the position-aware model (where n allows)
        Xp = matrix(rows_, KEYS_NM, True)
        p = loso(Xp, y, seas)
        sc = p if not invert else -p
        for pp in ("QB", "RB", "WR", "TE"):
            mask = np.array([r["pos"] == pp for r in rows_])
            g = gap_vec(sc, rows_, mask, flag, invert)
            n = int(mask.sum())
            print(f"      {pp}: n={n:4}  gap {'n/a' if g is None else f'{g:+.1f}'}")

# ============ P3: CONTINUOUS-OUTCOME RETEST (LAB_OVERHAUL Phase 2) ============
# run: python backtest_labscore.py conttest
# Binary hit/bust gaps discard most of each row's information. Target here:
# POINTS OVER ADP-EXPECTATION (pts minus the season's ADP-band mean), an
# every-row continuous outcome. PRE-REGISTERED RULE: adopt only if mean
# delta-rho > +0.02 AND >=4/5 schemes positive, AND the binary gaps do not
# degrade by more than 1.0 point.
if "conttest" in sys.argv:
    print("\n" + "=" * 18 + " P3: CONTINUOUS-OUTCOME RETEST " + "=" * 18)
    # per-season ADP-band expected points (bands of 12 slots)
    for Yc in SEASONS:
        rows_y = [r for r in all_rows if r["season"] == Yc and r["adp"] <= 240]
        bins = {}
        for r in rows_y:
            bins.setdefault(int(r["adp"] // 12), []).append(r["pts"])
        bmean = {b: sum(v) / len(v) for b, v in bins.items()}
        gmean = sum(r["pts"] for r in rows_y) / max(1, len(rows_y))
        for r in rows_y:
            r["resid"] = r["pts"] - bmean.get(int(r["adp"] // 12), gmean)
    latec = [r for r in all_rows if 84 <= r["adp"] <= 240 and "resid" in r]
    earlyc = [r for r in all_rows if r["adp"] <= 36 and "resid" in r]
    print(f"pools: late {len(latec)} | early {len(earlyc)} (target = pts over ADP-band mean)")

    ODD6 = {y for y in SEASONS if y % 2 == 1}
    EVEN6 = {y for y in SEASONS if y % 2 == 0}
    SCH6 = [("FWD", set(range(2022, 2026))), ("REV", set(range(2014, 2022))),
            ("ODD", ODD6), ("EVEN", EVEN6)]

    def rho_metric(fn, rows_, years):
        sub = [r for r in rows_ if r["season"] in years and fn(r) is not None]
        if len(sub) < 30:
            return None
        return spearman([fn(r) for r in sub], [r["resid"] for r in sub])

    def eval6(fn, rows_):
        vals = [rho_metric(fn, rows_, test) for _, test in SCH6]
        loso = [v for v in (rho_metric(fn, rows_, {y}) for y in SEASONS) if v is not None]
        vals.append(sum(loso) / len(loso) if loso else None)
        return vals

    fmt6 = lambda vals: " ".join(" none " if v is None else f"{v:+.3f}" for v in vals)
    nz6 = lambda v: 50.0 if v is None else v

    def stepwise_rho(side, rows_, base_fn, bin_rows, bin_flag, bin_invert):
        def bin_gap(fn):
            sub = [(fn(r), r) for r in bin_rows if fn(r) is not None]
            sub.sort(key=lambda t: -t[0])
            h = len(sub) // 2
            top = 100.0 * sum(bin_flag(r) for _, r in sub[:h]) / h
            bot = 100.0 * sum(bin_flag(r) for _, r in sub[h:]) / (len(sub) - h)
            return (bot - top) if bin_invert else (top - bot)
        base_vals = eval6(base_fn, rows_)
        base_bin = bin_gap(base_fn)
        cur_fn, cur_vals = base_fn, base_vals
        print(f"   {side} baseline rho {fmt6(base_vals)}  (binary gap {base_bin:+.1f})")
        for step in range(3):
            best = None
            for k in FEAT_KEYS:
                if k == "adpinv":
                    continue
                for w in (0.10, 0.15):
                    def cand(r, _k=k, _w=w, _f=cur_fn):
                        v = _f(r)
                        if v is None:
                            return None
                        fv = r["feat"].get(_k)
                        return (1 - _w) * v + _w * (fv if fv is not None else 50)
                    vals = eval6(cand, rows_)
                    ds = [v - b for v, b in zip(vals, cur_vals) if v is not None and b is not None]
                    if len(ds) < 5:
                        continue
                    mean = sum(ds) / len(ds)
                    pos_n = sum(1 for d in ds if d > 0)
                    if mean > 0.02 and pos_n >= 4:
                        bg = bin_gap(cand)
                        if bg >= base_bin - 1.0 and (best is None or mean > best[0]):
                            best = (mean, pos_n, k, w, cand, vals, bg)
            if best is None:
                print(f"   {side} step {step + 1}: nothing passes (rho rule + binary no-degrade). STOP.")
                break
            mean, pos_n, k, w, cand, vals, bg = best
            cur_fn, cur_vals = cand, vals
            print(f"   {side} ADOPTED +{k} w={w} (d-rho {mean:+.3f}, {pos_n}/5, binary {bg:+.1f})  rho -> {fmt6(vals)}")

    stepwise_rho("CEILING", latec, lambda r: r["ceiling"], latec, hit, False)
    stepwise_rho("SAFETY ", earlyc, lambda r: r["safety"], earlyc, bust, True)
