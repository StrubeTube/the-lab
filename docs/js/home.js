/* THE LAB — home: countdowns, league status, board health */
(async function () {
  LAB.nav('Home');
  const { players, leagues, meta } = await LAB.loadData(['players', 'leagues', 'meta']);
  const byId = LAB.playersById(players);

  // ---------- countdowns ----------
  const KEY_DATES = [
    { label: 'GGG keeper deadline', date: '2026-08-31T23:59:00-04:00' },
    { label: 'Draft day', date: '2026-09-07T12:00:00-04:00', dyn: 'draft' },
    { label: 'NFL kickoff', date: '2026-09-10T20:20:00-04:00' },
  ];
  const cd = LAB.$('#countdowns');
  const now = Date.now();
  KEY_DATES.forEach(k => {
    const days = Math.ceil((new Date(k.date) - now) / 86400000);
    if (days < -1) return;
    cd.append(LAB.el('div', { class: 'countdown' },
      LAB.el('div', { class: 'c-num' }, days <= 0 ? 'NOW' : days),
      LAB.el('div', { class: 'c-label' }, days === 1 ? k.label + ' (tomorrow)' : k.label),
      LAB.el('div', { class: 'c-date' }, new Date(k.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))));
  });

  // ---------- live league cards ----------
  const cardsRoot = LAB.$('#leagueCards');
  for (const [tag, L] of Object.entries(leagues)) {
    const card = LAB.el('div', { class: 'card' },
      LAB.el('div', { class: 'flex', style: 'justify-content:space-between' },
        LAB.el('h2', {}, L.name),
        LAB.el('span', { class: 'badge', style: 'background:var(--raised);color:var(--ink-2)' }, tag.toUpperCase())));
    cardsRoot.append(card);
    const body = LAB.el('div', { id: tag + 'Body' });
    card.append(body);
    (async () => {
      let draftLine = 'Draft not scheduled yet';
      let statusCls = 'dim';
      try {
        const d = await LAB.live(`/draft/${L.draftId}`);
        if (d.status === 'drafting') { draftLine = '🔴 DRAFT IS LIVE — get in the room'; statusCls = 'accent'; }
        else if (d.status === 'complete') { draftLine = '✓ Draft complete'; statusCls = 'good'; }
        else if (d.start_time) draftLine = 'Draft: ' + new Date(d.start_time).toLocaleString();
      } catch (e) {}
      const my = L.rosters.find(r => r.owner === L.myUserId);
      const keepers = (my?.keepers || []).map(pid => byId[pid]?.name || pid);
      body.append(
        LAB.el('p', { class: statusCls, style: 'font-weight:600;margin:6px 0' }, draftLine),
        LAB.el('div', { class: 'dim', style: 'font-size:12.5px' },
          `My keepers set: ${keepers.length ? keepers.join(', ') : 'none yet'} (max ${L.keeperMax})`),
        LAB.el('div', { class: 'toolbar', style: 'margin:10px 0 0' },
          LAB.el('a', { class: 'btn small', href: 'draft.html' }, 'Draft room'),
          LAB.el('a', { class: 'btn small', href: 'keepers.html' }, 'Keepers'),
          LAB.el('a', { class: 'btn small', href: `https://sleeper.com/leagues/${L.id}/league`, target: '_blank', rel: 'noopener' }, 'Sleeper ↗')));
    })();
  }

  // ---------- board health + data freshness ----------
  const board = LAB.loadBoard();
  const statusRow = LAB.$('#statusRow');
  const bTile = LAB.el('div', { class: 'card' }, LAB.el('h2', {}, 'My board'));
  if (board) {
    const nTiers = LAB.POS.reduce((s, p) => s + board.pos[p].tiers.length, 0);
    const nNotes = Object.keys(board.notes || {}).length;
    bTile.append(
      LAB.el('div', { class: 'tiles', style: 'grid-template-columns:repeat(3,1fr);margin-top:6px' },
        LAB.el('div', { class: 'tile' }, LAB.el('div', { class: 't-label' }, 'Tiers'), LAB.el('div', { class: 't-value' }, nTiers)),
        LAB.el('div', { class: 'tile' }, LAB.el('div', { class: 't-label' }, 'Notes'), LAB.el('div', { class: 't-value' }, nNotes)),
        LAB.el('div', { class: 'tile' }, LAB.el('div', { class: 't-label' }, 'Last edit'),
          LAB.el('div', { class: 't-value', style: 'font-size:15px;line-height:1.3;padding-top:6px' },
            board.updated ? new Date(board.updated).toLocaleDateString() : '–'))),
      LAB.el('div', { class: 'toolbar', style: 'margin:10px 0 0' },
        LAB.el('a', { class: 'btn small primary', href: 'board.html' }, 'Open the board'),
        LAB.el('button', { class: 'btn small', onclick: LAB.exportBoard }, 'Backup board')));
  } else {
    bTile.append(LAB.el('p', { class: 'dim' }, 'No board on this device yet — it seeds from ADP on first open.'),
      LAB.el('a', { class: 'btn small primary', href: 'board.html' }, 'Start ranking'));
  }
  statusRow.append(bTile);

  statusRow.append(LAB.el('div', { class: 'card' },
    LAB.el('h2', {}, 'Data'),
    LAB.el('div', { class: 'dim', style: 'font-size:12.5px;line-height:2;margin-top:4px' },
      LAB.el('div', {}, `Site data built: ${meta.built}`),
      LAB.el('div', {}, `ADP: FFC half-PPR, ${meta.adpMeta?.total_drafts?.toLocaleString() || '?'} drafts through ${meta.adpMeta?.end_date || '?'}`),
      LAB.el('div', {}, `Boris Chen tiers: ${meta.bcFresh ? 'live' : 'stale (auto-hidden until his 2026 draft tiers post)'}`),
      LAB.el('div', {}, 'Live: draft status, rosters, trending — fetched on page load'))));
})();
