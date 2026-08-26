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
SEASONS = [2021, 2022, 2023, 2024, 2025]
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
stats = {}
rosters = {}
for yr in range(2019, 2026):
    if yr == 2025:
        stats[yr] = json.loads((ROOT / "data" / "raw" / "stats_2025.json").read_text(encoding="utf-8"))
    else:
        stats[yr] = cached(f"stats_{yr}.json", f"https://api.sleeper.app/v1/stats/nfl/regular/{yr}")
    rows = cached(f"roster_{yr}.json",
                  f"https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{yr}.csv",
                  is_csv=True)
    rosters[yr] = {r["sleeper_id"]: (r["team"] or "").replace("LA", "LAR") if r["team"] == "LA" else r["team"]
                   for r in rows if r.get("sleeper_id") and r.get("team")}

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
           "sit": [("vac", .30), ("offq", .35), ("qbq", .35)]},
    "TE": {"opp": [("yptpa", .40), ("tshare", .35), ("tpg", .25)],
           "tal": [("rypg", .50), ("ypt", .30), ("tdluck", .20)],
           "sit": [("vac", .30), ("offq", .35), ("qbq", .35)]},
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


def build_season(Y):
    """Returns rows: {pid,pos,adp,safety,ceiling,fin,est, outcome fields}."""
    prior, S = stats[Y - 1], stats[Y]
    ros_prior, ros_now = rosters[Y - 1], rosters[Y]

    # ADP pool for year Y from FFC
    pool = []
    for e in (adp_hist.get(str(Y)) or {}).get("players", []):
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
        d = team_opp.setdefault(t, {"tgt": 0, "att": 0, "ay": 0, "vtgt": 0, "vatt": 0})
        tp = team_pts.setdefault(t, {"all": 0.0, "qb": 0.0, "wrte": 0.0, "rb": {}})
        tgt, att, ay = st.get("rec_tgt") or 0, st.get("rush_att") or 0, st.get("rec_air_yd") or 0
        d["tgt"] += tgt; d["att"] += att; d["ay"] += ay
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
        safety = mix([(opp_role, .40), (tal, .20), (sit, .18), (trS, .12), (dur_p, .10)])
        ceiling = .15 * opp + .30 * tal + .25 * sit + .30 * trC
        wc = max(0.15, min(0.85, (m["adp"] - 24) / 96))
        fin = (1 - wc) * safety + wc * ceiling
        if est:
            fin = 50 + (fin - 50) * 0.75
        rows.append({"pid": pid, "pos": pos, "adp": m["adp"], "est": est,
                     "safety": safety, "ceiling": ceiling, "fin": fin,
                     "outcome": fin_rank.get(pid),
                     "pts": S.get(pid, {}).get("pts_half_ppr") or 0,
                     "season": Y})
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

print("\n================ RESULTS (pooled 2021-2025) ================")
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
