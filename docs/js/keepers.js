/* THE LAB — keeper decide-helper */
(async function () {
  LAB.nav('Keepers');
  const { players, leagues } = await LAB.loadData(['players', 'leagues']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  const RULE_LABEL = {
    round_slot: 'keeper occupies the round he was drafted in last year',
    round_minus_1: 'keeper costs one round EARLIER than last year\'s draft round',
  };

  // expected overall pick for round R in a 10-team snake (mid-round)
  const midPick = r => (r - 0.5) * 10;

  for (const [tag, L] of Object.entries(leagues)) {
    const my = L.rosters.find(r => r.owner === L.myUserId);
    if (!my) continue;
    const officialKeepers = new Set(my.keepers || []);
    const cands = (my.players || [])
      .map(pid => byId[pid])
      .filter(p => p && p.pos !== 'DEF')
      .map(p => {
        const lastRd = L.lastDraftRound[p.id] || null;
        let costRd;
        if (L.keeperRule === 'round_minus_1') costRd = lastRd ? Math.max(1, lastRd - 1) : 10;
        else costRd = lastRd || 10;
        const worth = p.adp ?? 200;
        const surplus = midPick(costRd) - worth;
        return { p, lastRd, costRd, surplus, official: officialKeepers.has(p.id) };
      })
      .sort((a, b) => b.surplus - a.surplus);

    const card = LAB.el('div', { class: 'card', style: 'margin-top:16px' },
      LAB.el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap' },
        LAB.el('h2', {}, `${L.name} — keep ${L.keeperMax}`),
        LAB.el('span', { class: 'muted', style: 'font-size:12px' }, RULE_LABEL[L.keeperRule])));

    const tbl = LAB.el('table', { class: 'lab', style: 'margin-top:8px' },
      LAB.el('thead', {}, LAB.el('tr', {},
        LAB.el('th', {}, ''), LAB.el('th', {}, 'Player'),
        LAB.el('th', { class: 'num' }, "Last yr rd"),
        LAB.el('th', { class: 'num' }, 'Costs'),
        LAB.el('th', { class: 'num' }, 'ADP'),
        LAB.el('th', { class: 'num' }, 'My rank'),
        LAB.el('th', { class: 'num', title: 'expected pick value of the cost round minus ADP — positive = bargain' }, 'Surplus'),
        LAB.el('th', {}, ''))));
    const tb = LAB.el('tbody');
    cands.forEach((c, i) => {
      const verdict = c.surplus >= 25 ? ['KEEP', 'good'] : c.surplus >= 8 ? ['lean keep', 'warn'] : c.surplus <= -10 ? ['let go', 'bad'] : ['toss-up', 'muted'];
      tb.append(LAB.el('tr', { style: 'cursor:pointer', onclick: () => LAB.playerCard(c.p.id) },
        LAB.el('td', {}, LAB.headshot(c.p.id)),
        LAB.el('td', {}, LAB.el('div', { class: 'flex' },
          LAB.el('b', {}, c.p.name), LAB.posBadge(c.p.pos),
          c.official ? LAB.el('span', { class: 'badge keeper' }, 'OFFICIAL') : '',
          i < L.keeperMax && !c.official ? LAB.el('span', { class: 'badge mine' }, 'TOP ' + L.keeperMax) : '')),
        LAB.el('td', { class: 'num' }, c.lastRd ? 'R' + c.lastRd : 'FA'),
        LAB.el('td', { class: 'num' }, 'R' + c.costRd),
        LAB.el('td', { class: 'num' }, c.p.adp != null ? c.p.adp.toFixed(1) : '–'),
        LAB.el('td', { class: 'num' }, oRanks[c.p.id] ? '#' + oRanks[c.p.id] : '–'),
        LAB.el('td', { class: 'num ' + verdict[1] }, (c.surplus > 0 ? '+' : '') + Math.round(c.surplus)),
        LAB.el('td', {}, LAB.el('span', { class: verdict[1], style: 'font-weight:700;font-size:11.5px;text-transform:uppercase' }, verdict[0]))));
    });
    tbl.append(tb);
    card.append(tbl);

    if (tag === 'ggg') card.append(LAB.el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      'Salary/cap consequences → ', LAB.el('a', { href: 'https://strubetube.github.io/ggg-league/', target: '_blank', rel: 'noopener' }, 'GGG site'), '.'));
    root.append(card);
  }
})();
