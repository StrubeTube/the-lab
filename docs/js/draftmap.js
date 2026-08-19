/* THE LAB — Draft Map: pick-by-pick availability under keeper conditions.
   Model: placed keepers are certainties at their real board slots; predicted
   keepers occupy their team's pick in the cost round; the rest of the pool
   drains by Sleeper ADP. A player's draft position is treated as a bell curve
   around his keeper-adjusted expected slot with spread growing by depth
   (sigma = 2 + 0.13 x available-rank), giving P(available) at every pick. */
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
    // red (gone) -> yellow -> green (safe)
    const t = Math.max(0, Math.min(1, p));
    const c = t < 0.5
      ? [255, Math.round(92 + (197 - 92) * (t / 0.5)), 66]
      : [Math.round(255 - (255 - 62) * ((t - 0.5) / 0.5)), Math.round(197 + (230 - 197) * ((t - 0.5) / 0.5)), Math.round(66 + (143 - 66) * ((t - 0.5) / 0.5))];
    return `rgb(${c.join(',')})`;
  };
  const fmtPct = p => Math.round(p * 100) + '%';

  // ---------- keeper-conditioned draft simulation ----------
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
    const pickNum = (round, slot) => (round - 1) * N + (round % 2 === 1 ? slot : N + 1 - slot);
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
    const sortKey = p => p.adp ?? 500 - (p.proj || 0) / 1000;
    const pool = players.filter(p => !keptSet.has(p.id)).sort((a, b) => sortKey(a) - sortKey(b));
    const seqOf = {};
    pool.forEach((p, i) => (seqOf[p.id] = i));
    const expected = {};
    openPicks.forEach((p, i) => { if (pool[i]) expected[p] = pool[i].id; });
    const probAvail = (pid, k) => { // k = open-sequence index of the pick
      const i = seqOf[pid];
      return i == null ? 0 : 1 - phi((k - i) / sigma(i));
    };
    const mySlot = dd.draftOrder[L.myUserId];
    return { ROUNDS, N, cells, openPicks, openIdx, pool, seqOf, expected, probAvail, pickNum, mySlot, slotOfRoster, dd };
  }

  // player chip with availability %
  function probChip(p, prob, extra) {
    const col = pctColor(prob);
    return LAB.el('div', {
      class: 'flex', style: 'gap:7px;padding:3px 6px;border-radius:7px;background:var(--surface);border:1px solid var(--border);margin-top:3px;cursor:pointer;font-size:12.5px',
      onclick: () => LAB.playerCard(p.id),
      title: `${p.name} — ${fmtPct(prob)} chance he's still available · ADP ${p.adp ?? '–'} · your rank ${oRanks[p.id] ? '#' + oRanks[p.id] : '–'}`,
    },
      LAB.headshot(p.id, 'sm'),
      LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
      LAB.posBadge(p.pos),
      oRanks[p.id] ? LAB.el('span', { class: 'mono muted', style: 'font-size:11px' }, '#' + oRanks[p.id]) : '',
      LAB.el('b', { class: 'mono', style: 'color:' + col + ';width:38px;text-align:right' }, fmtPct(prob)),
      extra || '');
  }

  function pickDetail(sim, pick) {
    const k = sim.openIdx[pick];
    const rows = sim.pool
      .filter(p => sim.seqOf[p.id] >= Math.max(0, k - 30) && sim.seqOf[p.id] <= k + 25)
      .map(p => ({ p, prob: sim.probAvail(p.id, k) }))
      .filter(x => x.prob >= 0.01 && x.prob <= 0.995)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 16);
    const r = Math.ceil(pick / sim.N);
    LAB.modal(LAB.el('div', {},
      LAB.el('h2', {}, `Pick ${r}.${String(pick - (r - 1) * sim.N).padStart(2, '0')} (overall #${pick})`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px' },
        'Odds each player is still on the board when this pick comes up. Locks (≈100%) are omitted — anyone ranked well below this pick will be there.'),
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

    // ---------- my picks planner ----------
    const planner = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, `Your picks — slot ${sim.mySlot} of ${sim.N}`),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 6px' },
        'Best available by YOUR board at each of your picks, with the odds they last that long. ',
        LAB.el('b', { style: 'color:#3ee68f' }, 'green = safe'), ' → ', LAB.el('b', { style: 'color:#ff5c5c' }, 'red = long shot'), '.'));
    const cols = LAB.el('div', { style: 'display:flex;gap:10px;overflow-x:auto;padding-bottom:6px' });
    for (let r = 1; r <= sim.ROUNDS; r++) {
      const pick = sim.pickNum(r, sim.mySlot);
      const cell = sim.cells[pick];
      const col = LAB.el('div', { style: 'flex:none;width:216px' });
      col.append(LAB.el('div', {
        class: 'tier-head', style: 'cursor:' + (cell ? 'default' : 'pointer'), 'data-pick': pick,
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
        const cands = sim.pool
          .filter(p => sim.seqOf[p.id] <= k + 22)
          .map(p => ({ p, prob: sim.probAvail(p.id, k) }))
          .filter(x => x.prob >= 0.08)
          .sort((a, b) => (oRanks[a.p.id] ?? 9e3) - (oRanks[b.p.id] ?? 9e3))
          .slice(0, 8);
        cands.forEach(x => col.append(probChip(x.p, x.prob)));
      }
      cols.append(col);
    }
    planner.append(cols);
    root.append(planner);

    // ---------- full snake board ----------
    const boardCard = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'Projected snake board'),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' },
        'Solid amber = keeper locked on the real board · dashed = predicted keeper · everything else = most-likely pick by keeper-adjusted ADP. Your column is highlighted. Click any open cell for odds.'));
    const wrap = LAB.el('div', { style: 'overflow-x:auto' });
    const grid = LAB.el('div', { style: `display:grid;grid-template-columns:34px repeat(${sim.N},minmax(108px,1fr));gap:3px;min-width:${34 + sim.N * 112}px` });
    // header: slot owners
    grid.append(LAB.el('div', {}));
    const nameOfSlot = {};
    Object.entries(sim.dd.draftOrder).forEach(([uid, slot]) => (nameOfSlot[slot] = L.users[uid]?.name || 'slot ' + slot));
    for (let s = 1; s <= sim.N; s++) {
      grid.append(LAB.el('div', {
        style: 'font-family:var(--font-display);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:3px 5px;text-align:center;color:' + (s === sim.mySlot ? 'var(--accent)' : 'var(--ink-3)'),
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
    root.append(boardCard);
  }

  render();
})();
