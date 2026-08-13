/* THE LAB — tier board page */
(async function () {
  LAB.nav('The Board');
  const { players, leagues, meta } = await LAB.loadData(['players', 'leagues', 'meta']);
  const byId = LAB.playersById(players);
  let board = LAB.getBoardOrSeed(players);

  const state = {
    tab: LAB.prefs.boardTab || 'OVR',      // OVR | QB | RB | WR | TE | DEF
    view: 'list',                           // list | grid
    overlay: LAB.prefs.boardOverlay || '',  // '' | ggg | lob
    search: '',
  };

  // ---------- undo ----------
  const undoStack = [];
  function snapshot() {
    undoStack.push(JSON.stringify(board));
    if (undoStack.length > 60) undoStack.shift();
  }
  function undo() {
    if (!undoStack.length) return LAB.toast('Nothing to undo');
    board = JSON.parse(undoStack.pop());
    LAB.saveBoard(board);
    render();
    LAB.toast('Undone');
  }

  function commit() { LAB.saveBoard(board); render(); }

  // ---------- overlay info (rostered/keeper per league) ----------
  function overlayInfo() {
    const tag = state.overlay;
    if (!tag) return null;
    const L = leagues[tag];
    const rostered = {}, keepers = new Set(), mine = new Set();
    for (const r of L.rosters) {
      const owner = L.users[r.owner]?.name || '?';
      (r.players || []).forEach(pid => {
        rostered[pid] = owner;
        if (owner === 'Strubes') mine.add(pid);
      });
      (r.keepers || []).forEach(pid => keepers.add(pid));
    }
    return { tag, rostered, keepers, mine, name: L.name };
  }

  // ---------- tabs ----------
  const TABS = [['OVR', 'Overall'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE'], ['DEF', 'DEF']];
  const posTabs = LAB.$('#posTabs');
  TABS.forEach(([key, label]) => {
    posTabs.append(LAB.el('button', {
      class: (key === state.tab ? 'active ' : '') + 'pos-active-' + key,
      onclick: () => { state.tab = key; LAB.prefs.boardTab = key; LAB.savePrefs(); syncTabs(); render(); },
    }, label));
  });
  function syncTabs() {
    LAB.$$('#posTabs button').forEach((b, i) => b.classList.toggle('active', TABS[i][0] === state.tab));
  }

  LAB.$$('#viewTabs button').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    LAB.$$('#viewTabs button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }));

  // dynasty lens slider (view-only blend, never writes the board)
  state.dynW = 0;
  const dynSlider = LAB.$('#dynSlider');
  dynSlider.addEventListener('input', () => {
    state.dynW = Number(dynSlider.value) / 100;
    LAB.$('#dynPct').textContent = dynSlider.value + '%';
    render();
  });

  LAB.$('#leagueOverlay').value = state.overlay;
  LAB.$('#leagueOverlay').addEventListener('change', e => {
    state.overlay = e.target.value; LAB.prefs.boardOverlay = state.overlay; LAB.savePrefs(); render();
  });
  LAB.$('#undoBtn').addEventListener('click', undo);
  LAB.$('#exportBtn').addEventListener('click', LAB.exportBoard);
  LAB.$('#importBtn').addEventListener('click', () => LAB.importBoard(() => { board = LAB.loadBoard(); LAB.reconcileBoard(board, players); render(); }));
  LAB.$('#resetBtn').addEventListener('click', () => {
    if (!confirm('Reset the ENTIRE board (all positions + overall) back to ADP-seeded tiers? Notes survive. This cannot be undone past the undo stack.')) return;
    snapshot();
    const notes = board.notes || {};
    board = LAB.seedBoard(players);
    board.notes = notes;
    commit();
    LAB.toast('Board reseeded from ADP', 'good');
  });
  LAB.$('#addTierBtn').addEventListener('click', () => {
    if (state.tab === 'OVR') return LAB.toast('Add tiers on a position tab — overall arranges those tiers');
    snapshot();
    const t = { id: LAB.newTierId(), players: [] };
    board.pos[state.tab].tiers.push(t);
    board.overall.push({ pos: state.tab, tierId: t.id });
    commit();
  });
  let searchTimer;
  LAB.$('#searchBox').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value.trim().toLowerCase(); render(); }, 150);
  });

  // ---------- quick actions sheet ----------
  function quickActions(pid) {
    const p = byId[pid];
    const pos = p.pos;
    const tiers = board.pos[pos].tiers;
    const curIdx = tiers.findIndex(t => t.players.includes(pid));
    const moveTo = tIdx => {
      snapshot();
      tiers[curIdx].players = tiers[curIdx].players.filter(x => x !== pid);
      tiers[tIdx].players.push(pid);
      commit(); ov.remove();
    };
    const bump = dir => {
      snapshot();
      const arr = tiers[curIdx].players;
      const i = arr.indexOf(pid);
      const j = i + dir;
      if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; commit(); }
      else if (dir < 0 && curIdx > 0) { arr.splice(i, 1); tiers[curIdx - 1].players.push(pid); commit(); }
      else if (dir > 0 && curIdx < tiers.length - 1) { arr.splice(i, 1); tiers[curIdx + 1].players.unshift(pid); commit(); }
      ov.remove();
    };
    const body = LAB.el('div', {},
      LAB.el('div', { class: 'flex' }, LAB.headshot(pid), LAB.el('b', {}, p.name), LAB.posBadge(pos),
        LAB.el('span', { class: 'muted' }, `Tier ${curIdx + 1}`)),
      LAB.el('div', { class: 'sheet-actions' },
        LAB.el('button', { class: 'btn', onclick: () => { ov.remove(); LAB.playerCard(pid); } }, 'Open card'),
        LAB.el('button', { class: 'btn', onclick: () => bump(-1) }, '▲ Bump up'),
        LAB.el('button', { class: 'btn', onclick: () => bump(1) }, '▼ Bump down'),
        LAB.el('button', { class: 'btn', onclick: () => {
          snapshot();
          const arr = tiers[curIdx].players;
          arr.splice(arr.indexOf(pid), 1); arr.unshift(pid); commit(); ov.remove();
        } }, '⤒ Top of tier')),
      LAB.el('div', { style: 'margin-top:10px' },
        LAB.el('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;margin-bottom:6px' }, 'Send to tier'),
        LAB.el('div', { class: 'sheet-actions', style: 'grid-template-columns:repeat(4,1fr)' },
          tiers.map((t, i) => LAB.el('button', {
            class: 'btn small' + (i === curIdx ? ' primary' : ''),
            onclick: () => moveTo(i),
          }, 'T' + (i + 1))))));
    const ov = LAB.modal(body);
  }

  // ---------- row builder ----------
  function playerRow(pid, rankNo, ovl, opts) {
    const p = byId[pid];
    if (!p) return null;
    const ranks = opts.adpPosMode ? p.adp_pos : p.adp;
    const holder = ovl && ovl.rostered[pid];
    const isKeeper = ovl && ovl.keepers.has(pid);
    const mine = ovl && ovl.mine.has(pid);
    const row = LAB.el('div', { class: 'prow', 'data-pid': pid },
      LAB.el('span', { class: 'rank' }, rankNo),
      LAB.headshot(pid),
      LAB.el('div', { class: 'pmeta' },
        LAB.teamLogo(p.team),
        LAB.el('span', { class: 'pname' }, p.name),
        opts.showPos ? LAB.posBadge(p.pos) : '',
        p.rookie ? LAB.el('span', { class: 'badge rookie' }, 'R') : '',
        p.status ? LAB.el('span', { class: 'badge status' }, p.status.slice(0, 3).toUpperCase()) : '',
        isKeeper ? LAB.el('span', { class: 'badge keeper', title: 'announced keeper' }, 'K') : '',
        mine ? LAB.el('span', { class: 'badge mine', title: 'on my roster' }, 'MINE')
          : holder ? LAB.el('span', { class: 'muted', style: 'font-size:11px', title: 'rostered by' }, holder) : '',
        (board.notes || {})[pid] ? LAB.el('span', { class: 'note-dot', title: board.notes[pid] }, '✎') : ''),
      LAB.el('div', { class: 'stats' },
        LAB.el('span', { class: 'stat w40', title: 'bye week' }, p.bye || '–'),
        LAB.el('span', { class: 'stat', title: 'ADP (FFC half-PPR)', style: 'display:flex;align-items:center;justify-content:flex-end;gap:5px' },
          LAB.el('span', { class: 'adp-dot', style: 'background:' + LAB.adpColor(rankNo, opts.adpPosMode ? p.adp_pos : p.adp) }),
          (opts.adpPosMode ? (p.adp_pos ?? '–') : (p.adp != null ? p.adp.toFixed(1) : '–'))),
        LAB.el('span', { class: 'stat hide-m', title: "2026 projection (your scoring)" }, LAB.fmt0(p.proj)),
        LAB.el('span', { class: 'stat hide-m', title: "2025 finish" }, p.fin25 ? p.pos + p.fin25 : '–'),
        LAB.el('span', { class: 'stat hide-m', title: "2025 PPG (your scoring)" }, LAB.fmt1(p.ppg25)),
        meta.bcFresh ? LAB.el('span', { class: 'stat w40 hide-m', title: 'Boris Chen tier' }, p.bc ? 'T' + p.bc : '–') : ''),
      LAB.el('button', { class: 'qa-btn', onclick: e => { e.stopPropagation(); quickActions(pid); } }, '⋮'));
    row.addEventListener('dblclick', () => LAB.playerCard(pid));
    if (state.search && !p.name.toLowerCase().includes(state.search)) row.style.display = 'none';
    return row;
  }

  function colHeads(opts) {
    return LAB.el('div', { class: 'col-heads' },
      LAB.el('span', { style: 'width:30px' }, '#'),
      LAB.el('span', { style: 'width:34px' }, ''),
      LAB.el('span', {}, 'Player'),
      LAB.el('div', { class: 'stats' },
        LAB.el('span', { class: 'stat w40' }, 'Bye'),
        LAB.el('span', { class: 'stat' }, opts.adpPosMode ? 'PosADP' : 'ADP'),
        LAB.el('span', { class: 'stat hide-m' }, "'26 Proj"),
        LAB.el('span', { class: 'stat hide-m' }, "'25 Fin"),
        LAB.el('span', { class: 'stat hide-m' }, "'25 PPG"),
        meta.bcFresh ? LAB.el('span', { class: 'stat w40 hide-m' }, 'BC') : ''),
      LAB.el('span', { style: 'width:24px' }, ''));
  }

  // ---------- position list view ----------
  function renderPosition(root, pos, ovl) {
    const tiers = board.pos[pos].tiers;
    root.append(colHeads({ adpPosMode: false }));
    const listWrap = LAB.el('div', { id: 'flatList' });
    let rank = 1;
    tiers.forEach((t, ti) => {
      const head = LAB.el('div', { class: 'tier-head' + (ti === 0 ? ' t1' : ''), 'data-tier': t.id },
        `Tier ${ti + 1}`,
        LAB.el('span', { class: 'count' }, `${t.players.length}`),
        LAB.el('div', { class: 't-actions' },
          ti > 0 ? LAB.el('button', { class: 'kill-btn', title: 'dissolve tier into previous', onclick: () => {
            snapshot();
            tiers[ti - 1].players.push(...t.players);
            board.overall = board.overall.filter(b => !(b.pos === pos && b.tierId === t.id));
            tiers.splice(ti, 1);
            commit();
          } }, '✕') : ''));
      listWrap.append(head);
      t.players.forEach(pid => {
        const r = playerRow(pid, rank++, ovl, { showPos: false, adpPosMode: false });
        if (r) listWrap.append(r);
      });
    });
    root.append(listWrap);

    new Sortable(listWrap, {
      animation: 120,
      draggable: '.prow, .tier-head',
      filter: '.qa-btn, .kill-btn',
      delay: 150, delayOnTouchOnly: true,
      onEnd: () => {
        snapshot();
        // rebuild tiers from DOM order: headers split the flat list
        const kids = Array.from(listWrap.children);
        const newTiers = [];
        let cur = null;
        const headerById = {};
        tiers.forEach(t => (headerById[t.id] = t));
        kids.forEach(k => {
          if (k.classList.contains('tier-head')) {
            cur = { id: k.dataset.tier, players: [] };
            newTiers.push(cur);
          } else if (k.classList.contains('prow')) {
            if (!cur) { cur = { id: tiers[0].id, players: [] }; newTiers.unshift(cur); }
            cur.players.push(k.dataset.pid);
          }
        });
        board.pos[pos].tiers = newTiers;
        // keep overall order for surviving tiers, in position-local order for stability
        const liveIds = new Set(newTiers.map(t => t.id));
        board.overall = board.overall.filter(b => !(b.pos === pos && !liveIds.has(b.tierId)));
        commit();
      },
    });
  }

  // ---------- overall (tier-block) view ----------
  function renderOverall(root, ovl) {
    const ranks = LAB.overallRanks(board);
    const wrap = LAB.el('div', { id: 'blockList' });
    board.overall.forEach(ref => {
      const tiers = board.pos[ref.pos].tiers;
      const ti = tiers.findIndex(t => t.id === ref.tierId);
      if (ti === -1) return;
      const t = tiers[ti];
      const collapsed = LAB.prefs['collapse-' + t.id];
      const blk = LAB.el('div', { class: `block block-${ref.pos}` + (collapsed ? ' collapsed' : ''), 'data-ref': ref.pos + ':' + ref.tierId },
        LAB.el('div', { class: 'block-head' },
          LAB.el('span', { class: 'grip' }, '⠿'),
          `${ref.pos} · Tier ${ti + 1}`,
          LAB.el('span', { class: 'count', style: 'color:var(--ink-3);font-size:12px;font-family:var(--font-body);text-transform:none' }, `${t.players.length} players`),
          LAB.el('button', { class: 'collapse-btn', style: 'margin-left:auto;background:none;border:0;color:var(--ink-3);cursor:pointer', onclick: e => {
            e.stopPropagation();
            blk.classList.toggle('collapsed');
            LAB.prefs['collapse-' + t.id] = blk.classList.contains('collapsed');
            LAB.savePrefs();
          } }, collapsed ? '▸' : '▾')),
        LAB.el('div', { class: 'block-body' },
          t.players.map(pid => playerRow(pid, ranks[pid], ovl, { showPos: true, adpPosMode: false }))));
      wrap.append(blk);
    });
    root.append(wrap);

    new Sortable(wrap, {
      animation: 130,
      handle: '.block-head',
      draggable: '.block',
      onEnd: () => {
        snapshot();
        board.overall = Array.from(wrap.children).map(k => {
          const [pos, tierId] = k.dataset.ref.split(':');
          return { pos, tierId };
        });
        commit();
      },
    });
    // within-block reorder (writes back to the position tier)
    LAB.$$('.block .block-body', root).forEach(bodyEl => {
      const [pos, tierId] = bodyEl.parentElement.dataset.ref.split(':');
      new Sortable(bodyEl, {
        animation: 120, draggable: '.prow', filter: '.qa-btn',
        delay: 150, delayOnTouchOnly: true,
        group: 'blk-' + tierId,
        onEnd: () => {
          snapshot();
          const t = board.pos[pos].tiers.find(x => x.id === tierId);
          if (t) t.players = Array.from(bodyEl.children).filter(k => k.dataset.pid).map(k => k.dataset.pid);
          commit();
        },
      });
    });
  }

  // ---------- big board grid ----------
  function renderGrid(root, ovl) {
    if (state.tab === 'OVR') {
      board.overall.forEach(ref => {
        const tiers = board.pos[ref.pos].tiers;
        const ti = tiers.findIndex(t => t.id === ref.tierId);
        if (ti === -1) return;
        root.append(gridBand(`${ref.pos} · Tier ${ti + 1}`, tiers[ti].players, ovl));
      });
    } else {
      board.pos[state.tab].tiers.forEach((t, ti) => {
        root.append(gridBand(`Tier ${ti + 1}`, t.players, ovl));
      });
    }
  }
  function gridBand(label, pids, ovl) {
    return LAB.el('div', { class: 'grid-band' },
      LAB.el('div', { class: 'band-label' }, label),
      pids.map(pid => {
        const p = byId[pid];
        if (!p) return null;
        const off = ovl && (ovl.keepers.has(pid));
        const chip = LAB.el('span', { class: `chip pos-${p.pos}` + (off ? ' drafted' : ''), onclick: () => LAB.playerCard(pid) },
          LAB.headshot(pid, 'sm'), p.name, LAB.el('span', { class: 'muted' }, p.team || ''));
        return chip;
      }));
  }

  // ---------- analyst compare view ----------
  const SRC_META = [['joel', 'Joel Smyth'], ['fp', 'FantasyPros'], ['flock', 'Flock'], ['fb', 'Footballers']];
  function renderCompare(root) {
    if (state.tab === 'OVR') {
      root.append(LAB.el('div', { class: 'empty' },
        'Analyst lists are positional — pick a position tab (QB / RB / WR / TE) to compare.'));
      return;
    }
    const pos = state.tab;
    const myRanks = LAB.posRanks(board, pos);
    const posPlayers = players.filter(p => p.pos === pos);
    const srcs = SRC_META.filter(([key]) => posPlayers.some(p => p.crs && p.crs[key] != null));
    if (!srcs.length) {
      root.append(LAB.el('div', { class: 'empty' }, 'No analyst lists loaded for ' + pos + '.'));
      return;
    }
    const cell = (rank, p, myRank, mine) => {
      const diff = mine || myRank == null || rank == null ? null : rank - myRank;
      const col = mine ? 'transparent' : LAB.adpColor(myRank, rank, 8);
      return LAB.el('div', {
        class: 'flex',
        style: `padding:3px 7px;border-radius:6px;margin-top:3px;font-size:12.5px;gap:6px;` +
          (mine ? 'background:var(--raised);border:1px solid var(--border-strong)'
                : `background:${col}22;box-shadow:inset 2px 0 0 ${col}`),
        title: p ? `${p.name} — you: ${pos}${myRank ?? '?'}` +
          (mine ? '' : ` · them: ${pos}${rank}` +
            (diff == null ? '' : diff === 0 ? ' (same)' : diff > 0 ? ` (you're ${diff} higher)` : ` (they're ${-diff} higher)`)) : '',
        onclick: p ? (() => LAB.playerCard(p.id)) : null,
      },
        LAB.el('span', { class: 'mono muted', style: 'width:22px;text-align:right;flex:none' }, rank),
        p ? LAB.headshot(p.id, 'sm') : '',
        LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;cursor:pointer' }, p ? p.name : '?'),
        !mine && diff != null && diff !== 0
          ? LAB.el('span', { class: 'mono', style: `margin-left:auto;flex:none;font-size:11px;color:${col}` },
              (diff > 0 ? '+' : '') + diff)
          : '');
    };
    const colWrap = (title, rows) => LAB.el('div', { style: 'flex:1;min-width:210px' },
      LAB.el('div', { style: 'font-family:var(--font-display);font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:14px;color:var(--ink-2);padding:2px 7px' }, title),
      rows);
    const wrap = LAB.el('div', { style: 'display:flex;gap:12px;overflow-x:auto;align-items:flex-start' });
    // my column, in board order
    const myOrdered = [];
    board.pos[pos].tiers.forEach(t => t.players.forEach(pid => myOrdered.push(byId[pid])));
    wrap.append(colWrap('My board', myOrdered.filter(Boolean).slice(0, 60)
      .map(p => cell(myRanks[p.id], p, myRanks[p.id], true))));
    // one column per source, each in that source's order; colored vs my rank
    for (const [key, label] of srcs) {
      const theirs = posPlayers.filter(p => p.crs && p.crs[key] != null)
        .sort((a, b) => a.crs[key] - b.crs[key]).slice(0, 60);
      wrap.append(colWrap(label, theirs.map(p => cell(p.crs[key], p, myRanks[p.id], false))));
    }
    root.append(LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px' },
      'Analyst columns are colored against YOUR board: ',
      LAB.el('b', { class: 'good' }, 'green'), ' = you rank the player higher than they do, ',
      LAB.el('b', { class: 'bad' }, 'red'), ' = they rank him higher than you. Click a name for the card.'));
    root.append(wrap);
  }

  // ---------- dynasty lens (view-only blend; tiers stay fixed, players
  // re-order only WITHIN their tier) ----------
  function renderDynasty(root, ovl) {
    const w = state.dynW;
    // per-position dynasty ranks (nulls sink)
    const dynRank = {};
    for (const pos of LAB.POS) {
      const list = players.filter(p => p.pos === pos)
        .sort((a, b) => (a.dyn ?? 9999) - (b.dyn ?? 9999));
      list.forEach((p, i) => (dynRank[p.id] = p.dyn != null ? i + 1 : null));
    }
    root.append(LAB.el('div', { class: 'card raised', style: 'margin-bottom:10px;padding:9px 13px;border-color:var(--accent)' },
      LAB.el('b', { class: 'accent' }, `Dynasty lens ${Math.round(w * 100)}%`),
      LAB.el('span', { class: 'dim', style: 'margin-left:8px;font-size:12.5px' },
        'tiers stay put — players re-order inside their tier by a blend of your rank and Sleeper dynasty half-PPR ADP. View only; slide to 0% to edit.')));

    const dynRow = (pid, showPos, displayRank, move) => {
      const p = byId[pid];
      if (!p) return null;
      const row = LAB.el('div', { class: 'prow', style: 'cursor:pointer' },
        LAB.el('span', { class: 'rank' }, displayRank),
        LAB.headshot(pid),
        LAB.el('div', { class: 'pmeta' },
          LAB.teamLogo(p.team),
          LAB.el('span', { class: 'pname' }, p.name),
          showPos ? LAB.posBadge(p.pos) : '',
          p.rookie ? LAB.el('span', { class: 'badge rookie' }, 'R') : ''),
        LAB.el('div', { class: 'stats' },
          LAB.el('span', { class: 'stat', title: 'dynasty positional rank' }, dynRank[pid] ? 'D' + dynRank[pid] : '–'),
          LAB.el('span', { class: 'stat w40 ' + (move > 0 ? 'good' : move < 0 ? 'bad' : 'muted'), title: 'movement within tier vs my order' },
            move === 0 ? '·' : (move > 0 ? '▲' + move : '▼' + -move))));
      row.addEventListener('click', () => LAB.playerCard(pid));
      if (state.search && !p.name.toLowerCase().includes(state.search)) row.style.display = 'none';
      return row;
    };

    // blend WITHIN one tier: my order index vs dynasty rank
    const blendTier = (tier, pos) => {
      const pRanks = LAB.posRanks(board, pos);
      const orig = tier.players.filter(pid => byId[pid]);
      const sorted = [...orig].sort((a, b) => {
        const sa = (1 - w) * pRanks[a] + w * (dynRank[a] ?? 999);
        const sb = (1 - w) * pRanks[b] + w * (dynRank[b] ?? 999);
        return sa - sb;
      });
      return sorted.map(pid => ({ pid, move: orig.indexOf(pid) - sorted.indexOf(pid) }));
    };

    if (state.tab === 'OVR') {
      let rank = 1;
      for (const ref of board.overall) {
        const tiers = board.pos[ref.pos].tiers;
        const ti = tiers.findIndex(t => t.id === ref.tierId);
        if (ti === -1) continue;
        const blk = LAB.el('div', { class: `block block-${ref.pos}` },
          LAB.el('div', { class: 'block-head', style: 'cursor:default' }, `${ref.pos} · Tier ${ti + 1}`),
          LAB.el('div', { class: 'block-body' },
            blendTier(tiers[ti], ref.pos).map(x => dynRow(x.pid, true, rank++, x.move))));
        root.append(blk);
      }
    } else {
      const tiers = board.pos[state.tab].tiers;
      let rank = 1;
      tiers.forEach((t, ti) => {
        root.append(LAB.el('div', { class: 'tier-head' + (ti === 0 ? ' t1' : ''), style: 'cursor:default' },
          `Tier ${ti + 1}`, LAB.el('span', { class: 'count' }, `${t.players.length}`)));
        blendTier(t, state.tab).forEach(x => {
          const r = dynRow(x.pid, false, rank++, x.move);
          if (r) root.append(r);
        });
      });
    }
  }

  // ---------- render ----------
  const root = LAB.$('#boardRoot');
  function render() {
    root.innerHTML = '';
    const ovl = overlayInfo();
    const dynActive = state.dynW > 0 && state.view === 'list';
    LAB.$('#addTierBtn').style.display =
      (state.tab === 'OVR' || state.view !== 'list' || dynActive) ? 'none' : '';
    LAB.$('#dynWrap').style.display = state.view === 'list' ? '' : 'none';
    if (state.view === 'compare') return renderCompare(root);
    if (state.view === 'grid') return renderGrid(root, ovl);
    if (dynActive) return renderDynasty(root, ovl);
    if (state.tab === 'OVR') renderOverall(root, ovl);
    else renderPosition(root, state.tab, ovl);
  }
  render();
})();
