#!/usr/bin/env python3
"""THE LAB - compute stage.

Transforms data/raw/* into docs/data/*.json consumed by the site. Stdlib only.
Run: python compute.py
"""
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "docs" / "data"
OUT.mkdir(parents=True, exist_ok=True)

SEASON = 2026
PREV = 2025
POOL_TARGET = {"QB": 40, "RB": 80, "WR": 95, "TE": 35}  # ~250 skill players
POS = ["QB", "RB", "WR", "TE"]
MY_NAME = "Strubes"


def load(name):
    return json.loads((RAW / name).read_text(encoding="utf-8"))


def dump(name, obj):
    p = OUT / name
    p.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {name} ({p.stat().st_size//1024} KB)")


def norm(name):
    n = re.sub(r"[^a-z ]", "", (name or "").lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


print("Loading raw data...")
players_db = load("players_nfl.json")
proj = load("proj_2026.json")
stats25 = load("stats_2025.json")
weekly25 = load("stats_2025_weekly.json")
sched25 = load("schedule_2025.json")
sched26 = load("schedule_2026.json")
ffc = load("ffc_adp.json")
bc_raw = load("borischen.json")
state = load("state.json")

leagues = {}
for tag in ("ggg", "lob"):
    leagues[tag] = {
        "league": load(f"{tag}_league.json"),
        "users": load(f"{tag}_users.json"),
        "rosters": load(f"{tag}_rosters.json"),
        "drafts": load(f"{tag}_drafts.json"),
        "draft_picks": load(f"{tag}_draft_picks.json"),
        "draft_detail": load(f"{tag}_draft_detail.json"),
        "history": load(f"{tag}_history.json"),
    }

scoring = leagues["ggg"]["league"]["scoring_settings"]
lob_scoring = leagues["lob"]["league"]["scoring_settings"]
diffs = {k: (scoring.get(k), lob_scoring.get(k))
         for k in set(scoring) | set(lob_scoring)
         if abs((scoring.get(k) or 0) - (lob_scoring.get(k) or 0)) > 1e-9}
if diffs:
    print(f"  NOTE scoring diffs ggg vs lob: {diffs}")


def score(stat_obj):
    """League-scored fantasy points for a raw sleeper stat dict."""
    if not stat_obj:
        return 0.0
    return round(sum(v * stat_obj.get(k, 0) for k, v in scoring.items() if k in stat_obj), 2)


# ---- bye weeks 2026 from schedule ----
teams_playing = {}
for g in sched26:
    wk = g["week"]
    for t in (g["home"], g["away"]):
        teams_playing.setdefault(t, set()).add(wk)
all_teams = sorted(teams_playing)
byes = {}
for t, wks in teams_playing.items():
    missing = [w for w in range(1, 19) if w not in wks]
    byes[t] = missing[0] if missing else None

# opponent map per team per week, 2026 and 2025
def opp_map(sched):
    m = {}
    for g in sched:
        m.setdefault(g["home"], {})[g["week"]] = {"opp": g["away"], "home": True}
        m.setdefault(g["away"], {})[g["week"]] = {"opp": g["home"], "home": False}
    return m

opp26 = opp_map(sched26)
opp25 = opp_map(sched25)

# ---- 2025 league-scored season totals + positional finishes ----
season25 = {}  # pid -> {pts, gp, ppg}
for pid, st in stats25.items():
    p = players_db.get(pid)
    if not p and not (len(pid) <= 3 and pid.isupper()):
        continue
    pts = score(st)
    gp = st.get("gp") or st.get("gms_active") or 0
    if pts != 0 or gp:
        season25[pid] = {"pts": pts, "gp": int(gp), "ppg": round(pts / gp, 1) if gp else 0.0}

finish25 = {}  # pid -> positional finish rank
for pos in POS + ["DEF"]:
    if pos == "DEF":
        pool = [(pid, v) for pid, v in season25.items() if len(pid) <= 3 and pid.isupper()]
    else:
        pool = [(pid, v) for pid, v in season25.items()
                if players_db.get(pid, {}).get("position") == pos]
    pool.sort(key=lambda x: -x[1]["pts"])
    for i, (pid, _) in enumerate(pool):
        finish25[pid] = i + 1

# ---- 2025 weekly league-scored points (for cards / SoS) ----
weekpts25 = {}  # pid -> {week: pts}
for wk, blob in weekly25.items():
    for pid, st in (blob or {}).items():
        pts = score(st)
        if pts:
            weekpts25.setdefault(pid, {})[int(wk)] = pts

# ---- Boris Chen tiers: name -> (pos, tier) ----
bc = {}
for pos, text in bc_raw.items():
    for line in text.splitlines():
        m = re.match(r"Tier (\d+): (.*)", line.strip())
        if not m:
            continue
        tier = int(m.group(1))
        for nm in m.group(2).split(","):
            bc.setdefault(pos, {})[norm(nm)] = tier

# ---- Sleeper id index by normalized name for matching ----
by_name = {}
for pid, p in players_db.items():
    if p.get("position") in POS and p.get("active"):
        by_name.setdefault(norm(p.get("full_name") or ""), []).append(pid)


def match_pid(name, team, pos):
    cands = by_name.get(norm(name), [])
    if len(cands) == 1:
        return cands[0]
    for pid in cands:
        p = players_db[pid]
        if p.get("position") == pos and (p.get("team") == team or not team):
            return pid
    return cands[0] if cands else None


# ---- assemble the player pool ----
pool_ids = {}
unmatched = []
for fp in ffc.get("players", []):
    pid = match_pid(fp["name"], fp.get("team"), fp.get("position"))
    if pid:
        pool_ids[pid] = {"adp": fp["adp"], "adp_fmt": fp.get("adp_formatted"),
                         "adp_hi": fp.get("high"), "adp_lo": fp.get("low"),
                         "adp_sd": fp.get("stdev")}
    elif fp.get("position") in POS:
        unmatched.append(fp["name"])
if unmatched:
    print(f"  ADP unmatched (skipped): {unmatched}")

# top up per position by 2026 projected league points
proj_pts = {}
for pid, st in proj.items():
    p = players_db.get(pid)
    if p and p.get("position") in POS and p.get("active") and p.get("team"):
        pts = score(st)
        if pts > 0:
            proj_pts[pid] = pts

for pos, target in POOL_TARGET.items():
    have = [pid for pid in pool_ids if players_db.get(pid, {}).get("position") == pos]
    extras = sorted((pid for pid, v in proj_pts.items()
                     if players_db[pid]["position"] == pos and pid not in pool_ids),
                    key=lambda x: -proj_pts[x])
    for pid in extras[: max(0, target - len(have))]:
        pool_ids[pid] = {}

# positional ADP ranks
for pos in POS:
    ranked = sorted((pid for pid in pool_ids if players_db[pid]["position"] == pos),
                    key=lambda x: pool_ids[x].get("adp") or 999)
    for i, pid in enumerate(ranked):
        pool_ids[pid]["adp_pos"] = i + 1

def dyn_adp(pid):
    """Dynasty half-PPR ADP from Sleeper projections (999 = unranked)."""
    st = proj.get(pid) or {}
    v = st.get("adp_dynasty_half_ppr") or st.get("adp_dynasty")
    return round(v, 1) if v and v < 900 else None


def sleeper_adp(pid):
    """Redraft half-PPR ADP from Sleeper projections (999 = unranked)."""
    st = proj.get(pid) or {}
    v = st.get("adp_half_ppr")
    return round(v, 1) if v and v < 900 else None

players_out = []
for pid, extra in pool_ids.items():
    p = players_db[pid]
    pos = p["position"]
    exp = p.get("years_exp") or 0
    wk = weekpts25.get(pid, {})
    entry = {
        "id": pid,
        "name": p.get("full_name"),
        "team": p.get("team"),
        "pos": pos,
        "age": p.get("age"),
        "exp": exp,
        "rookie": exp == 0,
        "num": p.get("number"),
        "status": p.get("injury_status") or "",
        "depth": p.get("depth_chart_order"),
        "bye": byes.get(p.get("team")),
        # primary ADP = Sleeper half-PPR (updates daily); FFC fills gaps
        "adp": sleeper_adp(pid) if sleeper_adp(pid) is not None else extra.get("adp"),
        "adp_pos": extra.get("adp_pos"),
        "dyn": dyn_adp(pid),
        "proj": round(proj_pts.get(pid, 0), 1) or None,
        "p25": season25.get(pid, {}).get("pts"),
        "ppg25": season25.get(pid, {}).get("ppg"),
        "gp25": season25.get(pid, {}).get("gp"),
        "fin25": finish25.get(pid),
        "wk25": [wk.get(w, 0) for w in range(1, 19)] if wk else None,
        "bc": bc.get(pos, {}).get(norm(p.get("full_name") or "")),
    }
    players_out.append(entry)

# DEF pool
def_proj = {}
for pid, st in proj.items():
    if len(pid) <= 3 and pid.isupper():
        def_proj[pid] = score(st)
for t in all_teams:
    wk = weekpts25.get(t, {})
    players_out.append({
        "id": t, "name": t, "team": t, "pos": "DEF",
        "bye": byes.get(t),
        "adp": sleeper_adp(t), "adp_pos": None, "dyn": dyn_adp(t),
        "proj": round(def_proj.get(t, 0), 1) or None,
        "p25": season25.get(t, {}).get("pts"),
        "ppg25": season25.get(t, {}).get("ppg"),
        "gp25": season25.get(t, {}).get("gp"),
        "fin25": finish25.get(t),
        "wk25": [wk.get(w, 0) for w in range(1, 19)] if wk else None,
        "bc": bc.get("DST", {}).get(norm(t)),
    })

# positional ADP ranks recomputed on the Sleeper-primary numbers
for pos in POS + ["DEF"]:
    ranked = sorted((e for e in players_out if e["pos"] == pos and e.get("adp")),
                    key=lambda x: x["adp"])
    for i, e in enumerate(ranked):
        e["adp_pos"] = i + 1

skill_count = sum(1 for e in players_out if e["pos"] in POS)
print(f"  pool: {skill_count} skill + {len(players_out)-skill_count} DEF")

# BC DST tiers are by team name ("49ers") — remap via nickname
NICK = {"ARI":"cardinals","ATL":"falcons","BAL":"ravens","BUF":"bills","CAR":"panthers",
"CHI":"bears","CIN":"bengals","CLE":"browns","DAL":"cowboys","DEN":"broncos","DET":"lions",
"GB":"packers","HOU":"texans","IND":"colts","JAX":"jaguars","KC":"chiefs","LAC":"chargers",
"LAR":"rams","LV":"raiders","MIA":"dolphins","MIN":"vikings","NE":"patriots","NO":"saints",
"NYG":"giants","NYJ":"jets","PHI":"eagles","PIT":"steelers","SEA":"seahawks","SF":"ers",
"TB":"buccaneers","WAS":"commanders"}
dst_tiers = bc.get("DST", {})
if dst_tiers:
    for e in players_out:
        if e["pos"] == "DEF":
            for nm, tier in dst_tiers.items():
                if NICK.get(e["id"], "zzz") in nm.replace(" ", ""):
                    e["bc"] = tier
                    break

# ---- SoS: 2025 league-scored points allowed per defense per position ----
allowed = {t: {pos: [] for pos in POS + ["DEF"]} for t in all_teams}
for pid, wkpts in weekpts25.items():
    if len(pid) <= 3 and pid.isupper():
        team, pos = pid, "DEF"
    else:
        p = players_db.get(pid)
        if not p or p.get("position") not in POS:
            continue
        team, pos = p.get("team"), p["position"]
    if team not in opp25:
        continue
    for w, pts in wkpts.items():
        game = opp25.get(team, {}).get(w)
        if game and game["opp"] in allowed:
            allowed[game["opp"]][pos].append(pts)

def_vs_pos = {}
for t in all_teams:
    def_vs_pos[t] = {}
    for pos in POS + ["DEF"]:
        vals = allowed[t][pos]
        games = len(set(w for team2, wks in opp25.items()
                        for w, g in wks.items() if g["opp"] == t)) or 17
        avg = round(sum(vals) / 17, 1) if vals else 0
        def_vs_pos[t][pos] = {"avg": avg}
for pos in POS + ["DEF"]:
    ranked = sorted(all_teams, key=lambda t: -def_vs_pos[t][pos]["avg"])
    for i, t in enumerate(ranked):
        def_vs_pos[t][pos]["rank"] = i + 1  # 1 = allows most (easiest matchup)

sos = {
    "defVsPos": def_vs_pos,
    "schedule": {t: [
        ({"w": w, **opp26[t][w]} if w in opp26.get(t, {}) else {"w": w, "opp": None})
        for w in range(1, 19)] for t in all_teams},
    "byes": byes,
    "playoffWeeks": [15, 16, 17],
}

# ---- leagues.json ----
def league_out(tag):
    L = leagues[tag]
    users = {u["user_id"]: {
        "name": u.get("display_name"),
        "team": (u.get("metadata") or {}).get("team_name"),
        "avatar": u.get("avatar"),
    } for u in L["users"]}
    my_uid = next((uid for uid, u in users.items() if u["name"] == MY_NAME), None)
    rosters = [{
        "rid": r["roster_id"], "owner": r.get("owner_id"),
        "players": r.get("players") or [], "keepers": r.get("keepers") or [],
        "wins": (r.get("settings") or {}).get("wins", 0),
        "losses": (r.get("settings") or {}).get("losses", 0),
        "fpts": (r.get("settings") or {}).get("fpts", 0),
    } for r in L["rosters"]]
    d0 = (L["drafts"] or [{}])[0]
    # keeper cost basis: round drafted last season (from most recent completed draft).
    # A pick with is_keeper means the player was KEPT last year — his slot round is what
    # the keep cost, so this year's keep escalates one round earlier from there.
    last_rounds = {}
    last_kept = []
    for h in L["history"]:
        if h["season"] == str(PREV):
            for d in h["drafts"]:
                for pk in d["picks"]:
                    last_rounds[pk["player_id"]] = pk["round"]
                    if pk.get("is_keeper"):
                        last_kept.append(pk["player_id"])
    return {
        "id": L["league"]["league_id"],
        "name": L["league"]["name"].strip(),
        "season": L["league"]["season"],
        "status": L["league"]["status"],
        "draftId": d0.get("draft_id"),
        "rosterPositions": L["league"]["roster_positions"],
        "users": users,
        "rosters": rosters,
        "myUserId": my_uid,
        "lastDraftRound": last_rounds,
        "lastKept": last_kept,
        # keepers already PLACED on this season's actual draft board
        "draftKeepers": [{"pid": pk["player_id"], "round": pk["round"], "pick": pk.get("pick_no")}
                         for pk in (L.get("draft_picks") or []) if pk.get("is_keeper")],
        # this season's draft shape (order/slots known once the league sets them)
        "draftDetail": (lambda dd: {
            "status": dd.get("status"), "type": dd.get("type"),
            "rounds": (dd.get("settings") or {}).get("rounds"),
            "draftOrder": dd.get("draft_order"),
            "slotToRoster": dd.get("slot_to_roster_id"),
        })(L.get("draft_detail") or {}),
        "keeperRule": "round_slot" if tag == "ggg" else "round_minus_1",
        "keeperMax": (L["league"].get("settings") or {}).get("max_keepers", 3),
    }

leagues_out = {tag: league_out(tag) for tag in ("ggg", "lob")}

# ---- intel.json: draft tendencies per owner per league ----
def build_intel(tag):
    L = leagues[tag]
    current_users = {u["user_id"]: u.get("display_name") for u in L["users"]}
    stats = {}
    for h in L["history"]:
        season = int(h["season"])
        husers = {u["user_id"]: u.get("display_name") for u in (h["users"] or [])}
        for d in h["drafts"]:
            dd = d["draft"] or {}
            if (dd.get("status") != "complete"):
                continue
            for pk in d["picks"]:
                uid = pk.get("picked_by") or ""
                if not uid:
                    continue
                name = current_users.get(uid) or husers.get(uid) or uid
                md = pk.get("metadata") or {}
                pos = md.get("position")
                pid = pk.get("player_id")
                p = players_db.get(pid, {})
                exp_now = p.get("years_exp")
                was_rookie = exp_now is not None and exp_now == SEASON - season
                s = stats.setdefault(uid, {"name": name, "uid": uid, "seasons": set(),
                                           "picks": [], "current": uid in current_users})
                s["seasons"].add(season)
                s["picks"].append({
                    "season": season, "round": pk["round"], "pickno": pk.get("pick_no"),
                    "pos": pos, "rookie": was_rookie,
                    "keeper": bool(pk.get("is_keeper")),
                    "team": md.get("team"), "player": f"{md.get('first_name','')} {md.get('last_name','')}".strip(),
                })
    out = []
    for uid, s in stats.items():
        picks = [p for p in s["picks"] if not p["keeper"]]
        n_seasons = len(s["seasons"])
        if not picks or not n_seasons:
            continue
        def first_round_of(pos):
            firsts = []
            for season in s["seasons"]:
                rs = [p["round"] for p in picks if p["season"] == season and p["pos"] == pos]
                if rs:
                    firsts.append(min(rs))
            return round(sum(firsts) / len(firsts), 1) if firsts else None
        early = [p for p in picks if p["round"] <= 3]
        pos_mix = {}
        for p in early:
            pos_mix[p["pos"]] = pos_mix.get(p["pos"], 0) + 1
        rookies = [p for p in picks if p["rookie"]]
        nfl_teams = {}
        for p in picks:
            if p["team"]:
                nfl_teams[p["team"]] = nfl_teams.get(p["team"], 0) + 1
        fav_team = max(nfl_teams.items(), key=lambda x: x[1]) if nfl_teams else None
        out.append({
            "uid": uid, "name": s["name"], "current": s["current"],
            "seasons": sorted(s["seasons"]), "totalPicks": len(picks),
            "firstQB": first_round_of("QB"), "firstTE": first_round_of("TE"),
            "firstDEF": first_round_of("DEF"),
            "earlyMix": pos_mix,
            "rookieRate": round(len(rookies) / len(picks), 3),
            "favTeam": fav_team,
            "recent": [p for p in sorted(picks, key=lambda x: (-x["season"], x["pickno"] or 0))
                       if p["season"] == max(s["seasons"])][:16],
        })
    return sorted(out, key=lambda x: (not x["current"], x["name"].lower()))

intel_out = {tag: build_intel(tag) for tag in ("ggg", "lob")}

# ---- slim lookup for any rostered/drafted player id ----
lookup = {}
for pid, p in players_db.items():
    if p.get("position") in POS + ["K", "DEF"] and (p.get("active") or pid in season25):
        lookup[pid] = [p.get("full_name") or pid, p.get("position"), p.get("team") or ""]
for t in all_teams:
    lookup[t] = [t + " DEF", "DEF", t]

# ---- analyst consensus ranks (data/consensus_ranks.json from build_consensus.py) ----
consensus_path = ROOT / "data" / "consensus_ranks.json"
if consensus_path.exists():
    consensus = json.loads(consensus_path.read_text(encoding="utf-8"))
    pool_by_pos = {}
    for e in players_out:
        pool_by_pos.setdefault(e["pos"], {}).setdefault(norm(e["name"] or ""), e)
    matched = unmatched_cr = 0
    for pos, entries in consensus.items():
        if pos == "OVR":
            continue
        for c in entries:
            hit = pool_by_pos.get(pos, {}).get(norm(c["name"]))
            if hit:
                hit["cr"] = c["avg"]
                hit["cr_n"] = c["n"]
                hit["crs"] = c["ranks"]
                matched += 1
            else:
                unmatched_cr += 1
    print(f"  consensus: {matched} matched to pool, {unmatched_cr} outside pool")
    # overall lists ("OVR") match by name across the whole skill pool
    pool_by_name = {}
    for e in players_out:
        if e["pos"] in POS:
            pool_by_name.setdefault(norm(e["name"] or ""), e)
    omatched = ounmatched = 0
    for c in consensus.get("OVR", []):
        hit = pool_by_name.get(norm(c["name"]))
        if hit:
            hit["ocr"] = c["avg"]
            hit["ocr_n"] = c["n"]
            hit["ocrs"] = c["ranks"]
            omatched += 1
        else:
            ounmatched += 1
    print(f"  overall consensus: {omatched} matched, {ounmatched} outside pool")

# ---- Vegas "analyst": season prop O/U lines -> fantasy points -> ranks ----
# Positional rank = points within position; overall rank = value over a
# 10-team replacement baseline so QB raw-point inflation doesn't distort it.
vegas_raw = {}
try:
    vegas_raw = load("vegas_offers.json") or {}
except FileNotFoundError:
    pass
if vegas_raw:
    def vegas_line(offer):
        """Consensus O/U line: BettingPros book 0 main line, else opening."""
        for sel in offer.get("selections") or []:
            if (sel.get("selection") or "").lower() != "over":
                continue
            for bk in sel.get("books") or []:
                if bk.get("id") == 0:
                    for ln in bk.get("lines") or []:
                        if ln.get("main") and ln.get("line") is not None:
                            return ln["line"]
            op = sel.get("opening_line") or {}
            if op.get("line") is not None:
                return op["line"]
        return None

    vlines = {}  # (norm name, pos) -> {stat: line}
    for stat, offers in vegas_raw.items():
        for off in offers:
            parts = off.get("participants") or []
            pl = (parts[0].get("player") or {}) if parts else {}
            if pl.get("position") not in POS:
                continue
            line = vegas_line(off)
            if line is not None:
                vlines.setdefault((norm(parts[0].get("name") or ""), pl["position"]), {})[stat] = line

    def vegas_pts(pos, st):
        rec = st.get("rec")
        if rec is None and st.get("rec_yd"):
            # books didn't hang a receptions line — estimate off yards/catch
            rec = st["rec_yd"] / (8.5 if pos == "RB" else 11.0)
        return (st.get("pass_yd", 0) * scoring.get("pass_yd", 0.04)
                + st.get("pass_td", 0) * scoring.get("pass_td", 4)
                + st.get("rush_yd", 0) * scoring.get("rush_yd", 0.1)
                + st.get("rush_td", 0) * scoring.get("rush_td", 6)
                + st.get("rec_yd", 0) * scoring.get("rec_yd", 0.1)
                + st.get("rec_td", 0) * scoring.get("rec_td", 6)
                + (rec or 0) * scoring.get("rec", 0.5))

    by_pos_name = {}
    for e in players_out:
        if e["pos"] in POS:
            by_pos_name.setdefault((norm(e["name"] or ""), e["pos"]), e)
    vmatched = vunmatched = 0
    for key, st in vlines.items():
        e = by_pos_name.get(key)
        if e is None:
            vunmatched += 1
            continue
        e["vpts"] = round(vegas_pts(key[1], st), 1)
        vmatched += 1

    for pos in POS:
        ranked = sorted((e for e in players_out if e["pos"] == pos and e.get("vpts") is not None),
                        key=lambda x: -x["vpts"])
        for i, e in enumerate(ranked):
            rr = dict(e.get("crs") or {})
            rr["vegas"] = i + 1
            e["crs"] = rr
            e["cr"] = round(sum(rr.values()) / len(rr), 2)
            e["cr_n"] = len(rr)

    VBASE = {"QB": 12, "RB": 26, "WR": 28, "TE": 12}  # 10-team replacement slots
    baseline = {}
    for pos in POS:
        pts = sorted((e["vpts"] for e in players_out if e["pos"] == pos and e.get("vpts") is not None),
                     reverse=True)
        if pts:
            baseline[pos] = pts[min(VBASE[pos], len(pts)) - 1]
    vorp = sorted((e for e in players_out if e.get("vpts") is not None),
                  key=lambda e: -(e["vpts"] - baseline[e["pos"]]))
    for i, e in enumerate(vorp):
        rr = dict(e.get("ocrs") or {})
        rr["vegas"] = i + 1
        e["ocrs"] = rr
        e["ocr"] = round(sum(rr.values()) / len(rr), 2)
        e["ocr_n"] = len(rr)
    print(f"  vegas: {vmatched} players priced ({vunmatched} outside pool), "
          f"baselines {[f'{p}:{baseline.get(p)}' for p in POS]}")
    top_missing = [e["name"] for e in players_out
                   if e["pos"] in POS and e.get("adp") and e["adp"] <= 100 and "cr" not in e]
    if top_missing:
        print(f"  WARNING top-100-ADP players with no consensus rank: {top_missing}")

# BC freshness guard: only trust tiers if they cover the top of current ADP
top30 = sorted((p for p in players_out if p.get("adp") and p["pos"] in POS),
               key=lambda x: x["adp"])[:30]
bc_cover = sum(1 for p in top30 if p.get("bc")) / max(1, len(top30))
bc_fresh = bc_cover >= 0.8
print(f"  BC coverage of top-30 ADP: {bc_cover:.0%} -> {'FRESH' if bc_fresh else 'STALE (column hidden)'}")

meta = {
    "bcFresh": bc_fresh,
    "built": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    "season": SEASON,
    "state": state,
    "adpMeta": ffc.get("meta"),
    "scoringDiffs": diffs,
    "leagues": {t: {"id": leagues_out[t]["id"], "name": leagues_out[t]["name"],
                    "draftId": leagues_out[t]["draftId"]} for t in leagues_out},
}

print("Writing outputs...")
dump("meta.json", meta)
dump("players.json", players_out)
dump("leagues.json", leagues_out)
dump("intel.json", intel_out)
dump("sos.json", sos)
dump("lookup.json", lookup)
print("Done.")
