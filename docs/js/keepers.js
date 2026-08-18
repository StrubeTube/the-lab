/* THE LAB — keeper decide-helper */
(async function () {
  LAB.nav('Keepers');
  const { players, leagues } = await LAB.loadData(['players', 'leagues']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  const RULE_LABEL = {
    round_slot: 'drafted → keep at same round · repeat keep → one round earlier each year',
    round_minus_1: "keeper costs one round earlier than last year's slot",
  };

  // expected overall pick for round R in a 10-team snake (mid-round)
  const midPick = r => (r - 0.5) * 10;

  function candidates(L, roster, kMap) {
    const kept = new Set(L.lastKept || []);
    const officialKeepers = new Set(roster.keepers || []);
    return (roster.players || [])
      .map(pid => byId[pid])
      // undrafted/waiver pickups are NOT keeper-eligible — drafted last year only
      .filter(p => p && p.pos !== 'DEF' && L.lastDraftRound[p.id])
      .map(p => {
        const lastRd = L.lastDraftRound[p.id];
        const wasKept = kept.has(p.id);
        const costRd = LAB.keeperCostRound(L, lastRd, wasKept);
        const cost = midPick(costRd);
        const myRank = oRanks[p.id] || null;
        return {
          p, lastRd, wasKept, costRd, myRank,
          kRd: kMap[p.id] ?? null, // null = he's a predicted keeper, never drafted
          sBoard: myRank != null ? cost - myRank : null,
          sAdp: p.adp != null ? cost - p.adp : null,
          official: officialKeepers.has(p.id),
        };
      });
  }

  const COLS = [
    { key: 'name', label: 'Player', num: false, get: c => c.p.name },
    { key: 'lastRd', label: 'Last yr', num: true, get: c => c.lastRd },
    { key: 'costRd', label: 'Costs', num: true, get: c => c.costRd },
    { key: 'adp', label: 'ADP', num: true, get: c => c.p.adp,
      title: 'Sleeper half-PPR ADP (updates daily)' },
    { key: 'kRd', label: 'K rd', num: true, get: c => c.kRd,
      title: "projected round he'd go in THIS league's keeper draft (predicted keepers consume their cost rounds)" },
    { key: 'myRank', label: 'My rank', num: true, get: c => c.myRank },
    { key: 'sBoard', label: 'Surplus (board)', num: true, get: c => c.sBoard,
      title: 'expected pick value of the cost round minus your board rank — positive = bargain' },
    { key: 'sAdp', label: 'Surplus (ADP)', num: true, get: c => c.sAdp,
      title: 'expected pick value of the cost round minus ADP — positive = bargain' },
  ];
  // per-column natural direction: value columns default to best-first
  const DEFAULT_DIR = { name: 1, lastRd: 1, costRd: 1, adp: 1, kRd: 1, myRank: 1, sBoard: -1, sAdp: -1 };

  for (const [tag, L] of Object.entries(leagues)) {
    const myRoster = L.rosters.find(r => r.owner === L.myUserId);
    const teams = L.rosters.slice().sort((a, b) => {
      if (a === myRoster) return -1;
      if (b === myRoster) return 1;
      return (L.users[a.owner]?.name || '').localeCompare(L.users[b.owner]?.name || '');
    });
    const st = { rid: myRoster ? myRoster.rid : teams[0].rid, sortKey: 'sBoard', dir: -1 };
    const kMap = LAB.keeperRounds(players, L, board); // this league's keeper-draft sim

    const chipRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:6px;margin-top:10px' });
    const tblWrap = LAB.el('div');
    const card = LAB.el('div', { class: 'card', style: 'margin-top:16px' },
      LAB.el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap' },
        LAB.el('h2', {}, `${L.name} — keep ${L.keeperMax}`),
        LAB.el('span', { class: 'muted', style: 'font-size:12px' }, RULE_LABEL[L.keeperRule])),
      chipRow, tblWrap);

    function teamName(r) {
      const u = L.users[r.owner] || {};
      return u.team || u.name || 'Roster ' + r.rid;
    }

    function renderChips() {
      chipRow.innerHTML = '';
      for (const r of teams) {
        const active = r.rid === st.rid;
        chipRow.append(LAB.el('button', {
          class: 'btn small',
          style: active ? 'border-color:var(--accent);color:var(--accent)' : 'opacity:.7',
          onclick: () => { st.rid = r.rid; renderChips(); renderTable(); },
        }, teamName(r) + (r === myRoster ? ' (me)' : '')));
      }
    }

    function renderTable() {
      tblWrap.innerHTML = '';
      const roster = L.rosters.find(r => r.rid === st.rid);
      const cands = candidates(L, roster, kMap);

      // TOP-N badge is pinned to the default metric so it doesn't move with the sort
      const topIds = new Set(cands.slice()
        .sort((a, b) => (b.sBoard ?? b.sAdp ?? -999) - (a.sBoard ?? a.sAdp ?? -999))
        .slice(0, L.keeperMax).map(c => c.p.id));

      const col = COLS.find(c => c.key === st.sortKey);
      cands.sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // nulls last either direction
        if (vb == null) return -1;
        return typeof va === 'string' ? st.dir * va.localeCompare(vb) : st.dir * (va - vb);
      });

      const head = LAB.el('tr', {}, LAB.el('th', {}, ''));
      for (const c of COLS) {
        const active = c.key === st.sortKey;
        head.append(LAB.el('th', {
          class: (c.num ? 'num' : '') + ' sortable',
          style: 'cursor:pointer;user-select:none' + (active ? ';color:var(--accent)' : ''),
          title: c.title || 'click to sort',
          onclick: () => {
            st.dir = active ? -st.dir : DEFAULT_DIR[c.key];
            st.sortKey = c.key;
            renderTable();
          },
        }, c.label + (active ? (st.dir === 1 ? ' ↑' : ' ↓') : '')));
      }
      head.append(LAB.el('th', {}, ''));
      const tbl = LAB.el('table', { class: 'lab', style: 'margin-top:8px' }, LAB.el('thead', {}, head));

      const tb = LAB.el('tbody');
      for (const c of cands) {
        const s = c.sBoard ?? c.sAdp;
        const verdict = s == null ? ['?', 'muted']
          : s >= 25 ? ['KEEP', 'good'] : s >= 8 ? ['lean keep', 'warn'] : s <= -10 ? ['let go', 'bad'] : ['toss-up', 'muted'];
        const fmtS = v => v == null ? '–' : (v > 0 ? '+' : '') + Math.round(v);
        tb.append(LAB.el('tr', { style: 'cursor:pointer', onclick: () => LAB.playerCard(c.p.id) },
          LAB.el('td', {}, LAB.headshot(c.p.id)),
          LAB.el('td', {}, LAB.el('div', { class: 'flex' },
            LAB.el('b', {}, c.p.name), LAB.posBadge(c.p.pos),
            c.official ? LAB.el('span', { class: 'badge keeper' }, 'OFFICIAL') : '',
            topIds.has(c.p.id) && !c.official ? LAB.el('span', { class: 'badge mine' }, 'TOP ' + L.keeperMax) : '')),
          LAB.el('td', { class: 'num' }, c.lastRd
            ? LAB.el('span', { title: c.wasKept ? 'was a KEEPER last year — cost escalates one round' : 'drafted last year' },
                'R' + c.lastRd, c.wasKept ? LAB.el('span', { class: 'warn', style: 'font-size:10px;font-weight:700' }, ' K') : '')
            : 'FA'),
          LAB.el('td', { class: 'num' }, 'R' + c.costRd),
          LAB.el('td', { class: 'num' }, c.p.adp != null ? c.p.adp.toFixed(1) : '–'),
          LAB.el('td', { class: 'num' }, c.kRd
            ? LAB.el('span', { title: 'would fall to round ' + c.kRd + ' of the keeper draft' }, 'R' + c.kRd)
            : LAB.el('span', { class: 'muted', title: 'predicted to be KEPT — never hits the board' }, 'kept')),
          LAB.el('td', { class: 'num' }, c.myRank ? '#' + c.myRank : '–'),
          LAB.el('td', { class: 'num ' + (c.sBoard > 0 ? 'good' : c.sBoard < 0 ? 'bad' : 'muted') }, fmtS(c.sBoard)),
          LAB.el('td', { class: 'num muted' }, fmtS(c.sAdp)),
          LAB.el('td', {}, LAB.el('span', { class: verdict[1], style: 'font-weight:700;font-size:11.5px;text-transform:uppercase' }, verdict[0]))));
      }
      tbl.append(tb);
      tblWrap.append(tbl);
    }

    renderChips();
    renderTable();

    if (tag === 'ggg') card.append(LAB.el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      'Salary/cap consequences → ', LAB.el('a', { href: 'https://strubetube.github.io/ggg-league/', target: '_blank', rel: 'noopener' }, 'GGG site'), '.'));
    root.append(card);
  }
})();
