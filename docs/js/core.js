/* THE LAB — core: data, storage, nav, player cards, helpers */
(function () {
  const LAB = (window.LAB = {});

  // ---------- constants ----------
  LAB.POS = ['QB', 'RB', 'WR', 'TE', 'DEF'];
  LAB.SKILL = ['QB', 'RB', 'WR', 'TE'];
  LAB.API = 'https://api.sleeper.app/v1';
  LAB.KEY_BOARD = 'thelab-board-v2'; // v2: seeds from analyst consensus (cr), not raw ADP
  LAB.KEY_PREFS = 'thelab-prefs-v1';

  // ---------- tiny helpers ----------
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  LAB.$ = $; LAB.$$ = $$;

  LAB.el = function (tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) {
      if (k === null || k === undefined) continue;
      e.append(k.nodeType ? k : document.createTextNode(k));
    }
    return e;
  };
  const el = LAB.el;

  LAB.esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  LAB.fmt1 = n => (n == null ? '–' : Number(n).toFixed(1));
  LAB.fmt0 = n => (n == null ? '–' : Math.round(n));

  LAB.headshot = function (pid, cls) {
    const isDef = /^[A-Z]{2,3}$/.test(pid);
    const src = isDef
      ? `https://sleepercdn.com/images/team_logos/nfl/${pid.toLowerCase()}.png`
      : `https://sleepercdn.com/content/nfl/players/${pid}.jpg`;
    return el('img', { class: 'headshot ' + (cls || ''), src, loading: 'lazy',
      onerror: function () { this.style.visibility = 'hidden'; } });
  };
  LAB.teamLogo = t => t ? el('img', { class: 'team-logo', loading: 'lazy',
    src: `https://sleepercdn.com/images/team_logos/nfl/${t.toLowerCase()}.png` }) : el('span');

  LAB.posBadge = pos => el('span', { class: 'badge pos-' + pos }, pos);

  // ADP-vs-rank dot color (green = value, red = reach), same spirit as v1 site
  LAB.adpColor = function (rank, adp, scale) {
    if (rank == null || adp == null) return '#3a4656';
    const diff = adp - rank;
    const t = Math.max(-1, Math.min(1, diff / (scale || 12)));
    if (t >= 0) { // value: toward green
      return `rgb(${Math.round(58 + (70 - 58) * t)},${Math.round(70 + (214 - 70) * t)},${Math.round(86 + (140 - 86) * t)})`;
    }
    const u = -t;
    return `rgb(${Math.round(58 + (242 - 58) * u)},${Math.round(70 + (109 - 70) * u)},${Math.round(86 + (109 - 86) * u)})`;
  };

  // ---------- data ----------
  const cache = {};
  LAB.loadData = async function (names) {
    const need = names.filter(n => !cache[n]);
    await Promise.all(need.map(async n => {
      const r = await fetch(`data/${n}.json`, { cache: 'no-cache' }); // revalidate — stale data JSONs poison every page
      cache[n] = await r.json();
    }));
    const out = {};
    names.forEach(n => (out[n] = cache[n]));
    return out;
  };

  LAB.live = async function (path) { // live Sleeper API fetch
    const r = await fetch(LAB.API + path);
    if (!r.ok) throw new Error('sleeper ' + r.status);
    return r.json();
  };

  LAB.playersById = function (players) {
    const m = {};
    players.forEach(p => (m[p.id] = p));
    return m;
  };

  // ---------- prefs / storage ----------
  LAB.prefs = JSON.parse(localStorage.getItem(LAB.KEY_PREFS) || '{}');
  LAB.savePrefs = function () { localStorage.setItem(LAB.KEY_PREFS, JSON.stringify(LAB.prefs)); };

  // ---------- board storage (shared by board/draft/keepers pages) ----------
  LAB.loadBoard = function () {
    try { return JSON.parse(localStorage.getItem(LAB.KEY_BOARD)); } catch (e) { return null; }
  };
  LAB.saveBoard = function (board) {
    board.updated = new Date().toISOString();
    localStorage.setItem(LAB.KEY_BOARD, JSON.stringify(board));
  };

  // auto-tier seeding: cut on consensus-rank gaps (or ADP gaps past the
  // consensus horizon), cap tier size
  function seedTiers(list, gapThresh, maxSize) {
    const CR_GAP = 2; // avg positional ranks this far apart = real tier break
    const tiers = [];
    let cur = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const prev = list[i - 1];
      let gap = 0, thresh = gapThresh;
      if (prev && p.cr != null && prev.cr != null) { gap = p.cr - prev.cr; thresh = CR_GAP; }
      else if (prev && p.adp != null && prev.adp != null) gap = p.adp - prev.adp;
      if (cur.length && (cur.length >= maxSize || gap >= thresh)) {
        tiers.push(cur); cur = [];
      }
      cur.push(p);
    }
    if (cur.length) tiers.push(cur);
    return tiers;
  }

  let tierSeq = 0;
  const newTierId = () => 't' + Date.now().toString(36) + (tierSeq++).toString(36);
  LAB.newTierId = newTierId;

  LAB.seedBoard = function (players) {
    const board = { version: 1, pos: {}, overall: [], notes: {}, updated: null };
    const GAPS = { QB: 6, RB: 5, WR: 5, TE: 6, DEF: 99 };
    const MAX = { QB: 6, RB: 8, WR: 9, TE: 6, DEF: 8 };
    for (const pos of LAB.POS) {
      let list = players.filter(p => p.pos === pos);
      // consensus rank first, then ADP, then projections
      const key = p => p.cr != null ? p.cr : 200 + (p.adp ?? (500 - (p.proj || 0)));
      list.sort((a, b) => key(a) - key(b));
      const tiers = seedTiers(list, GAPS[pos], MAX[pos]).map(t => ({
        id: newTierId(), players: t.map(p => p.id),
      }));
      board.pos[pos] = { tiers };
    }
    // overall: k-way merge of each position's tier sequence by median overall
    // consensus rank (ADP fallback) — tiers of one position always stay in
    // order; only the interleave varies
    const byId = LAB.playersById(players);
    const queues = LAB.POS.map(pos => board.pos[pos].tiers.map(t => {
      const ms = t.players.map(id => byId[id]?.ocr ?? byId[id]?.adp ?? 500).sort((a, b) => a - b);
      return { pos, tierId: t.id, med: ms.length ? ms[Math.floor(ms.length / 2)] : 500 };
    }));
    board.overall = [];
    while (queues.some(q => q.length)) {
      let best = null;
      for (const q of queues) {
        if (q.length && (!best || q[0].med < best[0].med)) best = q;
      }
      const blk = best.shift();
      board.overall.push({ pos: blk.pos, tierId: blk.tierId });
    }
    return board;
  };

  // reset that KEEPS your tier structure: same tiers (ids, count, sizes) and
  // the same overall arrangement — only the players re-sort by analyst
  // consensus and reflow through the tiers in order
  LAB.reflowBoard = function (board, players) {
    const byId = LAB.playersById(players);
    const key = p => p.cr != null ? p.cr : 200 + (p.adp ?? (500 - (p.proj || 0)));
    for (const pos of LAB.POS) {
      const tiers = board.pos[pos]?.tiers || [];
      const pool = [];
      tiers.forEach(t => t.players.forEach(id => pool.push(id)));
      pool.sort((a, b) => key(byId[a] || {}) - key(byId[b] || {}));
      let i = 0;
      for (const t of tiers) {
        const n = t.players.length;
        t.players = pool.slice(i, i + n);
        i += n;
      }
    }
    return board;
  };

  // reconcile a stored board with today's player pool
  LAB.reconcileBoard = function (board, players) {
    const poolIds = new Set(players.map(p => p.id));
    const byId = LAB.playersById(players);
    let changed = false;
    const seen = new Set();
    for (const pos of LAB.POS) {
      if (!board.pos[pos]) { board.pos[pos] = { tiers: [{ id: newTierId(), players: [] }] }; changed = true; }
      for (const t of board.pos[pos].tiers) {
        const before = t.players.length;
        t.players = t.players.filter(id => poolIds.has(id) && byId[id].pos === pos && !seen.has(id));
        t.players.forEach(id => seen.add(id));
        if (t.players.length !== before) changed = true;
      }
    }
    // new arrivals -> append to last tier of their position
    const newcomers = [];
    for (const p of players) {
      if (!seen.has(p.id)) {
        const tiers = board.pos[p.pos].tiers;
        tiers[tiers.length - 1].players.push(p.id);
        newcomers.push(p.name);
        changed = true;
      }
    }
    // overall block sync: drop dead refs, add missing
    const tierKey = b => b.pos + ':' + b.tierId;
    const live = new Set();
    LAB.POS.forEach(pos => board.pos[pos].tiers.forEach(t => live.add(pos + ':' + t.id)));
    const before = board.overall.length;
    board.overall = board.overall.filter(b => live.has(tierKey(b)));
    const have = new Set(board.overall.map(tierKey));
    LAB.POS.forEach(pos => board.pos[pos].tiers.forEach(t => {
      if (!have.has(pos + ':' + t.id)) board.overall.push({ pos, tierId: t.id });
    }));
    if (board.overall.length !== before) changed = true;
    return { changed, newcomers };
  };

  LAB.getBoardOrSeed = function (players) {
    let board = LAB.loadBoard();
    if (!board) {
      board = LAB.seedBoard(players);
      LAB.saveBoard(board);
      LAB.toast('Fresh board seeded from your analyst consensus');
    } else {
      const { newcomers } = LAB.reconcileBoard(board, players);
      if (newcomers.length) {
        LAB.saveBoard(board);
        LAB.toast(`${newcomers.length} new player${newcomers.length > 1 ? 's' : ''} added to bottom tiers`);
      }
    }
    return board;
  };

  // overall rank map: pid -> overall rank per current board
  LAB.overallRanks = function (board) {
    const ranks = {}; let r = 1;
    for (const ref of board.overall) {
      const tier = board.pos[ref.pos]?.tiers.find(t => t.id === ref.tierId);
      if (tier) tier.players.forEach(id => (ranks[id] = r++));
    }
    return ranks;
  };
  LAB.posRanks = function (board, pos) {
    const ranks = {}; let r = 1;
    (board.pos[pos]?.tiers || []).forEach(t => t.players.forEach(id => (ranks[id] = r++)));
    return ranks;
  };

  // ---------- ADP rounds + keeper-draft simulation ----------
  // "22.5" -> "3.03": round + pick in a 10-team draft
  LAB.adpRound = function (adp) {
    if (adp == null) return null;
    const pick = Math.max(1, Math.round(adp));
    const r = Math.ceil(pick / 10);
    return r + '.' + String(pick - (r - 1) * 10).padStart(2, '0');
  };

  // keeper cost round (same rules as the Keepers page): GGG round-slot with
  // repeat-keep escalation, LOB slot minus 1; undrafted -> R10
  LAB.keeperCostRound = function (L, lastRd, wasKept) {
    if (!lastRd) return 10;
    if (L.keeperRule === 'round_minus_1') return Math.max(1, lastRd - 1);
    return wasKept ? Math.max(1, lastRd - 1) : lastRd;
  };

  // keepers for every roster: officially declared ones first (at their REAL
  // draft-board slot when the league has placed them), topped up to keeperMax
  // with the roster's best remaining candidates by surplus — mirrors the
  // Keepers page's TOP-3 logic. Before the deadline a short official list
  // usually means "not done declaring", so top-ups keep the model honest.
  LAB.predictKeepers = function (L, byId, oRanks) {
    const kept = new Set(L.lastKept || []);
    const midPick = r => (r - 0.5) * 10;
    const actual = {};
    for (const k of (L.draftKeepers || [])) actual[k.pid] = k.round;
    const keeps = [];
    for (const roster of L.rosters) {
      const official = (roster.keepers || []).filter(pid => byId[pid]);
      const chosen = official.map(pid => ({
        pid,
        costRd: actual[pid] ?? LAB.keeperCostRound(L, L.lastDraftRound[pid] || null, kept.has(pid)),
        official: true,
      }));
      const cands = (roster.players || [])
        .map(pid => byId[pid])
        // only players DRAFTED last year are keeper-eligible (no FA pickups)
        .filter(p => p && p.pos !== 'DEF' && L.lastDraftRound[p.id] && !official.includes(p.id))
        .map(p => {
          const costRd = LAB.keeperCostRound(L, L.lastDraftRound[p.id], kept.has(p.id));
          const worth = oRanks[p.id] ?? p.adp ?? 300;
          return { pid: p.id, costRd, surplus: midPick(costRd) - worth };
        })
        .sort((a, b) => b.surplus - a.surplus);
      for (const c of cands) {
        if (chosen.length >= L.keeperMax) break;
        chosen.push(c);
      }
      keeps.push(...chosen);
    }
    return { keeps, keptSet: new Set(keeps.map(k => k.pid)) };
  };

  // simulate the keeper draft: keepers consume slots in their cost rounds,
  // everyone else fills the open picks in ADP order.
  // Returns { rounds: pid -> round, keptSet, wouldBe(p) } — wouldBe gives the
  // hypothetical round for a player who is predicted kept (or undrafted): the
  // slot he'd fall to if he entered this draft at his ADP.
  LAB.keeperSim = function (players, L, board) {
    const byId = LAB.playersById(players);
    const oRanks = board ? LAB.overallRanks(board) : {};
    const { keeps, keptSet } = LAB.predictKeepers(L, byId, oRanks);
    const ROUNDS = Math.max(16, ...Object.values(L.lastDraftRound || {}));
    // keeper slots per round (overflow beyond 10 spills to the next round)
    const used = new Array(ROUNDS + 2).fill(0);
    for (const k of keeps) {
      let r = Math.min(k.costRd, ROUNDS);
      while (r <= ROUNDS && used[r] >= 10) r++;
      if (r <= ROUNDS) used[r]++;
    }
    const sortKey = p => p.adp ?? 500 - (p.proj || 0) / 1000;
    const pool = players.filter(p => !keptSet.has(p.id)).sort((a, b) => sortKey(a) - sortKey(b));
    const openSlotRounds = [];
    for (let r = 1; r <= ROUNDS; r++) for (let s = used[r]; s < 10; s++) openSlotRounds.push(r);
    const rounds = {};
    pool.forEach((p, i) => { if (i < openSlotRounds.length) rounds[p.id] = openSlotRounds[i]; });
    const wouldBe = p => {
      if (rounds[p.id]) return rounds[p.id];
      const a = sortKey(p);
      let idx = pool.findIndex(q => sortKey(q) > a);
      if (idx < 0) idx = pool.length;
      return openSlotRounds[Math.min(idx, openSlotRounds.length - 1)] ?? ROUNDS;
    };
    return { rounds, keptSet, wouldBe };
  };
  LAB.keeperRounds = (players, L, board) => LAB.keeperSim(players, L, board).rounds;

  // ---------- toast ----------
  LAB.toast = function (msg, cls) {
    let wrap = $('.toast-wrap');
    if (!wrap) { wrap = el('div', { class: 'toast-wrap' }); document.body.append(wrap); }
    const t = el('div', { class: 'toast ' + (cls || '') }, msg);
    wrap.append(t);
    setTimeout(() => t.remove(), 3200);
  };

  // ---------- modal ----------
  LAB.modal = function (contentEl) {
    const ov = el('div', { class: 'overlay', onclick: e => { if (e.target === ov) ov.remove(); } },
      el('div', { class: 'modal' }, contentEl));
    document.body.append(ov);
    return ov;
  };

  // ---------- sparkline (2025 weekly points) ----------
  LAB.sparkline = function (weeks) {
    const W = 320, H = 44, max = Math.max(...weeks, 10);
    const bw = W / weeks.length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'spark-svg');
    weeks.forEach((v, i) => {
      const h = Math.max(1, (v / max) * (H - 6));
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', i * bw + 1);
      rect.setAttribute('y', H - h);
      rect.setAttribute('width', Math.max(1, bw - 2));
      rect.setAttribute('height', h);
      rect.setAttribute('rx', 1.5);
      rect.setAttribute('fill', v > 0 ? 'var(--accent)' : 'var(--border)');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `Wk ${i + 1}: ${v.toFixed(1)} pts`;
      rect.append(title);
      svg.append(rect);
    });
    return svg;
  };

  // ---------- player card ----------
  LAB.playerCard = async function (pid) {
    const { players, leagues, meta } = await LAB.loadData(['players', 'leagues', 'meta']);
    const p = LAB.playersById(players)[pid];
    if (!p) return;
    const board = LAB.loadBoard();
    const oRanks = board ? LAB.overallRanks(board) : {};
    const pRanks = board ? LAB.posRanks(board, p.pos) : {};

    const leagueRows = [];
    for (const [tag, L] of Object.entries(leagues)) {
      let holder = null, isKeeper = false;
      for (const r of L.rosters) {
        if ((r.players || []).includes(pid)) {
          holder = L.users[r.owner]?.name || 'unknown';
          isKeeper = (r.keepers || []).includes(pid);
        }
      }
      const mine = holder === 'Strubes';
      const sim = board ? LAB.keeperSim(players, L, board) : null;
      const kTxt = !sim ? '' : sim.rounds[pid] ? 'keeper draft: R' + sim.rounds[pid]
        : sim.keptSet.has(pid) ? 'projected KEPT' : 'likely undrafted';
      leagueRows.push(el('div', { class: 'flex', style: 'margin-top:4px' },
        el('span', { class: 'muted', style: 'width:44px;text-transform:uppercase;font-weight:700;font-size:11px' }, tag),
        holder
          ? el('span', {}, mine ? el('span', { class: 'badge mine' }, 'ON MY ROSTER') : `rostered by ${holder}`,
              isKeeper ? el('span', { class: 'badge keeper', style: 'margin-left:6px' }, 'KEEPER') : '')
          : el('span', { class: 'good' }, 'available'),
        el('span', { class: 'muted', style: 'margin-left:auto;font-size:12px', title: 'projected round in this league\'s keeper draft' }, kTxt)));
    }

    const note = (board?.notes || {})[pid] || '';
    const noteArea = el('textarea', {
      style: 'width:100%;min-height:56px;background:var(--raised);border:1px solid var(--border-strong);color:var(--ink);border-radius:8px;padding:8px;font-family:var(--font-body);font-size:13px;margin-top:6px',
      placeholder: 'Your note on this player… (autosaves)',
    });
    noteArea.value = note;
    noteArea.addEventListener('input', () => {
      const b = LAB.loadBoard(); if (!b) return;
      b.notes = b.notes || {};
      if (noteArea.value.trim()) b.notes[pid] = noteArea.value; else delete b.notes[pid];
      LAB.saveBoard(b);
    });

    const stat = (label, val) => el('div', { class: 'tile', style: 'padding:8px 10px' },
      el('div', { class: 't-label' }, label), el('div', { class: 't-value', style: 'font-size:19px' }, val));

    const body = el('div', {},
      el('div', { class: 'flex', style: 'gap:14px' },
        LAB.headshot(pid, 'lg'),
        el('div', {},
          el('h2', {}, p.name, ' ', p.rookie ? el('span', { class: 'badge rookie' }, 'ROOKIE') : ''),
          el('div', { class: 'flex dim', style: 'margin-top:3px' },
            LAB.teamLogo(p.team), p.team || 'FA', ' · ', LAB.posBadge(p.pos),
            p.age ? ` · ${p.age}y` : '', p.exp != null && p.pos !== 'DEF' ? ` · ${p.exp} yr exp` : '',
            p.bye ? ` · bye ${p.bye}` : ''),
          p.status ? el('div', { class: 'bad', style: 'margin-top:3px;font-size:12px;font-weight:700' }, p.status.toUpperCase()) : '')),
      el('div', { class: 'tiles', style: 'margin-top:14px;grid-template-columns:repeat(3,1fr)' },
        stat('Sleeper ADP', p.adp != null ? p.adp.toFixed(1) + ' · ' + LAB.adpRound(p.adp) : '–'),
        stat('My rank', oRanks[pid] ? '#' + oRanks[pid] : '–'),
        stat('My ' + p.pos, pRanks[pid] ? p.pos + pRanks[pid] : '–'),
        stat("'26 proj", LAB.fmt0(p.proj)),
        stat("'25 " + (p.fin25 ? p.pos + p.fin25 : 'fin'), p.p25 != null ? p.p25.toFixed(0) + ' pts' : '–'),
        stat("'25 PPG", LAB.fmt1(p.ppg25))),
      p.wk25 ? el('div', { style: 'margin-top:12px' },
        el('div', { class: 't-label', style: 'color:var(--ink-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700' }, '2025 week-by-week (your scoring)'),
        LAB.sparkline(p.wk25)) : '',
      p.lab ? (() => {
        const L2 = p.lab;
        const line = (lbl, val, cls, tip) => val == null ? '' : el('div', { class: 'flex', style: 'margin-top:3px;font-size:12.5px', title: tip || '' },
          el('span', { class: 'muted', style: 'width:104px;flex:none;font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:700' }, lbl),
          el('span', { class: cls || '' }, val));
        const tdD = L2.xtd != null && L2.td != null ? Math.round((L2.td - L2.xtd) * 10) / 10 : null;
        return el('div', { style: 'margin-top:12px' },
          el('div', { class: 't-label', style: 'color:var(--ink-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700' }, 'Lab Score inputs'),
          line('Age curve', L2.alvl != null ? `${L2.age}y — ${Math.round(L2.alvl * 100)}% of ${p.pos} peak, ${L2.aslp > 0 ? 'ascending ↗' : L2.aslp < -0.05 ? 'declining ↘' : 'holding →'}` : L2.age ? L2.age + 'y' : null,
            L2.alvl >= 0.9 ? 'good' : L2.alvl < 0.6 ? 'bad' : 'warn',
            'position on the historical age-production curve for his position, and which way next season points'),
          line('Draft capital', L2.dcr ? `R${L2.dcr} · pick ${L2.dcp} (${L2.dcy})` : 'undrafted',
            L2.dcr === 1 ? 'good' : !L2.dcr ? 'muted' : '',
            'real NFL draft capital — teams keep giving early picks chances'),
          line('Team opportunity', L2.vt != null ? `${L2.vt} vacated targets (${L2.vtp}% of team) · ${L2.va} vacated carries (${L2.vap}%)` : null,
            L2.vtp >= 20 ? 'good' : '',
            'work that left his CURRENT team this offseason — targets and carries with no incumbent owner'),
          line('TD luck \'25', tdD != null ? `${L2.td} TD vs ${L2.xtd} expected (${tdD > 0 ? '+' : ''}${tdD})` : null,
            tdD > 2 ? 'bad' : tdD < -2 ? 'good' : '',
            'actual TDs vs what league-average conversion of his red-zone + volume opportunity would score. Over = fade risk, under = positive regression'),
          L2.moved ? line('Moved', `part of ${L2.moved}'s vacated pool`, 'muted', 'he changed teams — his old usage is what someone else inherits') : '');
      })() : '',
      el('hr', { class: 'hr' }),
      ...leagueRows,
      el('hr', { class: 'hr' }),
      noteArea);
    LAB.modal(body);
  };

  // ---------- nav ----------
  LAB.nav = function (active) {
    const links = [
      ['index.html', 'Home'], ['board.html', 'The Board'], ['draft.html', 'Draft Room'],
      ['draftmap.html', 'Draft Map'], ['trade.html', 'Trades'], ['finder.html', 'Finder'], ['keepers.html', 'Keepers'], ['season.html', 'Season'], ['sos.html', 'SoS'],
    ];
    const nav = el('nav', { class: 'nav' },
      el('a', { class: 'wordmark', href: 'index.html' }, el('span', { class: 'spark' }, '⚗'), ' The Lab'),
      links.map(([href, label]) => el('a', { class: 'tab' + (label === active ? ' active' : ''), href }, label)),
      el('div', { class: 'spacer' }),
      el('span', { class: 'build-stamp', id: 'buildStamp' }));
    document.body.prepend(nav);
    LAB.loadData(['meta']).then(({ meta }) => {
      const s = $('#buildStamp');
      if (s) s.textContent = 'data ' + meta.built.replace(' UTC', 'z');
    }).catch(() => {});
  };

  // ---------- export / import ----------
  LAB.exportBoard = function () {
    const board = LAB.loadBoard();
    if (!board) return LAB.toast('Nothing to export yet', 'bad');
    const blob = new Blob([JSON.stringify(board, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob),
      download: `thelab-board-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    LAB.toast('Board exported');
  };
  LAB.importBoard = function (onDone) {
    const inp = el('input', { type: 'file', accept: '.json' });
    inp.addEventListener('change', async () => {
      try {
        const txt = await inp.files[0].text();
        const board = JSON.parse(txt);
        if (!board.pos || !board.overall) throw new Error('not a board file');
        localStorage.setItem(LAB.KEY_BOARD, JSON.stringify(board));
        LAB.toast('Board imported', 'good');
        if (onDone) onDone();
      } catch (e) { LAB.toast('Import failed: ' + e.message, 'bad'); }
    });
    inp.click();
  };
})();
