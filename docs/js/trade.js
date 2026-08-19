/* THE LAB — Trade Lab: keeper-league trade analyzer.
   KEEPER lens (pre-draft): rosters reset at the draft, so a player's trade
   value is his KEEPER SURPLUS in draft-slot units — the same three numbers
   as the Keepers page (vs keeper-draft round / ADP / my board rank).
   PICKS are valued off the league's own historical market: preseason trades
   where a player was acquired AND kept tell us what round of pick buys a
   keeper at what cost round; a pick is then worth the surplus a typical
   keeper at that cost carries today.
   SEASON lens (in-season): rest-of-season projected points over replacement.
   Every proposal is checked against the league's real trade history
   (Sleeper, back to 2020; traded picks resolved to the player they became). */
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

  // ---------- season-lens value (points over replacement) ----------
  const BASE = { QB: 12, RB: 26, WR: 28, TE: 12, DEF: 10 };
  const basePts = {};
  for (const [pos, n] of Object.entries(BASE)) {
    const arr = players.filter(p => p.pos === pos && p.proj).sort((a, b) => b.proj - a.proj);
    basePts[pos] = arr[n - 1]?.proj || 0;
  }
  const vorp = p => Math.max(0, (p.proj || 0) - (basePts[p.pos] || 0));

  // ---------- keeper-lens engine (draft-slot units, Keepers-page math) ----------
  function makeEngine(L, TR) {
    const kSim = LAB.keeperSim(players, L, board);
    const actual = {};
    for (const k of (L.draftKeepers || [])) actual[k.pid] = k.round;
    const kept = new Set(L.lastKept || []);
    const eligible = p => p && p.pos !== 'DEF' && !!L.lastDraftRound[p.id];
    const costRd = p => Math.min(16, actual[p.id]
      ?? LAB.keeperCostRound(L, L.lastDraftRound[p.id] || null, kept.has(p.id)));
    // the three surplus bases, IDENTICAL to the Keepers page columns:
    // keeper = cost vs the round he'd go in THIS keeper draft (sKrd),
    // adp = cost vs Sleeper ADP (sAdp), board = cost vs my rank (sBoard)
    const midPick = r => (r - 0.5) * 10;
    const wouldRd = p => kSim.rounds[p.id] ?? kSim.wouldBe(p);
    const surplusSlots = (p, b) => {
      if (!eligible(p)) return null;
      const cost = midPick(costRd(p));
      if (b === 'adp') return p.adp != null ? cost - p.adp : null;
      if (b === 'board') return oRanks[p.id] != null ? cost - oRanks[p.id] : null;
      return cost - midPick(wouldRd(p));
    };
    // a pick is worth its DRAFT POSITION: slots of value over a last-round
    // pick, so an earlier pick is always worth more (R4 +125, R9 +75, R16 +5);
    // future-year picks discounted 15%/yr
    const pickVal = (season, round) => {
      const yrs = Math.max(0, (+season) - (+L.season));
      return Math.max(0, (16.5 - Math.min(16, +round)) * 10) * Math.pow(0.85, yrs);
    };
    // the league's real market, keyed by the keeper's surplus AT TRADE TIME
    // (retro: cost slot minus that season's national ADP)
    const MK = TR.market || [];
    const surpMatches = s => MK.filter(e => e.surp != null)
      .map(e => ({ ...e, diff: Math.abs(e.surp - s) }))
      .sort((a, b) => a.diff - b.diff || (b.ts || 0) - (a.ts || 0));
    return { eligible, costRd, surplusSlots, pickVal, surpMatches };
  }

  function assetVal(E, lens, a) {
    if (a.kind === 'pick') return E.pickVal(a.season, a.round);
    const p = byId[a.id];
    if (!p) return 0;
    if (lens === 'keeper') return Math.max(0, E.surplusSlots(p, basis) ?? 0);
    return vorp(p);
  }
  const fmt = v => Math.round(v);
  const fmtS = v => (v > 0 ? '+' : '') + Math.round(v);
  const BASIS_LABEL = { keeper: 'Keeper surplus', adp: 'ADP surplus', board: 'My-rank surplus' };
  const UNIT = () => lens === 'keeper' ? 'surplus' : 'pts';

  // ---------- per-league state ----------
  let L, TR, E, lens, basis, partnerRid, give, get, showAllLog;
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
    TR = trades[tag] || { trades: [], roundHist: {}, tradedPicks: [], market: [] };
    E = makeEngine(L, TR);
    lens = L.status === 'in_season' ? 'season' : 'keeper';
    basis = 'keeper';
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
  const sameAsset = (a, b) => a.kind === b.kind && (a.kind === 'pick'
    ? a.season === b.season && a.round === b.round && a.origRid === b.origRid
    : a.id === b.id);

  // ---------- optimal keeper slate (Keepers-page numbers) ----------
  function slate(pids) {
    return pids.map(pid => byId[pid]).filter(p => E.eligible(p))
      .map(p => ({ p, cost: E.costRd(p), s: E.surplusSlots(p, basis) ?? -999 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, L.keeperMax || 3);
  }
  const slateSum = sl => sl.reduce((t, x) => t + Math.max(0, x.s), 0);

  // ---------- UI pieces ----------
  function playerRow(p, listArr) {
    const inList = listArr.some(a => a.kind === 'player' && a.id === p.id);
    const s = E.surplusSlots(p, basis);
    const v = assetVal(E, lens, { kind: 'player', id: p.id });
    const shown = lens === 'keeper' ? (s ?? 0) : v;
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
        ? `keeper cost R${E.costRd(p)} · ${BASIS_LABEL[basis].toLowerCase()} ${s != null ? fmtS(s) : '–'} (same number as the Keepers page)`
        : 'not keeper-eligible (not in last year\'s draft)' + (p.pos === 'DEF' ? ' — DEF' : ''),
    },
      LAB.headshot(p.id, 'sm'),
      LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;flex:1' }, p.name),
      LAB.posBadge(p.pos),
      E.eligible(p)
        ? LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px;flex:none' }, 'K R' + E.costRd(p))
        : LAB.el('span', { class: 'mono', style: 'font-size:10.5px;flex:none;color:var(--ink-3)' }, '—'),
      LAB.el('b', {
        class: 'mono',
        style: 'width:48px;text-align:right;flex:none;color:' +
          (lens === 'keeper'
            ? (shown > 0 ? '#3ee68f' : shown < 0 ? '#ff5c5c' : 'var(--ink-3)')
            : (shown >= 1 ? '#3ee68f' : 'var(--ink-3)')),
      }, lens === 'keeper' ? (E.eligible(p) ? fmtS(shown) : '0') : fmt(shown)));
  }

  function pickChipTitle(a) {
    return `draft-position value: ≈+${fmt(E.pickVal(a.season, a.round))} slots over a last-round pick`
      + (+a.season > +L.season ? ' · future year, discounted 15%/yr' : '') + ' — click to remove';
  }

  function sideCard(label, roster, listArr) {
    const card = LAB.el('div', { class: 'card', style: 'flex:1;min-width:330px' },
      LAB.el('h2', {}, label),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 6px' },
        teamName(roster.rid) + ' · ' + mgrName(roster.rid) + ' — ' +
        (lens === 'keeper'
          ? `green/red = ${BASIS_LABEL[basis].toLowerCase()} in draft slots, the same numbers as the Keepers page`
          : 'value = rest-of-season projected pts over replacement')));
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
    const pickChips = listArr.filter(a => a.kind === 'pick');
    if (pickChips.length) {
      card.append(LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:5px;margin:4px 0' },
        pickChips.map(a => LAB.el('span', {
          class: 'badge', style: 'cursor:pointer;border:1px solid var(--accent);background:rgba(255,106,43,.12)',
          title: pickChipTitle(a),
          onclick: () => { listArr.splice(listArr.findIndex(x => sameAsset(x, a)), 1); render(); },
        }, `${a.season} R${a.round}` + (a.origRid !== roster.rid ? ` · orig ${teamName(a.origRid)}` : '') + ` — +${fmt(E.pickVal(a.season, a.round))} ✕`))));
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
    const me = myRoster();
    const sentP = give.filter(a => a.kind === 'player').map(a => a.id);
    const gotP = get.filter(a => a.kind === 'player').map(a => a.id);
    let gv, rv, slateD = 0;
    if (lens === 'keeper') {
      // players count by what they do to MY keeper slate — surplus I was
      // never going to keep costs me nothing; picks by their draft position
      const before = slateSum(slate(me.players));
      const after = slateSum(slate(me.players.filter(pid => !sentP.includes(pid)).concat(gotP)));
      slateD = after - before;
      gv = give.filter(a => a.kind === 'pick').reduce((t, a) => t + E.pickVal(a.season, a.round), 0) + Math.max(0, -slateD);
      rv = get.filter(a => a.kind === 'pick').reduce((t, a) => t + E.pickVal(a.season, a.round), 0) + Math.max(0, slateD);
    } else {
      gv = totalOf(give); rv = totalOf(get);
    }
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
      LAB.el('b', { class: 'mono', style: 'width:86px;text-align:right' }, fmt(v) + ' ' + UNIT()));
    card.append(bar('You send', gv, '#ff5c5c'), bar('You get', rv, '#3ee68f'));
    const d = rv - gv, rel = Math.abs(d) / Math.max(gv, rv, 1);
    const label = rel < 0.12 ? ['FAIR DEAL', 'var(--ink-2, #cbd5e1)']
      : d > 0 ? (rel > 0.35 ? ['CLEAR WIN', '#3ee68f'] : ['YOU WIN', '#3ee68f'])
        : (rel > 0.35 ? ['HEAVY LOSS', '#ff5c5c'] : ['YOU LOSE', '#ff5c5c']);
    card.append(LAB.el('div', { class: 'flex', style: 'gap:10px;margin-top:10px;align-items:baseline' },
      LAB.el('b', { style: 'font-family:var(--font-display);font-size:20px;letter-spacing:.03em;color:' + label[1] }, label[0]),
      LAB.el('span', { class: 'mono', style: 'color:' + label[1] }, fmtS(d) + ' ' + UNIT()),
      LAB.el('span', { class: 'muted', style: 'font-size:11.5px' },
        lens === 'keeper'
          ? 'your keeper-slate impact + pick position value, in draft slots'
          : 'rest-of-season projected pts over replacement')));
    // marginal impact of each individual player on MY slate
    const base = slateSum(slate(me.players));
    const marginal = (pid, sent) => sent
      ? base - slateSum(slate(me.players.filter(x => x !== pid)))
      : slateSum(slate(me.players.concat(pid))) - base;
    const item = (a, sent) => {
      if (a.kind === 'pick') return `${a.season} R${a.round} (+${fmt(E.pickVal(a.season, a.round))})`;
      const p = byId[a.id];
      if (lens !== 'keeper') return `${p.name} (${fmt(assetVal(E, lens, a))})`;
      const m = marginal(a.id, sent);
      const raw = E.surplusSlots(p, basis);
      return `${p.name} (slate ${fmtS(sent ? -m : m)}` +
        (E.eligible(p) ? ` · his surplus ${fmtS(raw ?? 0)} · K R${E.costRd(p)})` : ' · no keep)');
    };
    card.append(LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:8px' },
      'Send: ' + (give.map(a => item(a, true)).join(' · ') || '—'), LAB.el('br'),
      'Get: ' + (get.map(a => item(a, false)).join(' · ') || '—')));
    // market guidance: what picks keepers with THIS much surplus have fetched
    // here — the number to quote at the other manager
    if (lens === 'keeper') {
      for (const a of give) {
        if (a.kind !== 'player') continue;
        const p = byId[a.id];
        const s = E.surplusSlots(p, basis);
        if (!E.eligible(p) || s == null) continue;
        const evts = E.surpMatches(s).slice(0, 4);
        if (evts.length) {
          card.append(LAB.el('p', { style: 'font-size:11.5px;margin-top:6px;color:var(--warn)' },
            `⚖ Market: ${p.name} carries ${fmtS(s)} surplus — the closest keepers ever traded here went for `,
            evts.map(e => `R${e.paid.join('+R')} (${e.name} ${fmtS(e.surp)}, '${String(e.season).slice(2)})`).join(' · '),
            ` — ask in that range.`));
        }
      }
    }
    return card;
  }

  function slateLine(x) {
    return LAB.el('div', { class: 'flex', style: 'gap:6px;font-size:12px;padding:2px 0' },
      LAB.headshot(x.p.id, 'sm'),
      LAB.el('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600' }, x.p.name),
      LAB.posBadge(x.p.pos),
      LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px' }, 'R' + x.cost),
      LAB.el('b', { class: 'mono', style: 'width:42px;text-align:right;color:' + (x.s >= 0 ? '#3ee68f' : '#ff5c5c') }, fmtS(x.s)));
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
        `Each team's optimal ${L.keeperMax || 3}-keeper slate before → after this trade, ranked by ${BASIS_LABEL[basis].toLowerCase()} — the SAME numbers as the Keepers page. This answers "is one of theirs better than one of mine" — and shows what you'd be handing them.`));
    const half = (title, before, after) => {
      const sb = slate(before), sa = slate(after);
      const dd = slateSum(sa) - slateSum(sb);
      const swapIn = sa.filter(x => !sb.some(y => y.p.id === x.p.id));
      const swapOut = sb.filter(x => !sa.some(y => y.p.id === x.p.id));
      const box = LAB.el('div', { style: 'flex:1;min-width:300px' },
        LAB.el('div', { class: 'flex', style: 'gap:8px;margin-bottom:4px' },
          LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;font-size:13px' }, title),
          LAB.el('b', { class: 'mono', style: 'font-size:12px;color:' + (dd > 0.5 ? '#3ee68f' : dd < -0.5 ? '#ff5c5c' : 'var(--ink-3)') },
            fmtS(dd) + ' surplus')));
      if (swapIn.length) {
        box.append(LAB.el('div', { style: 'font-size:11px;color:var(--warn);margin-bottom:2px' },
          swapIn.map(x => x.p.name).join(', ') + ' replaces ' + (swapOut.map(x => x.p.name).join(', ') || '(open slot)')));
      }
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

  // "week 1" trades in this league are (per Alex) preseason keeper/pick deals
  const isPre = t => t.week === 1;

  function tradeLine(t) {
    const side = s => LAB.el('div', { class: 'flex', style: 'gap:5px;flex-wrap:wrap;font-size:12px;padding:1px 0' },
      LAB.el('b', { style: 'flex:none' }, s.team + ' got:'),
      s.players.map(p => LAB.el('span', { class: 'mono', style: 'color:var(--' + ({ QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', DEF: 'def' }[p.pos] || 'ink') + ')' },
        p.name + (p.keptAt ? ` (kept R${p.keptAt})` : ''))),
      s.picks.map(pk => LAB.el('span', { class: 'mono', style: 'color:var(--warn)' },
        `${pk.season} R${pk.round}` + (pk.became ? ` → ${pk.became.name}${pk.became.keeper ? ' (K)' : ''}` : ''))),
      (!s.players.length && !s.picks.length) ? LAB.el('span', { class: 'muted' }, 'nothing?') : '');
    return LAB.el('div', { style: 'border:1px solid var(--border);border-radius:8px;padding:6px 9px;margin-top:6px;background:var(--surface)' },
      LAB.el('div', { class: 'mono muted', style: 'font-size:10.5px' },
        `${t.season} · ` + (isPre(t) ? 'preseason' : 'week ' + t.week)),
      t.sides.map(side));
  }

  // how much a historical trade resembles the current proposal. Timing is a
  // HARD GATE: a preseason proposal only compares against preseason trades
  // (and in-season only against in-season). Then: shared players, and picks
  // within three rounds of the proposal's (closer = better).
  function similarity(t) {
    const preNow = L.status !== 'in_season';
    if (isPre(t) !== preNow) return 0;
    let s = 1;
    const propPids = new Set([...give, ...get].filter(a => a.kind === 'player').map(a => a.id));
    const propRounds = [...give, ...get].filter(a => a.kind === 'pick').map(a => a.round);
    let roundHit = 0;
    for (const side of t.sides) {
      for (const p of side.players) if (propPids.has(p.id)) s += 3;
      for (const pk of side.picks) for (const r of propRounds) {
        const d = Math.abs(pk.round - r);
        if (d <= 3) roundHit = Math.max(roundHit, 4 - d);
      }
    }
    s += roundHit;
    // strongest signal: this trade moved a keeper with surplus close to a
    // keeper in the proposal — those are the comps worth quoting
    const sentSurps = [...give, ...get].filter(a => a.kind === 'player')
      .map(a => E.surplusSlots(byId[a.id], basis)).filter(x => x != null);
    if (sentSurps.length && t.ts) {
      for (const e of (TR.market || [])) {
        if (e.ts !== t.ts || e.surp == null) continue;
        const d = Math.min(...sentSurps.map(x => Math.abs(e.surp - x)));
        s += d <= 5 ? 5 : d <= 10 ? 4 : d <= 20 ? 2.5 : d <= 30 ? 1 : 0;
      }
    }
    const tPicks = t.sides.some(x => x.picks.length);
    if (propRounds.length) s += tPicks ? 1 : -1;
    return s;
  }

  function historyCard() {
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, 'League trade history'),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 6px' },
        `${TR.trades.length} completed trades on record. Traded picks show the player they eventually became, traded players show the round they were kept at — that's the honest market rate in this league.`));
    const rounds = [...new Set([...give, ...get].filter(a => a.kind === 'pick').map(a => a.round))].sort((a, b) => a - b);
    for (const r of rounds) {
      const hist = (TR.roundHist[String(r)] || []).filter(x => !x.keeper).slice(0, 10);
      const mk = (TR.market || []).filter(e => Math.abs(e.paid[0] - r) <= 1).slice(0, 4);
      card.append(LAB.el('div', { style: 'margin:8px 0 2px' },
        LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;font-size:12.5px;color:var(--accent)' },
          `What R${r} picks became`),
        LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:5px;margin-top:3px' },
          hist.map(x => LAB.el('span', { class: 'badge', title: x.season }, `${x.season.slice(2)}' ${x.name}`))),
        mk.length ? LAB.el('div', { class: 'muted', style: 'font-size:11px;margin-top:3px' },
          `Picks like this have bought: ` + mk.map(e => `${e.name} kept R${e.cost} ('${String(e.season).slice(2)})`).join(' · ')) : ''));
    }
    if (give.length || get.length) {
      const sims = TR.trades
        .map(t => ({ t, s: similarity(t) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || (b.t.ts || 0) - (a.t.ts || 0))
        .slice(0, 6);
      if (sims.length) {
        card.append(LAB.el('div', { style: 'margin-top:10px' },
          LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em;font-size:12.5px;color:var(--accent)' },
            'Similar trades'),
          LAB.el('span', { class: 'muted', style: 'font-size:11px;margin-left:8px' },
            (L.status !== 'in_season' ? 'preseason deals only' : 'in-season deals only') + ' · shared players · picks within 3 rounds')));
        sims.forEach(x => card.append(tradeLine(x.t)));
      }
    }
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

    const partnerSel = LAB.el('select', {},
      L.rosters.filter(r => r.rid !== me.rid).map(r =>
        LAB.el('option', { value: r.rid, selected: r.rid === partnerRid ? '' : null },
          teamName(r.rid) + ' (' + mgrName(r.rid) + ')')));
    partnerSel.onchange = () => { partnerRid = +partnerSel.value; get = []; render(); };
    const lensSeg = LAB.el('div', { class: 'seg' },
      [['keeper', 'Keeper draft'], ['season', 'In-season']].map(([k, lbl]) =>
        LAB.el('button', { class: k === lens ? 'active' : '', onclick: () => { lens = k; render(); } }, lbl)));
    const basisSeg = LAB.el('div', { class: 'seg', title: 'which Keepers-page surplus to grade with: vs the keeper-draft round, vs ADP, or vs my board rank — always against the round he costs to keep' },
      [['keeper', 'Keeper surplus'], ['adp', 'ADP surplus'], ['board', 'My-rank surplus']].map(([k, lbl]) =>
        LAB.el('button', { class: k === basis ? 'active' : '', onclick: () => { basis = k; render(); } }, lbl)));
    root.append(LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('div', { class: 'flex', style: 'gap:12px;flex-wrap:wrap;align-items:center' },
        LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em' }, 'Trade partner'),
        partnerSel, LAB.el('div', { class: 'spacer', style: 'flex:1' }), lensSeg, basisSeg)));

    root.append(LAB.el('div', { class: 'flex', style: 'gap:14px;margin-top:14px;flex-wrap:wrap;align-items:flex-start' },
      sideCard('You send', me, give),
      sideCard('You receive', partner(), get)));
    root.append(verdictCard());
    root.append(keeperImpactCard());
    root.append(historyCard());
  }

  initLeague();
})();
