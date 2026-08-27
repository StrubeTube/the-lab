#!/usr/bin/env python3
"""THE LAB - data fetcher.

Pulls everything raw from public APIs into data/raw/. Stdlib only.
Run: python fetch_data.py
"""
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).parent
RAW = ROOT / "data" / "raw"
RAW.mkdir(parents=True, exist_ok=True)

LEAGUES = {
    "ggg": "1389357057668284416",
    "lob": "1389331963885670400",
}
SEASON = "2026"
PREV_SEASON = "2025"

UA = {"User-Agent": "the-lab/1.0 (personal fantasy hub)"}


def get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            if i == retries - 1:
                print(f"  FAIL {url}: {e}")
                return None
            time.sleep(2 * (i + 1))


def get_json(url):
    b = get(url)
    return json.loads(b) if b else None


def save(name, obj):
    p = RAW / name
    p.write_text(json.dumps(obj), encoding="utf-8")
    print(f"  saved {name} ({p.stat().st_size//1024} KB)")


def fetch_sleeper_core():
    print("Sleeper: players DB")
    save("players_nfl.json", get_json("https://api.sleeper.app/v1/players/nfl"))
    print("Sleeper: state")
    save("state.json", get_json("https://api.sleeper.app/v1/state/nfl"))
    for yr in (PREV_SEASON, SEASON):
        print(f"Sleeper: schedule {yr}")
        save(f"schedule_{yr}.json", get_json(f"https://api.sleeper.app/schedule/nfl/regular/{yr}"))
    print("Sleeper: 2026 season projections")
    save("proj_2026.json", get_json(f"https://api.sleeper.app/v1/projections/nfl/regular/{SEASON}"))
    print("Sleeper: 2025 season stats")
    save("stats_2025.json", get_json(f"https://api.sleeper.app/v1/stats/nfl/regular/{PREV_SEASON}"))
    print("Sleeper: 2024 season stats (Lab Score 2-year blend)")
    save("stats_prior2.json", get_json(f"https://api.sleeper.app/v1/stats/nfl/regular/{int(PREV_SEASON) - 1}"))
    print("Sleeper: 2025 weekly stats (for SoS)")
    weekly = {}
    for wk in range(1, 19):
        weekly[str(wk)] = get_json(f"https://api.sleeper.app/v1/stats/nfl/regular/{PREV_SEASON}/{wk}")
    save("stats_2025_weekly.json", weekly)


def fetch_league(tag, lid):
    print(f"League {tag} ({lid})")
    league = get_json(f"https://api.sleeper.app/v1/league/{lid}")
    save(f"{tag}_league.json", league)
    save(f"{tag}_users.json", get_json(f"https://api.sleeper.app/v1/league/{lid}/users"))
    save(f"{tag}_rosters.json", get_json(f"https://api.sleeper.app/v1/league/{lid}/rosters"))
    drafts = get_json(f"https://api.sleeper.app/v1/league/{lid}/drafts")
    save(f"{tag}_drafts.json", drafts)
    if drafts:
        d0 = drafts[0]
        save(f"{tag}_draft_detail.json", get_json(f"https://api.sleeper.app/v1/draft/{d0['draft_id']}"))
        save(f"{tag}_draft_picks.json", get_json(f"https://api.sleeper.app/v1/draft/{d0['draft_id']}/picks") or [])
    # walk history chain: league + users + draft picks per past season
    history = []
    prev = league.get("previous_league_id")
    while prev and prev != "0":
        pl = get_json(f"https://api.sleeper.app/v1/league/{prev}")
        if not pl:
            break
        entry = {
            "season": pl["season"],
            "league": pl,
            "users": get_json(f"https://api.sleeper.app/v1/league/{prev}/users"),
            "rosters": get_json(f"https://api.sleeper.app/v1/league/{prev}/rosters"),
            "drafts": [],
        }
        for d in get_json(f"https://api.sleeper.app/v1/league/{prev}/drafts") or []:
            entry["drafts"].append({
                "draft": get_json(f"https://api.sleeper.app/v1/draft/{d['draft_id']}"),
                "picks": get_json(f"https://api.sleeper.app/v1/draft/{d['draft_id']}/picks") or [],
            })
        history.append(entry)
        prev = pl.get("previous_league_id")
    save(f"{tag}_history.json", history)


def fetch_trades(tag, lid):
    """Every completed trade across the league's full history, plus current
    traded-pick ownership. Runs after fetch_league (reads the saved history
    chain). ~18 requests per season."""
    print(f"Trades {tag}")
    chain = [(SEASON, lid)]
    try:
        hist = json.loads((RAW / f"{tag}_history.json").read_text(encoding="utf-8"))
    except OSError:
        hist = []
    for h in hist:
        chain.append((h["season"], h["league"]["league_id"]))
    keep = ("type", "status", "roster_ids", "adds", "drops", "draft_picks", "created")
    seasons = {}
    for season, l in chain:
        rows = []
        for wk in range(1, 19):
            for t in get_json(f"https://api.sleeper.app/v1/league/{l}/transactions/{wk}") or []:
                if t.get("type") == "trade" and t.get("status") == "complete":
                    r = {k: t.get(k) for k in keep}
                    r["week"] = wk
                    rows.append(r)
        seasons[season] = rows
        print(f"  {season}: {len(rows)} trades")
    save(f"{tag}_trades.json", {
        "seasons": seasons,
        "traded_picks": get_json(f"https://api.sleeper.app/v1/league/{lid}/traded_picks") or [],
    })


