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


def fetch_adp():
    print("FFC ADP (half-ppr, 10-team)")
    save("ffc_adp.json", get_json(f"https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=10&year={SEASON}"))


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


if __name__ == "__main__":
    t0 = time.time()
    fetch_sleeper_core()
    for tag, lid in LEAGUES.items():
        fetch_league(tag, lid)
    fetch_adp()
    fetch_borischen()
    print(f"Done in {time.time()-t0:.0f}s")
