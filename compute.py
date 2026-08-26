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

# League-approved keeper swaps not yet fixed inside Sleeper (Alex's exception):
# lynnkm23 traded for Jonathan Taylor and keeps HIM, not Chuba Hubbard, even
# though Sleeper still shows Hubbard locked on the board. The stale board slot
# is dropped; Taylor keeps at his own cost round via the normal rules.
KEEPER_SWAPS = {"ggg": [("7594", "6813")]}  # (old pid Hubbard, new pid Taylor)


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
    draft_keepers = [{"pid": pk["player_id"], "round": pk["round"], "pick": pk.get("pick_no")}
                     for pk in (L.get("draft_picks") or []) if pk.get("is_keeper")]
    for old, new in KEEPER_SWAPS.get(tag, []):
        for r in rosters:
            r["keepers"] = [new if k == old else k for k in (r["keepers"] or [])]
        draft_keepers = [dk for dk in draft_keepers if dk["pid"] != old]
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
        "draftKeepers": draft_keepers,
        # this season's draft shape (order/slots known once the league sets them)
        "draftDetail": (lambda dd: {
            "status": dd.get("status"), "type": dd.get("type"),
            "rounds": (dd.get("settings") or {}).get("rounds"),
            "draftOrder": dd.get("draft_order"),
            "slotToRoster": dd.get("slot_to_roster_id"),
        })(L.get("draft_detail") or {}),
        # both leagues use the same rule (confirmed by Alex 08-25): first keep
        # costs the round he was drafted; repeat keeps escalate one round/yr
        "keeperRule": "round_slot",
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

def load_opt(name, default):
    try:
        return load(name)
    except OSError:
        return default