def fetch_adp():
    print("FFC ADP (half-ppr, 10-team)")
    save("ffc_adp.json", get_json(f"https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=10&year={SEASON}"))
    # historical ADP per past season — retro keeper surplus for the trade market
    hist = {}
    for yr in range(2020, int(SEASON)):
        hist[str(yr)] = get_json(f"https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=10&year={yr}") or {}
    save("ffc_adp_hist.json", hist)


def archive_snapshots():
    """LAB_OVERHAUL P2: daily compact snapshots of the two datasets that
    cannot be bought historically — Vegas season prop lines (with BOTH
    sides' prices, so future backtests can de-vig) and Sleeper ADP.
    Written to data/archive/ and committed by the daily Action.
    Idempotent per day."""
    import datetime
    arch = Path(__file__).parent / "data" / "archive"
    arch.mkdir(exist_ok=True)
    day = datetime.date.today().isoformat()
    vf, af = arch / f"{day}_vegas.json", arch / f"{day}_adp.json"
    if not vf.exists():
        try:
            offers = json.loads((RAW / "vegas_offers.json").read_text(encoding="utf-8"))
            out = {}
            for stat, offs in offers.items():
                for off in offs or []:
                    parts = off.get("participants") or []
                    if not parts:
                        continue
                    nm = parts[0].get("name")
                    pos = ((parts[0].get("player") or {}).get("position"))
                    entry = {}
                    for sel in off.get("selections") or []:
                        side = (sel.get("selection") or "").lower()
                        for bk in sel.get("books") or []:
                            if bk.get("id") == 0:
                                for ln in bk.get("lines") or []:
                                    if ln.get("main") and ln.get("line") is not None:
                                        entry[side] = [ln["line"], ln.get("cost")]
                    if entry:
                        out.setdefault(f"{nm}|{pos}", {})[stat] = entry
            vf.write_text(json.dumps(out), encoding="utf-8")
            print(f"  archived {len(out)} player prop sets -> {vf.name}")
        except (OSError, ValueError) as ex:
            print(f"  vegas archive skipped: {ex}")
    if not af.exists():
        try:
            proj = json.loads((RAW / f"proj_{SEASON}.json").read_text(encoding="utf-8"))
            adp = {pid: round(v["adp_half_ppr"], 1) for pid, v in proj.items()
                   if isinstance(v, dict) and v.get("adp_half_ppr")}
            af.write_text(json.dumps(adp), encoding="utf-8")
            print(f"  archived {len(adp)} ADP values -> {af.name}")
        except (OSError, ValueError) as ex:
            print(f"  adp archive skipped: {ex}")


def fetch_borischen():
    print("Boris Chen tiers")
    files = {
        "QB": "text_QB.txt",
        "RB": "text_RB-HALF.txt",
        "WR": "text_WR-HALF.txt",
        "TE": "text_TE-HALF.txt",
        "FLX": "text_FLX-HALF.txt",
        "DST": "text_DST.txt",
    }
    out = {}
    for pos, fn in files.items():
        b = get(f"https://s3-us-west-1.amazonaws.com/fftiers/out/{fn}", retries=1)
        if b and not b.startswith(b"<?xml"):
            out[pos] = b.decode("utf-8", "replace")
            print(f"  BC {pos}: ok")
        else:
            print(f"  BC {pos}: unavailable")
    save("borischen.json", out)


def fetch_vegas():
    """Season-long player prop totals (O/U lines) from BettingPros' public API.

    Markets: 300 pass yds, 301 rush yds, 302 rec yds, 304 pass TDs,
    305 rush TDs, 306 rec TDs, 330 receptions. The x-api-key is the public
    one shipped in bettingpros.com's own front-end JS.
    """
    print("Vegas season props (BettingPros)")
    headers = {**UA, "Accept": "application/json",
               "x-api-key": "CHi8Hy5CEE4khd46XNYL23dCFX96oUdw6qOt1Dnh"}
    markets = {300: "pass_yd", 301: "rush_yd", 302: "rec_yd",
               304: "pass_td", 305: "rush_td", 306: "rec_td", 330: "rec"}
    out = {}
    for mid, stat in markets.items():
        offers, page = [], 1
        while True:
            url = (f"https://api.bettingpros.com/v3/offers?sport=NFL"
                   f"&market_id={mid}&season={SEASON}&limit=10&page={page}")  # API caps limit at 10
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.loads(r.read())
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"  FAIL market {mid} p{page}: {e}")
                break
            offers.extend(d.get("offers") or [])
            pg = d.get("_pagination") or {}
            if page >= (pg.get("total_pages") or 1):
                break
            page += 1
            time.sleep(0.3)
        out[stat] = offers
        print(f"  {stat} (market {mid}): {len(offers)} players")
    save("vegas_offers.json", out)


