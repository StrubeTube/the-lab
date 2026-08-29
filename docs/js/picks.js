/* THE LAB — Pick Sheet: the draft-table view.
   One card per pick I own, in order. Each card lists the players the Monte
   Carlo says will realistically be there, ranked by Lab @Draft window gap
   (score minus the median of who else is available at that slot) — the
   "who most out-values this pick" read, not a global ranking.
   Players struck off with ✓ are removed everywhere and the sheet re-ranks,
   so it stays correct as the real draft diverges from the projection.
   State is per-device localStorage; no server round trip, works offline. */
(async function () {
  LAB.nav('Pick Sheet');
  const { players, leagues, intel, trades } = await LAB.loadData(['players', 'leagues', 'intel', 'trades']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  const K_GONE = 'thelab-picksheet-gone-v1';
  const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  let tag = LAB.prefs.dmLeague || 'ggg';
  let gone = new Set((store(K_GONE, {})[tag]) || []);
  const persistGone = () => {
    const all = store(K_GONE, {});
    all[tag] = [...gone];
    save(K_GONE, all);
  };

  const tabs = LAB.$('#leagueTabs');
  for (const t of ['ggg', 'lob']) {
    tabs.append(LAB.el('button', {
      class: t === tag ? 'active' : '',
      onclick: e => {
        tag = t; LAB.prefs.dmLeague = t; LAB.savePrefs();
        gone = new Set((store(K_GONE, {})[tag]) || []);
        LAB.$$('#leagueTabs button').forEach(b => b.classList.toggle('active', b === e.target));
        render();
      },
    }, leagues[t].name));
  }

  // Lab @Draft accessors (see compute.py) — scores at the REAL slot in this
  // keeper draft, not national ADP
  const dKey = k => (tag === 'ggg' ? { s: 'ds', v: 'dg', g: 'dgw' }[k] : { s: 'dls', v: 'dl', g: 'dlw' }[k]);
  const dSlot = p => ((p && p.lab) || {})[dKey('s')] ?? null;
  const dScore = p => ((p && p.lab) || {})[dKey('v')] ?? null;
  const dGap = p => ((p && p.lab) || {})[dKey('g')] ?? null;
  const gapColor = g => g == null ? 'var(--ink-3)' : g >= 20 ? '#3ee68f' : g <= -20 ? '#ff5c5c' : 'var(--ink-2)';

  function render() {
    root.innerHTML = '';
    const L = leagues[tag];
    const dd = L.draftDetail || {};
    if (!dd.draftOrder) {
      root.append(LAB.el('p', { class: 'muted', style: 'margin-top:16px' },
        `${L.name} hasn't set its draft order yet — the sheet unlocks when Sleeper knows the slots.`));
      return;
    }
    const N = 10, ROUNDS = dd.rounds || 16;
    const { keeps, keptSet } = LAB.predictKeepers(L, byId, oRanks);
    const myRid = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    const slotOfRoster = {};
    Object.entries(dd.slotToRoster || {}).forEach(([slot, rid]) => (slotOfRoster[rid] = +slot));
    const mySlot = slotOfRoster[myRid];
    const pickNum = (r, s) => (r - 1) * N + (r % 2 === 1 ? s : N + 1 - s);

    // my picks (ownership-aware via traded picks)
    const ownerOfPick = {};
    for (const t of ((trades[tag] || {}).tradedPicks || [])) {
      if (String(t.season) !== String(L.season)) continue;
      const slot = slotOfRoster[t.origRid];
      if (slot != null && t.ownerRid !== t.origRid) ownerOfPick[pickNum(t.round, slot)] = t.ownerRid;
    }
    const myKeeperPicks = new Set();
    const keepAt = {};
    for (const k of keeps) {
      const rid = (L.rosters.find(r => (r.players || []).includes(k.pid)) || {}).rid;
      if (rid !== myRid) continue;
      const pk = pickNum(Math.min(k.costRd, ROUNDS), mySlot);
      myKeeperPicks.add(pk);
      keepAt[pk] = k.pid;
    }
    const myPicks = [];
    for (let p = 1; p <= ROUNDS * N; p++) {
      const owner = ownerOfPick[p];
      const base = (dd.slotToRoster || {})[String(((Math.ceil(p / N)) % 2 === 1)
        ? p - (Math.ceil(p / N) - 1) * N : N + 1 - (p - (Math.ceil(p / N) - 1) * N))];
      if ((owner != null ? owner : base) === myRid) myPicks.push(p);
    }

    // availability: reuse the simple ADP-consumption model — at pick P the
    // players expected gone are the top (P - keepers before P) by draft slot
    const pool = players
      .filter(p => p.pos !== 'DEF' && dSlot(p) != null && !keptSet.has(p.id) && !gone.has(p.id))
      .sort((a, b) => dSlot(a) - dSlot(b));

    const summary = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('div', { class: 'flex', style: 'justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:baseline' },
        LAB.el('h2', {}, `Slot ${mySlot} of ${N} — ${myPicks.length} picks`),
        LAB.el('button', {
          class: 'btn small',
          onclick: () => { gone = new Set(); persistGone(); render(); },
        }, `reset ✓ (${gone.size} marked gone)`)),
      LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0' },
        'Tap a player’s ✓ when someone drafts him. He disappears from every card below and the ranks recompute — so late in the draft this sheet reflects the real board, not the projection.'));
    root.append(summary);

    let consumed = 0;
    for (const pick of myPicks) {
      const r = Math.ceil(pick / N);
      const card = LAB.el('div', { class: 'card', style: 'margin-top:12px' });
      if (myKeeperPicks.has(pick)) {
        const kp = byId[keepAt[pick]];
        card.append(LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:center;flex-wrap:wrap' },
          LAB.el('h2', { style: 'margin:0' }, `R${r} · #${pick}`),
          LAB.el('span', { class: 'badge keeper' }, 'KEEPER'),
          kp ? LAB.headshot(kp.id, 'sm') : '',
          LAB.el('b', {}, kp ? kp.name : '—')));
        root.append(card);
        continue;
      }
      // players expected gone by this pick = everyone whose real slot is
      // earlier, minus the ones I marked ✓ (already removed from pool)
      // edge = his expected slot minus this pick. NEGATIVE means he normally
      // goes BEFORE this pick (so he's only here if he falls to you);
      // strongly POSITIVE means taking him now is a reach of that many slots.
      const here = pool.filter(p => dSlot(p) >= pick - 8);
      const likely = here.slice(0, 16)
        .map(p => ({ p, edge: dSlot(p) - pick }))
        .sort((a, b) => (dGap(b.p) ?? -99) - (dGap(a.p) ?? -99))
        .slice(0, 8);
      card.append(LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' },
        LAB.el('h2', { style: 'margin:0' }, `R${r} · #${pick}`),
        LAB.el('span', { class: 'muted', style: 'font-size:11.5px' },
          'ranked by how far each beats the field available here')));
      if (!likely.length) {
        card.append(LAB.el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:6px' }, 'nothing left in the pool for this pick'));
        root.append(card);
        continue;
      }
      for (const { p, edge } of likely) {
        const g = dGap(p);
        card.append(LAB.el('div', {
          class: 'flex',
          style: 'gap:8px;align-items:center;padding:5px 7px;border-radius:8px;margin-top:4px;background:var(--surface);border:1px solid '
            + (g != null && g >= 20 ? 'rgba(62,230,143,.5)' : g != null && g <= -20 ? 'rgba(255,92,92,.4)' : 'var(--border)'),
        },
          LAB.el('button', {
            class: 'btn small', style: 'flex:none;padding:1px 8px;font-size:12px',
            title: 'mark him gone — removes him from every pick card',
            onclick: () => { gone.add(p.id); persistGone(); render(); },
          }, '✓'),
          LAB.headshot(p.id, 'sm'),
          LAB.el('span', {
            style: 'font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer',
            onclick: () => LAB.playerCard(p.id),
          }, p.name),
          LAB.posBadge(p.pos),
          LAB.el('span', {
            class: 'mono', style: 'font-size:10.5px;color:' + (edge < 0 ? 'var(--warn)' : 'var(--ink-3)'),
            title: edge < 0
              ? `normally drafted around pick ${dSlot(p)} — he only reaches you here if he falls ${-edge} slots`
              : edge > 15
                ? `normally drafted around pick ${dSlot(p)} — taking him here is a ${edge}-slot reach; he will likely last`
                : `normally drafted around pick ${dSlot(p)} — right on time for this pick`,
          }, edge < 0 ? `if he falls` : edge > 15 ? `reach +${edge}` : `~${dSlot(p)}`),
          LAB.el('b', { class: 'mono', style: 'font-size:12px;width:30px;text-align:right', title: 'Lab @Draft score' }, dScore(p) ?? '–'),
          LAB.el('b', {
            class: 'mono', style: 'font-size:12px;width:34px;text-align:right;color:' + gapColor(g),
            title: 'window gap: his score minus the median of everyone else available at this pick',
          }, g == null ? '–' : (g > 0 ? '+' : '') + g)));
      }
      root.append(card);
      consumed++;
    }
  }

  render();
})();
