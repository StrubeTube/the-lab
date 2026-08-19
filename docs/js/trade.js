/* THE LAB — Trade Lab: two-lens trade analyzer.
   KEEPER lens (pre-draft): rosters reset at the draft, so a player's trade
   value is his KEEPER SURPLUS — projected points over replacement minus the
   value of the pick round he costs to keep (non-eligible players carry ~0).
   SEASON lens (in-season): rest-of-season VORP plus a 30% nod to keeper
   surplus for players with keeper rights.
   Picks are valued by what's actually left on the board in that round of
   THIS league's keeper draft (median VORP of players the keeper sim sends
   there), future seasons discounted 15%/yr. Every proposal is checked
   against the league's real trade history (fetched from Sleeper back to
   2020, traded picks resolved to the player they became). */
(async function () {
  LAB.nav('Trades');
  const { players, leagues, trades } = await LAB.loadData(['players', 'leagues', 'trades']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  let tag = LAB.prefs.trLeague || 'ggg';
  const tabs = LAB.$('#leagueTabs');
  for (const t of ['ggg', 'lob']) {
    tabs.append(LAB.el('button', {
      class: t === tag ? 'active' : '',
      onclick: e => {
        tag = t; LAB.prefs.trLeague = t; LAB.savePrefs();
        LAB.$$('#leagueTabs button').forEach(b => b.classList.toggle('active', b === e.target));
        initLeague();
      },
    }, leagues[t].name));
  }

  // ---------- value engine ----------
  const BASE = { QB: 12, RB: 26, WR: 28, TE: 12, DEF: 10 }; // replacement = Nth at pos
  const basePts = {};
  for (const [pos, n] of Object.entries(BASE)) {
    const arr = players.filter(p => p.pos === pos && p.proj).sort((a, b) => b.proj - a.proj);
    basePts[pos] = arr[n - 1]?.proj || 0;
  }
  const vorp = p => Math.max(0, (p.proj || 0) - (basePts[p.pos] || 0));

  function makeEngine(L) {
    const kSim = LAB.keeperSim(players, L, board);
    // a round's pick value = median VORP of the players the keeper sim puts
    // there, forced monotone (an earlier round is never worth less)
    const byRound = {};
    for (const p of players) {
      const r = kSim.rounds[p.id];
      if (r) (byRound[r] = byRound[r] || []).push(vorp(p));
    }
    const roundVal = {};
    for (let r = 1; r <= 16; r++) {
      const a = (byRound[r] || []).sort((x, y) => x - y);
      roundVal[r] = a.length ? a[Math.floor(a.length / 2)] : 0;
    }
    for (let r = 15; r >= 1; r--) roundVal[r] = Math.max(roundVal[r], roundVal[r + 1]);
    const actual = {};
    for (const k of (L.draftKeepers || [])) actual[k.pid] = k.round;
    const kept = new Set(L.lastKept || []);
    const eligible = p => p && p.pos !== 'DEF' && !!L.lastDraftRound[p.id];
    const costRd = p => Math.min(16, actual[p.id]
      ?? LAB.keeperCostRound(L, L.lastDraftRound[p.id] || null, kept.has(p.id)));
    const surplus = p => eligible(p) ? vorp(p) - roundVal[costRd(p)] : null;
    const pickVal = (season, round) => {
      const yrs = Math.max(0, (+season) - (+L.season));
      return roundVal[Math.min(16, +round)] * Math.pow(0.85, yrs);
    };
    return { roundVal, eligible, costRd, surplus, pickVal };
  }

  function assetVal(E, lens, a) {
    if (a.kind === 'pick') return E.pickVal(a.season, a.round);
    const p = byId[a.id];
    if (!p) return 0;
    const s = E.surplus(p);
    if (lens === 'keeper') return Math.max(0, s ?? 0);
    return vorp(p) + 0.3 * Math.max(0, s ?? 0);
  }
  const pts = v => Math.round(v);

  // ---------- per-league state ----------
  let L, TR, E, lens, partnerRid, give, get, showAllLog;
  const teamName = rid => {
    const r = L.rosters.find(x => x.rid === rid);
    const u = r && L.users[r.owner];
    return u ? (u.team || u.name) : 'Team ' + rid;
  };
  const mgrName = rid => {
    const r = L.rosters.find(x => x.rid === rid);
    return (r && L.users[r.owner]?.name) || '';
  };

  function initLeague() {
    L = leagues[tag];
    TR = trades[tag] || { trades: [], roundHist: {}, tradedPicks: [] };
    E = makeEngine(L);
    lens = L.status === 'in_season' ? 'season' : 'keeper';
    const myRid = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    partnerRid = (L.rosters.find(r => r.rid !== myRid) || {}).rid;
    give = []; get = []; showAllLog = false;
    render();
  }
  const myRoster = () => L.rosters.find(r => r.owner === L.myUserId);
  const partner = () => L.rosters.find(r => r.rid === partnerRid);

  // picks a roster currently owns (own slots minus traded away, plus acquired)
  function ownedPicks(rid) {
    const seasons = [+L.season, +L.season + 1];
    const out = [];
    for (const s of seasons) {
      for (let r = 1; r <= 16; r++) {
        const away = TR.tradedPicks.find(t => +t.season === s && t.round === r && t.origRid === rid && t.ownerRid !== rid);
        if (!away) out.push({ season: String(s), round: r, origRid: rid });
      }
      for (const t of TR.tradedPicks) {
        if (+t.season === s && t.ownerRid === rid && t.origRid !== rid) {
          out.push({ season: String(s), round: t.round, origRid: t.origRid });
        }
      }
    }
    return out.sort((a, b) => (+a.season) - (+b.season) || a.round - b.round);
  }
  const pickLabel = a => `${a.season} R${a.round}` + (a.origRid != null && a.origRid !== (a.side === 'give' ? myRoster().rid : partnerRid) ? ` (orig ${teamName(a.origRid)})` : '');
  const sameAsset = (a, b) => a.kind === b.kind && (a.kind === 'pick'
    ? a.season === b.season && a.round === b.round && a.origRid === b.origRid
    : a.id === b.id);

  // ---------- optimal keeper slate ----------
  function slate(pids) {
    return pids.map(pid => byId[pid]).filter(p => E.eligible(p))
      .map(p => ({ p, cost: E.costRd(p), s: E.surplus(p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, L.keeperMax || 3);
  }
  const slateSum = sl => sl.reduce((t, x) => t + Math.max(0, x.s), 0);

  // ---------- UI pieces ----------
  function playerRow(p, listArr, otherArr) {
    const inList = listArr.some(a => a.kind === 'player' && a.id === p.id);
    const s = E.surplus(p);
    const v = assetVal(E, lens, { kind: 'player', id: p.id });
    return LAB.el('div', {
      class: 'flex',
      style: 'gap:7px;padding:3px 6px;border-radius:7px;margin-top:3px;cursor:pointer;font-size:12.5px;' +
        (inList ? 'background:rgba(255,106,43,.12);border:1px solid var(--accent)' : 'background:var(--surface);border:1px solid var(--border)'),
      onclick: () => {
        const i = listArr.findIndex(a => a.kind === 'player' && a.id === p.id);
        if (i >= 0) listArr.splice(i, 1); else listArr.push({ kind: 'player', id: p.id });
        render();
      },
      title: E.eligible(p)
        ? `keeper cost R${E.costRd(p)} · surplus ${pts(s)} pts over that pick`
        : 'not keeper-eligible (not in last year\'s draft)' + (p.pos === 'DEF' ? ' — DEF' : ''),
    },
      LAB.headshot(p.id, 'sm'),
      LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
      LAB.posBadge(p.pos),
      E.eligible(p)
        ? LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px;flex:none' }, 'K R' + E.costRd(p))
        : LAB.el('span', { class: 'mono', style: 'font-size:10.5px;flex:none;color:var(--ink-3)' }, '—'),
      LAB.el('b', { class: 'mono', style: 'width:48px;text-align:right;flex:none;color:' + (v >= 1 ? 'var(--good, #3ee68f)' : 'var(--ink-3)') }, pts(v)));
  }

  function sideCard(label, roster, listArr) {
    const isMine = roster.rid === myRoster().rid;
    const card = LAB.el('div', { class: 'card', style: 'flex:1;min-width:330px' },
      LAB.el('h2', {}, label),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 6px' },
        teamName(roster.rid) + ' · ' + mgrName(roster.rid) + ' — click players or add picks; value = ' + (lens === 'keeper' ? 'keeper surplus' : 'season VORP') + ' in pts'));
    // pick adder
    const owned = ownedPicks(roster.rid).filter(op => !listArr.some(a => a.kind === 'pick' && sameAsset(a, { ...op, kind: 'pick' })));
    const sel = LAB.el('select', { style: 'flex:1' },
      LAB.el('option', { value: '' }, '+ add a draft pick…'),
      owned.map(op => LAB.el('option', { value: JSON.stringify(op) },
        `${op.season} R${op.round}` + (op.origRid !== roster.rid ? ` (orig ${teamName(op.origRid)})` : ''))));
    sel.onchange = () => {
      if (!sel.value) return;
      listArr.push({ kind: 'pick', ...JSON.parse(sel.value) });
      render();
    };
    card.append(LAB.el('div', { class: 'flex', style: 'gap:6px;margin-bottom:4px' }, sel));
    // selected picks as chips (players highlight in the roster list itself)
    const pickChips = listArr.filter(a => a.kind === 'pick');
    if (pickChips.length) {
      card.append(LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:5px;margin:4px 0' },
        pickChips.map(a => LAB.el('span', {
          class: 'badge', style: 'cursor:pointer;border:1px solid var(--accent);background:rgba(255,106,43,.12)',
          title: 'click to remove · worth ' + pts(E.pickVal(a.season, a.round)) + ' pts (best realistic player left in that round of the keeper draft)',
          onclick: () => { listArr.splice(listArr.findIndex(x => sameAsset(x, a)), 1); render(); },
        }, `${a.season} R${a.round}` + (a.origRid !== roster.rid ? ` · orig ${teamName(a.origRid)}` : '') + ` — ${pts(E.pickVal(a.season, a.round))} pts ✕`))));
    }
    const list = LAB.el('div', { style: 'max-height:330px;overflow-y:auto;padding-right:2px' });
    (roster.players || []).map(pid => byId[pid]).filter(Boolean)
      .sort((a, b) => assetVal(E, lens, { kind: 'player', id: b.id }) - assetVal(E, lens, { kind: 'player', id: a.id }))
      .forEach(p => list.append(playerRow(p, listArr)));
    card.append(list);
    return card;
  }

  function totalOf(listArr) { return listArr.reduce((t, a) => t + assetVal(E, lens, a), 0); }

  function verdictCard() {
    const gv = totalOf(give), rv = totalOf(get);
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' }, LAB.el('h2', {}, 'Verdict'));
    if (!give.length && !get.length) {
      card.append(LAB.el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Add assets to both sides to grade the deal.'));
      return card;
    }
    const max = Math.max(gv, rv, 1);
    const bar = (lbl, v, col) => LAB.el('div', { class: 'flex', style: 'gap:8px;margin-top:6px' },
      LAB.el('span', { style: 'width:78px;flex:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)' }, lbl),
      LAB.el('div', { style: 'flex:1;background:var(--surface);border-radius:5px;height:18px;overflow:hidden' },
        LAB.el('div', { style: `width:${Math.max(2, 100 * v / max)}%;height:100%;background:${col};border-radius:5px` })),
      LAB.el('b', { class: 'mono', style: 'width:64px;text-align:right' }, pts(v) + ' pts'));
    card.append(bar('You send', gv, '#ff5c5c'), bar('You get', rv, '#3ee68f'));
    const d = rv - gv, rel = Math.abs(d) / Math.max(gv, rv, 1);
    const label = rel < 0.12 ? ['FAIR DEAL', 'var(--ink-2, #cbd5e1)']
      : d > 0 ? (rel > 0.35 ? ['CLEAR WIN', '#3ee68f'] : ['YOU WIN', '#3ee68f'])
        : (rel > 0.35 ? ['HEAVY LOSS', '#ff5c5c'] : ['YOU LOSE', '#ff5c5c']);
    card.append(LAB.el('div', { class: 'flex', style: 'gap:10px;margin-top:10px;align-items:baseline' },
      LAB.el('b', { style: 'font-family:var(--font-display);font-size:20px;letter-spacing:.03em;color:' + label[1] }, label[0]),
      LAB.el('span', { class: 'mono', style: 'color:' + label[1] }, (d >= 0 ? '+' : '') + pts(d) + ' pts'),
      LAB.el('span', { class: 'muted', style: 'font-size:11.5px' },
        lens === 'keeper' ? 'keeper-draft lens: surplus + pick value, in points over replacement'
          : 'season lens: rest-of-season VORP + 30% of keeper surplus')));
    // itemization
    const item = a => {
      const v = assetVal(E, lens, a);
      if (a.kind === 'pick') return `${a.season} R${a.round} (${pts(v)})`;
      const p = byId[a.id];
      const s = E.surplus(p);
      return `${p.name} (${pts(v)}${E.eligible(p) ? ` · K R${E.costRd(p)}` : ' · no keep'})`;
    };
    card.append(LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:8px' },
      'Send: ' + (give.map(item).join(' · ') || '—'), LAB.el('br'), 'Get: ' + (get.map(item).join(' · ') || '—')));
    const otherLens = lens === 'keeper' ? 'season' : 'keeper';
    const o = l => give.reduce((t, a) => t + assetVal(E, l, a), 0).toFixed(0) + ' → ' + get.reduce((t, a) => t + assetVal(E, l, a), 0).toFixed(0);
    card.append(LAB.el('p', { class: 'muted', style: 'font-size:11px;margin-top:4px' },
      `Other lens (${otherLens}): ${o(otherLens)} pts.`));
    return card;
  }

  function slateLine(x) {
    return LAB.el('div', { class: 'flex', style: 'gap:6px;font-size:12px;padding:2px 0' },
      LAB.headshot(x.p.id, 'sm'),
      LAB.el('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600' }, x.p.name),
      LAB.posBadge(x.p.pos),
      LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px' }, 'R' + x.cost),
      LAB.el('b', { class: 'mono', style: 'width:42px;text-align:right;color:' + (x.s >= 0 ? '#3ee68f' : '#ff5c5c') }, (x.s >= 0 ? '+' : '') + pts(x.s)));
  }

  function keeperImpactCard() {
    const me = myRoster(), pa = partner();
    const sentP = give.filter(a => a.kind === 'player').map(a => a.id);
    const gotP = get.filter(a => a.kind === 'player').map(a => a.id);
    const mineAfter = me.players.filter(pid => !sentP.includes(pid)).concat(gotP);
    const theirsAfter = pa.players.filter(pid => !gotP.includes(pid)).concat(sentP);
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'Keeper impact'),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 8px' },
        `Each team's optimal ${L.keeperMax || 3}-keeper slate (best surplus vs cost round), before → after this trade. This answers "is one of theirs better than one of mine" — and shows what you'd be handing them.`));
    const half = (title, before, after) => {
      const sb = slate(before), sa = slate(after);
      const db = slateSum(sb), da = slateSum(sa);
      const dd = da - db;
      const box = LAB.el('div', { style: 'flex:1;min-width:300px' },
        LAB.el('div', { class: 'flex', style: 'gap:8px;margin-bottom:4px' },
          LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;font-size:13px' }, title),
          LAB.el('b', { class: 'mono', style: 'font-size:12px;color:' + (dd > 0.5 ? '#3ee68f' : dd < -0.5 ? '#ff5c5c' : 'var(--ink-3)') },
            (dd >= 0 ? '+' : '') + pts(dd) + ' pts')));
      const cols = LAB.el('div', { class: 'flex', style: 'gap:10px;align-items:flex-start' });
      const col = (h, sl) => {
        const c = LAB.el('div', { style: 'flex:1;min-width:0' },
          LAB.el('div', { class: 'muted', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em' }, h));
        sl.forEach(x => c.append(slateLine(x)));
        if (!sl.length) c.append(LAB.el('div', { class: 'muted', style: 'font-size:11.5px' }, 'no eligible keepers'));
        return c;
      };
      cols.append(col('before', sb), col('after', sa));
      box.append(cols);
      return box;
    };
    card.append(LAB.el('div', { class: 'flex', style: 'gap:18px;flex-wrap:wrap;align-items:flex-start' },
      half('You', me.players, mineAfter),
      half(teamName(pa.rid), pa.players, theirsAfter)));
    return card;
  }

  function tradeLine(t) {
    const side = s => LAB.el('div', { class: 'flex', style: 'gap:5px;flex-wrap:wrap;font-size:12px;padding:1px 0' },
      LAB.el('b', { style: 'flex:none' }, s.team + ' got:'),
      s.players.map(p => LAB.el('span', { class: 'mono', style: 'color:var(--' + ({ QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', DEF: 'def' }[p.pos] || 'ink') + ')' }, p.name)),
      s.picks.map(pk => LAB.el('span', { class: 'mono', style: 'color:var(--warn)' },
        `${pk.season} R${pk.round}` + (pk.became ? ` → ${pk.became.name}${pk.became.keeper ? ' (K)' : ''}` : ''))),
      (!s.players.length && !s.picks.length) ? LAB.el('span', { class: 'muted' }, 'nothing?') : '');
    return LAB.el('div', { style: 'border:1px solid var(--border);border-radius:8px;padding:6px 9px;margin-top:6px;background:var(--surface)' },
      LAB.el('div', { class: 'mono muted', style: 'font-size:10.5px' }, `${t.season} · week ${t.week}`),
      t.sides.map(side));
  }

  function historyCard() {
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'League trade history'),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 6px' },
        `${TR.trades.length} completed trades on record. Traded picks show the player they eventually became — that's the honest market rate for a pick in this league.`));
    // precedent for the rounds in the current proposal
    const rounds = [...new Set([...give, ...get].filter(a => a.kind === 'pick').map(a => a.round))].sort((a, b) => a - b);
    for (const r of rounds) {
      const hist = (TR.roundHist[String(r)] || []).filter(x => !x.keeper).slice(0, 10);
      card.append(LAB.el('div', { style: 'margin:8px 0 2px' },
        LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;font-size:12.5px;color:var(--accent)' },
          `What R${r} picks became`),
        LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:5px;margin-top:3px' },
          hist.map(x => LAB.el('span', { class: 'badge', title: x.season }, `${x.season.slice(2)}' ${x.name}`)),
          LAB.el('span', { class: 'muted', style: 'font-size:11px' }, `· worth ~${pts(E.roundVal[r])} pts in this year's keeper draft`))));
      const prec = TR.trades.filter(t => t.sides.some(s => s.picks.some(pk => pk.round === r))).slice(0, 4);
      if (prec.length) {
        card.append(LAB.el('div', { class: 'muted', style: 'font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:5px' },
          `past trades moving an R${r}`));
        prec.forEach(t => card.append(tradeLine(t)));
      }
    }
    // the full log
    const shown = showAllLog ? TR.trades : TR.trades.slice(0, 8);
    card.append(LAB.el('div', { class: 'muted', style: 'font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:10px' }, 'full log'));
    shown.forEach(t => card.append(tradeLine(t)));
    if (!showAllLog && TR.trades.length > 8) {
      card.append(LAB.el('button', { style: 'margin-top:8px', onclick: () => { showAllLog = true; render(); } },
        `show all ${TR.trades.length} trades`));
    }
    return card;
  }

  // ---------- page ----------
  function render() {
    root.innerHTML = '';
    const me = myRoster();
    if (!me) { root.append(LAB.el('div', { class: 'empty' }, 'Could not find your roster in this league.')); return; }

    // controls: partner + lens
    const partnerSel = LAB.el('select', {},
      L.rosters.filter(r => r.rid !== me.rid).map(r =>
        LAB.el('option', { value: r.rid, selected: r.rid === partnerRid ? '' : null },
          teamName(r.rid) + ' (' + mgrName(r.rid) + ')')));
    partnerSel.onchange = () => { partnerRid = +partnerSel.value; get = []; render(); };
    const lensSeg = LAB.el('div', { class: 'seg' },
      [['keeper', 'Keeper draft'], ['season', 'In-season']].map(([k, lbl]) =>
        LAB.el('button', { class: k === lens ? 'active' : '', onclick: () => { lens = k; render(); } }, lbl)));
    root.append(LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('div', { class: 'flex', style: 'gap:12px;flex-wrap:wrap;align-items:center' },
        LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em' }, 'Trade partner'),
        partnerSel, LAB.el('div', { class: 'spacer', style: 'flex:1' }), lensSeg)));

    root.append(LAB.el('div', { class: 'flex', style: 'gap:14px;margin-top:14px;flex-wrap:wrap;align-items:flex-start' },
      sideCard('You send', me, give),
      sideCard('You receive', partner(), get)));
    root.append(verdictCard());
    root.append(keeperImpactCard());
    root.append(historyCard());
  }

  initLeague();
})();
