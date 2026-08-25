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
    // convex draft-value curve: slot 5 ≈ 90, slot 35 (R4) ≈ 46, slot 95
    // (R10) ≈ 12 — the same 20-slot gap is worth far more up high than late.
    // TRUE SURPLUS = value(market slot) − value(cost slot) on this curve.
    const V = s => 100 * Math.exp(-Math.max(1, s) / 45);
    const surplusSlots = (p, b) => {
      if (!eligible(p)) return null;
      const cost = midPick(costRd(p));
      if (b === 'adp') return p.adp != null ? cost - p.adp : null;
      if (b === 'board') return oRanks[p.id] != null ? cost - oRanks[p.id] : null;
      if (b === 'true') return V(midPick(wouldRd(p))) - V(cost);
      return cost - midPick(wouldRd(p));
    };
    // a pick is worth its DRAFT POSITION: slots of value over a last-round
    // pick, so an earlier pick is always worth more (R4 +125, R9 +75, R16 +5);
    // future-year picks discounted 15%/yr
    const pickVal = (season, round) => {
      const yrs = Math.max(0, (+season) - (+L.season));
      const base = basis === 'true'
        ? V(midPick(Math.min(16, +round))) // same convex curve as true surplus
        : Math.max(0, (16.5 - Math.min(16, +round)) * 10);
      return base * Math.pow(0.85, yrs);
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
  const BASIS_LABEL = { true: 'True surplus', keeper: 'Keeper surplus', adp: 'ADP surplus', board: 'My-rank surplus' };
  const UNIT = () => lens === 'keeper' ? (basis === 'true' ? 'value' : 'surplus') : 'pts';

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
    basis = 'true';
    const myRid = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    partnerRid = (L.rosters.find(r => r.rid !== myRid) || {}).rid;
    give = []; get = []; showAllLog = false;
    finderExcl = new Set(); finderType = 'all'; finderShowAll = false;
    render();
  }
  let finderExcl, finderType, finderShowAll;
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
        // market comps are stored in slot units — always match on those
        const s = E.surplusSlots(p, 'keeper');
        if (!E.eligible(p) || s == null) continue;
        const evts = E.surpMatches(s).slice(0, 4);
        if (evts.length) {
          card.append(LAB.el('p', { style: 'font-size:11.5px;margin-top:6px;color:var(--warn)' },
            `⚖ Market: ${p.name} carries ${fmtS(s)} keeper surplus — the closest keepers ever traded here went for `,
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
      .map(a => E.surplusSlots(byId[a.id], 'keeper')).filter(x => x != null); // comps live in slot units
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

  // ---------- TRADE FINDER ----------
  // Generates opening proposals for the preseason: my SPARE keepers (outside
  // my optimal slate, so they cost my slate nothing) and my open picks, aimed
  // at the partners most likely to say yes — teams sitting on extra picks
  // they literally can't roster, and teams whose keeper slates my spares
  // would upgrade. Asks are a LADDER: an opening ~1 round better than the
  // historical market rate (both leagues' history), and a fallback at market.
  const MKT_ALL = () => [...((trades.ggg || {}).market || []), ...((trades.lob || {}).market || [])];
  const INTEREST = () => {
    // known buyer intel: Chris (VEROVILLIANZ) wants George Pickens
    const vero = L.rosters.find(r => (L.users[r.owner]?.name || '').toUpperCase().startsWith('VEROVILLI'));
    return vero ? [{ rid: vero.rid, pid: '8137', boost: 3.5, note: 'Chris is already interested in Pickens' }] : [];
  };
  const pv = r => Math.max(0, (16.5 - Math.min(16, +r)) * 10);

  function buildProposals() {
    const me = myRoster();
    const rosterOfPid = {};
    L.rosters.forEach(r => (r.players || []).forEach(pid => (rosterOfPid[pid] = r.rid)));
    const { keeps } = LAB.predictKeepers(L, byId, oRanks);
    const kRounds = {}; // rid -> {round: count} consumed by (official+predicted) keepers
    let kCount = {};
    for (const k of keeps) {
      const rid = rosterOfPid[k.pid];
      if (rid == null) continue;
      const r = Math.min(16, k.costRd);
      (kRounds[rid] = kRounds[rid] || {})[r] = (kRounds[rid][r] || 0) + 1;
      kCount[rid] = (kCount[rid] || 0) + 1;
    }
    // a team's OPEN owned picks this season (keeper-consumed rounds removed;
    // keepers on rounds the team no longer owns spill onto the latest opens)
    function openOf(rid) {
      const owned = ownedPicks(rid).filter(o => +o.season === +L.season);
      const used = { ...(kRounds[rid] || {}) };
      const open = [];
      let spill = 0;
      for (const o of owned.slice().sort((a, b) => a.round - b.round || (a.origRid === rid ? -1 : 1))) {
        if (used[o.round] > 0) { used[o.round]--; continue; }
        open.push(o);
      }
      for (const r in used) spill += used[r];
      return open.slice(0, Math.max(0, open.length - spill));
    }
    const myOpen = openOf(me.rid);
    const myOwnedCount = ownedPicks(me.rid).filter(o => +o.season === +L.season).length;
    // my spare keepers: eligible, positive surplus, NOT in my optimal slate.
    // s (display/gain) follows the active basis; sK (slot units) drives the
    // historical market matching
    const mySlateIds = new Set(slate(me.players).map(x => x.p.id));
    const spares = me.players.map(pid => byId[pid])
      .filter(p => E.eligible(p) && !mySlateIds.has(p.id) && (E.surplusSlots(p, basis) ?? 0) > 0)
      .map(p => ({ p, s: E.surplusSlots(p, basis), sK: E.surplusSlots(p, 'keeper'), cost: E.costRd(p) }))
      .sort((a, b) => b.s - a.s);
    // market rate for a keeper of surplus s: median headline pick round of the
    // closest comps across BOTH leagues (fallback: keepers fetch ~1.5 rounds
    // earlier than they cost)
    const rateFor = (s, cost) => {
      const evts = MKT_ALL().filter(e => e.surp != null)
        .map(e => ({ ...e, diff: Math.abs(e.surp - s) }))
        .sort((a, b) => a.diff - b.diff).slice(0, 5).filter(e => e.diff <= 25);
      if (!evts.length) return { round: Math.max(1, Math.round(cost - 1.5)), evts: [] };
      const rounds = evts.map(e => e.paid[0]).sort((a, b) => a - b);
      return { round: rounds[Math.floor(rounds.length / 2)], evts };
    };
    const props = [];
    for (const P of L.rosters) {
      if (P.rid === me.rid) continue;
      const pOpen = openOf(P.rid);
      // roster pressure: every owned pick becomes a player (keepers consume
      // picks, they don't add) — more than 16 owned picks = must shed
      const extra = ownedPicks(P.rid).filter(o => +o.season === +L.season).length - 16;
      const pSlate = slate(P.players);
      const weak3 = pSlate.length >= (L.keeperMax || 3) ? pSlate[pSlate.length - 1].s : -999;
      const baseSum = slateSum(pSlate);
      const chips = [];
      if (extra > 0) chips.push(`${extra} more pick${extra > 1 ? 's' : ''} than roster spots — must shed`);
      if (extra < 0) chips.push(`${-extra} pick${extra < -1 ? 's' : ''} short`);
      if (weak3 < 15 && weak3 > -900) chips.push(`weak #${L.keeperMax || 3} keeper (${fmtS(weak3)})`);
      // A: spare keeper -> their open pick (ladder ask). CRITICAL: the keeper
      // I'm sending must be KEPT at his cost round — that consumes one of
      // THEIR open picks (at his cost, else the next open after, else their
      // latest open), and that pick can never be part of my ask.
      const reserveFor = costRd => {
        let idx = pOpen.findIndex(o => o.round === costRd);
        if (idx < 0) idx = pOpen.findIndex(o => o.round > costRd);
        if (idx < 0) idx = pOpen.length - 1;
        return pOpen.filter((_, i) => i !== idx);
      };
      for (const sp of spares.slice(0, 4)) {
        const gain = slateSum(slate(P.players.concat(sp.p.id))) - baseSum;
        const intr = INTEREST().find(i => i.rid === P.rid && i.pid === sp.p.id);
        if (gain < 3 && !intr) continue;
        const avail = reserveFor(Math.min(16, sp.cost));
        if (!avail.length) continue;
        const { round: mktRd, evts } = rateFor(sp.sK, sp.cost);
        const pickAt = want => avail.find(o => o.round >= want) || avail[avail.length - 1];
        const open = pickAt(Math.max(1, mktRd - 1)), fall = pickAt(mktRd);
        if (!open) continue;
        let score = 5 + (extra > 0 ? 1.5 : extra < 0 ? -2 : 0) + Math.min(2.5, gain / 15) + (weak3 < 15 ? 1 : 0)
          + (evts.length >= 3 ? 1 : 0) + (intr ? intr.boost : 0);
        props.push({
          type: 'keeper', rid: P.rid, score,
          myGain: pv(open.round), theirGain: gain, chips: intr ? [...chips, intr.note] : chips,
          title: `${sp.p.name} (K R${sp.cost} · ${fmtS(sp.s)}) → their pick`,
          opening: { give: [{ kind: 'player', id: sp.p.id }], get: [{ kind: 'pick', ...open }], label: `2026 R${open.round}${open.origRid !== P.rid ? ' (orig ' + teamName(open.origRid) + ')' : ''}` },
          fallback: fall && fall !== open ? { give: [{ kind: 'player', id: sp.p.id }], get: [{ kind: 'pick', ...fall }], label: `2026 R${fall.round}${fall.origRid !== P.rid ? ' (orig ' + teamName(fall.origRid) + ')' : ''}` } : null,
          precedent: evts.slice(0, 3).map(e => `R${e.paid.join('+R')} (${e.name} ${fmtS(e.surp)}, '${String(e.season).slice(2)})`).join(' · ')
            || 'no close comps — priced from the cost-round rule of thumb',
        });
      }
      // B: consolidation — my 1 earlier open pick for 2 of their opens.
      // ONLY when it works for both rosters: I must be UNDER 16 picks (or
      // I couldn't roster my own draft class) and they must be OVER
      if (pOpen.length >= 2 && myOwnedCount < 16 && extra > 0) {
        let best = null;
        for (const a of myOpen) {
          if (a.round < 3) continue; // my early picks aren't for sale
          const later = pOpen.filter(o => o.round > a.round);
          for (let i = 0; i < later.length - 1; i++) {
            const b = later[i], c = later[i + 1];
            const net = pv(b.round) + pv(c.round) - pv(a.round);
            // my edge must be real but small enough that a crunched team
            // still says yes (consolidating is worth a modest haircut to
            // them, not a fleecing)
            if (net < 8 || net > 40) continue;
            const theirNet = -net + (extra > 0 ? 25 : 0);
            if (theirNet < -15) continue;
            const score = 3.5 + (extra > 0 ? 2.5 : extra < 0 ? -3 : 0) + Math.min(2, net / 15) - Math.max(0, -theirNet) / 15;
            if (!best || score + net / 100 > best.score + best.net / 100) {
              best = { a, b, c, net, score };
            }
          }
        }
        if (best) {
          props.push({
            type: 'picks', rid: P.rid, score: best.score,
            myGain: best.net, theirGain: -best.net + (extra > 0 ? 25 : 0), chips,
            title: `my 2026 R${best.a.round} → their R${best.b.round} + R${best.c.round} (they consolidate)`,
            opening: {
              give: [{ kind: 'pick', ...best.a }],
              get: [{ kind: 'pick', ...best.b }, { kind: 'pick', ...best.c }],
              label: `2026 R${best.b.round} + R${best.c.round}`,
            },
            fallback: null,
            precedent: 'pick-for-pick swaps: they turn spare picks into one better one',
          });
        }
      }
    }
    return props.sort((x, y) => y.score - x.score || y.myGain - x.myGain);
  }

  function loadProposal(rid, side) {
    partnerRid = rid;
    give = side.give.map(a => ({ ...a }));
    get = side.get.map(a => ({ ...a }));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finderCard() {
    const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
      LAB.el('h2', {}, '🔎 Trade Finder — preseason openers'),
      LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:2px 0 8px' },
        'Proposals built from YOUR spare keepers (outside your optimal slate — sending them costs you nothing) and open picks, aimed at the teams most likely to accept: pick-rich rosters that must shed, and weak keeper slates your spares upgrade. Never asks for a pick a keeper is sitting on. Each card: an OPENING ask ~1 round better than the market rate from both leagues\' trade history, and a FALLBACK at market. Send several — one falls.'));
    if (lens !== 'keeper') {
      card.append(LAB.el('p', { class: 'muted', style: 'font-size:12px' }, 'Switch to the Keeper draft lens for preseason proposals.'));
      return card;
    }
    const props = buildProposals();
    // filters: team chips EXCLUDE — click a team to hide its proposals
    const teams = [...new Set(props.map(x => x.rid))];
    const chipRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:6px;margin-bottom:8px' });
    const mkChip = (label, active, fn, dim) => LAB.el('button', {
      class: active ? 'active' : '', style: 'font-size:11.5px;padding:3px 9px' + (dim ? ';opacity:.45;text-decoration:line-through' : ''),
      title: dim ? 'hidden — click to show again' : undefined, onclick: fn,
    }, label);
    chipRow.append(mkChip('All teams', finderExcl.size === 0, () => { finderExcl = new Set(); render(); }));
    teams.forEach(rid => chipRow.append(mkChip(mgrName(rid) || teamName(rid), false, () => {
      if (finderExcl.has(rid)) finderExcl.delete(rid); else finderExcl.add(rid);
      render();
    }, finderExcl.has(rid))));
    chipRow.append(LAB.el('span', { style: 'width:10px' }));
    [['all', 'All types'], ['keeper', 'Keeper → pick'], ['picks', 'Pick swaps']].forEach(([k, lbl]) =>
      chipRow.append(mkChip(lbl, finderType === k, () => { finderType = k; render(); })));
    card.append(chipRow);
    const shown = props.filter(x => !finderExcl.has(x.rid) && (finderType === 'all' || x.type === finderType));
    const list = finderShowAll ? shown : shown.slice(0, 8);
    if (!list.length) card.append(LAB.el('p', { class: 'muted', style: 'font-size:12px' }, 'No proposals under these filters — your spares don\'t upgrade these slates, or no open picks line up.'));
    for (const x of list) {
      const tag_ = x.score >= 8 ? ['🔥 likely', '#3ee68f'] : x.score >= 6 ? ['⚖ coin-flip', 'var(--warn)'] : ['🎯 anchor shot', '#ff5c5c'];
      const row = LAB.el('div', { style: 'border:1px solid var(--border);border-radius:9px;padding:8px 10px;margin-top:7px;background:var(--surface)' },
        LAB.el('div', { class: 'flex', style: 'gap:8px;flex-wrap:wrap;align-items:baseline' },
          LAB.el('b', { style: 'font-family:var(--font-display);font-size:14px' }, mgrName(x.rid) || teamName(x.rid)),
          LAB.el('b', { style: 'font-size:11.5px;color:' + tag_[1] }, tag_[0]),
          LAB.el('span', { class: 'mono', style: 'font-size:11px;color:#3ee68f' }, `you ${fmtS(x.myGain)}`),
          LAB.el('span', { class: 'mono muted', style: 'font-size:11px' }, `them ${fmtS(Math.round(x.theirGain))}`),
          x.chips.map(c => LAB.el('span', { class: 'badge', style: 'font-size:9.5px' }, c))),
        LAB.el('div', { style: 'font-size:12.5px;margin-top:3px;font-weight:600' }, x.title),
        LAB.el('div', { class: 'flex', style: 'gap:8px;flex-wrap:wrap;margin-top:5px;align-items:center' },
          LAB.el('button', { style: 'font-size:11.5px', onclick: () => loadProposal(x.rid, x.opening) }, `OPEN: ask ${x.opening.label} ▸`),
          x.fallback ? LAB.el('button', { style: 'font-size:11.5px', onclick: () => loadProposal(x.rid, x.fallback) }, `FALLBACK: ${x.fallback.label} ▸`) : ''),
        LAB.el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:4px' }, '⚖ ' + x.precedent));
      card.append(row);
    }
    if (!finderShowAll && shown.length > 8) {
      card.append(LAB.el('button', { style: 'margin-top:8px', onclick: () => { finderShowAll = true; render(); } }, `show all ${shown.length} proposals`));
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
    const basisSeg = LAB.el('div', { class: 'seg', title: 'True surplus (default) weights the gap on a convex draft-value curve — the same slots saved count for much more early in the draft. The other three are the raw Keepers-page surpluses: vs keeper-draft round, vs ADP, vs my board rank.' },
      [['true', 'True surplus'], ['keeper', 'Keeper surplus'], ['adp', 'ADP surplus'], ['board', 'My-rank surplus']].map(([k, lbl]) =>
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
    root.append(finderCard());
  }

  initLeague();
})();
