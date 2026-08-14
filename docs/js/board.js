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
    if (!confirm('Reset the ENTIRE board (all positions + overall) back to the average of your analyst rankings, tiers included? Notes survive. This cannot be undone past the undo stack.')) return;
    snapshot();
    const notes = board.notes || {};
    board = LAB.seedBoard(players);
    board.notes = notes;
    commit();
    LAB.toast('Board + tiers reseeded from your analyst consensus', 'good');
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
  // Rows align by rank; my tier breaks run as full-width bars across every
  // column; my column stays drag-editable (writes the real board).
  const SRC_META = [['joel', 'Joel Smyth'], ['fp', 'FantasyPros'], ['flock', 'Flock'], ['fb', 'Footballers']];
  function diffColor(myRank, theirRank, span) {
    if (myRank == null || theirRank == null) return null;
    const t = Math.max(-1, Math.min(1, (theirRank - myRank) / (span || 6)));
    if (t === 0) return null;
    const from = [86, 98, 116];                       // neutral slate
    const to = t > 0 ? [62, 230, 143] : [255, 92, 92]; // bright green / bright red
    const u = Math.abs(t);
    return `rgb(${from.map((f, i) => Math.round(f + (to[i] - f) * u)).join(',')})`;
  }
  function renderCompare(root) {
    const pos = state.tab;
    const isOvr = pos === 'OVR';
    const myRanks = isOvr ? LAB.overallRanks(board) : LAB.posRanks(board, pos);
    const ranksOf = p => isOvr ? p.ocrs : p.crs;      // per-source rank map
    const avgOf = p => isOvr ? p.ocr : p.cr;          // consensus average
    const SPAN = isOvr ? 15 : 6;                      // full-color diff distance
    const tag = r => isOvr ? '#' + r : pos + r;
    const posPlayers = isOvr ? players : players.filter(p => p.pos === pos);
    const srcs = SRC_META.filter(([key]) => posPlayers.some(p => ranksOf(p) && ranksOf(p)[key] != null));
    if (!srcs.length) {
      root.append(LAB.el('div', { class: 'empty' }, 'No analyst lists loaded for ' + pos + '.'));
      return;
    }
    const srcLists = {};
    for (const [key] of srcs) {
      srcLists[key] = posPlayers.filter(p => ranksOf(p) && ranksOf(p)[key] != null)
        .sort((a, b) => ranksOf(a)[key] - ranksOf(b)[key]);
    }

    const CELL_BASE = 'display:flex;align-items:center;gap:6px;padding:4px 7px;border-radius:7px;margin-top:4px;font-size:12.5px;min-height:32px;';
    const myCell = pid => {
      const p = byId[pid];
      if (!p) return null;
      // vs the average of the analyst lists on this page (consensus avg)
      let vsAvg = '';
      const avg = avgOf(p);
      const my = myRanks[pid];
      if (avg != null && my != null) {
        const d = avg - my; // positive = I'm higher than their average
        const near = Math.abs(d) < (isOvr ? 3 : 1);
        const sym = near ? '＝' : d > 0 ? '▲' : '▼';
        const col = near ? 'var(--ink-3)' : d > 0 ? '#3ee68f' : '#f5c542';
        vsAvg = LAB.el('span', {
          style: `flex:none;font-size:${near ? 9 : 10}px;color:${col};width:14px;text-align:center`,
          title: `You: ${tag(my)} · their average: ${tag(avg.toFixed(1))}` +
            (near ? ' — right at the average' : d > 0 ? ` — you're ${d.toFixed(1)} higher` : ` — you're ${(-d).toFixed(1)} lower`),
        }, sym);
      }
      const c = LAB.el('div', {
        class: 'cmp-mine', 'data-pid': pid,
        style: CELL_BASE + 'background:var(--raised);border:1px solid var(--border-strong)' + (isOvr ? '' : ';cursor:grab'),
        title: p.name + (isOvr ? ' — edit on a position tab; ⋮ for actions' : ' — drag to re-rank, ⋮ for actions'),
      },
        LAB.el('span', { class: 'mono muted', style: 'width:22px;text-align:right;flex:none' }, myRanks[pid]),
        LAB.headshot(pid, 'sm'),
        LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600' }, p.name),
        isOvr ? LAB.posBadge(p.pos) : '',
        vsAvg,
        LAB.el('button', { class: 'qa-btn', style: 'margin-left:auto', onclick: e => { e.stopPropagation(); quickActions(pid); } }, '⋮'));
      c.addEventListener('dblclick', () => LAB.playerCard(pid));
      return c;
    };
    const analystCell = (p, rank) => {
      if (!p) return LAB.el('div', { style: CELL_BASE + 'opacity:0' }, '·');
      const myRank = myRanks[p.id];
      const diff = myRank != null ? rank - myRank : null;
      const col = diffColor(myRank, rank, SPAN);
      const bg = col ? `background:${col.replace('rgb', 'rgba').replace(')', ',0.28)')};box-shadow:inset 3px 0 0 ${col};` : 'background:var(--surface);border:1px solid var(--border);';
      return LAB.el('div', {
        style: CELL_BASE + bg + 'cursor:pointer',
        title: `${p.name} — you: ${myRank != null ? tag(myRank) : '—'} · them: ${tag(rank)}` +
          (diff == null ? ' (not on your board)' : diff === 0 ? ' (same)' : diff > 0 ? ` — you're ${diff} higher` : ` — they're ${-diff} higher`),
        onclick: () => LAB.playerCard(p.id),
      },
        LAB.el('span', { class: 'mono', style: 'width:22px;text-align:right;flex:none;color:' + (col || 'var(--ink-3)') }, rank),
        LAB.headshot(p.id, 'sm'),
        LAB.el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600' }, p.name),
        isOvr ? LAB.posBadge(p.pos) : '',
        diff != null && diff !== 0
          ? LAB.el('b', { class: 'mono', style: `margin-left:auto;flex:none;font-size:11.5px;color:${col}` }, (diff > 0 ? '+' : '') + diff)
          : '');
    };

    root.append(LAB.el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 10px' },
      'Rows align by rank; the bars are YOUR tiers. Analyst cells vs your board: ',
      LAB.el('b', { style: 'color:#3ee68f' }, 'green = you\'re higher on him'), ', ',
      LAB.el('b', { style: 'color:#ff5c5c' }, 'red = they\'re higher'), '. ',
      isOvr ? 'Overall lists: analyst rank numbers keep their K/DST gaps. Edit on a position tab.'
        : 'Drag in the My column to edit for real.'));

    const COLW = isOvr ? 235 : 210;
    const grid = LAB.el('div', { style: 'min-width:' + (COLW * (srcs.length + 1) + 12 * srcs.length) + 'px' });
    const outer = LAB.el('div', { style: 'overflow-x:auto' }, grid);
    const colStyle = 'flex:1;min-width:' + COLW + 'px';
    // header row
    grid.append(LAB.el('div', { style: 'display:flex;gap:12px' },
      [['', 'My board'], ...srcs].map(([, label], i) => LAB.el('div', {
        style: colStyle + ';font-family:var(--font-display);font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:14px;color:var(--ink-2);padding:2px 7px',
      }, i === 0 ? 'My board' : label))));

    const totalW = COLW * (srcs.length + 1) + 12 * srcs.length;

    if (isOvr) {
      // ---- OVR: whole tier blocks (the overall board arranges blocks) ----
      const blocks = board.overall.map(ref => {
        const posTiers = board.pos[ref.pos]?.tiers || [];
        const i = posTiers.findIndex(x => x.id === ref.tierId);
        return i >= 0 ? { tier: posTiers[i], pos: ref.pos, label: `${ref.pos} · Tier ${i + 1}` } : null;
      }).filter(Boolean);
      let cursor = 0; // rank index consumed so far
      blocks.forEach(({ tier: t, pos: bpos, label }, ti) => {
        const n = t.players.length;
        const blk = LAB.el('div', { class: 'cmp-block', 'data-tier': t.id, 'data-pos': bpos });
        blk.append(LAB.el('div', { class: 'tier-head' + (ti === 0 ? ' t1' : ''), style: 'cursor:grab;margin-top:10px', title: 'drag to move this whole tier block (overall arranges blocks)' },
          LAB.el('span', { class: 'grip', style: 'margin-right:6px' }, '⠿'),
          label, LAB.el('span', { class: 'count' }, `${n}`)));
        const row = LAB.el('div', { style: 'display:flex;gap:12px;align-items:flex-start' });
        const mineCol = LAB.el('div', { style: colStyle });
        t.players.forEach(pid => { const c = myCell(pid); if (c) mineCol.append(c); });
        row.append(mineCol);
        for (const [key] of srcs) {
          const col = LAB.el('div', { style: colStyle });
          for (let i = cursor; i < cursor + n; i++) {
            const p = srcLists[key][i];
            col.append(analystCell(p, p ? ranksOf(p)[key] : null));
          }
          row.append(col);
        }
        blk.append(row);
        grid.append(blk);
        cursor += n;
      });
      root.append(outer);
      new Sortable(grid, {
        animation: 130, handle: '.tier-head', draggable: '.cmp-block',
        onEnd: () => {
          snapshot();
          board.overall = Array.from(grid.querySelectorAll('.cmp-block'))
            .map(b => ({ pos: b.dataset.pos, tierId: b.dataset.tier }));
          commit();
        },
      });
      return;
    }

    // ---- position tab: one flat my-column; tier bars are movable BREAKS —
    // drag a bar between players to re-split tiers, drag players to re-rank
    grid.style.width = totalW + 'px'; // fixed widths keep the bars spanning exactly
    const tiers = board.pos[pos].tiers;
    const BAR_H = 36; // fixed bar height so analyst columns stay row-aligned
    const myCol = LAB.el('div', { style: colStyle });
    tiers.forEach((t, ti) => {
      myCol.append(LAB.el('div', {
        class: 'tier-head' + (ti === 0 ? ' t1' : ''), 'data-tier': t.id,
        style: `width:${totalW}px;height:${BAR_H}px;box-sizing:border-box;position:relative;z-index:2`,
        title: 'drag between players to move this tier break',
      },
        LAB.el('span', { class: 'grip', style: 'margin-right:6px;color:var(--ink-3)' }, '⠿'),
        `Tier ${ti + 1}`, LAB.el('span', { class: 'count' }, `${t.players.length}`)));
      t.players.forEach(pid => { const c = myCell(pid); if (c) myCol.append(c); });
    });
    const row = LAB.el('div', { style: 'display:flex;gap:12px;align-items:flex-start' });
    row.append(myCol);
    for (const [key] of srcs) {
      const col = LAB.el('div', { style: colStyle });
      let i = 0;
      tiers.forEach(t => {
        col.append(LAB.el('div', { style: `height:${BAR_H}px;margin-top:10px` })); // aligns with the bar
        for (let k = 0; k < t.players.length; k++, i++) {
          const p = srcLists[key][i];
          col.append(analystCell(p, p ? ranksOf(p)[key] : null));
        }
      });
      row.append(col);
    }
    grid.append(row);
    root.append(outer);

    new Sortable(myCol, {
      animation: 120, draggable: '.cmp-mine, .tier-head', filter: '.qa-btn',
      delay: 150, delayOnTouchOnly: true,
      onEnd: () => {
        snapshot();
        const newTiers = [];
        let cur = null;
        const leading = []; // players dropped above the Tier 1 bar
        Array.from(myCol.children).forEach(k => {
          if (k.classList.contains('tier-head')) {
            cur = { id: k.dataset.tier, players: [] };
            newTiers.push(cur);
          } else if (k.classList.contains('cmp-mine')) {
            (cur ? cur.players : leading).push(k.dataset.pid);
          }
        });
        if (newTiers.length) newTiers[0].players = leading.concat(newTiers[0].players);
        board.pos[pos].tiers = newTiers;
        commit();
      },
    });
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
