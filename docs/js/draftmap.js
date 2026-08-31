/* THE LAB — Draft Map: pick-by-pick availability under keeper conditions.
   Model: placed keepers are certainties at their real board slots; predicted
   keepers occupy their team's pick in the cost round. Every other pick is
   simulated with each MANAGER'S OWN HISTORY (intel.json, 2020-2025): the
   round he historically takes his first QB / TE / DEF, how many of each he
   actually drafts (2025 caps — the room has a 3-QB drafter), and soft
   roster-need weighting (a team whose keepers fill its RB starters leans WR
   early). MY picks run off MY board with a 1 QB / 1 TE cap, DEF at the end.
   Availability odds come from a MONTE CARLO of the room: 500 seeded
   randomized drafts without me; P(available at pick n) = the fraction of
   sims where the room hasn't taken him before pick n. The displayed board
   is the deterministic (most-likely) walk of the same model. */
(async function () {
  LAB.nav('Draft Map');
  const { players, leagues, intel, trades } = await LAB.loadData(['players', 'leagues', 'intel', 'trades']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  let tag = LAB.prefs.dmLeague || 'ggg';
  const tabs = LAB.$('#leagueTabs');
  for (const t of ['ggg', 'lob']) {
    tabs.append(LAB.el('button', {
      class: t === tag ? 'active' : '',
      onclick: e => {
        tag = t; LAB.prefs.dmLeague = t; LAB.savePrefs();
        LAB.$$('#leagueTabs button').forEach(b => b.classList.toggle('active', b === e.target));
        render();
      },
    }, leagues[t].name));
  }

  // ---------- what-if scenario ----------
  // Locks let you replay the draft under a decision: force a player to one of
  // YOUR picks, force a player to a pick BEFORE yours (what if the room takes
  // him?), or swap your keeper trio. Everything downstream -- the sim, the
  // odds, the projected roster -- rebuilds off these.
  const K_SCEN = 'thelab-dm-scenario-v1';
  let scenAll = (() => { try { return JSON.parse(localStorage.getItem(K_SCEN)) || {}; } catch (e) { return {}; } })();
  const scen = () => (scenAll[tag] = scenAll[tag] || { picks: {}, keepers: null });
  const saveScen = () => { try { localStorage.setItem(K_SCEN, JSON.stringify(scenAll)); } catch (e) {} };
  const scenN = () => Object.keys(scen().picks).length + (scen().keepers ? 1 : 0);
  const setLock = (pick, pid) => {
    scen().picks[pick] = pid; saveScen();
    document.querySelectorAll('.overlay').forEach(o => o.remove()); // close any picker
    render();
  };
  const clearLock = pick => { delete scen().picks[pick]; saveScen(); render(); };
  const clearScen = () => { scenAll[tag] = { picks: {}, keepers: null }; saveScen(); render(); };

  // ---------- Lab @Draft accessors (compute.py: dg/dgw/ds per league) ----------
  // In THIS draft ~28 keepers are off the board, so the top ~130 available
  // players slide up a mean of 27 picks. dScore/dGap are the score and the
  // window gap recomputed at each player's REAL expected slot; dSlot is that
  // slot. Everything on this page reads the draft-adjusted numbers.
  const dKey = k => (tag === 'ggg'
    ? { s: 'ds', v: 'dg', g: 'dgw' }[k]
    : { s: 'dls', v: 'dl', g: 'dlw' }[k]);
  const dSlot = p => ((p && p.lab) || {})[dKey('s')] ?? null;
  const dScore = p => ((p && p.lab) || {})[dKey('v')] ?? null;
  const dGap = p => ((p && p.lab) || {})[dKey('g')] ?? null;
  // madp = Sleeper ADP shaded toward the analyst consensus where news has
  // moved them and the market has not caught up yet.
  // Module scope: buildSim, the tooltips and the availability chart all use it.
  const mADP = p => ((p && p.madp) ?? (p && p.adp)) ?? null;
  const gapColor = g => g == null ? 'var(--ink-3)' : g >= 20 ? '#3ee68f' : g <= -20 ? '#ff5c5c' : 'var(--ink-2)';

  // ---------- math / rng ----------
  // seeded PRNG so the Monte Carlo gives the same numbers on every render
  const mulberry32 = seed => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pctColor = p => {
    const t = Math.max(0, Math.min(1, p));
    const c = t < 0.5
      ? [255, Math.round(92 + (197 - 92) * (t / 0.5)), 66]
      : [Math.round(255 - (255 - 62) * ((t - 0.5) / 0.5)), Math.round(197 + (230 - 197) * ((t - 0.5) / 0.5)), Math.round(66 + (143 - 66) * ((t - 0.5) / 0.5))];
    return `rgb(${c.join(',')})`;
  };
  const fmtPct = p => Math.round(p * 100) + '%';
  const MY_CAP = { QB: 1, TE: 1 }; // my own hard caps (keepers included)
  const SIMS = 500;                // Monte Carlo drafts of the room
  const DECAY = 0.65;              // preference decay down the eligible ADP list

  // ---------- keeper-conditioned, need-aware draft simulation ----------
  function buildSim(L) {
    const dd = L.draftDetail || {};
    if (!dd.draftOrder) return null;
    const ROUNDS = dd.rounds || 16, N = 10;
    let { keeps, keptSet } = LAB.predictKeepers(L, byId, oRanks);
    const myRid0 = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    // MY keeper trio can be overridden by the scenario
    if (scen().keepers && scen().keepers.length) {
      const mine = new Set((L.rosters.find(r => r.rid === myRid0) || {}).players || []);
      const kept0 = new Set(L.lastKept || []);
      keeps = keeps.filter(k => !mine.has(k.pid)).concat(scen().keepers.filter(pid => mine.has(pid)).map(pid => ({
        pid, costRd: LAB.keeperCostRound(L, L.lastDraftRound[pid] || null, kept0.has(pid)), official: false,
      })));
      keptSet = new Set(keeps.map(k => k.pid));
    }
    const officialPick = {};
    for (const k of (L.draftKeepers || [])) officialPick[k.pid] = k.pick;
    const slotOfRoster = {};
    Object.entries(dd.slotToRoster || {}).forEach(([slot, rid]) => (slotOfRoster[rid] = +slot));
    const rosterOfPid = {};
    L.rosters.forEach(r => (r.players || []).forEach(pid => (rosterOfPid[pid] = r.rid)));
    const myRid = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    const pickNum = (round, slot) => (round - 1) * N + (round % 2 === 1 ? slot : N + 1 - slot);
    const slotOfPick = pick => {
      const r = Math.ceil(pick / N), within = pick - (r - 1) * N;
      return r % 2 === 1 ? within : N + 1 - within;
    };

    // TRADED PICKS: a pick belongs to whoever OWNS it now, not the slot's
    // team — the owner's tendencies/needs decide the player, and the player
    // lands on the owner's team
    const ownerOfPick = {}; // pick number -> acquiring rid (only where traded)
    for (const t of ((trades[tag] || {}).tradedPicks || [])) {
      if (String(t.season) !== String(L.season)) continue;
      const slot = slotOfRoster[t.origRid];
      if (slot != null && t.ownerRid !== t.origRid) ownerOfPick[pickNum(t.round, slot)] = t.ownerRid;
    }
    const ridOfPick = pick => ownerOfPick[pick] ?? (dd.slotToRoster || {})[String(slotOfPick(pick))];

    // keepers onto the board — a predicted keeper can only occupy a pick his
    // team still OWNS (traded-away rounds spill past)
    const cells = {}; // pick -> {pid, official}
    for (const k of keeps) {
      let pick = officialPick[k.pid];
      if (pick == null) {
        const rid = rosterOfPid[k.pid];
        const slot = slotOfRoster[rid];
        if (slot == null) continue;
        const blocked = p => cells[p] || ridOfPick(p) !== rid;
        const start = Math.min(k.costRd, ROUNDS);
        // LEAGUE RULE: when two keepers want the same round, the collision
        // spills EARLIER — the extra keeper costs MORE, not less. (VERO's
        // Skattebo and Javonte both cost R9; Javonte lands on the R8.)
        let r = start;
        pick = pickNum(r, slot);
        while (blocked(pick) && r > 1) { r--; pick = pickNum(r, slot); }
        if (blocked(pick)) { // nothing earlier is free — fall back to later
          r = start;
          pick = pickNum(r, slot);
          while (blocked(pick) && r < ROUNDS) { r++; pick = pickNum(r, slot); }
        }
      }
      if (!cells[pick]) cells[pick] = { pid: k.pid, official: officialPick[k.pid] != null };
    }
    const openPicks = [], openIdx = {};
    for (let p = 1; p <= ROUNDS * N; p++) if (!cells[p]) { openIdx[p] = openPicks.length; openPicks.push(p); }

    // positional counts per roster from keepers only (walks copy this)
    const keeperCounts = {};
    L.rosters.forEach(r => (keeperCounts[r.rid] = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 }));
    for (const k of keeps) {
      const pos = byId[k.pid]?.pos, rid = rosterOfPid[k.pid];
      if (keeperCounts[rid] && pos in keeperCounts[rid]) keeperCounts[rid][pos]++;
    }

    // per-manager priors from league history (intel.json, 2020-2025): the
    // round he takes his first QB/TE/DEF, and caps from what he actually
    // drafted in 2025 (non-keeper picks)
    const intelByUid = {};
    for (const m of (intel[tag] || [])) if (m.current) intelByUid[m.uid] = m;
    const priors = {};
    L.rosters.forEach(rr => {
      const m = intelByUid[rr.owner];
      const picks25 = (m?.recent || []).filter(p => !p.keeper);
      const n = pos => picks25.filter(p => p.pos === pos).length;
      priors[rr.rid] = {
        qbRd: m?.firstQB ?? 7.5,
        teRd: m?.firstTE ?? 8,
        defRd: Math.min(ROUNDS, Math.round(m?.firstDEF ?? 15)),
        cap: {
          QB: Math.max(1, Math.min(3, n('QB'))),
          TE: Math.max(1, Math.min(2, n('TE'))),
          DEF: Math.max(1, Math.min(2, n('DEF'))),
        },
      };
    });

    // how attractive a player is to THIS manager at THIS pick, given what he
    // already holds — 0 means he won't take him here. History drives the
    // windows, but they're never absolute: managers deviate, and elite
    // fallers get stolen (no player should ever be a flat 100% safe).
    function posWeight(x, cnt, pr, r, pick) {
      const pos = x.pos;
      if (pos === 'DEF') {
        if (cnt.DEF >= pr.cap.DEF) return 0;
        if (cnt.DEF >= 1) return r >= 15 ? 0.4 : 0;  // a second DEF: dead-late only
        if (r < pr.defRd - 1) return 0;
        return r >= pr.defRd ? 5 : 0.7;
      }
      if (pos === 'QB' || pos === 'TE') {
        const first = pos === 'QB' ? pr.qbRd : pr.teRd;
        const fall = mADP(x) != null ? pick - mADP(x) : -99; // how far past ADP he's slid
        if (cnt[pos] >= pr.cap[pos]) {
          // even a set team steals a mega-faller (2 QBs is a real roster)
          return fall >= 30 && cnt[pos] < 2 ? 0.25 : 0;
        }
        if (cnt[pos] >= 1) return r >= 13 ? 0.3 : fall >= 30 ? 0.25 : 0; // backups: dead-late or mega-value
        if (r < first - 2) return fall >= 18 ? 0.5 : 0.05; // early strike is rare, not impossible
        if (r < first - 0.5) return Math.max(0.45, fall >= 18 ? 0.9 : 0);
        return 3;                                    // his historical window
      }
      // RB/WR: soft roster need — keepers that already fill the RB (or WR)
      // starters + flex share push him the other way in the early rounds
      if (r <= 8 && cnt[pos] >= 3) return 0.35;
      return 1;
    }
    // each roster's last OPEN pick (ownership-aware) — a DEF-less team must
    // grab one there even if keepers/trades ate its late picks
    const lastOpen = {};
    for (const pick of openPicks) lastOpen[ridOfPick(pick)] = pick;

    // draft order lists: everyone by ADP, me by MY board
    const sortAdp = p => mADP(p) ?? 500 - (p.proj || 0) / 1000;
    const adpOrder = players.filter(p => !keptSet.has(p.id)).sort((a, b) => sortAdp(a) - sortAdp(b));
    const myOrder = adpOrder.slice().sort((a, b) =>
      (oRanks[a.id] ?? 9000 + sortAdp(a)) - (oRanks[b.id] ?? 9000 + sortAdp(b)));

    // one full draft of the open picks. rand=null → deterministic most-likely
    // walk (argmax); rand=fn → Monte Carlo (roulette over weighted candidates).
    // includeMe=false ghosts my picks: that run measures when THE ROOM takes
    // each player, which is what availability-at-my-pick is judged against.
    function runDraft(includeMe, rand) {
      const cnts = {};
      L.rosters.forEach(r => (cnts[r.rid] = { ...keeperCounts[r.rid] }));
      const taken = new Set(), exp = {}, takenAt = {};
      const locks = scen().picks;
      for (const pick of openPicks) {
        const r = Math.ceil(pick / N);
        const rid = ridOfPick(pick);
        const cnt = cnts[rid] || { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
        let p = null;
        if (rid === myRid && !includeMe) continue; // ghost run: my slots stay empty
        const lock = locks[pick];
        if (lock && !taken.has(lock) && byId[lock]) {
          p = byId[lock];                          // scenario: this pick is decided
        } else if (rid === myRid) {
          const forceDef = cnt.DEF < 1 && (r === ROUNDS || pick === lastOpen[rid]);
          p = myOrder.find(x => !taken.has(x.id)
            && (forceDef ? x.pos === 'DEF' : x.pos !== 'DEF')
            && !(x.pos in MY_CAP && cnt[x.pos] >= MY_CAP[x.pos]));
        } else {
          const pr = priors[rid];
          const forceDef = cnt.DEF < 1 && pick === lastOpen[rid];
          const cands = [];
          for (const x of adpOrder) {
            if (taken.has(x.id)) continue;
            if (forceDef) { if (x.pos !== 'DEF') continue; cands.push({ x, w: 1 }); break; }
            const w = posWeight(x, cnt, pr, r, pick);
            if (w > 0) cands.push({ x, w: w * Math.pow(DECAY, cands.length) });
            if (cands.length >= 12) break;
          }
          // an overdue QB/TE/DEF pulls the best one up — even from below the
          // ADP window — so a manager past his historical round goes and gets
          // his guy (the classic positional reach)
          if (!forceDef) {
            const floor = 2.4 * DECAY * DECAY;
            for (const pos of ['QB', 'TE', 'DEF']) {
              const due = cnt[pos] < 1 && (pos === 'DEF' ? r >= pr.defRd : r >= (pos === 'QB' ? pr.qbRd : pr.teRd) - 0.5);
              if (!due) continue;
              const inList = cands.find(c => c.x.pos === pos);
              if (inList) inList.w = Math.max(inList.w, floor);
              else {
                const x = adpOrder.find(y => !taken.has(y.id) && y.pos === pos);
                if (x) cands.push({ x, w: floor });
              }
            }
          }
          if (cands.length) {
            if (!rand) {
              let best = cands[0];
              for (const c of cands) if (c.w > best.w) best = c;
              p = best.x;
            } else {
              let tot = 0;
              for (const c of cands) tot += c.w;
              let z = rand() * tot;
              for (const c of cands) { z -= c.w; if (z <= 0) { p = c.x; break; } }
              if (!p) p = cands[cands.length - 1].x;
            }
          }
        }
        if (!p) continue;
        exp[pick] = p.id;
        takenAt[p.id] = pick;
        taken.add(p.id);
        if (p.pos in cnt) cnt[p.pos]++;
      }
      return { exp, takenAt };
    }

    // Monte Carlo: SIMS randomized room-drafts (without me) → per-player
    // survival curves; seeded so numbers hold still between renders
    const TOTAL = ROUNDS * N;
    const cum = new Map(); // pid -> Int32Array; after prefix-sum, [n] = sims taken at pick <= n
    const tSum = {}, tCnt = {};
    for (let s = 0; s < SIMS; s++) {
      const { takenAt } = runDraft(false, mulberry32(0xC0FFEE + s * 7919));
      for (const pid in takenAt) {
        let a = cum.get(pid);
        if (!a) { a = new Int32Array(TOTAL + 2); cum.set(pid, a); }
        a[takenAt[pid]]++;
        tSum[pid] = (tSum[pid] || 0) + takenAt[pid];
        tCnt[pid] = (tCnt[pid] || 0) + 1;
      }
    }
    for (const a of cum.values()) for (let i = 1; i < a.length; i++) a[i] += a[i - 1];
    const roomPick = {}; // mean pick where the room takes him (absent = room ~never takes him)
    for (const pid in tCnt) if (tCnt[pid] >= SIMS * 0.05) roomPick[pid] = tSum[pid] / tCnt[pid];
    const probAvail = (pid, pick) => {
      if (keptSet.has(pid)) return 0;
      const a = cum.get(pid);
      return a ? 1 - a[pick - 1] / SIMS : 1;
    };
    const expected = runDraft(true, null).exp; // display board incl. my board-driven picks
    const mySlot = dd.draftOrder[L.myUserId];
    // every pick that is MINE: open picks I own (incl. acquired via trade,
    // excl. ones I traded away) + cells holding MY keepers
    const myPicks = [];
    for (let p = 1; p <= ROUNDS * N; p++) {
      const c = cells[p];
      if (c ? rosterOfPid[c.pid] === myRid : ridOfPick(p) === myRid) myPicks.push(p);
    }
    return { ROUNDS, N, cells, openPicks, adpOrder, roomPick, expected, probAvail, pickNum, slotOfPick, mySlot, myRid, myPicks, ownerOfPick, ridOfPick, dd, keptSet, priors };
  }

  function probChip(p, prob, hero, lockPick) {
    const col = pctColor(prob);
    return LAB.el('div', {
      class: 'flex', style: 'gap:7px;padding:3px 6px;border-radius:7px;margin-top:3px;cursor:pointer;font-size:12.5px;' +
        (hero ? 'background:rgba(255,106,43,.10);border:1px solid var(--accent)' : 'background:var(--surface);border:1px solid var(--border)'),
      onclick: () => LAB.playerCard(p.id),
      title: `${p.name} — ${fmtPct(prob)} chance he's still available`
        + `\nADP ${mADP(p) ?? '–'} (Sleeper, news-adjusted), ~pick ${dSlot(p) ?? '?'} in THIS draft (keepers removed)`
        + (p.asd != null ? `\nmarket spread ±${p.asd}${p.asd >= 15 ? ' — UNSETTLED' : p.asd >= 8 ? ' — some disagreement' : ''}` : '')
        + `\nLab @Draft ${dScore(p) ?? '–'}`
        + (dGap(p) != null ? ` · ${dGap(p) > 0 ? '+' : ''}${dGap(p)} vs the players available around him` : '')
        + `\nyour rank ${oRanks[p.id] ? '#' + oRanks[p.id] : '–'}`
        + (hero ? '\nprojected pick given your earlier picks' : ''),
    },
      LAB.headshot(p.id, 'sm'),
      LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
      LAB.posBadge(p.pos),
      dGap(p) != null ? LAB.el('b', {
        class: 'mono', style: 'font-size:10.5px;flex:none;color:' + gapColor(dGap(p)),
        title: 'Lab @Draft window gap — his score minus the median of who else is available here',
      }, (dGap(p) > 0 ? '+' : '') + dGap(p)) : '',
      LAB.el('b', { class: 'mono', style: 'color:' + col + ';width:38px;text-align:right' }, fmtPct(prob)),
      lockPick ? LAB.el('button', {
        style: 'flex:none;font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--border);background:var(--surface);cursor:pointer',
        title: 'Lock ' + p.name + ' to this pick and replay the rest of the draft',
        onclick: e => { e.stopPropagation(); setLock(lockPick, p.id); },
      }, '\u21b3 lock') : '');
  }

  // Lock ANY player still on the board to a pick. The zone list is capped at
  // the players your board says you'd actually consider, so a guy you rank
  // lower (Saquon at 1.06) never shows up there — this is how you reach him.
  function anyPlayerPicker(sim, pick, taken) {
    const pool = sim.adpOrder.filter(p => !taken.has(p.id) && !sim.keptSet.has(p.id));
    const input = LAB.el('input', {
      type: 'search', placeholder: 'Type a name…',
      style: 'width:100%;margin:6px 0 8px;padding:6px 9px',
    });
    const rows = LAB.el('div', { style: 'max-height:52vh;overflow:auto' });
    const draw = () => {
      rows.innerHTML = '';
      const q = (input.value || '').toLowerCase().trim();
      const hits = pool.filter(p => !q || p.name.toLowerCase().includes(q));
      if (!hits.length) rows.append(LAB.el('div', { class: 'muted', style: 'font-size:12px;padding:6px' }, 'nobody by that name is still on the board'));
      hits.slice(0, 60).forEach(p => rows.append(probChip(p, sim.probAvail(p.id, pick), false, pick)));
    };
    input.addEventListener('input', draw);
    draw();
    const r = Math.ceil(pick / sim.N);
    LAB.modal(LAB.el('div', {},
      LAB.el('h2', {}, `Lock anyone to ${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} (#${pick})`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0' },
        'Every player still on the board at this pick, your board rank ignored. '
        + 'The % is his real chance of being there — locking someone at 3% is a plan for a draft that will not happen.'),
      input, rows));
    setTimeout(() => input.focus(), 30);
  }

  function pickDetail(sim, pick) {
    const rows = sim.adpOrder
      .filter(p => sim.roomPick[p.id] != null && sim.roomPick[p.id] >= pick - 32 && sim.roomPick[p.id] <= pick + 28)
      .map(p => ({ p, prob: sim.probAvail(p.id, pick) }))
      .filter(x => x.prob >= 0.01 && x.prob <= 0.995)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 16);
    const r = Math.ceil(pick / sim.N);
    LAB.modal(LAB.el('div', {},
      LAB.el('h2', {}, `Pick ${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} (overall #${pick})`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px' },
        `Odds each player lasts to this pick, from ${SIMS} simulated drafts where every manager follows his own historical QB/TE/DEF timing, positional appetite, and roster needs. Locks (≈100%) are omitted.`),
      rows.map(x => probChip(x.p, x.prob, false, pick))));
  }

  // ---------- projected starting lineup ----------
  // The payoff of a what-if: fill the league's real starting slots with the
  // best of my keepers + projected picks and total the projections. Two
  // scenarios are only comparable through this number.
  const FLEX_OK = { RB: 1, WR: 1, TE: 1 };
  function lineupOf(L, pids) {
    const slots = (L.rosterPositions || []).filter(x => x !== 'BN');
    const pool = pids.map(id => byId[id]).filter(Boolean)
      .sort((a, b) => (b.proj || 0) - (a.proj || 0));
    const used = new Set(), rows = [];
    for (const slot of slots) {
      const hit = pool.find(p => !used.has(p.id)
        && (slot === 'FLEX' ? FLEX_OK[p.pos] : p.pos === slot));
      if (hit) used.add(hit.id);
      rows.push({ slot, p: hit || null });
    }
    const bench = pool.filter(p => !used.has(p.id));
    return { rows, bench, total: rows.reduce((t, x) => t + ((x.p && x.p.proj) || 0), 0) };
  }

  // ---------- positional cliff timer ----------
  // A "tier" here is a run of players at one position whose Lab @Draft
  // scores sit close together; the cliff is where the next man is a real
  // step down. Paired with the Monte Carlo it answers the only tier
  // question that matters on the clock: take one now, or can I wait?
  function cliffs(sim) {
    const out = [];
    for (const pos of ['RB', 'WR', 'TE', 'QB']) {
      const list = sim.adpOrder
        .filter(p => p.pos === pos && !sim.keptSet.has(p.id) && dScore(p) != null)
        .sort((a, b) => (dSlot(a) ?? 9e3) - (dSlot(b) ?? 9e3));
      if (list.length < 4) continue;
      // walk from the best still-available and cut where the score drops
      const top = list.slice(0, 24);
      let cut = -1;
      for (let i = 1; i < Math.min(top.length, 12); i++) {
        const cur = dScore(top[i]);
        const prevAvg = top.slice(0, i).reduce((a, p) => a + dScore(p), 0) / i;
        if (prevAvg - cur >= 8) { cut = i; break; }
      }
      if (cut < 1) continue;
      const tier = top.slice(0, cut);
      const nextMan = top[cut];
      // when is the tier expected to be gone? the LAST member's room pick
      const gone = tier.map(p => sim.roomPick[p.id]).filter(v => v != null);
      const goneBy = gone.length ? Math.round(Math.max.apply(null, gone)) : null;
      out.push({ pos, tier, nextMan, goneBy, drop: Math.round(
        tier.reduce((a, p) => a + dScore(p), 0) / tier.length - dScore(nextMan)) });
    }
    return out;
  }

  function cliffCard(sim) {
    const list = cliffs(sim);
    const myNext = sim.myPicks.filter(pk => !sim.cells[pk]).sort((a, b) => a - b);
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'Tier cliffs — take one now, or wait?'),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:2px 0 8px' },
        'Each position\u2019s current tier, when the room is projected to finish it off, and what the drop costs you. Scores are Lab @Draft \u2014 graded at each player\u2019s real slot in THIS keeper draft.'));
    if (!list.length) {
      card.append(LAB.el('p', { class: 'muted', style: 'font-size:12.5px' }, 'No clean cliffs right now \u2014 the boards are smooth at every position.'));
      return card;
    }
    for (const c of list) {
      const nextAfter = myNext.find(pk => c.goneBy != null && pk > c.goneBy);
      const beforeCliff = myNext.filter(pk => c.goneBy == null || pk <= c.goneBy);
      const urgent = c.goneBy != null && beforeCliff.length <= 1;
      card.append(LAB.el('div', {
        style: 'border:1px solid ' + (urgent ? 'var(--accent)' : 'var(--border)')
          + ';border-radius:9px;padding:6px 10px;margin-top:6px;background:'
          + (urgent ? 'rgba(255,106,43,.06)' : 'var(--surface)'),
      },
        LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' },
          LAB.posBadge(c.pos),
          LAB.el('b', { style: 'font-size:13px' }, `${c.tier.length} left in this tier`),
          c.goneBy != null ? LAB.el('span', { class: 'mono muted', style: 'font-size:11.5px' },
            `projected gone by pick #${c.goneBy}`) : '',
          LAB.el('span', { class: 'mono', style: 'font-size:11.5px;color:var(--warn)' },
            `next man is ${c.drop} pts worse`),
          urgent ? LAB.el('b', { style: 'font-size:11px;color:var(--accent)' }, 'LAST CHANCE') : ''),
        LAB.el('div', { class: 'flex', style: 'gap:5px;flex-wrap:wrap;margin-top:4px' },
          c.tier.map(p => LAB.el('span', {
            class: 'badge', style: 'font-size:10px;cursor:pointer',
            title: `Lab @Draft ${dScore(p)} \u00b7 ~pick ${dSlot(p)}`,
            onclick: () => LAB.playerCard(p.id),
          }, p.name)),
          LAB.el('span', { class: 'muted', style: 'font-size:10.5px' },
            `\u2192 then ${c.nextMan.name} (${dScore(c.nextMan)})`)),
        LAB.el('div', { class: 'muted', style: 'font-size:11px;margin-top:3px' },
          c.goneBy == null ? 'the room rarely takes these \u2014 you can wait'
            : beforeCliff.length === 0 ? 'the tier is gone before your next pick'
              : `you have ${beforeCliff.length} pick${beforeCliff.length === 1 ? '' : 's'} `
                + `(#${beforeCliff.join(', #')}) before it empties`
                + (nextAfter ? ` \u2014 wait past that and you're shopping the next tier at #${nextAfter}` : ''))));
    }
    return card;
  }

  function render() {
    root.innerHTML = '';
    const L = leagues[tag];
    const sim = buildSim(L);
    if (!sim) {
      root.append(LAB.el('div', { class: 'empty' },
        `${L.name} hasn't set its draft order yet — the snake map unlocks the moment Sleeper knows the slots. (Keeper-round projections on the Board and Keepers pages work already.)`));
      return;
    }
    // page layout: everything on the left, my projected team in its own
    // sidebar on the right so the snake board never has to scroll
    const main = LAB.el('div', { style: 'flex:1;min-width:0' });
    const aside = LAB.el('div', { class: 'side-rail', style: 'flex:none;width:230px' });
    root.append(LAB.el('div', { style: 'display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap' }, main, aside));

    // ---------- my picks planner ----------
    // keeper set under the CURRENT scenario (buildSim already applied it)
    const keeps = (() => {
      const base = LAB.predictKeepers(L, byId, oRanks).keeps;
      if (!scen().keepers || !scen().keepers.length) return base;
      const meIds = new Set((L.rosters.find(r => r.rid === sim.myRid) || {}).players || []);
      const kept0 = new Set(L.lastKept || []);
      return base.filter(k => !meIds.has(k.pid)).concat(scen().keepers.filter(p => meIds.has(p)).map(pid => ({
        pid, costRd: LAB.keeperCostRound(L, L.lastDraftRound[pid] || null, kept0.has(pid)), official: false,
      })));
    })();
    const planner = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, `Your picks — slot ${sim.mySlot} of ${sim.N}`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 6px' },
        'The ', LAB.el('b', { class: 'accent' }, 'orange card'), ' is your projected pick off YOUR board (one QB, one TE, filled positions drop out). Below it: alternatives with the odds they last, from ' + SIMS + ' simulated drafts of this room — every manager drafting like his six-year history says. ',
        LAB.el('b', { style: 'color:#3ee68f' }, 'green = safe'), ' → ', LAB.el('b', { style: 'color:#ff5c5c' }, 'red = long shot'), '.'));
    // ---- active scenario bar ----
    {
      const locks = Object.entries(scen().picks)
        .map(([pk, pid]) => ({ pk: +pk, p: byId[pid] })).filter(x => x.p)
        .sort((a, b) => a.pk - b.pk);
      const bar = LAB.el('div', {
        style: 'margin:2px 0 8px;padding:6px 8px;border-radius:8px;font-size:11.5px;'
          + (scenN() ? 'border:1px solid var(--accent);background:rgba(255,106,43,.06)'
                     : 'border:1px dashed var(--border)'),
      });
      if (!scenN()) {
        bar.append(LAB.el('span', { class: 'muted' },
          'WHAT-IF: hit ', LAB.el('b', {}, '\u21b3 lock'),
          ' on any player to force him to that pick and replay the draft. '
          + 'Click a round header for the full board at that pick \u2014 that is how you '
          + 'decide what the room does before you.'));
      } else {
        bar.append(LAB.el('b', { class: 'accent' }, 'SCENARIO: '));
        if (scen().keepers) {
          bar.append(LAB.el('span', {
            style: 'display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;border-radius:99px;background:var(--surface);border:1px solid var(--border)',
          }, 'keepers: ' + scen().keepers.map(x => (byId[x] || {}).name || x).join(', '),
            LAB.el('button', {
              style: 'margin-left:5px;border:0;background:none;cursor:pointer;color:var(--bad)',
              title: 'back to your declared/predicted keepers',
              onclick: () => { scen().keepers = null; saveScen(); render(); },
            }, '\u00d7')));
        }
        locks.forEach(x => bar.append(LAB.el('span', {
          style: 'display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;border-radius:99px;background:var(--surface);border:1px solid var(--border)',
        }, `#${x.pk} ${x.p.name}`,
          LAB.el('button', {
            style: 'margin-left:5px;border:0;background:none;cursor:pointer;color:var(--bad)',
            onclick: () => clearLock(x.pk),
          }, '\u00d7'))));
        bar.append(LAB.el('button', {
          style: 'margin-left:6px;font-size:10.5px;padding:1px 7px;border-radius:6px;border:1px solid var(--border);background:var(--surface);cursor:pointer',
          onclick: clearScen,
        }, 'clear all'));
      }
      planner.append(bar);
    }

    // ---- keeper swapper: my trio is a decision too ----
    {
      const meR = L.rosters.find(r => r.rid === sim.myRid) || { players: [] };
      const kept0 = new Set(L.lastKept || []);
      const elig = (meR.players || []).map(id => byId[id])
        .filter(p => p && p.pos !== 'DEF' && L.lastDraftRound[p.id])
        .map(p => ({ p, rd: LAB.keeperCostRound(L, L.lastDraftRound[p.id], kept0.has(p.id)) }))
        .sort((a, b) => (a.p.madp ?? a.p.adp ?? 999) - (b.p.madp ?? b.p.adp ?? 999))
        .slice(0, 10);
      const cur = new Set(scen().keepers
        || keeps.filter(k => (meR.players || []).includes(k.pid)).map(k => k.pid));
      const max = L.keeperMax || 3;
      const row = LAB.el('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin:0 0 8px' });
      elig.forEach(({ p, rd }) => {
        const on = cur.has(p.id);
        row.append(LAB.el('button', {
          style: 'font-size:11px;padding:2px 8px;border-radius:99px;cursor:pointer;border:1px solid '
            + (on ? 'var(--accent);background:rgba(255,106,43,.12);color:var(--accent)'
                  : 'var(--border);background:var(--surface)'),
          title: `${p.name} keeps at R${rd}` + (on ? ' — click to drop him from the scenario' : ' — click to keep him instead'),
          onclick: () => {
            const nxt = new Set(cur);
            if (nxt.has(p.id)) nxt.delete(p.id);
            else { if (nxt.size >= max) return LAB.toast(`Only ${max} keepers — drop one first`); nxt.add(p.id); }
            scen().keepers = [...nxt];
            saveScen(); render();
          },
        }, `${p.name} R${rd}`));
      });
      if (elig.length) {
        planner.append(LAB.el('div', { class: 'muted', style: 'font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:3px' },
          `your keepers \u2014 pick ${max} (${cur.size}/${max} set)`));
        planner.append(row);
      }
    }

    const cols = LAB.el('div', { style: 'display:flex;gap:10px;overflow-x:auto;padding-bottom:6px' });
    const myFilled = { QB: 0, TE: 0, DEF: 0 }; // my keepers count toward my caps
    const heroTaken = new Set(); // my projected picks so far, excluded from later lists
    const myOpenSet = new Set(sim.myPicks.filter(p => !sim.cells[p])); // my open picks (don't count against dominance)
    const ridName = {};
    L.rosters.forEach(rr => (ridName[rr.rid] = L.users[rr.owner]?.name || 'Team ' + rr.rid));
    for (const k of keeps) {
      const p = byId[k.pid];
      if (p && (L.rosters.find(r => r.rid === sim.myRid)?.players || []).includes(k.pid) && p.pos in myFilled) myFilled[p.pos]++;
    }
    for (const pick of sim.myPicks) {
      const r = Math.ceil(pick / sim.N);
      const cell = sim.cells[pick];
      const acquired = sim.slotOfPick(pick) !== sim.mySlot;
      const col = LAB.el('div', { style: 'flex:none;width:216px' });
      col.append(LAB.el('div', {
        class: 'tier-head', style: 'cursor:' + (cell ? 'default' : 'pointer'),
        title: (cell ? 'this pick is consumed by your keeper' : 'click for the full odds list')
          + (acquired ? ` — acquired via trade (originally ${ridName[(sim.dd.slotToRoster || {})[String(sim.slotOfPick(pick))]] || '?'}'s slot)` : ''),
        onclick: cell ? null : () => pickDetail(sim, pick),
      }, `R${r}` + (acquired ? ' ⇄' : ''), LAB.el('span', { class: 'count' }, '#' + pick)));
      if (cell) {
        const kp = byId[cell.pid];
        col.append(LAB.el('div', { class: 'flex', style: 'gap:7px;padding:6px;border:1px dashed var(--warn);border-radius:7px;margin-top:4px;font-size:12.5px' },
          LAB.headshot(cell.pid, 'sm'),
          LAB.el('b', {}, kp ? kp.name : cell.pid),
          LAB.el('span', { class: 'badge keeper' }, cell.official ? 'KEPT' : 'PROJ KEEP')));
      } else {
        const heroPid = sim.expected[pick];
        const heroPos = byId[heroPid]?.pos;
        const isMyDefPick = heroPos === 'DEF';
        // DOMINANCE: only (other teams' open picks before mine) players can
        // leave the pool before I'm on the clock, so someone in my top-D
        // legal candidates is GUARANTEED to be there — I will never be
        // picking below that line. In R1 that's a hard 4-5 player set.
        const othersBefore = sim.openPicks.filter(pk => pk < pick && !myOpenSet.has(pk)).length;
        const D = othersBefore + 1;
        // every legal candidate at this pick, in MY board order (hero included)
        const legalAll = sim.adpOrder
          .filter(p => !heroTaken.has(p.id)
            && !(p.pos === 'QB' && myFilled.QB >= 1)
            && !(p.pos === 'TE' && myFilled.TE >= 1)
            && (p.pos === 'DEF') === isMyDefPick) // DEFs only on my DEF pick
          .sort((a, b) => (oRanks[a.id] ?? 9e3) - (oRanks[b.id] ?? 9e3));
        const topD = legalAll.slice(0, D).map(p => ({ p, prob: sim.probAvail(p.id, pick) }));
        let zone, depth;
        if (D <= 8) {
          // the guaranteed set IS the choice set — show it whole
          zone = topD.filter(x => x.prob >= 0.03 || x.p.id === heroPid).slice(0, 7);
          depth = [];
        } else {
          // deeper rounds: within the top-D, everyone above your best SAFE
          // option (>=85% to be there) with a real shot (>=15%)
          const legalList = topD
            .filter(x => x.p.id === heroPid
              || (sim.roomPick[x.p.id] == null ? (oRanks[x.p.id] ?? 9e3) < 300 : sim.roomPick[x.p.id] <= pick + 24))
            .filter(x => x.prob >= 0.08 || x.p.id === heroPid);
          const anchorIdx = legalList.findIndex(x => x.prob >= 0.85);
          const cut = anchorIdx < 0 ? legalList.length : anchorIdx + 1;
          zone = legalList.slice(0, cut).filter(x => x.prob >= 0.15 || x.p.id === heroPid).slice(0, 7);
          const zoneIds = new Set(zone.map(x => x.p.id));
          depth = legalList.filter(x => !zoneIds.has(x.p.id) && x.prob >= 0.5).slice(0, Math.max(0, 8 - zone.length));
        }
        const zoneBox = LAB.el('div', {
          style: 'border:1.5px solid var(--accent);border-radius:9px;padding:3px 5px 5px;margin-top:4px',
          title: D <= 8
            ? `only ${othersBefore} pick${othersBefore === 1 ? '' : 's'} happen before this one — your pick is guaranteed to come from these ${zone.length} players`
            : 'the players this pick will realistically come down to',
        }, LAB.el('div', { style: 'font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)' }, '⌖ likely picking from'));
        // the SET is fixed by the dominance guarantee (my board order), but
        // the ORDER shown is by Lab @Draft window gap — of the players who
        // will actually be here, who most out-values this slot
        zone.slice().sort((a, b) => (dGap(b.p) ?? -99) - (dGap(a.p) ?? -99))
          .forEach(x => zoneBox.append(probChip(x.p, x.prob, x.p.id === heroPid, pick)));
        col.append(zoneBox);
        col.append(LAB.el('button', {
          style: 'width:100%;margin-top:4px;font-size:10.5px;padding:3px 0;border-radius:6px;border:1px dashed var(--border);background:var(--surface);cursor:pointer',
          title: 'Lock any player on the board to this pick — including someone your board ranks below this zone',
          onclick: () => anyPlayerPicker(sim, pick, new Set(heroTaken)),
        }, '⌕ lock anyone to this pick'));
        // --- two-pick lookahead: the best PAIR across this pick and my next
        const nextPick = sim.myPicks.filter(pk => pk > pick && !sim.cells[pk])[0];
        if (nextPick && zone.length) {
          const later = sim.adpOrder
            .filter(p => !heroTaken.has(p.id) && dGap(p) != null && p.pos !== 'DEF'
              && !(p.pos === 'QB' && myFilled.QB >= 1) && !(p.pos === 'TE' && myFilled.TE >= 1))
            .map(p => ({ p, prob: sim.probAvail(p.id, nextPick) }))
            // likely to last but NOT a lock: a player who is ~always there is
            // not a pairing decision, he's just a later pick
            .filter(x => x.prob >= 0.55 && x.prob <= 0.95)
            .sort((a, b) => (dGap(b.p) ?? -99) - (dGap(a.p) ?? -99));
          let best = null;
          for (const a of zone) {
            for (const b of later.slice(0, 12)) {
              if (b.p.id === a.p.id) continue;
              if (a.p.pos === b.p.pos && (a.p.pos === 'QB' || a.p.pos === 'TE')) continue;
              const v = (dGap(a.p) ?? 0) + (dGap(b.p) ?? 0) * b.prob;
              if (!best || v > best.v) best = { v, a, b };
            }
          }
          if (best) {
            col.append(LAB.el('div', {
              style: 'margin-top:5px;padding:4px 7px;border-left:2px solid var(--accent);background:rgba(255,106,43,.05);border-radius:0 6px 6px 0;font-size:10.5px;line-height:1.35',
              title: 'the best COMBINATION across this pick and your next one — taking the higher-gap player now only wins if the other survives the wait',
            },
              LAB.el('b', { style: 'color:var(--accent)' }, '⇢ best pair: '),
              `${best.a.p.name} now, then ${best.b.p.name} at #${nextPick} `,
              LAB.el('span', { class: 'mono muted' }, `(${fmtPct(best.b.prob)} he lasts)`)));
          }
        }
        // --- what the room needs before I'm on the clock again
        if (nextPick) {
          const between = sim.openPicks.filter(pk => pk > pick && pk < nextPick && !myOpenSet.has(pk));
          const needCount = {};
          between.forEach(pk => {
            const q = byId[sim.expected[pk]];
            if (q && q.pos) needCount[q.pos] = (needCount[q.pos] || 0) + 1;
          });
          const parts = Object.entries(needCount).sort((a, b) => b[1] - a[1])
            .map(([ps, n]) => `${n} ${ps}`);
          if (parts.length) {
            col.append(LAB.el('div', {
              class: 'muted', style: 'font-size:10px;margin-top:4px',
              title: 'positions the room is projected to take between this pick and your next — the scarcity clock',
            }, `room takes before you again: ${parts.join(' · ')}`));
          }
        }
        if (depth.length) {
          col.append(LAB.el('div', { class: 'muted', style: 'font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:5px' }, 'depth if it breaks weird'));
          depth.forEach(x => col.append(probChip(x.p, x.prob, false, pick)));
        }
        if (heroPos && heroPos in myFilled) myFilled[heroPos]++;
        if (heroPid) heroTaken.add(heroPid);
      }
      cols.append(col);
    }
    planner.append(cols);
    main.append(planner);
    main.append(cliffCard(sim));

    // ---------- full snake board + my projected team ----------
    const boardCard = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'Projected snake board'),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' },
        'Solid amber = keeper locked on the real board · dashed = predicted keeper · everything else = each manager\'s most-likely pick given ADP, his historical QB/TE/DEF timing (hover a name up top), how many he really drafts, and what his keepers already cover. Your column runs off your board; your resulting team is on the right. Click any open cell for odds.'));
    // columns compress to fit — the board never scrolls horizontally
    const wrap = LAB.el('div', { class: 'snake-wrap', style: 'min-width:0' });
    const grid = LAB.el('div', { class: 'snake-grid', style: `display:grid;grid-template-columns:28px repeat(${sim.N},minmax(0,1fr));gap:3px` });
    grid.append(LAB.el('div', {}));
    const nameOfSlot = {};
    Object.entries(sim.dd.draftOrder).forEach(([uid, slot]) => (nameOfSlot[slot] = L.users[uid]?.name || 'slot ' + slot));
    for (let s = 1; s <= sim.N; s++) {
      const rid = (sim.dd.slotToRoster || {})[String(s)];
      const pr = sim.priors[rid];
      grid.append(LAB.el('div', {
        style: 'font-family:var(--font-display);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:3px 2px;text-align:center;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (s === sim.mySlot ? 'var(--accent)' : 'var(--ink-3)'),
        title: nameOfSlot[s] + (pr ? ` — history: 1st QB ~R${Math.round(pr.qbRd)} · 1st TE ~R${Math.round(pr.teRd)} · DEF ~R${pr.defRd}` + (pr.cap.QB > 1 ? ` · drafts ${pr.cap.QB} QBs` : '') + (pr.cap.TE > 1 ? ` · ${pr.cap.TE} TEs` : '') + (pr.cap.DEF > 1 ? ` · ${pr.cap.DEF} DEFs` : '') : ''),
      }, s === sim.mySlot ? 'YOU' : nameOfSlot[s]));
    }
    // cliff overlay: the pick where each position's current tier is projected
    // to run out — a colored underline on that cell, so the scarcity is
    // visible spatially instead of only in the card above
    const cliffAt = {};
    for (const c of cliffs(sim)) {
      if (c.goneBy != null) {
        cliffAt[Math.round(c.goneBy)] = cliffAt[Math.round(c.goneBy)] || [];
        cliffAt[Math.round(c.goneBy)].push(c);
      }
    }
    for (let r = 1; r <= sim.ROUNDS; r++) {
      grid.append(LAB.el('div', { class: 'mono muted', style: 'font-size:11px;display:flex;align-items:center;justify-content:center' }, 'R' + r));
      for (let s = 1; s <= sim.N; s++) {
        const pick = sim.pickNum(r, s);
        const cell = sim.cells[pick];
        const pid = cell ? cell.pid : sim.expected[pick];
        const p = byId[pid];
        const owner = !cell && sim.ownerOfPick[pick] != null ? sim.ownerOfPick[pick] : null;
        const mineCell = owner != null ? owner === sim.myRid : s === sim.mySlot;
        const base = 'padding:4px 6px;border-radius:6px;font-size:11.5px;min-height:34px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;';
        const cl = cliffAt[pick];
        const clCss = cl ? `box-shadow:inset 0 -3px 0 var(--${cl[0].pos.toLowerCase()});` : '';
        const style = (cell
          ? base + (cell.official ? 'background:rgba(245,197,66,.13);border:1px solid var(--warn);' : 'background:rgba(245,197,66,.06);border:1px dashed var(--warn);')
          : base + `background:var(--surface);border:1px solid ${mineCell ? 'var(--accent)' : 'var(--border)'};cursor:pointer;`) + clCss;
        grid.append(LAB.el('div', {
          style,
          title: (p ? `${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} — ${p.name}` + (cell ? (cell.official ? ' (keeper, locked)' : ' (predicted keeper)') : ' (most likely; click for odds)')
            + (owner != null ? ` — PICK TRADED: ${ridName[owner]} drafts here` : '') : '')
            + (cl ? cl.map(c => `\nTIER CLIFF: the ${c.pos} tier is projected to empty here — next man is ${c.drop} pts worse`).join('') : ''),
          onclick: cell ? () => LAB.playerCard(pid) : () => pickDetail(sim, pick),
        },
          LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--' + ({ QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', DEF: 'def' }[p?.pos] || 'ink') + ')' }, p ? p.name : '—'),
          LAB.el('span', { class: 'mono', style: 'font-size:9.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, `${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')}` + (cell ? (cell.official ? ' · KEPT' : ' · proj') : '') + (owner != null ? ` ⇄ ${ridName[owner]}` : ''))));
      }
    }
    wrap.append(grid);
    boardCard.append(wrap);
    main.append(boardCard);

    // ---------- my projected team, grouped by position (right sidebar) ----------
    const teamCard = LAB.el('div', { class: 'card', style: 'margin-top:14px;position:sticky;top:10px' },
      LAB.el('h2', {}, 'Your projected team'));
    // ---- the number that makes two what-ifs comparable ----
    {
      const mine = sim.myPicks.map(pk => sim.cells[pk] ? sim.cells[pk].pid : sim.expected[pk]).filter(Boolean);
      const lu = lineupOf(L, mine);
      teamCard.append(LAB.el('div', {
        style: 'margin:2px 0 8px;padding:7px 9px;border-radius:8px;border:1px solid var(--accent);background:rgba(255,106,43,.07)',
        title: 'Best starting lineup from your keepers + projected picks, totalled on 2026 projections.\n'
          + 'This is the number to watch when you change a lock or a keeper — everything else on the page is process, this is outcome.',
      },
        LAB.el('div', { class: 'muted', style: 'font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase' }, 'projected starters'),
        LAB.el('div', { style: 'font-size:23px;font-weight:800;font-family:var(--font-display);line-height:1.1' },
          LAB.fmt0(lu.total), LAB.el('span', { class: 'muted', style: 'font-size:11px;font-weight:400;margin-left:5px' }, 'pts')),
        LAB.el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:2px' },
          lu.rows.filter(x => !x.p).length
            ? lu.rows.filter(x => !x.p).length + ' starting slot(s) unfilled'
            : 'all ' + lu.rows.length + ' starting slots filled'),
        scenN() ? LAB.el('div', { style: 'font-size:10.5px;margin-top:3px;color:var(--accent)' }, '↳ under your scenario') : ''));
      const det = LAB.el('div', { style: 'margin-bottom:8px' });
      lu.rows.forEach(x => det.append(LAB.el('div', {
        class: 'flex', style: 'gap:6px;font-size:11px;padding:1px 4px',
        title: x.p ? `${x.slot}: ${x.p.name} — ${LAB.fmt0(x.p.proj)} projected` : `${x.slot}: nobody projected`,
      },
        LAB.el('span', { class: 'mono muted', style: 'width:34px;flex:none' }, x.slot),
        LAB.el('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, x.p ? x.p.name : '—'),
        LAB.el('span', { class: 'mono muted', style: 'flex:none' }, x.p ? LAB.fmt0(x.p.proj) : '–'))));
      teamCard.append(det);
    }
    const byPos = { QB: [], RB: [], WR: [], TE: [], DEF: [] };
    for (const pick of sim.myPicks) {
      const r = Math.ceil(pick / sim.N);
      const cell = sim.cells[pick];
      const pid = cell ? cell.pid : sim.expected[pick];
      const p = byId[pid];
      if (p && p.pos in byPos) byPos[p.pos].push({ r, pick, p, cell });
    }
    for (const [pos, list] of Object.entries(byPos)) {
      if (!list.length) continue;
      const pr = LAB.posRanks(board, pos); // order by MY positional rank, not draft round
      list.sort((a, b) => (pr[a.p.id] ?? 999) - (pr[b.p.id] ?? 999) || a.r - b.r);
      teamCard.append(LAB.el('div', {
        class: 'flex', style: `margin:8px 0 2px;font-family:var(--font-display);font-weight:700;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--${pos.toLowerCase()})`,
      }, pos, LAB.el('span', { class: 'muted', style: 'font-family:var(--font-body);font-weight:400;text-transform:none;font-size:11px' }, `× ${list.length}`)));
      for (const { r, pick, p, cell } of list) {
        teamCard.append(LAB.el('div', {
          class: 'flex', style: 'gap:6px;padding:3px 6px;border-radius:7px;margin-top:3px;font-size:12px;' +
            (cell ? 'background:rgba(245,197,66,.10);border:1px solid var(--warn)' : 'background:var(--surface);border:1px solid var(--border)'),
          title: `R${r} (#${pick}) — ${p.name}` + (cell ? (cell.official ? ' · your keeper' : ' · predicted keeper') : ' · projected pick'),
          onclick: () => LAB.playerCard(p.id),
        },
          LAB.el('span', { class: 'mono muted', style: 'width:24px;flex:none' }, 'R' + r),
          LAB.headshot(p.id, 'sm'),
          LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
          pr[p.id] ? LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px;flex:none', title: 'your positional rank' }, pos + pr[p.id]) : '',
          cell ? LAB.el('span', { class: 'badge keeper', style: 'font-size:9px' }, 'K') : ''));
      }
    }
    aside.append(teamCard);
  }

  render();
})();
