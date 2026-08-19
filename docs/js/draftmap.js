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
  const { players, leagues, intel } = await LAB.loadData(['players', 'leagues', 'intel']);
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
    const { keeps, keptSet } = LAB.predictKeepers(L, byId, oRanks);
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

    // keepers onto the board
    const cells = {}; // pick -> {pid, official}
    for (const k of keeps) {
      let pick = officialPick[k.pid];
      if (pick == null) {
        const slot = slotOfRoster[rosterOfPid[k.pid]];
        if (slot == null) continue;
        let r = Math.min(k.costRd, ROUNDS);
        pick = pickNum(r, slot);
        while (cells[pick] && r < ROUNDS) { r++; pick = pickNum(r, slot); }
        if (cells[pick]) { // no later round free — collision spills EARLIER
          r = Math.min(k.costRd, ROUNDS) - 1;
          pick = pickNum(r, slot);
          while (cells[pick] && r > 1) { r--; pick = pickNum(r, slot); }
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

    // how attractive a position is to THIS manager at THIS round, given what
    // he already holds — 0 means he won't take it here
    function posWeight(pos, cnt, pr, r) {
      if (pos === 'DEF') {
        if (cnt.DEF >= pr.cap.DEF) return 0;
        if (cnt.DEF >= 1) return r >= 15 ? 0.4 : 0;  // a second DEF: dead-late only
        if (r < pr.defRd - 1) return 0;
        return r >= pr.defRd ? 5 : 0.7;
      }
      if (pos === 'QB' || pos === 'TE') {
        const first = pos === 'QB' ? pr.qbRd : pr.teRd;
        if (cnt[pos] >= pr.cap[pos]) return 0;
        if (cnt[pos] >= 1) return r >= 13 ? 0.3 : 0; // backups: dead-late only
        if (r < first - 2) return 0;                 // won't reach that early
        if (r < first - 0.5) return 0.45;            // window approaching
        return 3;                                    // his historical window
      }
      // RB/WR: soft roster need — keepers that already fill the RB (or WR)
      // starters + flex share push him the other way in the early rounds
      if (r <= 8 && cnt[pos] >= 3) return 0.35;
      return 1;
    }
    // each roster's last OPEN pick — a DEF-less team must grab one there even
    // if keepers ate its R15/R16 picks
    const lastOpen = {};
    for (const pick of openPicks) lastOpen[(dd.slotToRoster || {})[String(slotOfPick(pick))]] = pick;

    // draft order lists: everyone by ADP, me by MY board
    const sortAdp = p => p.adp ?? 500 - (p.proj || 0) / 1000;
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
      for (const pick of openPicks) {
        const r = Math.ceil(pick / N);
        const rid = (dd.slotToRoster || {})[String(slotOfPick(pick))];
        const cnt = cnts[rid] || { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
        let p = null;
        if (rid === myRid) {
          if (!includeMe) continue; // ghost run: my slots stay empty
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
            const w = posWeight(x.pos, cnt, pr, r);
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
    return { ROUNDS, N, cells, openPicks, adpOrder, roomPick, expected, probAvail, pickNum, mySlot, myRid, dd, keptSet, priors };
  }

  function probChip(p, prob, hero) {
    const col = pctColor(prob);
    return LAB.el('div', {
      class: 'flex', style: 'gap:7px;padding:3px 6px;border-radius:7px;margin-top:3px;cursor:pointer;font-size:12.5px;' +
        (hero ? 'background:rgba(255,106,43,.10);border:1px solid var(--accent)' : 'background:var(--surface);border:1px solid var(--border)'),
      onclick: () => LAB.playerCard(p.id),
      title: `${p.name} — ${fmtPct(prob)} chance he's still available · ADP ${p.adp ?? '–'} · your rank ${oRanks[p.id] ? '#' + oRanks[p.id] : '–'}` + (hero ? ' · projected pick given your earlier picks' : ''),
    },
      LAB.headshot(p.id, 'sm'),
      LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
      LAB.posBadge(p.pos),
      oRanks[p.id] ? LAB.el('span', { class: 'mono muted', style: 'font-size:11px' }, '#' + oRanks[p.id]) : '',
      LAB.el('b', { class: 'mono', style: 'color:' + col + ';width:38px;text-align:right' }, fmtPct(prob)));
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
      rows.map(x => probChip(x.p, x.prob))));
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
    const aside = LAB.el('div', { style: 'flex:none;width:230px' });
    root.append(LAB.el('div', { style: 'display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap' }, main, aside));

    // ---------- my picks planner ----------
    const planner = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, `Your picks — slot ${sim.mySlot} of ${sim.N}`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 6px' },
        'The ', LAB.el('b', { class: 'accent' }, 'orange card'), ' is your projected pick off YOUR board (one QB, one TE, filled positions drop out). Below it: alternatives with the odds they last, from ' + SIMS + ' simulated drafts of this room — every manager drafting like his six-year history says. ',
        LAB.el('b', { style: 'color:#3ee68f' }, 'green = safe'), ' → ', LAB.el('b', { style: 'color:#ff5c5c' }, 'red = long shot'), '.'));
    const cols = LAB.el('div', { style: 'display:flex;gap:10px;overflow-x:auto;padding-bottom:6px' });
    const myFilled = { QB: 0, TE: 0, DEF: 0 }; // my keepers count toward my caps
    const heroTaken = new Set(); // my projected picks so far, excluded from later lists
    const myOpenSet = new Set(); // my own open picks (don't count against dominance)
    for (let r = 1; r <= sim.ROUNDS; r++) {
      const p = sim.pickNum(r, sim.mySlot);
      if (!sim.cells[p]) myOpenSet.add(p);
    }
    const { keeps } = LAB.predictKeepers(L, byId, oRanks);
    for (const k of keeps) {
      const p = byId[k.pid];
      if (p && (L.rosters.find(r => r.rid === sim.myRid)?.players || []).includes(k.pid) && p.pos in myFilled) myFilled[p.pos]++;
    }
    for (let r = 1; r <= sim.ROUNDS; r++) {
      const pick = sim.pickNum(r, sim.mySlot);
      const cell = sim.cells[pick];
      const col = LAB.el('div', { style: 'flex:none;width:216px' });
      col.append(LAB.el('div', {
        class: 'tier-head', style: 'cursor:' + (cell ? 'default' : 'pointer'),
        title: cell ? 'this pick is consumed by your keeper' : 'click for the full odds list',
        onclick: cell ? null : () => pickDetail(sim, pick),
      }, `R${r}`, LAB.el('span', { class: 'count' }, '#' + pick)));
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
        zone.forEach(x => zoneBox.append(probChip(x.p, x.prob, x.p.id === heroPid)));
        col.append(zoneBox);
        if (depth.length) {
          col.append(LAB.el('div', { class: 'muted', style: 'font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:5px' }, 'depth if it breaks weird'));
          depth.forEach(x => col.append(probChip(x.p, x.prob)));
        }
        if (heroPos && heroPos in myFilled) myFilled[heroPos]++;
        if (heroPid) heroTaken.add(heroPid);
      }
      cols.append(col);
    }
    planner.append(cols);
    main.append(planner);

    // ---------- full snake board + my projected team ----------
    const boardCard = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'Projected snake board'),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' },
        'Solid amber = keeper locked on the real board · dashed = predicted keeper · everything else = each manager\'s most-likely pick given ADP, his historical QB/TE/DEF timing (hover a name up top), how many he really drafts, and what his keepers already cover. Your column runs off your board; your resulting team is on the right. Click any open cell for odds.'));
    // columns compress to fit — the board never scrolls horizontally
    const wrap = LAB.el('div', { style: 'min-width:0' });
    const grid = LAB.el('div', { style: `display:grid;grid-template-columns:28px repeat(${sim.N},minmax(0,1fr));gap:3px` });
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
    for (let r = 1; r <= sim.ROUNDS; r++) {
      grid.append(LAB.el('div', { class: 'mono muted', style: 'font-size:11px;display:flex;align-items:center;justify-content:center' }, 'R' + r));
      for (let s = 1; s <= sim.N; s++) {
        const pick = sim.pickNum(r, s);
        const cell = sim.cells[pick];
        const pid = cell ? cell.pid : sim.expected[pick];
        const p = byId[pid];
        const mineCol = s === sim.mySlot;
        const base = 'padding:4px 6px;border-radius:6px;font-size:11.5px;min-height:34px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;';
        const style = cell
          ? base + (cell.official ? 'background:rgba(245,197,66,.13);border:1px solid var(--warn);' : 'background:rgba(245,197,66,.06);border:1px dashed var(--warn);')
          : base + `background:var(--surface);border:1px solid ${mineCol ? 'var(--accent)' : 'var(--border)'};cursor:pointer;`;
        grid.append(LAB.el('div', {
          style,
          title: p ? `${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} — ${p.name}` + (cell ? (cell.official ? ' (keeper, locked)' : ' (predicted keeper)') : ' (most likely; click for odds)') : '',
          onclick: cell ? () => LAB.playerCard(pid) : () => pickDetail(sim, pick),
        },
          LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--' + ({ QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', DEF: 'def' }[p?.pos] || 'ink') + ')' }, p ? p.name : '—'),
          LAB.el('span', { class: 'mono', style: 'font-size:9.5px;color:var(--ink-3)' }, `${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')}` + (cell ? (cell.official ? ' · KEPT' : ' · proj') : ''))));
      }
    }
    wrap.append(grid);
    boardCard.append(wrap);
    main.append(boardCard);

    // ---------- my projected team, grouped by position (right sidebar) ----------
    const teamCard = LAB.el('div', { class: 'card', style: 'margin-top:14px;position:sticky;top:10px' },
      LAB.el('h2', {}, 'Your projected team'));
    const byPos = { QB: [], RB: [], WR: [], TE: [], DEF: [] };
    for (let r = 1; r <= sim.ROUNDS; r++) {
      const pick = sim.pickNum(r, sim.mySlot);
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