def fetch_nflverse():
    """Free nflverse datasets for the Lab Score data layer (phase 1):

    - draft_picks.csv: real draft capital (round + overall pick) per gsis_id.
    - roster_{last season}.csv: which NFL team each player finished LAST
      season on (has sleeper_id directly) — the input for vacated targets;
      Sleeper's season stats carry no team, so this is the attribution source.
    """
    import csv
    import io
    print("nflverse (draft capital + last-season rosters)")
    base = "https://github.com/nflverse/nflverse-data/releases/download"
    b = get(f"{base}/draft_picks/draft_picks.csv")
    draft = []
    if b:
        for row in csv.DictReader(io.StringIO(b.decode("utf-8", "replace"))):
            if row.get("season") and int(row["season"]) >= 2000:
                # keep name+position too: Sleeper gsis ids are spotty (format
                # quirks; missing for fresh rookies) so compute.py joins by
                # gsis first, then by normalized name+pos
                draft.append({"g": (row.get("gsis_id") or "").strip(),
                              "n": row.get("pfr_player_name") or "",
                              "p": row.get("position") or "",
                              "s": int(row["season"]), "r": int(row["round"]),
                              "pk": int(row["pick"])})
        print(f"  draft capital: {len(draft)} picks since 2000")
    else:
        print("  FAIL draft_picks")
    save("nflverse_draft.json", draft)

    for yr, name in ((int(SEASON) - 1, "nflverse_roster_last.json"),
                     (int(SEASON) - 2, "nflverse_roster_prior2.json")):
        b = get(f"{base}/rosters/roster_{yr}.csv")
        roster = {}
        if b:
            for row in csv.DictReader(io.StringIO(b.decode("utf-8", "replace"))):
                sid = row.get("sleeper_id")
                if sid and row.get("team"):
                    roster[sid] = {"team": row["team"], "gsis_id": row.get("gsis_id") or ""}
            print(f"  roster_{yr}: {len(roster)} players with sleeper ids")
        else:
            print(f"  FAIL roster_{yr}")
        save(name, roster)
    # nflverse season player stats: QB PACR (air conversion) feeds the
    # ceiling per LAB_OVERHAUL.md — prior season + one back for the blend
    for name2, yr2 in (("nflverse_pstats.json", int(PREV_SEASON)),
                       ("nflverse_pstats2.json", int(PREV_SEASON) - 1)):
        b2 = get(f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{yr2}.csv")
        out2 = []
        if b2:
            for row in csv.DictReader(io.StringIO(b2.decode("utf-8", "replace"))):
                if row.get("position") == "QB" and row.get("pacr") not in (None, ""):
                    try:
                        out2.append({"n": row.get("player_display_name"),
                                     "pacr": float(row["pacr"])})
                    except ValueError:
                        pass
            print(f"  pstats_{yr2}: {len(out2)} QB PACR rows")
        else:
            print(f"  FAIL pstats_{yr2}")
        save(name2, out2)


def fetch_contracts():
    """Live contracts from OverTheCap's position pages (server-rendered
    tables; the nflverse contracts mirror is stale, the site itself is
    current). Feeds the Lab Score's role-security signal: how much money a
    team has committed to a player and for how long."""
    import re as _re
    print("OverTheCap contracts")
    pages = {"QB": "quarterback", "RB": "running-back",
             "WR": "wide-receiver", "TE": "tight-end"}
    out = []
    for pos, slug in pages.items():
        b = get(f"https://overthecap.com/position/{slug}", retries=2)
        if not b:
            print(f"  FAIL {pos}")
            continue
        html = b.decode("utf-8", "replace")
        n = 0
        for tr in _re.findall(r"<tr><td><a href=\"/player/[^\"]+\">([^<]+)</a></td>(.*?)</tr>", html):
            name, rest = tr
            tds = _re.findall(r"<td[^>]*>(?:<a[^>]*>)?([^<]*)", rest)
            # tds: team, age, total, avg/year, total gtd, fully gtd, FA year
            if len(tds) < 7:
                continue
            money = lambda s: float(_re.sub(r"[^\d]", "", s) or 0)
            fa = _re.search(r"(\d{4})", tds[6])
            out.append({"n": name.strip(), "p": pos,
                        "apy": money(tds[3]), "gtd": money(tds[4]),
                        "fa": int(fa.group(1)) if fa else None})
            n += 1
        print(f"  {pos}: {n} contracts")
        time.sleep(0.5)
    save("otc_contracts.json", out)


if __name__ == "__main__":
    t0 = time.time()
    fetch_sleeper_core()
    for tag, lid in LEAGUES.items():
        fetch_league(tag, lid)
        fetch_trades(tag, lid)
    fetch_adp()
    fetch_borischen()
    fetch_vegas()
    fetch_nflverse()
    fetch_contracts()
    archive_snapshots()
    print(f"Done in {time.time()-t0:.0f}s")
