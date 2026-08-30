/* THE LAB — shared trade engine + proposal generator (used by finder.js).
   All valuation follows the settled house rules:
   - keeper surplus bases: true (convex value curve, default) / keeper (sKrd)
     / adp / board — identical numbers to the Keepers page
   - picks: draft-position value, on the convex curve under the true basis
   - market: historical preseason keeper-for-pick trades from BOTH leagues,
     matched by the keeper's surplus at trade time (slot units)
   - roster law: 16 owned picks = 16 roster spots; keepers CONSUME picks
     (their cost round, spilling to the next owned open pick) */
(function () {
  LAB.tradeCore = function (players, board, L, TR, allTrades) {
    const byId = LAB.playersById(players);
    const oRanks = LAB.overallRanks(board);
    const kSim = LAB.keeperSim(players, L, board);
    const midPick = r => (r - 0.5) * 10;
    const V = s => 100 * Math.exp(-Math.max(1, s) / 45);
    const actual = {};
    for (const k of (L.draftKeepers || [])) actual[k.pid] = k.round;
    const kept = new Set(L.lastKept || []);
    const eligible = p => p && p.pos !== 'DEF' && !!L.lastDraftRound[p.id];
    const costRd = p => Math.min(16, actual[p.id]
      ?? LAB.keeperCostRound(L, L.lastDraftRound[p.id] || null, kept.has(p.id)));
    const wouldRd = p => kSim.rounds[p.id] ?? kSim.wouldBe(p);
    // 'adp' is KEEPER-AWARE (v40): ADP mapped onto this keeper board via
    // wouldRd; 'true' = value-curve average of the board and keeper-ADP
    // forms; 'keeper' remains an alias of 'adp'
    const surplusSlots = (p, b) => {
      if (!eligible(p)) return null;
      const cost = midPick(costRd(p));
      if (b === 'board') return oRanks[p.id] != null ? cost - oRanks[p.id] : null;
      if (b === 'true') {
        const vAdp = V(midPick(wouldRd(p))) - V(cost);
        const vBoard = oRanks[p.id] != null ? V(Math.max(1, oRanks[p.id])) - V(cost) : null;
        return vBoard == null ? vAdp : (vAdp + vBoard) / 2;
      }
      return cost - midPick(wouldRd(p)); // 'adp' (and legacy 'keeper')
    };
    // ---- real draft-pick numbers (snake) ----
    // a "3rd rounder" is not one asset: with 10 teams the first 3rd is pick 21
    // and the last is pick 30. A pick sits at the ORIGINAL owner's slot no
    // matter who holds it, so value it there. Falls back to the round midpoint
    // when the draft order is not set yet.
    const dd = L.draftDetail || {};
    const N = (L.rosters || []).length || 10;
    const slotOfRoster = {};
    Object.entries(dd.slotToRoster || {}).forEach(([slot, rid]) => (slotOfRoster[rid] = +slot));
    const pickNo = (round, origRid) => {
      const r = Math.min(16, Math.max(1, +round || 1));
      const slot = slotOfRoster[origRid];
      if (!slot) return (r - 0.5) * N;
      return (r - 1) * N + (r % 2 === 1 ? slot : N + 1 - slot);
    };
    const pickVal = (season, round, b, origRid) => {
      const yrs = Math.max(0, (+season) - (+L.season));
      const no = pickNo(round, origRid);
      const base = b === 'true' ? V(no) : Math.max(0, N * 16 - no);
      return base * Math.pow(0.85, yrs);
    };

    // ---- cap band ----
    // salary is the flattened round table and EVERY held pick counts toward
    // the opening (16 is the post-draft roster limit, not a cap cutoff). The
    // band is only enforced in the WORSENING direction, matching the league
    // rule: a team already outside it may not move further outside.
    const SALARY = { 1: 30, 2: 26, 3: 22, 4: 19, 5: 16, 6: 14, 7: 12, 8: 10,
      9: 8, 10: 7, 11: 6, 12: 5, 13: 4, 14: 3, 15: 2, 16: 2 };
    const CAP = L.capMax ?? 230, FLOOR = L.capMin ?? 160;
    const salaryOf = a => (a && a.kind === 'pick' && String(a.season) === String(L.season))
      ? (SALARY[Math.min(16, +a.round)] || 0) : 0;
    const openAmt = rid => ownedPicks(rid).reduce((t, p) => t + (SALARY[p.round] || 0), 0);
    const bandOk = (before, after) =>
      !((after > CAP && after > before) || (after < FLOOR && after < before));
    // give = what I send them, get = what I receive
    const tradeLegal = (rid, give, get) => {
      const sum = arr => (arr || []).reduce((t, a) => t + salaryOf(a), 0);
      const inbound = sum(get), outbound = sum(give);
      if (!inbound && !outbound) return true;            // players only: cap-neutral
      const tBefore = openAmt(rid), mBefore = openAmt(myRid);
      return bandOk(tBefore, tBefore + outbound - inbound)
        && bandOk(mBefore, mBefore + inbound - outbound);
    };

    // ---- pick ownership + keeper consumption ----
    const ownedPicks = rid => {
      const out = [];
      const s = +L.season;
      for (let r = 1; r <= 16; r++) {
        const away = (TR.tradedPicks || []).find(t => +t.season === s && t.round === r && t.origRid === rid && t.ownerRid !== rid);
        if (!away) out.push({ season: String(s), round: r, origRid: rid });
      }
      for (const t of (TR.tradedPicks || [])) {
        if (+t.season === s && t.ownerRid === rid && t.origRid !== rid) out.push({ season: String(s), round: t.round, origRid: t.origRid });
      }
      return out.sort((a, b) => a.round - b.round);
    };
    const rosterOfPid = {};
    L.rosters.forEach(r => (r.players || []).forEach(pid => (rosterOfPid[pid] = r.rid)));
    const keeps = LAB.predictKeepers(L, byId, oRanks).keeps;
    const kRounds = {};
    for (const k of keeps) {
      const rid = rosterOfPid[k.pid];
      if (rid == null) continue;
      const r = Math.min(16, k.costRd);
      (kRounds[rid] = kRounds[rid] || {})[r] = (kRounds[rid][r] || 0) + 1;
    }
    const openOf = rid => {
      const used = { ...(kRounds[rid] || {}) };
      const open = [];
      let spill = 0;
      for (const o of ownedPicks(rid)) {
        if (used[o.round] > 0) { used[o.round]--; continue; }
        open.push(o);
      }
      for (const r in used) spill += used[r];
      return open.slice(0, Math.max(0, open.length - spill));
    };
    // remove ONE open pick to keep an incoming keeper at his cost round
    // (at cost, else the next open after, else the latest open)
    const reserve = (opens, cost) => {
      let i = opens.findIndex(o => o.round === cost);
      if (i < 0) i = opens.findIndex(o => o.round > cost);
      if (i < 0) i = opens.length - 1;
      return i < 0 ? null : opens.filter((_, j) => j !== i);
    };

    // ---- slates ----
    const slate = (pids, b) => pids.map(pid => byId[pid]).filter(p => eligible(p))
      .map(p => ({ p, cost: costRd(p), s: surplusSlots(p, b) ?? -999 }))
      .sort((x, y) => y.s - x.s).slice(0, L.keeperMax || 3);
    const slateSum = sl => sl.reduce((t, x) => t + Math.max(0, x.s), 0);

    // ---- historical market (BOTH leagues, slot units) ----
    const MKT = [...((allTrades.ggg || {}).market || []), ...((allTrades.lob || {}).market || [])];
    const surpMatches = s => MKT.filter(e => e.surp != null)
      .map(e => ({ ...e, diff: Math.abs(e.surp - s) }))
      .sort((a, b) => a.diff - b.diff || (b.ts || 0) - (a.ts || 0));
    const marketRound = (sK, cost) => {
      const evts = surpMatches(sK).slice(0, 5).filter(e => e.diff <= 25);
      if (!evts.length) return { round: Math.max(1, Math.round(cost - 1.5)), evts: [] };
      const rounds = evts.map(e => e.paid[0]).sort((a, b) => a - b);
      return { round: rounds[Math.floor(rounds.length / 2)], evts };
    };

    // ---- trade propensity from real history (uid-keyed) ----
    const propensity = {};
    {
      const counts = {}, pre = {};
      for (const t of (TR.trades || [])) {
        for (const sd of t.sides) {
          if (!sd.uid) continue;
          counts[sd.uid] = (counts[sd.uid] || 0) + 1;
          if (String(t.season) === String(L.season)) pre[sd.uid] = (pre[sd.uid] || 0) + 1;
        }
      }
      const seasons = Math.max(1, new Set((TR.trades || []).map(t => t.season)).size);
      for (const r of L.rosters) {
        const n = counts[r.owner] || 0, rate = n / seasons;
        propensity[r.rid] = {
          n, rate, pre: pre[r.owner] || 0,
          score: (rate >= 4 ? 2 : rate >= 2 ? 1.2 : rate >= 1 ? 0.6 : 0) + ((pre[r.owner] || 0) > 0 ? 0.8 : 0),
        };
      }
    }

    const myRid = (L.rosters.find(r => r.owner === L.myUserId) || {}).rid;
    return {
      byId, oRanks, midPick, V, eligible, costRd, wouldRd, surplusSlots, pickVal,
      ownedPicks, openOf, reserve, slate, slateSum, surpMatches, marketRound,
      propensity, myRid, keeps, rosterOfPid,
      pickNo, openAmt, tradeLegal, CAP, FLOOR, SALARY,
    };
  };

  /* Proposal generator. opts:
     basis, aggr ('market'|'ladder'|'aggressive'), maxAssets (2|3),
     weights {motivation, propensity, fairness, market, intel} (multipliers),
     intel [{rid, pid?, boost, note}] */
  LAB.tradeFinder = function (C, L, opts) {
    const o = { basis: 'true', aggr: 'ladder', maxAssets: 3,
      weights: { motivation: 1, propensity: 1, fairness: 1, market: 1, intel: 1 }, intel: [], ...opts };
    const W = o.weights;
    const b = o.basis;
    const me = L.rosters.find(r => r.rid === C.myRid);
    const myOpen = C.openOf(C.myRid);
    const myOwned = C.ownedPicks(C.myRid).length;
    const mySlate = C.slate(me.players, b);
    const mySlateIds = new Set(mySlate.map(x => x.p.id));
    const mySlateSum = C.slateSum(mySlate);
    const spares = me.players.map(pid => C.byId[pid])
      .filter(p => C.eligible(p) && !mySlateIds.has(p.id) && (C.surplusSlots(p, b) ?? 0) > 0)
      .map(p => ({ p, s: C.surplusSlots(p, b), sK: C.surplusSlots(p, 'keeper'), cost: C.costRd(p) }))
      .sort((x, y) => y.s - x.s);
    const pv = pk => C.pickVal(L.season, pk.round, b, pk.origRid);
    const fmtPick = (pk, rid) => `2026 R${pk.round}` + (pk.origRid !== rid ? ` (orig)` : '');
    const props = [];
    const push = x => props.push(x);
    const intelFor = (rid, pids) => (o.intel || []).filter(i => i.rid === rid && (!i.pid || pids.includes(i.pid)));
    const scoreOf = parts => 3 + parts.reduce((t, p) => t + p.v, 0);
    // rung selection by aggressiveness
    const rungs = (avail, mktRd) => {
      const at = want => avail.find(x => x.round >= want) || avail[avail.length - 1];
      const anchor = at(Math.max(1, mktRd - (o.aggr === 'aggressive' ? 2 : 1)));
      const market = at(mktRd);
      const list = [];
      if (o.aggr !== 'market' && anchor) list.push({ label: 'OPENING', pick: anchor });
      if (market && (!anchor || market.round !== anchor.round || o.aggr === 'market')) list.push({ label: o.aggr === 'market' ? 'ASK' : 'FALLBACK', pick: market });
      if (!list.length && avail.length) list.push({ label: 'ASK', pick: avail[avail.length - 1] });
      return list;
    };

    for (const P of L.rosters) {
      if (P.rid === C.myRid) continue;
      const pOpen = C.openOf(P.rid);
      const pOwned = C.ownedPicks(P.rid).length;
      const extra = pOwned - 16;
      const pSlate = C.slate(P.players, b);
      const pSum = C.slateSum(pSlate);
      const weak3 = pSlate.length >= (L.keeperMax || 3) ? pSlate[pSlate.length - 1].s : -999;
      const prop = C.propensity[P.rid] || { score: 0, n: 0, pre: 0 };
      const chips = [];
      if (extra > 0) chips.push(`${extra} pick${extra > 1 ? 's' : ''} over roster — must shed`);
      if (extra < 0) chips.push(`${-extra} pick${extra < -1 ? 's' : ''} short`);
      if (prop.pre > 0) chips.push(`already trading this preseason (${prop.pre})`);
      else if (prop.rate >= 2) chips.push(`frequent trader (${prop.n} all-time)`);
      else if (prop.rate < 0.8) chips.push(`rarely trades (${prop.n} all-time)`);
      if (weak3 < 12 && weak3 > -900) chips.push(`weak #${L.keeperMax || 3} keeper`);
      const baseParts = motiv => ([
        { k: 'motivation', v: W.motivation * motiv },
        { k: 'propensity', v: W.propensity * prop.score },
      ]);

      // ---- SELL: keeper (+optional sweetener / pair) -> their pick ----
      for (const sp of spares.slice(0, 4)) {
        const afterSlate = C.slate(P.players.concat(sp.p.id), b);
        const gain = C.slateSum(afterSlate) - pSum;
        // who my keeper would knock off their slate — the perspective line
        const disp = pSlate.find(x => !afterSlate.some(y => y.p.id === x.p.id));
        const slotLine = afterSlate.some(y => y.p.id === sp.p.id)
          ? (disp ? `replaces ${disp.p.name} (+${Math.round(disp.s)}) on their keeper slate` : 'fills an empty keeper slot for them')
          : (pSlate.length ? `doesn't crack their slate (their #${pSlate.length}: ${pSlate[pSlate.length - 1].p.name} +${Math.round(pSlate[pSlate.length - 1].s)})` : '');
        const intel = intelFor(P.rid, [sp.p.id]);
        if (gain < 3 && !intel.length) continue;
        const avail = C.reserve(pOpen, sp.cost);
        if (!avail || !avail.length) continue;
        const { round: mktRd, evts } = C.marketRound(sp.sK, sp.cost);
        const rr = rungs(avail, mktRd);
        if (!rr.length) continue;
        for (const r of rr) {
          push({
            type: 'sell', rid: P.rid,
            give: [{ kind: 'player', id: sp.p.id }], get: [{ kind: 'pick', ...r.pick }],
            rung: r.label, chips,
            myGain: pv(r.pick), theirGain: gain,
            parts: [...baseParts((extra > 0 ? 1.5 : extra < 0 ? -1.5 : 0) + (weak3 < 12 ? 1 : 0)),
              { k: 'fairness', v: W.fairness * Math.min(2, gain / 12) },
              { k: 'market', v: (r.pick.round >= mktRd ? 1.2 : -0.9 * (mktRd - r.pick.round)) * W.market + (evts.length >= 3 ? 0.5 : 0) },
              ...intel.map(i => ({ k: 'intel', v: W.intel * (i.boost ?? 3) }))],
            title: `${sp.p.name} (K R${sp.cost}) → their ${fmtPick(r.pick, P.rid)}`,
            why: gain > 3 ? `${slotLine} — net +${Math.round(gain)}` : [intel[0]?.note, slotLine].filter(Boolean).join(' · '),
            precedent: evts.slice(0, 3).map(e => `R${e.paid.join('+R')} (${e.name} ${e.surp > 0 ? '+' : ''}${e.surp}, '${String(e.season).slice(2)})`).join(' · ') || 'no close comps — cost-round rule of thumb',
          });
        }
        // package: keeper + my late open pick -> ~2 rounds better than solo market
        if (o.maxAssets >= 3) {
          const sweet = myOpen.filter(x => x.round >= 8).slice(-1)[0];
          const target = C.reserve(pOpen, sp.cost);
          const up = target && target.find(x => x.round >= Math.max(1, mktRd - 3) && x.round < mktRd);
          if (sweet && up && gain >= 3) {
            push({
              type: 'sell', rid: P.rid,
              give: [{ kind: 'player', id: sp.p.id }, { kind: 'pick', ...sweet }], get: [{ kind: 'pick', ...up }],
              rung: 'PACKAGE', chips,
              myGain: pv(up) - pv(sweet), theirGain: gain + pv(sweet) - 0,
              parts: [...baseParts((extra > 0 ? 1 : 0) + (weak3 < 12 ? 1 : 0)),
                { k: 'fairness', v: W.fairness * Math.min(2, (gain + 5) / 12) },
                { k: 'market', v: 0.4 * W.market },
                ...intel.map(i => ({ k: 'intel', v: W.intel * (i.boost ?? 3) }))],
              title: `${sp.p.name} + my R${sweet.round} → their ${fmtPick(up, P.rid)}`,
              why: `${slotLine} + an extra pick for them; I move up to R${up.round}`,
              precedent: 'package pricing: solo market ' + `R${mktRd}` + ' improved ~' + (mktRd - up.round) + ' rounds by the sweetener',
            });
          }
        }
      }
      // pair of spares -> one good pick
      if (o.maxAssets >= 3 && spares.length >= 2) {
        const [a2, b2] = spares;
        const after2 = C.slate(P.players.concat(a2.p.id, b2.p.id), b);
        const gain2 = C.slateSum(after2) - pSum;
        const disp2 = pSlate.filter(x => !after2.some(y => y.p.id === x.p.id)).map(x => `${x.p.name} (+${Math.round(x.s)})`);
        if (gain2 >= 8) {
          let avail = C.reserve(pOpen, a2.cost);
          avail = avail && C.reserve(avail, b2.cost);
          const mkt2 = Math.max(1, C.marketRound(a2.sK, a2.cost).round - 2);
          const up = avail && avail.find(x => x.round >= mkt2);
          if (up) {
            push({
              type: 'sell', rid: P.rid,
              give: [{ kind: 'player', id: a2.p.id }, { kind: 'player', id: b2.p.id }], get: [{ kind: 'pick', ...up }],
              rung: 'PAIR', chips,
              myGain: pv(up), theirGain: gain2,
              parts: [...baseParts((extra > 0 ? 1 : 0) + 1),
                { k: 'fairness', v: W.fairness * Math.min(2.5, gain2 / 10) },
                { k: 'market', v: 0.3 * W.market }],
              title: `${a2.p.name} + ${b2.p.name} → their ${fmtPick(up, P.rid)}`,
              why: `they'd replace ${disp2.join(' and ') || 'empty slots'} on their slate (+${Math.round(gain2)})`,
              precedent: 'double-keeper deals price ~2 rounds above the better solo comp',
            });
          }
        }
      }
      // ---- BUY: their spare keeper -> my pick ----
      {
        const theirSlateIds = new Set(pSlate.map(x => x.p.id));
        const theirSpares = (P.players || []).map(pid => C.byId[pid])
          .filter(p => C.eligible(p) && !theirSlateIds.has(p.id) && (C.surplusSlots(p, b) ?? 0) > 0)
          .map(p => ({ p, s: C.surplusSlots(p, b), sK: C.surplusSlots(p, 'keeper'), cost: C.costRd(p) }))
          .sort((x, y) => y.s - x.s).slice(0, 3);
        for (const ts of theirSpares) {
          const myGain = C.slateSum(C.slate(me.players.concat(ts.p.id), b)) - mySlateSum;
          if (myGain < 3) continue;
          const afterReserve = C.reserve(myOpen, ts.cost);
          if (!afterReserve) continue;
          const { round: mktRd, evts } = C.marketRound(ts.sK, ts.cost);
          // pay one round LATER than market first (cheap), fallback at market
          const at = want => afterReserve.find(x => x.round >= want) || afterReserve[afterReserve.length - 1];
          const cheap = at(mktRd + (o.aggr === 'aggressive' ? 2 : 1)), fair = at(mktRd);
          const rr = o.aggr === 'market' ? [{ label: 'OFFER', pick: fair }]
            : [cheap && { label: 'OPENING', pick: cheap }, fair && fair.round !== cheap?.round && { label: 'FALLBACK', pick: fair }].filter(Boolean);
          for (const r of rr) {
            if (!r.pick) continue;
            push({
              type: 'buy', rid: P.rid,
              give: [{ kind: 'pick', ...r.pick }], get: [{ kind: 'player', id: ts.p.id }],
              rung: r.label, chips,
              myGain: myGain - pv(r.pick) / 3, theirGain: pv(r.pick),
              parts: [...baseParts((extra < 0 ? 1 : 0) + 0.5),
                { k: 'fairness', v: W.fairness * (r.pick.round <= mktRd ? 1.5 : 0.4) },
                { k: 'market', v: (r.pick.round <= mktRd ? 0.8 : -0.2) * W.market + (evts.length >= 3 ? 0.4 : 0) }],
              title: `their ${ts.p.name} (K R${ts.cost}) ← my R${r.pick.round}`,
              why: `he's OUTSIDE their top-${L.keeperMax || 3} (worthless to them) and upgrades MY slate +${Math.round(myGain)}`,
              precedent: evts.slice(0, 3).map(e => `R${e.paid.join('+R')} (${e.name}, '${String(e.season).slice(2)})`).join(' · ') || 'cost-round rule of thumb',
            });
          }
        }
        // ---- SWAP: my spare <-> their spare, both slates improve ----
        for (const sp of spares.slice(0, 3)) {
          for (const ts of theirSpares) {
            const afterM = C.slate(me.players.filter(x => x !== sp.p.id).concat(ts.p.id), b);
            const afterT = C.slate(P.players.filter(x => x !== ts.p.id).concat(sp.p.id), b);
            const mg = C.slateSum(afterM) - mySlateSum;
            const tg = C.slateSum(afterT) - pSum;
            if (mg < 3 || tg < 2) continue;
            const dispT = pSlate.find(x => x.p.id !== ts.p.id && !afterT.some(y => y.p.id === x.p.id));
            push({
              type: 'swap', rid: P.rid,
              give: [{ kind: 'player', id: sp.p.id }], get: [{ kind: 'player', id: ts.p.id }],
              rung: 'SWAP', chips,
              myGain: mg, theirGain: tg,
              parts: [...baseParts(0.5),
                { k: 'fairness', v: W.fairness * Math.min(2.5, tg / 8) },
                { k: 'market', v: 0.6 * W.market }],
              title: `${sp.p.name} ⇄ ${ts.p.name}`,
              why: `win-win: my slate +${Math.round(mg)}, theirs +${Math.round(tg)}` + (dispT ? ` — ${sp.p.name} replaces ${dispT.p.name} (+${Math.round(dispT.s)}) for them` : ''),
              precedent: 'keeper-for-keeper: both sides keep someone they otherwise lose',
            });
          }
        }
      }
      // ---- consolidation DOWN (I'm OVER): my 2 later picks -> their 1
      // higher — the shed leg of the broker play. They must be UNDER 16
      // (they need the count), and my value haircut stays small.
      if (myOwned > 16 && pOwned < 16 && myOpen.length >= 2) {
        let best = null;
        for (const a of pOpen) {
          if (a.round < 3) continue; // their early picks aren't for sale either
          const laters = myOpen.filter(x => x.round > a.round);
          for (let i = 0; i < laters.length - 1; i++) {
            const net = pv(a) - pv(laters[i]) - pv(laters[i + 1]);
            if (net < -8 || net > 8) continue; // near-fair; count is their payment
            if (Lv(laters[i]) + Lv(laters[i + 1]) - Lv(a) < 0) continue; // chart optics
            const score = 4 + 2 * W.motivation + Math.min(1.5, Math.max(0, net) / 10) + W.propensity * prop.score * 0.5;
            if (!best || score > best.score) best = { a, b: laters[i], c: laters[i + 1], net, score };
          }
        }
        if (best) {
          push({
            type: 'picks', rid: P.rid, score: best.score,
            give: [{ kind: 'pick', ...best.b }, { kind: 'pick', ...best.c }], get: [{ kind: 'pick', ...best.a }],
            rung: 'SHED', chips: [...chips, 'I must shed — they need count'],
            myGain: best.net + 10, theirGain: 15 - Math.max(0, best.net),
            parts: [{ k: 'motivation', v: 2 * W.motivation }, { k: 'propensity', v: W.propensity * prop.score * 0.5 },
              { k: 'fairness', v: W.fairness * (best.net <= 0 ? 1.2 : 0.6) }],
            title: `my R${best.b.round} + R${best.c.round} → their R${best.a.round} (I consolidate down)`,
            why: `they're ${16 - pOwned} pick${16 - pOwned > 1 ? 's' : ''} short — two real picks fix their roster math`,
            precedent: 'the shed leg: count for them, quality for me',
          });
        }
      }
      // ---- consolidation UP (I'm UNDER): my 1 pick -> their 2 later ----
      if (myOwned < 16 && extra > 0 && pOpen.length >= 2) {
        for (const a of myOpen) {
          if (a.round < 3) continue;
          const later = pOpen.filter(x => x.round > a.round);
          for (let i = 0; i < later.length - 1; i++) {
            const net = pv(later[i]) + pv(later[i + 1]) - pv(a);
            if (net < 5 || net > 40) continue;
            push({
              type: 'picks', rid: P.rid,
              give: [{ kind: 'pick', ...a }], get: [{ kind: 'pick', ...later[i] }, { kind: 'pick', ...later[i + 1] }],
              rung: 'SWAP', chips,
              myGain: net, theirGain: -net + 20,
              parts: [...baseParts(2.5), { k: 'fairness', v: -net / 20 * W.fairness }, { k: 'market', v: 0.3 }],
              title: `my R${a.round} → their R${later[i].round} + R${later[i + 1].round}`,
              why: 'they consolidate down to roster size; I add a pick I have room for',
              precedent: 'pick-for-pick: spare picks become one better one',
            });
            break;
          }
          break;
        }
      }
    }
    for (const x of props) x.score = scoreOf(x.parts);
    // a proposal that pushes either side further outside the cap band is not a
    // trade the league would let them make — never surface it
    return props.filter(x => C.tradeLegal(x.rid, x.give, x.get));
  };

  // OPTICS: partners judge pick trades on a classic linear chart, not my
  // convex curve. A shed leg (my 2 -> their 1) must LOOK good to them there:
  // the two picks they receive must be worth >= the one they give, linearly.
  // This kills "R14+R15 for your R8" (-45 on their chart) but keeps
  // "R10+R14 for your R8" (+5 on their chart, still curve-positive for me).

  // small follow-up shed that returns me to 16 after a trade hands me an
  // extra pick: give 2 of my laters -> 1 higher from an under-16 team,
  // near-fair (their real payment is the count they need)
  LAB.rebalanceFor = function (C, L, opts) {
    const o = { exclude: [], ...opts }; // pick keys I can't give (spent in the main trade)
    const myOpen = C.openOf(C.myRid).filter(p => !o.exclude.includes(p.round + '.' + p.origRid));
    const pv = pk => C.pickVal(L.season, pk.round, 'true', pk.origRid);
    const Lv = pk => C.pickVal(L.season, pk.round, 'linear', pk.origRid);
    let best = null;
    for (const P of L.rosters) {
      if (P.rid === C.myRid) continue;
      const pOwned = C.ownedPicks(P.rid).length;
      if (pOwned >= 16) continue;
      const prop = (C.propensity[P.rid] || {}).score || 0;
      for (const d of C.openOf(P.rid)) {
        if (d.round < 3) continue;
        const laters = myOpen.filter(x => x.round > d.round);
        for (let i = 0; i < laters.length - 1; i++) {
          const net = pv(d) - pv(laters[i]) - pv(laters[i + 1]);
          if (net < -6 || net > 6) continue; // near-even both ways — they'd actually say yes
          const optics = Lv(laters[i]) + Lv(laters[i + 1]) - Lv(d);
          if (optics < 0) continue; // must also look good on their chart
          if (!C.tradeLegal(P.rid, [laters[i], laters[i + 1]].map(x => ({ kind: 'pick', ...x })),
            [{ kind: 'pick', ...d }])) continue; // cap band
          const score = (16 - pOwned) + prop + net / 10 + optics / 40;
          if (!best || score > best.score) best = { rid: P.rid, give: [laters[i], laters[i + 1]], get: d, net, optics, score };
        }
      }
    }
    return best;
  };

  // PAIRED pick-only trades: consolidate UP with an over-16 team while
  // simultaneously shedding DOWN to an under-16 team — no shared picks, my
  // count nets back to 16, and my pick quality rises. One best pair per
  // (over, under) partner combination.
  LAB.pickPairs = function (C, L) {
    const pv = pk => C.pickVal(L.season, pk.round, 'true', pk.origRid);
    const Lv = pk => C.pickVal(L.season, pk.round, 'linear', pk.origRid);
    const myOpen = C.openOf(C.myRid);
    const overs = [], unders = [];
    for (const P of L.rosters) {
      if (P.rid === C.myRid) continue;
      const n = C.ownedPicks(P.rid).length;
      if (n > 16) overs.push({ P, n });
      if (n < 16) unders.push({ P, n });
    }
    const pairs = [];
    for (const { P: O, n: nO } of overs) {
      const oOpen = C.openOf(O.rid);
      for (const { P: U, n: nU } of unders) {
        let best = null;
        for (const a1 of myOpen) {
          if (a1.round < 2) continue;
          const bs = oOpen.filter(x => x.round > a1.round);
          for (let i = 0; i < bs.length - 1; i++) {
            const netA = pv(bs[i]) + pv(bs[i + 1]) - pv(a1);
            // each LEG must be only a SLIGHT gain for me — the partner's real
            // payment is the count fix, never a value fleecing they'd refuse
            if (netA < 0.5 || netA > 10) continue;
            for (const d of C.openOf(U.rid)) {
              if (d.round < 3) continue;
              const cs = myOpen.filter(x => x !== a1 && x.round > d.round);
              for (let j = 0; j < cs.length - 1; j++) {
                const netB = pv(d) - pv(cs[j]) - pv(cs[j + 1]);
                if (netB < 0.5 || netB > 10) continue;
                const opticsB = Lv(cs[j]) + Lv(cs[j + 1]) - Lv(d);
                if (opticsB < 0) continue; // the shed leg must LOOK like a win on their chart
                const pk = x => ({ kind: 'pick', ...x });
                if (!C.tradeLegal(O.rid, [pk(a1)], [pk(bs[i]), pk(bs[i + 1])])) continue;
                if (!C.tradeLegal(U.rid, [pk(cs[j]), pk(cs[j + 1])], [pk(d)])) continue;
                const total = netA + netB;
                // prefer BALANCED pairs (both legs modest) over max total
                const score = Math.min(netA, netB) * 0.8 + total / 10 + (nO - 16) + (16 - nU)
                  + ((C.propensity[O.rid] || {}).score || 0) * 0.5
                  + ((C.propensity[U.rid] || {}).score || 0) * 0.5;
                if (!best || score > best.score) best = {
                  over: { rid: O.rid, give: [a1], get: [bs[i], bs[i + 1]], net: netA },
                  under: { rid: U.rid, give: [cs[j], cs[j + 1]], get: [d], net: netB, optics: opticsB },
                  total, score,
                };
              }
            }
          }
        }
        if (best) pairs.push(best);
      }
    }
    return pairs.sort((x, y) => y.score - x.score);
  };
})();