def build_trades(tag):
    """League trade history with picks resolved to the player they became,
    per-round realized draft outcomes, and current traded-pick ownership."""
    raw = load_opt(f"{tag}_trades.json", {"seasons": {}, "traded_picks": []})
    cur = load(f"{tag}_league.json")
    hist = load_opt(f"{tag}_history.json", [])

    def team_names(users, rosters):
        uname = {u["user_id"]: (u.get("metadata") or {}).get("team_name")
                 or u.get("display_name") for u in users or []}
        return {r["roster_id"]: uname.get(r.get("owner_id")) or f"Team {r['roster_id']}"
                for r in rosters or []}

    def owner_uids(rosters):
        return {r["roster_id"]: r.get("owner_id") for r in rosters or []}

    ctx = {str(cur.get("season")): {
        "names": team_names(load(f"{tag}_users.json"), load(f"{tag}_rosters.json")),
        "uids": owner_uids(load(f"{tag}_rosters.json"))}}
    for h in hist:
        d = (h.get("drafts") or [{}])[0]
        draft = d.get("draft") or {}
        ctx[str(h["season"])] = {
            "names": team_names(h.get("users"), h.get("rosters")),
            "uids": owner_uids(h.get("rosters")),
            "rid_slot": {int(v): int(k) for k, v in (draft.get("slot_to_roster_id") or {}).items()},
            "picks": {(p["round"], p["draft_slot"]): p for p in d.get("picks") or []},
        }

    def resolve_pick(season, rnd, orig_rid):
        c = ctx.get(str(season))
        if not c or "picks" not in c:
            return None  # future draft (or missing history)
        slot = c["rid_slot"].get(orig_rid)
        p = c["picks"].get((rnd, slot)) if slot else None
        if not p:
            return None
        md = p.get("metadata") or {}
        return {"name": f"{md.get('first_name', '')} {md.get('last_name', '')}".strip(),
                "pos": md.get("position"), "keeper": bool(p.get("is_keeper"))}

    # historical ADP (overall pick) by season for retro keeper surplus
    adp_hist = load_opt("ffc_adp_hist.json", {})
    adp_by_season = {}
    for yr, d in adp_hist.items():
        adp_by_season[yr] = {norm(p.get("name")): p.get("adp")
                             for p in (d.get("players") or [])}

    # who was KEPT in each season's draft (pid, roster) -> keeper round; the
    # current season's board keeps count too (placed keeper slots)
    kept_at = {}
    for h in hist:
        for p in (h.get("drafts") or [{}])[0].get("picks") or []:
            if p.get("is_keeper"):
                kept_at[(str(h["season"]), p.get("player_id"), p.get("roster_id"))] = p["round"]
    try:
        for p in load(f"{tag}_draft_picks.json"):
            if p.get("is_keeper"):
                kept_at[(str(cur.get("season")), p.get("player_id"), p.get("roster_id"))] = p["round"]
    except OSError:
        pass

    trades = []
    market = []  # preseason exchange rate: keeper cost round <-> pick rounds paid
    for season, rows in (raw.get("seasons") or {}).items():
        names = (ctx.get(str(season)) or {}).get("names") or {}
        uids = (ctx.get(str(season)) or {}).get("uids") or {}
        for t in rows:
            sides = {rid: {"team": names.get(rid, f"Team {rid}"), "uid": uids.get(rid),
                           "players": [], "picks": []}
                     for rid in t.get("roster_ids") or []}
            for pid, rid in (t.get("adds") or {}).items():
                pl = players_db.get(pid) or {}
                if rid in sides:
                    sides[rid]["players"].append({
                        "id": pid,
                        "name": pl.get("full_name")
                        or f"{pl.get('first_name', '')} {pl.get('last_name', '')}".strip() or pid,
                        "pos": pl.get("position") or "?",
                        "keptAt": kept_at.get((str(season), pid, rid))})
            for dp in t.get("draft_picks") or []:
                rid = dp.get("owner_id")
                if rid in sides:
                    sides[rid]["picks"].append({
                        "season": dp.get("season"), "round": dp.get("round"),
                        "orig": names.get(dp.get("roster_id"), f"Team {dp.get('roster_id')}"),
                        "became": resolve_pick(dp.get("season"), dp.get("round"), dp.get("roster_id"))})
            side_list = list(sides.values())
            trades.append({"season": season, "week": t.get("week"),
                           "ts": t.get("created"), "sides": side_list})
            # market events: a preseason trade where a player was acquired AND
            # kept that season, with picks going back the other way = the
            # league's real price for a keeper at that cost round
            if t.get("week") == 1 and len(side_list) == 2:
                for i, side in enumerate(side_list):
                    other = side_list[1 - i]
                    paid = [pk["round"] for pk in other["picks"]]
                    if not paid:
                        continue
                    outs = [max(0, int(pk["season"]) - int(season)) for pk in other["picks"]]
                    for pl in side["players"]:
                        if pl["keptAt"]:
                            # retro surplus at trade time: keeper-cost slot
                            # minus that season's national ADP (FFC)
                            adp = (adp_by_season.get(str(season)) or {}).get(norm(pl["name"]))
                            surp = round((pl["keptAt"] - 0.5) * 10 - adp) if adp else None
                            market.append({"season": season, "name": pl["name"], "pos": pl["pos"],
                                           "cost": pl["keptAt"], "paid": sorted(paid),
                                           "out": min(outs), "surp": surp, "ts": t.get("created")})
    trades.sort(key=lambda x: -(x["ts"] or 0))
    market.sort(key=lambda x: -int(x["season"]))

    # what each round has actually turned into, season by season (drafted
    # players only — keeper slots are excluded on the front-end when needed)
    round_hist = {}
    for h in hist:
        for (rnd, _slot), p in ctx[str(h["season"])]["picks"].items():
            md = p.get("metadata") or {}
            round_hist.setdefault(str(rnd), []).append({
                "season": h["season"],
                "name": f"{md.get('first_name', '')} {md.get('last_name', '')}".strip(),
                "pos": md.get("position"), "keeper": bool(p.get("is_keeper"))})
    for v in round_hist.values():
        v.sort(key=lambda x: -int(x["season"]))

    cur_names = ctx[str(cur.get("season"))]["names"]
    traded_picks = [{"season": d.get("season"), "round": d.get("round"),
                     "origRid": d.get("roster_id"), "ownerRid": d.get("owner_id"),
                     "orig": cur_names.get(d.get("roster_id")),
                     "owner": cur_names.get(d.get("owner_id"))}
                    for d in raw.get("traded_picks") or []]
    n_res = sum(1 for t in trades for s in t["sides"] for pk in s["picks"] if pk["became"])
    print(f"  {tag}: {len(trades)} trades ({n_res} traded picks resolved), "
          f"{len(traded_picks)} picks currently traded, {len(market)} keeper-market events")
    return {"trades": trades, "roundHist": round_hist, "tradedPicks": traded_picks,
            "market": market}


