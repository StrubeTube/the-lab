/* THE LAB — SoS heatmap */
(async function () {
  LAB.nav('SoS');
  const { sos } = await LAB.loadData(['sos']);
  const root = LAB.$('#heatRoot');
  let pos = 'QB', sortBy = 'team';

  LAB.$$('#posSeg button').forEach(b => b.addEventListener('click', () => {
    pos = b.dataset.p;
    LAB.$$('#posSeg button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }));
  LAB.$$('#sortSeg button').forEach(b => b.addEventListener('click', () => {
    sortBy = b.dataset.s;
    LAB.$$('#sortSeg button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }));

  // diverging color: rank 1 (easy, green) <-> rank 32 (hard, orange), neutral mid
  function cellColor(rank) {
    const t = (rank - 16.5) / 15.5; // -1 easy .. +1 hard
    const mid = [58, 68, 82], easy = [31, 163, 133], hard = [255, 138, 77];
    const from = t < 0 ? easy : hard;
    const u = Math.abs(t);
    const c = mid.map((m, i) => Math.round(m + (from[i] - m) * u));
    return `rgb(${c.join(',')})`;
  }

  function avgRank(team, weeks) {
    const games = sos.schedule[team].filter(g => g.opp && weeks.includes(g.w));
    if (!games.length) return 33;
    return games.reduce((s, g) => s + sos.defVsPos[g.opp][pos].rank, 0) / games.length;
  }

  function render() {
    root.innerHTML = '';
    const allWeeks = Array.from({ length: 18 }, (_, i) => i + 1);
    let teams = Object.keys(sos.schedule).sort();
    if (sortBy === 'season') teams.sort((a, b) => avgRank(a, allWeeks) - avgRank(b, allWeeks));
    if (sortBy === 'playoffs') teams.sort((a, b) => avgRank(a, sos.playoffWeeks) - avgRank(b, sos.playoffWeeks));

    const tbl = LAB.el('table', { class: 'heat' });
    tbl.append(LAB.el('tr', {},
      LAB.el('th', { style: 'text-align:left;padding-left:8px' }, 'Team'),
      allWeeks.map(w => LAB.el('th', {}, 'W' + w)),
      LAB.el('th', {}, 'SZN'), LAB.el('th', {}, 'PO')));
    for (const t of teams) {
      const tr = LAB.el('tr', {},
        LAB.el('td', { class: 'team-cell' }, LAB.el('span', { class: 'flex', style: 'gap:6px' }, LAB.teamLogo(t), t)));
      for (const g of sos.schedule[t]) {
        if (!g.opp) {
          tr.append(LAB.el('td', { class: 'cell bye-cell' }, 'bye'));
          continue;
        }
        const rk = sos.defVsPos[g.opp][pos].rank;
        const avg = sos.defVsPos[g.opp][pos].avg;
        tr.append(LAB.el('td', {
          class: 'cell' + (sos.playoffWeeks.includes(g.w) ? ' playoff' : ''),
          style: `background:${cellColor(rk)};color:#0b0f14`,
          title: `W${g.w}: ${g.home ? 'vs' : '@'} ${g.opp} — allows ${avg} pts/g to ${pos} (rank ${rk}/32)`,
        }, `${g.home ? '' : '@'}${g.opp}`));
      }
      const s = avgRank(t, allWeeks), p = avgRank(t, sos.playoffWeeks);
      tr.append(
        LAB.el('td', { class: 'cell', style: `background:${cellColor(s)};color:#0b0f14`, title: `season avg opponent rank ${s.toFixed(1)}` }, s.toFixed(0)),
        LAB.el('td', { class: 'cell playoff', style: `background:${cellColor(p)};color:#0b0f14`, title: `playoff-weeks avg opponent rank ${p.toFixed(1)}` }, p.toFixed(0)));
      tbl.append(tr);
    }
    root.append(tbl);
  }
  render();
})();
