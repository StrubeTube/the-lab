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


if __name__ == "__main__":
    t0 = time.time()
    fetch_sleeper_core()
    for tag, lid in LEAGUES.items():
        fetch_league(tag, lid)
        fetch_trades(tag, lid)
    fetch_adp()
    fetch_borischen()
    fetch_vegas()
    print(f"Done in {time.time()-t0:.0f}s")