print("Building trade history...")
trades_out = {t: build_trades(t) for t in ("ggg", "lob")}


# ---- Lab Score data layer (phase 1) ------------------------------------
# Per-player inputs for the coming 0-100 Lab Score: age-curve position,
# real draft capital, team vacated opportunity, and TD-over-expected.
# Backing research: actual TDs are near-noise year over year while expected
# TDs are sticky (regression hit rates 66-94% by tier); RB production cliffs
# at 27+ (57% of RB1 seasons at ages 23-26); WR peaks 24-28; TE ramps to a
# late 25-28 peak; QB is flat into the mid-30s.
print("Lab Score data layer...")
nv_draft_rows = load_opt("nflverse_draft.json", [])  # [{g,n,p,s,r,pk}]
nv_roster = load_opt("nflverse_roster_last.json", {})  # sleeper_id -> {team, gsis_id}
nv_by_gsis, nv_by_name = {}, {}
for row in (nv_draft_rows if isinstance(nv_draft_rows, list) else []):
    dc_e = {"season": row["s"], "round": row["r"], "pick": row["pk"]}
    if row["g"]:
        nv_by_gsis[row["g"]] = dc_e
    if row["n"]:
        nv_by_name[norm(row["n"]) + "|" + row["p"]] = dc_e
NV_TEAM = {"LA": "LAR"}  # nflverse codes Rams as LA; Sleeper uses LAR
team_last = {sid: NV_TEAM.get(r["team"], r["team"]) for sid, r in nv_roster.items()}

# team 2025 opportunity totals + what departed players took with them
team_opp = {}
for spid, st in stats25.items():
    pdb = players_db.get(spid)
    if not isinstance(pdb, dict) or pdb.get("position") not in POS:
        continue
    t25 = team_last.get(spid)
    if not t25:
        continue
    d = team_opp.setdefault(t25, {"tgt": 0, "att": 0, "ay": 0,
                                  "vtgt": 0, "vatt": 0, "vay": 0})
    tgt = st.get("rec_tgt") or 0
    att = st.get("rush_att") or 0
    ay = st.get("rec_air_yd") or 0
    d["tgt"] += tgt
    d["att"] += att
    d["ay"] += ay
    if pdb.get("team") != t25:  # traded, cut, signed away, or retired
        d["vtgt"] += tgt
        d["vatt"] += att
        d["vay"] += ay

# expected TDs: league-pooled OLS on red-zone vs non-red-zone opportunity
def ols2(rows):
    """No-intercept 2-var least squares: y ~ a*x1 + b*x2 -> (a, b)."""
    s11 = s12 = s22 = s1y = s2y = 0.0
    for x1, x2, y in rows:
        s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2
        s1y += x1 * y; s2y += x2 * y
    det = s11 * s22 - s12 * s12
    if abs(det) < 1e-9:
        return (0.0, 0.0)
    a = (s22 * s1y - s12 * s2y) / det
    b = (s11 * s2y - s12 * s1y) / det
    # a negative marginal rate would dock players for volume; refit 1-var
    if b < 0:
        return (s1y / s11 if s11 else 0.0, 0.0)
    if a < 0:
        return (0.0, s2y / s22 if s22 else 0.0)
    return (a, b)

rec_rows, rush_rows, pass_rows = [], [], []
for spid, st in stats25.items():
    pdb = players_db.get(spid)
    if not isinstance(pdb, dict) or pdb.get("position") not in POS:
        continue
    tgt, rz_t = st.get("rec_tgt") or 0, st.get("rec_rz_tgt") or 0
    att, rz_a = st.get("rush_att") or 0, st.get("rush_rz_att") or 0
    pat, rz_p = st.get("pass_att") or 0, st.get("pass_rz_att") or 0
    if tgt >= 15:
        rec_rows.append((rz_t, tgt - rz_t, st.get("rec_td") or 0))
    if att >= 25:
        rush_rows.append((rz_a, att - rz_a, st.get("rush_td") or 0))
    if pat >= 100:
        pass_rows.append((rz_p, pat - rz_p, st.get("pass_td") or 0))
