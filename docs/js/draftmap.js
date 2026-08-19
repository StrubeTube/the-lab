/* THE LAB — Draft Map: pick-by-pick availability under keeper conditions.
   Model: placed keepers are certainties at their real board slots; predicted
   keepers occupy their team's pick in the cost round; every other pick is
   simulated with positional need — teams draft best available by Sleeper ADP
   but stop at ONE QB and ONE TE (keepers count), and defenses only go in
   R15/R16 (forced early if a team's R16 pick is keeper-consumed). MY picks
   are drafted off MY board instead of ADP, with the same 1 QB / 1 TE cap.
   A player's landing spot is a bell curve around his simulated slot with
   spread growing by depth (sigma = 2 + 0.13 x sim-rank), giving
   P(available) at every pick. */
(async function () {
  LAB.nav('Draft Map');
  const { players, leagues } = await LAB.loadData(['players', 'leagues']);
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

  // ---------- math ----------
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  const sigma = i => 2 + 0.13 * i;
  const pctColor = p => {
    const t = Math.max(0, Math.min(1, p));
    const c = t < 0.5
      ? [255, Math.round(92 + (197 - 92) * (t / 0.5)), 66]
      : [Math.round(255 - (255 - 62) * ((t - 0.5) / 0.5)), Math.round(197 + (230 - 197) * ((t - 0.5) / 0.5)), Math.round(66 + (143 - 66) * ((t - 0.5) / 0.5))];
    return `rgb(${c.join(',')})`;
  };
  const fmtPct = p => Math.round(p * 100) + '%';
  const POS_CAP = { QB: 1, TE: 1, DEF: 1 }; // per team, keepers included
  const DEF_FROM_ROUND = 15;

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
    L.rosters.forEach(r => (keeperCounts[r.rid] = { QB: 0, TE: 0, DEF: 0 }));
    for (const k of keeps) {
      const pos = byId[k.pid]?.pos, rid = rosterOfPid[k.pid];
      if (pos in POS_CAP && keeperCounts[rid]) keeperCounts[rid][pos]++;
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

    // deterministic constrained walk. includeMe=false ghosts my picks — that
    // run measures when THE ROOM would take each player, which is what
    // availability-at-my-pick should be judged against.
    function runWalk(includeMe) {
      const cnts = {};
      L.rosters.forEach(r => (cnts[r.rid] = { ...keeperCounts[r.rid] }));
      const exp = {}, idx = {}, taken = new Set();
      openPicks.forEach((pick, k) => {
        const r = Math.ceil(pick / N);
        const rid = (dd.slotToRoster || {})[String(slotOfPick(pick))];
        if (!includeMe && rid === myRid) return;
        const cnt = cnts[rid] || { QB: 0, TE: 0, DEF: 0 };
        // DEF goes in R16, full stop — earlier only when keepers ate the 16th
        const forceDef = cnt.DEF < 1 && (r === ROUNDS || pick === lastOpen[rid]);
        const list = includeMe && rid === myRid ? myOrder : adpOrder;
        const p = list.find(x => {
          if (taken.has(x.id)) return false;
          if (forceDef) return x.pos === 'DEF';
          if (x.pos === 'DEF') return false; // never voluntarily early
          if (x.pos in POS_CAP && cnt[x.pos] >= POS_CAP[x.pos]) return false;
          return true;
        });
        if (!p) return;
        exp[pick] = p.id;
        idx[p.id] = k;
        taken.add(p.id);
        if (p.pos in cnt) cnt[p.pos]++;
      });
      return { exp, idx };
    }
    const full = runWalk(true);    // display board incl. my board-driven picks
    const others = runWalk(false); // the room without me -> availability odds
    const expected = full.exp;

    const probAvail = (pid, k) => {
      if (keptSet.has(pid)) return 0;
      const i = others.idx[pid];
      if (i == null) return 1; // the room never takes him (e.g. QB13 in a 1-QB room)
      return 1 - phi((k - i) / sigma(i));
    };
    const mySlot = dd.draftOrder[L.myUserId];
    return { ROUNDS, N, cells, openPicks, openIdx, adpOrder, othersIdx: others.idx, expected, probAvail, pickNum, mySlot, myRid, dd, keptSet };
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
    const k = sim.openIdx[pick];
    const rows = sim.adpOrder
      .filter(p => sim.othersIdx[p.id] != null && sim.othersIdx[p.id] >= Math.max(0, k - 30) && sim.othersIdx[p.id] <= k + 25)
      .map(p => ({ p, prob: sim.probAvail(p.id, k) }))
      .filter(x => x.prob >= 0.01 && x.prob <= 0.995)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 16);
    const r = Math.ceil(pick / sim.N);
    LAB.modal(LAB.el('div', {},
      LAB.el('h2', {}, `Pick ${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} (overall #${pick})`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px' },
        'Odds each player is still on the board at this pick, given keepers and positional need (1 QB / 1 TE per team, DEF in R15-16). Locks (≈100%) are omitted.'),
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
        'The ', LAB.el('b', { class: 'accent' }, 'orange card'), ' is your projected pick off YOUR board (one QB, one TE, filled positions drop out). Below it: alternatives with the odds they last. ',
        LAB.el('b', { style: 'color:#3ee68f' }, 'green = safe'), ' → ', LAB.el('b', { style: 'color:#ff5c5c' }, 'red = long shot'), '.'));
    const cols = LAB.el('div', { style: 'display:flex;gap:10px;overflow-x:auto;padding-bottom:6px' });
    const myFilled = { QB: 0, TE: 0, DEF: 0 }; // my keepers count toward my caps
    const heroTaken = new Set(); // my projected picks so far, excluded from later lists
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
        const k = sim.openIdx[pick];
        const heroPid = sim.expected[pick];
        const heroPos = byId[heroPid]?.pos;
        const isMyDefPick = heroPos === 'DEF';
        // every legal candidate at this pick, in MY board order (hero included)
        const legalList = sim.adpOrder
          .filter(p => !heroTaken.has(p.id)
            && (p.id === heroPid
              || (sim.othersIdx[p.id] == null ? (oRanks[p.id] ?? 9e3) < 300 : sim.othersIdx[p.id] <= k + 22))
            && !(p.pos === 'QB' && myFilled.QB >= 1)
            && !(p.pos === 'TE' && myFilled.TE >= 1)
            && (p.pos === 'DEF') === isMyDefPick) // DEFs only on my DEF pick
          .map(p => ({ p, prob: sim.probAvail(p.id, k) }))
          .filter(x => x.prob >= 0.08 || x.p.id === heroPid)
          .sort((a, b) => (oRanks[a.p.id] ?? 9e3) - (oRanks[b.p.id] ?? 9e3));
        // selection zone: everyone you rank above your best SAFE option (>=85%
        // to be there) with a real shot (>=15%) — that's the set you'll
        // actually be choosing from; players ranked below the safe anchor are
        // dominated by him
        const anchorIdx = legalList.findIndex(x => x.prob >= 0.85);
        const cut = anchorIdx < 0 ? legalList.length : anchorIdx + 1;
        const zone = legalList.slice(0, cut).filter(x => x.prob >= 0.15 || x.p.id === heroPid).slice(0, 7);
        const zoneIds = new Set(zone.map(x => x.p.id));
        const depth = legalList.filter(x => !zoneIds.has(x.p.id) && x.prob >= 0.5).slice(0, Math.max(0, 8 - zone.length));
        const zoneBox = LAB.el('div', {
          style: 'border:1.5px solid var(--accent);border-radius:9px;padding:3px 5px 5px;margin-top:4px',
          title: 'the players this pick will realistically come down to',
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
        'Solid amber = keeper locked on the real board · dashed = predicted keeper · everything else = most-likely pick given ADP + positional need (1 QB / 1 TE each, DEF in R16 unless keepers ate it). Your column runs off your board; your resulting team is on the right. Click any open cell for odds.'));
    // columns compress to fit — the board never scrolls horizontally
    const wrap = LAB.el('div', { style: 'min-width:0' });
    const grid = LAB.el('div', { style: `display:grid;grid-template-columns:28px repeat(${sim.N},minmax(0,1fr));gap:3px` });
    grid.append(LAB.el('div', {}));
    const nameOfSlot = {};
    Object.entries(sim.dd.draftOrder).forEach(([uid, slot]) => (nameOfSlot[slot] = L.users[uid]?.name || 'slot ' + slot));
    for (let s = 1; s <= sim.N; s++) {
      grid.append(LAB.el('div', {
        style: 'font-family:var(--font-display);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:3px 2px;text-align:center;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (s === sim.mySlot ? 'var(--accent)' : 'var(--ink-3)'),
        title: nameOfSlot[s],
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
          cell ? LAB.el('span', { class: 'badge keeper', style: 'font-size:9px' }, 'K') : ''));
      }
    }
    aside.append(teamCard);
  }

  render();
})();
