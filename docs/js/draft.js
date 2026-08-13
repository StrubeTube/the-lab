/* THE LAB — draft room: live sync, mock simulator, rival intel, report card */
(async function () {
  LAB.nav('Draft Room');
  const { players, leagues, intel, meta } = await LAB.loadData(['players', 'leagues', 'intel', 'meta']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);

  const state = {
    lg: LAB.prefs.draftLg || 'ggg',
    mode: 'live',
    posFilter: 'ALL',
    hideDrafted: true,
    live: { picks: [], draft: null, timer: null },
    mock: null, // {order:[uid...], picks:[], slot, round, onMe, done}
  };

  const ROSTER_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
  const TOTAL_ROUNDS = ROSTER_SLOTS.length;

  // ---------- helpers ----------
  const L = () => leagues[state.lg];
  const myUid = () => L().myUserId;

  function keeperSet() {
    const s = new Set();
    L().rosters.forEach(r => (r.keepers || []).forEach(pid => s.add(pid)));
    return s;
  }

  function draftedSet() {
    const s = new Set(keeperSet());
    const picks = state.mode === 'mock' ? (state.mock?.picks || []) : state.live.picks;
    picks.forEach(pk => s.add(pk.player_id));
    return s;
  }

  function overallOrderedPids() {
    const out = [];
    for (const ref of board.overall) {
      const t = board.pos[ref.pos]?.tiers.find(x => x.id === ref.tierId);
      if (t) out.push(...t.players.map(pid => ({ pid, pos: ref.pos, tierRef: ref })));
    }
    return out;
  }

  // ---------- segments ----------
  LAB.$$('#leagueSeg button').forEach(b => b.addEventListener('click', () => {
    state.lg = b.dataset.lg; LAB.prefs.draftLg = state.lg; LAB.savePrefs();
    LAB.$$('#leagueSeg button').forEach(x => x.classList.toggle('active', x === b));
    state.mock = null;
    boot();
  }));
  LAB.$$('#modeSeg button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    LAB.$$('#modeSeg button').forEach(x => x.classList.toggle('active', x === b));
    boot();
  }));
  LAB.$$('#posFilter button').forEach(b => b.addEventListener('click', () => {
    state.posFilter = b.dataset.p;
    LAB.$$('#posFilter button').forEach(x => x.classList.toggle('active', x === b));
    renderBoard();
  }));
  LAB.$('#hideDrafted').addEventListener('change', e => { state.hideDrafted = e.target.checked; renderBoard(); });

  // ---------- live polling ----------
  async function pollLive() {
    try {
      const d = await LAB.live(`/draft/${L().draftId}`);
      state.live.draft = d;
      if (d.status === 'drafting' || d.status === 'complete') {
        state.live.picks = await LAB.live(`/draft/${L().draftId}/picks`);
      }
      renderAll();
      clearTimeout(state.live.timer);
      if (d.status === 'drafting') state.live.timer = setTimeout(pollLive, 4000);
      else if (d.status === 'pre_draft') state.live.timer = setTimeout(pollLive, 60000);
    } catch (e) {
      LAB.$('#statusBar').innerHTML = '';
      LAB.$('#statusBar').append(LAB.el('span', { class: 'bad' }, 'Sleeper API unreachable — retrying…'));
      state.live.timer = setTimeout(pollLive, 8000);
    }
  }

  // ---------- status bar ----------
  function renderStatus() {
    const bar = LAB.$('#statusBar');
    bar.innerHTML = '';
    if (state.mode === 'mock') {
      bar.append(LAB.el('b', {}, `${L().name} — mock draft`),
        LAB.el('span', { class: 'dim', style: 'margin-left:10px' },
          state.mock ? (state.mock.done ? 'Mock complete.' : `Round ${state.mock.round} · pick ${state.mock.picks.length + 1}`) : 'Set your slot and start.'));
      return;
    }
    const d = state.live.draft;
    if (!d) { bar.append('Checking draft status…'); return; }
    const when = d.start_time ? new Date(d.start_time).toLocaleString() : 'not scheduled yet';
    const statusTxt = { pre_draft: `Draft not started — ${when}`, drafting: 'DRAFT IS LIVE', complete: 'Draft complete' }[d.status] || d.status;
    bar.append(
      LAB.el('b', { class: d.status === 'drafting' ? 'accent' : '' }, `${L().name}: ${statusTxt}`),
      LAB.el('span', { class: 'dim', style: 'margin-left:10px' }, `${state.live.picks.length} picks in · ${keeperSet().size} keepers locked`));
  }

  // ---------- on the clock + ticker ----------
  function slotOwner(draftOrder, slot) {
    for (const [uid, s] of Object.entries(draftOrder || {})) if (s === slot) return uid;
    return null;
  }
  function pickToSlot(pickNo) { // snake
    const r = Math.ceil(pickNo / 10);
    const i = (pickNo - 1) % 10;
    return r % 2 === 1 ? i + 1 : 10 - i;
  }

  function currentDrafter() {
    if (state.mode === 'mock') {
      if (!state.mock || state.mock.done) return null;
      const pickNo = state.mock.picks.length + 1;
      return { uid: state.mock.order[pickToSlot(pickNo) - 1], pickNo };
    }
    const d = state.live.draft;
    if (!d || d.status !== 'drafting') return null;
    const pickNo = state.live.picks.length + 1;
    return { uid: slotOwner(d.draft_order, pickToSlot(pickNo)), pickNo };
  }

  function renderClock() {
    const root = LAB.$('#onClock');
    root.innerHTML = '';
    const cur = currentDrafter();
    if (!cur) return;
    const name = L().users[cur.uid]?.name || '?';
    const mine = cur.uid === myUid();
    let untilMe = '';
    if (!mine) {
      const order = state.mode === 'mock' ? state.mock.order : Object.entries(state.live.draft.draft_order || {}).sort((a, b) => a[1] - b[1]).map(x => x[0]);
      const mySlot = order.indexOf(myUid()) + 1;
      if (mySlot > 0) {
        let n = 0, pk = cur.pickNo;
        while (n < 40 && slotOfOrder(order, pk) !== mySlot) { pk++; n++; }
        untilMe = ` · ${pk - cur.pickNo} picks until you`;
      }
    }
    function slotOfOrder(order, pickNo) { return pickToSlot(pickNo); }
    root.append(LAB.el('div', { class: 'on-clock' },
      LAB.el('b', { style: 'font-size:16px' }, mine ? '🫵 YOU ARE ON THE CLOCK' : `On the clock: ${name}`),
      LAB.el('span', { class: 'dim' }, `pick ${cur.pickNo} (R${Math.ceil(cur.pickNo / 10)})${untilMe}`),
      runWarning()));
  }

  function runWarning() {
    const picks = (state.mode === 'mock' ? state.mock?.picks : state.live.picks) || [];
    const last5 = picks.slice(-5).map(pk => byId[pk.player_id]?.pos).filter(Boolean);
    for (const pos of LAB.SKILL) {
      if (last5.filter(p => p === pos).length >= 3)
        return LAB.el('span', { class: 'badge status', style: 'font-size:13px' }, `${pos} RUN`);
    }
    return '';
  }

  function renderTicker() {
    const root = LAB.$('#ticker');
    root.innerHTML = '';
    const picks = (state.mode === 'mock' ? state.mock?.picks : state.live.picks) || [];
    if (!picks.length) return;
    const wrap = LAB.el('div', { class: 'pick-ticker' });
    picks.slice(-14).reverse().forEach(pk => {
      const p = byId[pk.player_id];
      const who = L().users[pk.picked_by]?.name || '?';
      wrap.append(LAB.el('div', { class: 'tick' },
        LAB.el('div', { class: 't-pick' }, `${pk.round}.${String(pk.draft_slot ?? '').padStart(2, '0')} · ${who}${pk.is_keeper ? ' · K' : ''}`),
        LAB.el('div', { class: 'flex', style: 'gap:5px;margin-top:2px' },
          p ? LAB.posBadge(p.pos) : '', LAB.el('b', { style: 'font-size:12px' }, p ? p.name : pk.player_id))));
    });
    root.append(wrap);
  }

  // ---------- best available ----------
  function renderBoard() {
    const root = LAB.$('#bestBoard');
    root.innerHTML = '';
    const drafted = draftedSet();
    const ranks = LAB.overallRanks(board);
    const cur = currentDrafter();
    const iAmUp = cur && cur.uid === myUid() && state.mode === 'mock';

    let items = overallOrderedPids();
    if (state.posFilter !== 'ALL') items = items.filter(x => byId[x.pid]?.pos === state.posFilter);

    let lastRef = null, bandEl = null, shown = 0;
    for (const it of items) {
      if (shown > 120) break;
      const isDrafted = drafted.has(it.pid);
      if (state.hideDrafted && isDrafted) continue;
      const p = byId[it.pid];
      if (!p) continue;
      if (!lastRef || lastRef !== it.tierRef) {
        lastRef = it.tierRef;
        const tiers = board.pos[it.pos].tiers;
        const ti = tiers.findIndex(t => t.id === it.tierRef.tierId);
        const remaining = tiers[ti].players.filter(pid => !drafted.has(pid)).length;
        bandEl = LAB.el('div', {},
          LAB.el('div', { class: 'tier-head', style: 'cursor:default' },
            `${it.pos} · Tier ${ti + 1}`,
            LAB.el('span', { class: 'count' }, `${remaining} left`),
            remaining === 1 ? LAB.el('span', { class: 'badge status' }, 'TIER CLIFF') : ''));
        root.append(bandEl);
      }
      const row = LAB.el('div', { class: 'prow' + (isDrafted ? ' drafted' : ''), style: 'cursor:pointer' },
        LAB.el('span', { class: 'rank' }, ranks[it.pid] || ''),
        LAB.headshot(it.pid),
        LAB.el('div', { class: 'pmeta' },
          LAB.teamLogo(p.team),
          LAB.el('span', { class: 'pname' }, p.name),
          LAB.posBadge(p.pos),
          p.rookie ? LAB.el('span', { class: 'badge rookie' }, 'R') : '',
          p.status ? LAB.el('span', { class: 'badge status' }, p.status.slice(0, 3).toUpperCase()) : ''),
        LAB.el('div', { class: 'stats' },
          LAB.el('span', { class: 'stat w40' }, p.bye || '–'),
          LAB.el('span', { class: 'stat' }, p.adp != null ? p.adp.toFixed(1) : '–'),
          LAB.el('span', { class: 'stat hide-m' }, LAB.fmt0(p.proj))),
        iAmUp && !isDrafted
          ? LAB.el('button', { class: 'btn small primary', onclick: e => { e.stopPropagation(); mockPick(it.pid); } }, 'Draft')
          : '');
      row.addEventListener('click', () => LAB.playerCard(it.pid));
      bandEl.append(row);
      shown++;
    }
    if (!shown) root.append(LAB.el('div', { class: 'empty' }, 'Nobody left here.'));
  }

  // ---------- my roster panel ----------
  function myPicks() {
    const picks = (state.mode === 'mock' ? state.mock?.picks : state.live.picks) || [];
    const mineFromDraft = picks.filter(pk => pk.picked_by === myUid()).map(pk => pk.player_id);
    // pre-draft: show my keepers as roster starters-to-be
    const myRoster = L().rosters.find(r => r.owner === myUid());
    const myKeepers = (myRoster?.keepers) || [];
    return [...new Set([...myKeepers, ...mineFromDraft])];
  }

  function renderRoster() {
    const root = LAB.$('#myRosterCard');
    root.innerHTML = '';
    root.append(LAB.el('h2', {}, 'My roster build'));
    const pids = myPicks();
    const byes = {};
    const slots = ROSTER_SLOTS.map(s => ({ tag: s, pid: null }));
    const flexable = new Set(['RB', 'WR', 'TE']);
    for (const pid of pids) {
      const p = byId[pid]; if (!p) continue;
      let slot = slots.find(s => !s.pid && s.tag === p.pos)
        || (flexable.has(p.pos) ? slots.find(s => !s.pid && s.tag === 'FLEX') : null)
        || slots.find(s => !s.pid && s.tag === 'BN');
      if (slot) slot.pid = pid;
      if (p.bye && p.pos !== 'DEF') byes[p.bye] = (byes[p.bye] || 0) + 1;
    }
    slots.forEach(s => {
      const p = s.pid ? byId[s.pid] : null;
      root.append(LAB.el('div', { class: 'roster-slot' + (p ? ' filled' : '') },
        LAB.el('span', { class: 'slot-tag' }, s.tag),
        p ? [LAB.headshot(s.pid, 'sm'), LAB.el('b', {}, p.name), LAB.el('span', { class: 'muted' }, `bye ${p.bye || '–'}`)]
          : LAB.el('span', { class: 'muted' }, '—')));
    });
    const stacked = Object.entries(byes).filter(([w, n]) => n >= 3);
    if (stacked.length) root.append(LAB.el('div', { class: 'warn', style: 'margin-top:8px;font-size:12.5px;font-weight:600' },
      '⚠ Bye stack: ' + stacked.map(([w, n]) => `${n} starters on wk ${w}`).join(', ')));
  }

  // ---------- rival intel ----------
  function renderIntel() {
    const root = LAB.$('#intelPanel');
    root.innerHTML = '';
    root.append(LAB.el('h2', {}, 'Rival intel'));
    const cur = currentDrafter();
    const lgIntel = intel[state.lg] || [];
    const focus = [];
    if (cur && cur.uid !== myUid()) {
      const hit = lgIntel.find(x => x.uid === cur.uid);
      if (hit) focus.push({ ...hit, onClock: true });
    }
    for (const x of lgIntel) {
      if (!x.current || x.uid === myUid() || focus.some(f => f.uid === x.uid)) continue;
      focus.push(x);
      if (focus.length >= (cur ? 4 : 9)) break;
    }
    if (!focus.length) { root.append(LAB.el('div', { class: 'empty' }, 'No draft history yet.')); return; }
    focus.forEach(x => {
      const traits = [];
      if (x.firstQB != null) traits.push(LAB.el('span', { class: 'trait' + (x.firstQB <= 5 ? ' hot' : '') }, `QB rd ${x.firstQB}`));
      if (x.firstTE != null) traits.push(LAB.el('span', { class: 'trait' }, `TE rd ${x.firstTE}`));
      if (x.rookieRate != null) traits.push(LAB.el('span', { class: 'trait' + (x.rookieRate > 0.18 ? ' hot' : '') }, `${Math.round(x.rookieRate * 100)}% rookies`));
      const mix = Object.entries(x.earlyMix || {}).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([pos, n]) => `${pos}×${n}`).join(' ');
      if (mix) traits.push(LAB.el('span', { class: 'trait' }, `early: ${mix}`));
      if (x.favTeam) traits.push(LAB.el('span', { class: 'trait' }, `♥ ${x.favTeam[0]}`));
      root.append(LAB.el('div', { class: 'intel-card' + (x.onClock ? ' on-clock' : '') },
        LAB.el('div', { class: 'i-name' }, x.onClock ? '⏱ ' : '', x.name,
          LAB.el('span', { class: 'muted', style: 'font-weight:400;font-size:11.5px' }, `${x.seasons.length} drafts`)),
        LAB.el('div', { class: 'i-traits' }, traits)));
    });
  }

  // ---------- mock simulator ----------
  function renderMockControls() {
    const root = LAB.$('#mockControls');
    root.style.display = state.mode === 'mock' ? '' : 'none';
    if (state.mode !== 'mock') return;
    root.innerHTML = '';
    if (state.mock && !state.mock.done) {
      root.append(LAB.el('div', { class: 'toolbar', style: 'margin:0' },
        LAB.el('button', { class: 'btn small', onclick: stepMock }, '▶ Next pick'),
        LAB.el('button', { class: 'btn small', onclick: () => runMock(false) }, '⏩ To my pick'),
        LAB.el('button', { class: 'btn small', onclick: () => runMock(true) }, '⏭ Finish draft'),
        LAB.el('button', { class: 'btn small danger', onclick: () => { state.mock = null; renderAll(); } }, 'Abandon')));
      return;
    }
    if (state.mock?.done) {
      root.append(LAB.el('div', { class: 'toolbar', style: 'margin:0' },
        LAB.el('button', { class: 'btn small primary', onclick: () => { state.mock = null; renderAll(); } }, 'New mock')));
      return;
    }
    // setup
    const d = state.live.draft;
    const realOrder = d && d.draft_order && Object.keys(d.draft_order).length
      ? Object.entries(d.draft_order).sort((a, b) => a[1] - b[1]).map(x => x[0]) : null;
    const slotSel = LAB.el('select', {},
      LAB.el('option', { value: '' }, realOrder ? 'Use real draft order' : 'Random slot'),
      Array.from({ length: 10 }, (_, i) => LAB.el('option', { value: i + 1 }, `I pick from slot ${i + 1}`)));
    root.append(LAB.el('div', { class: 'toolbar', style: 'margin:0' },
      slotSel,
      LAB.el('button', { class: 'btn primary', onclick: () => startMock(slotSel.value ? Number(slotSel.value) : null, realOrder) }, 'Start mock')));
  }

  function startMock(mySlot, realOrder) {
    const uids = Object.keys(L().users);
    let order;
    if (realOrder && !mySlot) order = realOrder;
    else {
      const others = uids.filter(u => u !== myUid());
      shuffle(others);
      const slot = mySlot || 1 + Math.floor(Math.random() * 10);
      order = [];
      let oi = 0;
      for (let i = 1; i <= 10; i++) order.push(i === slot ? myUid() : others[oi++]);
    }
    state.mock = { order, picks: [], round: 1, done: false, needs: {} };
    // place keepers into their cost rounds as pre-made picks
    const keeperPicks = [];
    for (const r of L().rosters) {
      for (const pid of (r.keepers || [])) {
        const lastRd = L().lastDraftRound[pid];
        let costRd = L().keeperRule === 'round_minus_1' ? (lastRd ? Math.max(1, lastRd - 1) : 10) : (lastRd || 10);
        keeperPicks.push({ uid: r.owner, pid, round: costRd });
      }
    }
    state.mock.keeperPicks = keeperPicks;
    renderAll();
    LAB.toast('Mock started — keepers auto-slot into their cost rounds');
  }

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

  function mockKeeperFor(uid, round) {
    const k = (state.mock.keeperPicks || []).find(x => x.uid === uid && x.round === round && !x.used);
    return k;
  }

  function aiPick(uid) {
    const drafted = draftedSet();
    const pickNo = state.mock.picks.length + 1;
    const round = Math.ceil(pickNo / 10);
    // team needs: count current roster by pos
    const have = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
    state.mock.picks.filter(pk => pk.picked_by === uid).forEach(pk => { const p = byId[pk.player_id]; if (p) have[p.pos]++; });
    L().rosters.find(r => r.owner === uid)?.keepers?.forEach(pid => { const p = byId[pid]; if (p) have[p.pos]++; });
    const caps = { QB: 2, RB: 7, WR: 7, TE: 2, DEF: 1 };
    const tendency = (intel[state.lg] || []).find(x => x.uid === uid);
    const cands = players
      .filter(p => !drafted.has(p.id) && p.adp != null)
      .sort((a, b) => a.adp - b.adp)
      .slice(0, 14)
      .filter(p => {
        if (have[p.pos] >= caps[p.pos]) return false;
        if (p.pos === 'DEF' && round < 13) return false;
        if (p.pos === 'QB' && have.QB >= 1 && round < 10) return false;
        if (p.pos === 'TE' && have.TE >= 1 && round < 11) return false;
        return true;
      });
    let pool = cands.length ? cands : players.filter(p => !drafted.has(p.id)).sort((a, b) => (a.adp ?? 400) - (b.adp ?? 400)).slice(0, 8);
    // tendency nudges: early-QB drafters jump on QBs near their historic round
    let weights = pool.map((p, i) => {
      let w = 1 / (i + 1.6);
      if (tendency) {
        if (p.pos === 'QB' && tendency.firstQB && round >= Math.floor(tendency.firstQB) && have.QB === 0) w *= 2.2;
        if (p.rookie && tendency.rookieRate > 0.18) w *= 1.5;
        if (tendency.favTeam && p.team === tendency.favTeam[0]) w *= 1.25;
      }
      return w;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * sum;
    for (let i = 0; i < pool.length; i++) { roll -= weights[i]; if (roll <= 0) return pool[i].id; }
    return pool[0].id;
  }

  function pushMockPick(uid, pid, isKeeper) {
    const pickNo = state.mock.picks.length + 1;
    state.mock.picks.push({
      player_id: pid, picked_by: uid, round: Math.ceil(pickNo / 10),
      pick_no: pickNo, draft_slot: pickToSlot(pickNo), is_keeper: !!isKeeper,
    });
    state.mock.round = Math.ceil((state.mock.picks.length + 1) / 10);
    if (state.mock.picks.length >= TOTAL_ROUNDS * 10) { state.mock.done = true; }
  }

  function stepMock() {
    if (!state.mock || state.mock.done) return;
    const cur = currentDrafter();
    const k = mockKeeperFor(cur.uid, Math.ceil(cur.pickNo / 10));
    if (k) { k.used = true; pushMockPick(cur.uid, k.pid, true); renderAll(); return; }
    if (cur.uid === myUid()) { LAB.toast('You are up — pick from the board'); renderAll(); return; }
    pushMockPick(cur.uid, aiPick(cur.uid));
    renderAll();
  }

  function runMock(toEnd) {
    if (!state.mock) return;
    let guard = 0;
    while (!state.mock.done && guard++ < 400) {
      const cur = currentDrafter();
      const k = mockKeeperFor(cur.uid, Math.ceil(cur.pickNo / 10));
      if (k) { k.used = true; pushMockPick(cur.uid, k.pid, true); continue; }
      if (cur.uid === myUid()) {
        if (!toEnd) break;
        // auto-pick my best-available from my board, forcing must-fill slots late
        const drafted = draftedSet();
        const have = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
        myPicks().forEach(pid => { const x = byId[pid]; if (x) have[x.pos]++; });
        const myRemaining = TOTAL_ROUNDS - myPicks().length;
        const mustFill = ['QB', 'TE', 'DEF'].filter(pos => have[pos] === 0);
        let mineNext;
        if (mustFill.length >= myRemaining) {
          mineNext = overallOrderedPids().find(x => !drafted.has(x.pid) && mustFill.includes(byId[x.pid]?.pos));
        }
        if (!mineNext) mineNext = overallOrderedPids().find(x => !drafted.has(x.pid) && roomFor(byId[x.pid]));
        pushMockPick(myUid(), mineNext ? mineNext.pid : aiPick(myUid()));
        continue;
      }
      pushMockPick(cur.uid, aiPick(cur.uid));
    }
    renderAll();
  }

  function roomFor(p) {
    if (!p) return false;
    const have = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
    myPicks().forEach(pid => { const x = byId[pid]; if (x) have[x.pos]++; });
    const caps = { QB: 2, RB: 8, WR: 8, TE: 2, DEF: 1 };
    return have[p.pos] < caps[p.pos];
  }

  function mockPick(pid) {
    if (!state.mock || state.mock.done) return;
    const cur = currentDrafter();
    if (cur.uid !== myUid()) return LAB.toast('Not your pick');
    pushMockPick(myUid(), pid);
    renderAll();
  }

  // ---------- report card ----------
  function renderReport() {
    const root = LAB.$('#reportPanel');
    root.innerHTML = '';
    const picks = (state.mode === 'mock' ? state.mock?.picks : state.live.picks) || [];
    const complete = state.mode === 'mock' ? state.mock?.done : state.live.draft?.status === 'complete';
    root.append(LAB.el('h2', {}, 'Report card'));
    if (!complete || !picks.length) {
      root.append(LAB.el('div', { class: 'empty' }, 'Appears when the draft completes.'));
      return;
    }
    const ranks = LAB.overallRanks(board);
    const graded = picks.filter(pk => !pk.is_keeper && byId[pk.player_id]).map(pk => {
      const p = byId[pk.player_id];
      return { ...pk, p, adpDelta: p.adp != null ? +(pk.pick_no ?? pk.pick_no) - p.adp : null,
        boardDelta: ranks[pk.player_id] ? pk.pick_no - ranks[pk.player_id] : null };
    });
    const mine = graded.filter(g => g.picked_by === myUid());
    const steal = [...mine].sort((a, b) => (b.adpDelta ?? -99) - (a.adpDelta ?? -99))[0];
    const reach = [...mine].sort((a, b) => (a.adpDelta ?? 99) - (b.adpDelta ?? 99))[0];
    const myProj = myPicks().reduce((s, pid) => s + (byId[pid]?.proj || 0), 0);
    const teamProj = {};
    for (const r of L().rosters) {
      const ids = new Set([...(r.keepers || [])]);
      picks.filter(pk => pk.picked_by === r.owner).forEach(pk => ids.add(pk.player_id));
      teamProj[r.owner] = [...ids].reduce((s, pid) => s + (byId[pid]?.proj || 0), 0);
    }
    const sorted = Object.entries(teamProj).sort((a, b) => b[1] - a[1]);
    const myRank = sorted.findIndex(([uid]) => uid === myUid()) + 1;
    const tile = (label, value, sub) => LAB.el('div', { class: 'tile' },
      LAB.el('div', { class: 't-label' }, label), LAB.el('div', { class: 't-value', style: 'font-size:20px' }, value),
      sub ? LAB.el('div', { class: 't-sub' }, sub) : '');
    root.append(LAB.el('div', { class: 'tiles', style: 'grid-template-columns:1fr 1fr' },
      tile('Total proj', Math.round(myProj)),
      tile('League rank', myRank ? `#${myRank} of 10` : '–'),
      steal ? tile('Best value', steal.p.name, `+${Math.round(steal.adpDelta)} vs ADP`) : '',
      reach && reach.adpDelta < 0 ? tile('Biggest reach', reach.p.name, `${Math.round(reach.adpDelta)} vs ADP`) : ''));
    const list = LAB.el('div', { style: 'margin-top:10px' });
    mine.forEach(g => {
      list.append(LAB.el('div', { class: 'flex', style: 'padding:3px 0;font-size:12.5px' },
        LAB.el('span', { class: 'mono muted', style: 'width:36px' }, `${g.round}.${String(g.draft_slot).padStart(2, '0')}`),
        LAB.posBadge(g.p.pos), LAB.el('b', {}, g.p.name),
        LAB.el('span', { class: (g.adpDelta ?? 0) >= 8 ? 'good' : (g.adpDelta ?? 0) <= -8 ? 'bad' : 'muted', style: 'margin-left:auto' },
          g.adpDelta != null ? (g.adpDelta > 0 ? `+${Math.round(g.adpDelta)}` : Math.round(g.adpDelta)) + ' ADP' : '')));
    });
    root.append(list);
  }

  // ---------- boot / render ----------
  function renderAll() {
    renderStatus(); renderMockControls(); renderClock(); renderTicker();
    renderBoard(); renderRoster(); renderIntel(); renderReport();
  }
  function boot() {
    clearTimeout(state.live.timer);
    renderAll();
    if (state.mode === 'live') pollLive();
  }
  boot();
})();