TD_RATES = {"rec": ols2(rec_rows), "rush": ols2(rush_rows), "pass": ols2(pass_rows)}
print("  xTD rates (rz, non-rz): " + "  ".join(
    f"{k}={a:.3f}/{b:.4f}" for k, (a, b) in TD_RATES.items()))

# age curves: (age, level) anchor points, linearly interpolated.
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

import datetime
SEASON_START = datetime.date(int(meta["season"]) if isinstance(meta, dict) and meta.get("season") else 2026, 9, 1)

n_lab = 0
for e in players_out:
    if e["pos"] not in POS:
        continue
    pdb = players_db.get(e["id"]) or {}
    st = stats25.get(e["id"]) or {}
    lab = {}
    # decimal age at kickoff + curve position (level now, slope to next year)
    bd = pdb.get("birth_date")
    age = None
    if bd:
        try:
            b = datetime.date(*map(int, bd.split("-")))
            age = round((SEASON_START - b).days / 365.25, 1)
        except ValueError:
            age = e.get("age")
    else:
        age = e.get("age")
    if age is not None:
        lvl = age_level(e["pos"], age)
        nxt = age_level(e["pos"], age + 1)
        lab["age"] = age
        if lvl is not None:
            lab["alvl"] = round(lvl, 2)
            lab["aslp"] = round(nxt - lvl, 2)
    # draft capital: gsis join (roster file as fallback gsis), then name+pos
    gid = ((pdb.get("gsis_id") or "").strip()
           or ((nv_roster.get(e["id"]) or {}).get("gsis_id") or "").strip())
    dc = (nv_by_gsis.get(gid) if gid else None) \
        or nv_by_name.get(norm(e.get("name") or "") + "|" + e["pos"])
    if dc:
        lab["dcr"] = dc["round"]
        lab["dcp"] = dc["pick"]
        lab["dcy"] = dc["season"]
    # team context: vacated opportunity on his CURRENT team
    d = team_opp.get(e.get("team"))
    if d and d["tgt"]:
        lab["vt"] = int(d["vtgt"])
        lab["vtp"] = round(100 * d["vtgt"] / d["tgt"], 1)
        lab["va"] = int(d["vatt"])
        lab["vap"] = round(100 * d["vatt"] / d["att"], 1) if d["att"] else 0
        lab["vay"] = int(d["vay"])
    if team_last.get(e["id"]) and team_last[e["id"]] != e.get("team"):
        lab["moved"] = team_last[e["id"]]  # he IS part of a vacated pool elsewhere
    # TD-over-expected from 2025 usage (positive delta = fade, negative = buy)
    tgt, rz_t = st.get("rec_tgt") or 0, st.get("rec_rz_tgt") or 0
    att, rz_a = st.get("rush_att") or 0, st.get("rush_rz_att") or 0
    pat, rz_p = st.get("pass_att") or 0, st.get("pass_rz_att") or 0
    if tgt or att or pat:
        a, b2 = TD_RATES["rec"]
        exp = a * rz_t + b2 * max(0, tgt - rz_t)
        a, b2 = TD_RATES["rush"]
        exp += a * rz_a + b2 * max(0, att - rz_a)
        a, b2 = TD_RATES["pass"]
        exp += a * rz_p + b2 * max(0, pat - rz_p)
        act = (st.get("rec_td") or 0) + (st.get("rush_td") or 0) + (st.get("pass_td") or 0)
        lab["td"] = int(act)
        lab["xtd"] = round(exp, 1)
    if lab:
        e["lab"] = lab
        n_lab += 1
print(f"  lab inputs on {n_lab} players; "
      f"top vacated tgt: " + ", ".join(f"{t} {d['vtgt']:.0f}" for t, d in
      sorted(team_opp.items(), key=lambda x: -x[1]['vtgt'])[:3]))

print("Writing outputs...")
dump("meta.json", meta)
dump("players.json", players_out)
dump("leagues.json", leagues_out)
dump("intel.json", intel_out)
dump("sos.json", sos)
dump("lookup.json", lookup)
dump("trades.json", trades_out)
print("Done.")
