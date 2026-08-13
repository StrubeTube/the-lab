# ⚗ The Lab

Personal fantasy football war room for the 2026 season — tiered rankings, live draft room,
keeper math, and in-season decision tools for two 10-team half-PPR Sleeper keeper leagues
(GGG + LOB). Successor to [fantasy-hub](https://github.com/StrubeTube/fantasy-hub).

**Live site:** https://strubetube.github.io/the-lab/

## How it works

Static site on GitHub Pages (`docs/`), no accounts, no server. Rankings live in the
browser's localStorage with JSON export/import for backup and cross-device moves.

```
fetch_data.py   # pulls Sleeper (players, leagues, drafts, history, stats, projections,
                # schedule), FFC half-PPR ADP, Boris Chen tiers  ->  data/raw/
compute.py      # re-scores 2025 stats & 2026 projections with the leagues' exact
                # scoring, builds SoS, rival draft intel, keeper costs  ->  docs/data/
```

A GitHub Action (`.github/workflows/refresh.yml`) reruns both daily and commits changed
`docs/data/`. Live things (draft picks, rosters, trending adds) are fetched client-side
from Sleeper's public API on page load.

## Pages

- **Home** — countdowns, live draft status per league, board health
- **The Board** — positional tier lists (drag & drop, quick actions) + the overall board
  arranged as draggable *whole-tier blocks* ("RB Tier 1" above "WR Tier 1"), plus a
  big-board grid view. League overlays mark keepers/rostered players.
- **Draft Room** — live pick sync (auto cross-off, tier cliffs, position runs, picks-until-you),
  mock draft simulator with AI opponents shaped by real league tendencies, rival intel
  cards from 8 seasons of draft history, post-draft report card
- **Keepers** — surplus-value grades for keeper candidates in both leagues
  (GGG round-slot, LOB round−1); cap math stays on the GGG league site
- **Season** — command center (rosters, flags, matchups), waiver scanner with
  cross-league availability, trade radar, standings
- **SoS** — 2026 schedule heatmap by position from 2025 points allowed (league scoring)

## Rebuild locally

```
python fetch_data.py && python compute.py
python -m http.server 8791 --directory docs
```

Pull before local work — the Action pushes bot commits daily.
