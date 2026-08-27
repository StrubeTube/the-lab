/* THE LAB — Trade Finder page: steer, rank, track, and send preseason
   proposals. Engine + generator live in tradecore.js; this file is UI.
   Left rail: shop-a-player, target-a-return, dials, partner intel.
   Center: ranked proposal feed with score breakdowns and pitch copy.
   Right rail: the campaign (Sent / Countered / Dead / Accepted). */
(async function () {
  LAB.nav('Finder');
  const { players, leagues, trades } = await LAB.loadData(['players', 'leagues', 'trades']);
  const root = LAB.$('#root');

  const K_INTEL = 'thelab-intel-v1';
  const K_PROPS = 'thelab-proposals-v1';
  const K_WEIGHTS = 'thelab-finder-weights-v1';
  const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  let tag = LAB.prefs.dmLeague || 'ggg';
  const tabs = LAB.$('#leagueTabs');
  for (const t of ['ggg', 'lob']) {
    tabs.append(LAB.el('button', {
      class: t === tag ? 'active' : '',
      onclick: e => {
        tag = t;
        LAB.$$('#leagueTabs button').forEach(x => x.classList.toggle('active', x === e.target));
        init();
      },
    }, leagues[t].name));
  }

  // intel starts empty now. The old seed (VERO wants Pickens) is DEAD — Chris
  // denied interest 8/26 — so a one-time migration strips it from any device
  // that stored it and keeps the denial as a note instead.
  let intel = store(K_INTEL, null) || { ggg: {}, lob: {} };
  if (!store('thelab-intel-fix1', false)) {
    const L0 = leagues.ggg;
    const vero = L0.rosters.find(r => (L0.users[r.owner]?.name || '').toUpperCase().startsWith('VEROVILLI'));
    const iv = vero && (intel.ggg || {})[vero.rid];
    if (iv && (iv.wants || []).includes('8137')) {
      iv.wants = iv.wants.filter(x => x !== '8137');
      iv.note = 'asked about Pickens — denied interest (8/26)';
    }
    save(K_INTEL, intel);
    save('thelab-intel-fix1', true);
  }
  let statuses = store(K_PROPS, {});
  let weights = store(K_WEIGHTS, { motivation: 1, propensity: 1, fairness: 1, market: 1, intel: 1 });

  let L, C, props;
  // filters are EXCLUSION-style (per Alex): everything shows by default,
  // click a chip to remove it from the feed, click again to bring it back
  const ui = { exclAssets: new Set(), exclTeams: new Set(), exclTargets: new Set(), minTier: 'all', minGain: 0, aggr: 'ladder', maxAssets: 3, showWeights: false, showDead: false, expand: {} };

  const mgrName = rid => (L.users[(L.rosters.find(r => r.rid === rid) || {}).owner]?.name) || 'Team ' + rid;
  const pname = pid => C.byId[pid]?.name || pid;
  const hash = x => [tag, x.type, x.rid, x.rung,
    x.give.map(a => a.kind === 'pick' ? 'p' + a.round + '.' + a.origRid : a.id).join('+'),
    x.get.map(a => a.kind === 'pick' ? 'p' + a.round + '.' + a.origRid : a.id).join('+')].join('|');
  const tier = s => s >= 8 ? ['🔥 likely', '#3ee68f'] : s >= 6 ? ['⚖ coin-flip', 'var(--warn)'] : ['🎯 anchor shot', '#ff5c5c'];
  const prob = s => s >= 9 ? 0.6 : s >= 8 ? 0.45 : s >= 7 ? 0.32 : s >= 6 ? 0.22 : s >= 5 ? 0.12 : 0.06;
  const fmtAsset = a => a.kind === 'pick' ? `2026 R${a.round}` : pname(a.id);

  function rebuild() {
    const intelList = [];
    for (const [rid, v] of Object.entries(intel[tag] || {})) {
      if (v.never) intelList.push({ rid: +rid, boost: -4, note: 'marked: never trades' });
      for (const pid of (v.wants || [])) intelList.push({ rid: +rid, pid, boost: 3.5, note: v.note || 'wants him' });
    }
    props = LAB.tradeFinder(C, L, {
      basis: 'true', aggr: ui.aggr, maxAssets: ui.maxAssets, weights, intel: intelList,
    });
    for (const x of props) x.h = hash(x);
  }
  function init() {
    L = leagues[tag];
    C = LAB.tradeCore(players, LAB.getBoardOrSeed(players), L, trades[tag] || { trades: [], tradedPicks: [], market: [] }, trades);
    ui.exclAssets = new Set(); ui.exclTeams = new Set(); ui.exclTargets = new Set();
    rebuild();
    render();
  }

  const setStatus = (h, status) => {
    if (status === null) delete statuses[h];
    else statuses[h] = { ...(statuses[h] || {}), status, ts: Date.now(), tag };
    save(K_PROPS, statuses);
    render();
  };

  function pitchText(x) {
    const give = x.give.map(fmtAsset).join(' + ');
    const get = x.get.map(fmtAsset).join(' + ');
    return `Hey ${mgrName(x.rid)} — offer: my ${give} for your ${get}. ` +
      (x.why ? `Why it works for you: ${x.why}. ` : '') +
      (x.precedent && !/rule of thumb|price/.test(x.precedent) ? `League precedent: ${x.precedent}. ` : '') +
      `Thoughts?`;
  }

  // ---------- rails ----------
  function controlsRail() {
    const rail = LAB.el('div', { class: 'card side-rail', style: 'width:250px;flex:none' }, LAB.el('h2', {}, 'Steer'));
    const label = t => LAB.el('div', { class: 'muted', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px' }, t);
    // exclusion chip: lit = in the feed, dimmed/struck = filtered out
    const xchip = (lbl, excluded, fn) => LAB.el('button', {
      class: excluded ? '' : 'active',
      style: 'font-size:11px;padding:2px 8px' + (excluded ? ';opacity:.4;text-decoration:line-through' : ''),
      title: excluded ? 'hidden — click to include again' : 'click to filter out',
      onclick: fn,
    }, lbl);
    const toggle = (set, key) => { set.has(key) ? set.delete(key) : set.add(key); render(); };
    // teams (click to exclude)
    rail.append(label('Teams'));
    const teamRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:4px' });
    teamRow.append(LAB.el('button', {
      class: ui.exclTeams.size ? '' : 'active', style: 'font-size:11px;padding:2px 8px',
      onclick: () => { ui.exclTeams = new Set(); render(); },
    }, 'All'));
    L.rosters.filter(r => r.rid !== C.myRid).forEach(r =>
      teamRow.append(xchip(mgrName(r.rid), ui.exclTeams.has(r.rid), () => toggle(ui.exclTeams, r.rid))));
    rail.append(teamRow);
    // my assets (click to stop shopping one)
    rail.append(label('My assets'));
    const myAssets = [];
    const me = L.rosters.find(r => r.rid === C.myRid);
    const slateIds = new Set(C.slate(me.players, 'true').map(x => x.p.id));
    me.players.map(pid => C.byId[pid])
      .filter(p => C.eligible(p) && !slateIds.has(p.id) && (C.surplusSlots(p, 'true') ?? 0) > 0)
      .forEach(p => myAssets.push({ key: 'pl:' + p.id, label: p.name }));
    C.openOf(C.myRid).forEach(o => myAssets.push({ key: 'pk:' + o.round + '.' + o.origRid, label: 'R' + o.round + (o.origRid !== C.myRid ? ' ⇄' : '') }));
    const shopRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:4px' });
    shopRow.append(LAB.el('button', {
      class: ui.exclAssets.size ? '' : 'active', style: 'font-size:11px;padding:2px 8px',
      onclick: () => { ui.exclAssets = new Set(); render(); },
    }, 'All'));
    myAssets.forEach(a => shopRow.append(xchip(a.label, ui.exclAssets.has(a.key), () => toggle(ui.exclAssets, a.key))));
    rail.append(shopRow);
    // return types (click to exclude what you DON'T want back)
    rail.append(label('Returns (click to exclude)'));
    const tRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:4px' });
    [['early', 'R1-4 pick'], ['mid', 'R5-8 pick'], ['late', 'R9+ pick'], ['upgrade', 'Slate upgrade'], ['consolidate', 'Consolidate']]
      .forEach(([k, lbl]) => tRow.append(xchip(lbl, ui.exclTargets.has(k), () => toggle(ui.exclTargets, k))));
    rail.append(tRow);
    // dials
    rail.append(label('Dials'));
    const dial = (lbl, el) => LAB.el('div', { class: 'flex', style: 'gap:6px;font-size:11.5px;margin-top:4px;align-items:center' },
      LAB.el('span', { style: 'width:86px;flex:none' }, lbl), el);
    const aggrSeg = LAB.el('div', { class: 'seg' },
      [['market', 'Market'], ['ladder', 'Ladder'], ['aggressive', 'Aggro']].map(([k, lbl]) =>
        LAB.el('button', { class: ui.aggr === k ? 'active' : '', style: 'font-size:10.5px;padding:2px 7px', onclick: () => { ui.aggr = k; rebuild(); render(); } }, lbl)));
    rail.append(dial('Asks', aggrSeg));
    const tierSeg = LAB.el('div', { class: 'seg' },
      [['all', 'All'], ['coin', '⚖+'], ['fire', '🔥 only']].map(([k, lbl]) =>
        LAB.el('button', { class: ui.minTier === k ? 'active' : '', style: 'font-size:10.5px;padding:2px 7px', onclick: () => { ui.minTier = k; render(); } }, lbl)));
    rail.append(dial('Min success', tierSeg));
    const gainIn = LAB.el('input', { type: 'number', value: ui.minGain, style: 'width:64px', onchange: e => { ui.minGain = +e.target.value || 0; render(); } });
    rail.append(dial('Min my gain', gainIn));
    const maxSeg = LAB.el('div', { class: 'seg' },
      [[2, '1-for-1'], [3, 'Packages']].map(([k, lbl]) =>
        LAB.el('button', { class: ui.maxAssets === k ? 'active' : '', style: 'font-size:10.5px;padding:2px 7px', onclick: () => { ui.maxAssets = k; rebuild(); render(); } }, lbl)));
    rail.append(dial('Size', maxSeg));
    // weights drawer
    rail.append(label('Model'));
    rail.append(LAB.el('button', { style: 'font-size:11px', onclick: () => { ui.showWeights = !ui.showWeights; render(); } },
      (ui.showWeights ? '▾' : '▸') + ' scoring weights'));
    if (ui.showWeights) {
      for (const k of ['motivation', 'propensity', 'fairness', 'market', 'intel']) {
        const s = LAB.el('input', {
          type: 'range', min: 0, max: 2, step: 0.25, value: weights[k], style: 'flex:1',
          oninput: e => { weights[k] = +e.target.value; save(K_WEIGHTS, weights); rebuild(); render(); },
        });
        rail.append(dial(k + ' ×' + weights[k], s));
      }
    }
    // partner intel
    rail.append(label('Partner intel'));
    for (const P of L.rosters) {
      if (P.rid === C.myRid) continue;
      const iv = (intel[tag] || {})[P.rid] || {};
      const open = ui.intelOpen === P.rid;
      rail.append(LAB.el('div', { style: 'margin-top:3px' },
        LAB.el('button', {
          style: 'font-size:11px;width:100%;text-align:left' + (iv.note || (iv.wants || []).length || iv.never ? ';border-color:var(--accent)' : ''),
          onclick: () => { ui.intelOpen = open ? null : P.rid; render(); },
        }, (open ? '▾ ' : '▸ ') + mgrName(P.rid) + (iv.never ? ' 🚫' : (iv.wants || []).length ? ' ★' : ''))));
      if (open) {
        const box = LAB.el('div', { style: 'border:1px solid var(--border);border-radius:7px;padding:6px;margin-top:3px;font-size:11.5px' });
        const note = LAB.el('input', { type: 'text', placeholder: 'note (e.g. QB-desperate)', value: iv.note || '', style: 'width:100%' });
        note.onchange = () => { intel[tag][P.rid] = { ...iv, note: note.value }; save(K_INTEL, intel); rebuild(); render(); };
        box.append(note);
        const wantIn = LAB.el('input', { type: 'text', list: 'fdPlayers', placeholder: 'wants player… (type name)', style: 'width:100%;margin-top:4px' });
        wantIn.onchange = () => {
          const p = players.find(x => x.name.toLowerCase() === wantIn.value.trim().toLowerCase());
          if (!p) return LAB.toast('no player by that name');
          intel[tag][P.rid] = { ...iv, wants: [...new Set([...(iv.wants || []), p.id])] };
          save(K_INTEL, intel); rebuild(); render();
        };
        box.append(wantIn);
        (iv.wants || []).forEach(pid => box.append(LAB.el('span', {
          class: 'badge', style: 'cursor:pointer;margin:3px 3px 0 0', title: 'click to remove',
          onclick: () => { intel[tag][P.rid].wants = iv.wants.filter(x => x !== pid); save(K_INTEL, intel); rebuild(); render(); },
        }, '★ ' + pname(pid) + ' ✕')));
        box.append(LAB.el('label', { class: 'flex', style: 'gap:5px;margin-top:4px;cursor:pointer' },
          LAB.el('input', { type: 'checkbox', checked: iv.never ? '' : null, onchange: e => { intel[tag][P.rid] = { ...iv, never: e.target.checked }; save(K_INTEL, intel); rebuild(); render(); } }),
          'never trades'));
        rail.append(box);
      }
    }
    const dl = LAB.el('datalist', { id: 'fdPlayers' });
    players.slice(0, 400).forEach(p => dl.append(LAB.el('option', { value: p.name })));
    rail.append(dl);
    return rail;
  }

  function campaignRail() {
    const rail = LAB.el('div', { class: 'card side-rail', style: 'width:250px;flex:none;position:sticky;top:10px' }, LAB.el('h2', {}, 'Campaign'));
    const mine = props.filter(x => statuses[x.h]);
    const groups = { sent: '📤 Sent', countered: '🔁 Countered', accepted: '✅ Accepted', dead: '💀 Dead' };
    let any = false;
    for (const [st, lbl] of Object.entries(groups)) {
      const list = mine.filter(x => statuses[x.h].status === st);
      if (!list.length) continue;
      if (st === 'dead' && !ui.showDead) {
        rail.append(LAB.el('button', { style: 'font-size:11px;margin-top:8px', onclick: () => { ui.showDead = true; render(); } }, `▸ ${lbl} (${list.length})`));
        continue;
      }
      any = true;
      rail.append(LAB.el('div', { class: 'muted', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:8px 0 2px' }, lbl));
      for (const x of list) {
        rail.append(LAB.el('div', { style: 'border:1px solid var(--border);border-radius:7px;padding:4px 7px;margin-top:3px;font-size:11px' },
          LAB.el('b', {}, mgrName(x.rid)), LAB.el('br'),
          LAB.el('span', { class: 'muted' }, x.title.slice(0, 44)),
          LAB.el('div', { class: 'flex', style: 'gap:4px;margin-top:3px' },
            ...(st !== 'accepted' ? [['countered', '🔁'], ['dead', '💀'], ['accepted', '✅']] : [])
              .filter(([s2]) => s2 !== st)
              .map(([s2, ic]) => LAB.el('button', { style: 'font-size:10px;padding:1px 6px', onclick: () => setStatus(x.h, s2) }, ic)),
            LAB.el('button', { style: 'font-size:10px;padding:1px 6px', title: 'clear', onclick: () => setStatus(x.h, null) }, '✕'))));
      }
    }
    if (!any && !mine.length) rail.append(LAB.el('p', { class: 'muted', style: 'font-size:11.5px' }, 'Nothing sent yet. Mark a card 📤 when you fire it off — dead openings auto-suggest their fallback.'));
    return rail;
  }

  // ---------- feed ----------
  // hand a proposal to the Trade Lab builder (was referenced but never
  // defined — the pairs-view builder buttons were dead until now)
  const loadProposal = (rid, x) => {
    save('thelab-handoff-v1', { tag, partnerRid: rid, give: x.give, get: x.get });
    location.href = 'trade.html';
  };
  // exclusion + dial filters, STATUS-BLIND — sections need dead options
  // countable so they can offer a per-action reset
  function passes(x) {
    if (ui.exclTeams.has(x.rid)) return false;
    for (const a of x.give) {
      const key = a.kind === 'player' ? 'pl:' + a.id : 'pk:' + a.round + '.' + a.origRid;
      if (ui.exclAssets.has(key)) return false;
    }
    const gp = x.get.filter(a => a.kind === 'pick').map(a => a.round);
    if (ui.exclTargets.has('early') && gp.some(r => r <= 4)) return false;
    if (ui.exclTargets.has('mid') && gp.some(r => r >= 5 && r <= 8)) return false;
    if (ui.exclTargets.has('late') && gp.some(r => r >= 9)) return false;
    if (ui.exclTargets.has('upgrade') && x.get.some(a => a.kind === 'player')) return false;
    if (ui.exclTargets.has('consolidate') && x.type === 'picks') return false;
    if (ui.minTier === 'fire' && x.score < 8) return false;
    if (ui.minTier === 'coin' && x.score < 6) return false;
    if (x.myGain < ui.minGain) return false;
    return true;
  }

  // one asset, drawn like a person would read it: face + name + the keeper
  // math for players, a big round chip for picks
  function assetRow(a, ownerRid) {
    if (a.kind === 'pick') {
      const via = a.origRid !== ownerRid;
      return LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:center;padding:3px 0' },
        LAB.el('span', {
          class: 'mono',
          style: 'flex:none;width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;background:rgba(245,197,66,.12);border:1px solid var(--warn);color:var(--warn)',
        }, 'R' + a.round),
        LAB.el('div', { style: 'min-width:0' },
          LAB.el('div', { style: 'font-weight:600;font-size:12.5px' }, `Round ${a.round} pick`),
          LAB.el('div', { class: 'mono muted', style: 'font-size:10px' }, a.season + (via ? ' · via trade' : ''))));
    }
    const p = C.byId[a.id];
    const s = C.surplusSlots(p, 'true') ?? 0;
    return LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:center;padding:3px 0' },
      LAB.headshot(a.id, 'sm'),
      LAB.el('div', { style: 'min-width:0' },
        LAB.el('div', { class: 'flex', style: 'gap:5px;align-items:center' },
          LAB.el('b', { style: 'font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, p.name),
          LAB.posBadge(p.pos)),
        LAB.el('div', { class: 'mono muted', style: 'font-size:10px' },
          `keeps at R${C.costRd(p)} · `,
          LAB.el('b', { style: 'color:' + (s > 0 ? '#3ee68f' : 'var(--ink-3)') }, (s > 0 ? '+' : '') + Math.round(s) + ' true'))));
  }

  // if this trade nets me an extra pick (over the 16 limit), suggest the
  // small follow-up shed that balances me back — rendered as a quiet rider
  function rebalanceRow(x) {
    const netPicks = x.get.filter(a => a.kind === 'pick').length - x.give.filter(a => a.kind === 'pick').length;
    if (netPicks <= 0) return '';
    const given = x.give.filter(a => a.kind === 'pick').map(a => a.round + '.' + a.origRid);
    const rb = LAB.rebalanceFor(C, L, { exclude: given });
    if (!rb) return '';
    return LAB.el('div', {
      style: 'margin-top:5px;padding:4px 8px;border-left:2px solid var(--accent);background:rgba(255,106,43,.05);border-radius:0 6px 6px 0;font-size:10.5px;color:var(--ink-2)',
    },
      LAB.el('b', { style: 'color:var(--accent)' }, '↩ then rebalance to 16: '),
      `my R${rb.give[0].round} + R${rb.give[1].round} → ${mgrName(rb.rid)}'s R${rb.get.round}`,
      LAB.el('span', { class: 'mono muted' }, ` (${rb.net >= 0 ? '+' : ''}${Math.round(rb.net)} value, they're short on picks) `),
      LAB.el('button', {
        style: 'font-size:10px;padding:1px 7px;margin-left:4px',
        onclick: () => loadProposal(rb.rid, { give: rb.give.map(a => ({ kind: 'pick', ...a })), get: [{ kind: 'pick', ...rb.get }] }),
      }, 'load ▸'));
  }

  function card(x, grp) {
    const t = tier(x.score);
    const st = statuses[x.h]?.status;
    // auto-ladder: a dead OPENING makes its FALLBACK sibling glow
    const deadOpening = x.rung === 'FALLBACK' && props.some(y => y.rid === x.rid && y.type === x.type
      && y.rung === 'OPENING' && statuses[y.h]?.status === 'dead'
      && y.give.map(fmtAsset).join() === x.give.map(fmtAsset).join());
    const el = LAB.el('div', {
      style: 'border:1px solid ' + (deadOpening ? 'var(--accent)' : 'var(--border)') + ';border-radius:10px;padding:9px 12px;margin-top:8px;background:var(--surface)',
    },
      LAB.el('div', { class: 'flex', style: 'gap:8px;flex-wrap:wrap;align-items:baseline' },
        LAB.el('b', { style: 'font-family:var(--font-display);font-size:15px' }, mgrName(x.rid)),
        LAB.el('span', { class: 'badge', style: 'font-size:9px' }, x.rung),
        LAB.el('b', { style: 'font-size:11.5px;color:' + t[1] }, t[0]),
        LAB.el('span', { class: 'mono', style: 'font-size:11px;color:#3ee68f' }, `me +${Math.round(x.myGain)}`),
        LAB.el('span', { class: 'mono muted', style: 'font-size:11px' }, `them ${x.theirGain >= 0 ? '+' : ''}${Math.round(x.theirGain)}`),
        deadOpening ? LAB.el('span', { style: 'font-size:10.5px;color:var(--accent);font-weight:700' }, '↩ NEXT RUNG — opening died') : '',
        x.chips.slice(0, 2).map(c => LAB.el('span', { class: 'badge', style: 'font-size:9px' }, c))),
      grp && grp.vs.length > 1 ? LAB.el('div', { class: 'flex', style: 'gap:5px;flex-wrap:wrap;margin-top:4px;align-items:center' },
        LAB.el('span', { class: 'muted', style: 'font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em' }, 'works with'),
        grp.vs.map((v, i) => LAB.el('button', {
          class: v === x ? 'active' : '',
          style: 'font-size:10.5px;padding:1px 8px',
          title: `${tier(v.score)[0]} · me +${Math.round(v.myGain)} · them ${v.theirGain >= 0 ? '+' : ''}${Math.round(v.theirGain)}`,
          onclick: () => { ui.groupSel[grp.k] = i; render(); },
        }, `${mgrName(v.rid)} ${tier(v.score)[0].split(' ')[0]}`))) : '',
      LAB.el('div', { style: 'display:flex;gap:10px;align-items:stretch;margin-top:7px' },
        LAB.el('div', { style: 'flex:1;min-width:0;border:1px solid rgba(255,92,92,.35);border-radius:8px;padding:4px 9px 6px;background:rgba(255,92,92,.05)' },
          LAB.el('div', { style: 'font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#ff5c5c' }, 'you send'),
          x.give.map(a => assetRow(a, C.myRid))),
        LAB.el('div', { style: 'align-self:center;flex:none;font-size:17px;color:var(--ink-3)' }, '⇄'),
        LAB.el('div', { style: 'flex:1;min-width:0;border:1px solid rgba(62,230,143,.35);border-radius:8px;padding:4px 9px 6px;background:rgba(62,230,143,.05)' },
          LAB.el('div', { style: 'font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#3ee68f' }, 'you get'),
          x.get.map(a => assetRow(a, x.rid)))),
      x.why ? LAB.el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px' }, 'Their angle: ' + x.why) : '',
      rebalanceRow(x),
      LAB.el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:3px' }, '⚖ ' + x.precedent),
      LAB.el('div', {
        class: 'mono muted', style: 'font-size:10px;margin-top:3px', title: 'score breakdown',
      }, 'score ' + x.score.toFixed(1) + ' = 3 base ' + x.parts.filter(p => Math.abs(p.v) >= 0.05)
        .map(p => (p.v > 0 ? '+' : '−') + Math.abs(p.v).toFixed(1) + ' ' + p.k).join(' ')),
      LAB.el('div', { class: 'flex', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' },
        LAB.el('button', { style: 'font-size:11px', onclick: () => { setStatus(x.h, st === 'sent' ? null : 'sent'); } }, st === 'sent' ? '📤 sent ✓' : '📤 mark sent'),
        LAB.el('button', {
          style: 'font-size:11px', onclick: () => {
            navigator.clipboard.writeText(pitchText(x)).then(() => LAB.toast('pitch copied — paste into league chat', 'good'));
          },
        }, '📋 copy pitch'),
        LAB.el('button', {
          style: 'font-size:11px', onclick: () => {
            save('thelab-handoff-v1', { tag, partnerRid: x.rid, give: x.give, get: x.get });
            location.href = 'trade.html';
          },
        }, '⚗ open in builder'),
        LAB.el('button', { style: 'font-size:11px', onclick: () => setStatus(x.h, 'dead') }, '💀')));
    return el;
  }

  // ---------- pick pairs: one self-contained card per two-trade combo ----------
  function pairCard(pr) {
    const box = (title, sub, side, ownerRid) => LAB.el('div', { style: 'flex:1;min-width:230px' },
      LAB.el('div', { class: 'flex', style: 'gap:6px;align-items:baseline' },
        LAB.el('b', { style: 'font-family:var(--font-display);font-size:13px' }, title),
        LAB.el('span', { class: 'muted', style: 'font-size:10px' }, sub),
        LAB.el('span', { class: 'mono', style: 'font-size:10px;color:#3ee68f' }, `me +${Math.round(side.net)}`),
        side.optics != null ? LAB.el('span', {
          class: 'mono', style: 'font-size:10px;color:var(--warn)',
          title: 'what the deal looks like TO THEM on a classic linear value chart — positive means two real picks beat the one they give',
        }, `their chart +${Math.round(side.optics)}`) : ''),
      LAB.el('div', { style: 'display:flex;gap:8px;margin-top:3px' },
        LAB.el('div', { style: 'flex:1;border:1px solid rgba(255,92,92,.35);border-radius:7px;padding:3px 7px 5px;background:rgba(255,92,92,.05)' },
          LAB.el('div', { style: 'font-size:8.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#ff5c5c' }, 'you send'),
          side.give.map(a => assetRow({ kind: 'pick', ...a }, C.myRid))),
        LAB.el('div', { style: 'align-self:center;flex:none;color:var(--ink-3)' }, '⇄'),
        LAB.el('div', { style: 'flex:1;border:1px solid rgba(62,230,143,.35);border-radius:7px;padding:3px 7px 5px;background:rgba(62,230,143,.05)' },
          LAB.el('div', { style: 'font-size:8.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#3ee68f' }, 'you get'),
          side.get.map(a => assetRow({ kind: 'pick', ...a }, ownerRid)))));
    const oName = mgrName(pr.over.rid), uName = mgrName(pr.under.rid);
    const oOver = C.ownedPicks(pr.over.rid).length - 16, uShort = 16 - C.ownedPicks(pr.under.rid).length;
    const pitch = 'Two clean pick trades, no players:\n' +
      `1) ${oName}: my R${pr.over.give.map(a => a.round).join('+R')} for your R${pr.over.get.map(a => a.round).join('+R')} — you're carrying ${oOver} pick${oOver > 1 ? 's' : ''} more than you can roster (and they all count on your cap); this sheds one.\n` +
      `2) ${uName}: my R${pr.under.give.map(a => a.round).join('+R')} for your R${pr.under.get.map(a => a.round).join('+R')} — you're ${uShort} short; this fixes your count AND nets you +${Math.round(pr.under.optics || 0)} on a classic value chart (two real picks beat the one).`;
    const outR = [...pr.over.give, ...pr.under.give].map(a => a.round).sort((x, y) => x - y);
    const inR = [...pr.over.get, ...pr.under.get].map(a => a.round).sort((x, y) => x - y);
    const netChip = (r, col2) => LAB.el('span', {
      class: 'mono',
      style: `display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;font-weight:700;font-size:12px;margin-right:4px;border:1px solid ${col2};color:${col2};background:${col2}11`,
    }, 'R' + r);
    return LAB.el('div', {
      style: 'border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-top:8px;background:var(--surface)',
    },
      LAB.el('div', { style: 'border:1.5px solid var(--accent);border-radius:9px;padding:6px 10px 8px;background:rgba(255,106,43,.05)' },
        LAB.el('div', { class: 'flex', style: 'gap:10px;flex-wrap:wrap;align-items:baseline' },
          LAB.el('b', { style: 'font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent)' }, 'net — both trades together'),
          LAB.el('b', { style: 'font-size:12.5px;color:#3ee68f' }, `+${Math.round(pr.total)} value`),
          LAB.el('span', { class: 'muted', style: 'font-size:10.5px' }, 'count stays 16 · no shared picks')),
        LAB.el('div', { class: 'flex', style: 'gap:12px;flex-wrap:wrap;margin-top:5px;align-items:center' },
          LAB.el('span', { style: 'font-size:10px;font-weight:700;color:#ff5c5c;text-transform:uppercase' }, 'out'),
          LAB.el('span', {}, outR.map(r => netChip(r, '#ff5c5c'))),
          LAB.el('span', { style: 'color:var(--ink-3)' }, '→'),
          LAB.el('span', { style: 'font-size:10px;font-weight:700;color:#3ee68f;text-transform:uppercase' }, 'in'),
          LAB.el('span', {}, inR.map(r => netChip(r, '#3ee68f'))))),
      LAB.el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:8px' },
        box(`1 · ${oName}`, `${oOver} over 16 — extra salary`, pr.over, pr.over.rid),
        box(`2 · ${uName}`, `${uShort} short, needs count`, pr.under, pr.under.rid)),
      LAB.el('div', { class: 'flex', style: 'gap:6px;margin-top:7px;flex-wrap:wrap' },
        LAB.el('button', {
          style: 'font-size:11px',
          onclick: () => loadProposal(pr.over.rid, { give: pr.over.give.map(a => ({ kind: 'pick', ...a })), get: pr.over.get.map(a => ({ kind: 'pick', ...a })) }),
        }, '⚗ trade 1 in builder'),
        LAB.el('button', {
          style: 'font-size:11px',
          onclick: () => loadProposal(pr.under.rid, { give: pr.under.give.map(a => ({ kind: 'pick', ...a })), get: pr.under.get.map(a => ({ kind: 'pick', ...a })) }),
        }, '⚗ trade 2 in builder'),
        LAB.el('button', {
          style: 'font-size:11px',
          onclick: () => navigator.clipboard.writeText(pitch).then(() => LAB.toast('both pitches copied', 'good')),
        }, '📋 copy both pitches')));
  }

  // ---------- the page IS the priority list (Alex 8/27): one numbered ----------
  // section per targeted action — each spare keeper to sell, then pick
  // balance, then leftovers — with the top options stacked under it.
  // 💀 kills an option forever (persisted by hash) and the next-best one
  // takes its seat; each section can resurrect its dead in one click.
  function render() {
    root.innerHTML = '';
    const row = LAB.el('div', { style: 'display:flex;gap:14px;margin-top:14px;align-items:flex-start;flex-wrap:wrap' });
    row.append(controlsRail());
    const feedCol = LAB.el('div', { style: 'flex:1;min-width:340px' });
    const byScore = (a, b2) => b2.score - a.score || b2.myGain - a.myGain;
    const stOf = x => statuses[x.h]?.status;

    // one proposal, one row
    const optionRow = x => {
      const t = tier(x.score);
      const st = stOf(x);
      const open = ui.topOpen === x.h;
      return LAB.el('div', { style: 'margin-top:6px;border:1px solid ' + (st ? 'var(--accent)' : 'var(--border)') + ';border-radius:8px;padding:5px 9px;background:var(--surface)' },
        LAB.el('div', { class: 'flex', style: 'gap:7px;flex-wrap:wrap;align-items:baseline' },
          st ? LAB.el('b', { style: 'font-size:10px;color:var(--accent)' }, st === 'sent' ? '📤 SENT' : '🔁 COUNTERED') : '',
          LAB.el('b', { style: 'font-size:12.5px' }, mgrName(x.rid)),
          LAB.el('span', { style: 'font-size:12px' }, 'my ' + x.give.map(fmtAsset).join(' + ') + ' ⇄ ' + x.get.map(fmtAsset).join(' + ')),
          LAB.el('span', { class: 'badge', style: 'font-size:8.5px' }, x.rung),
          LAB.el('b', { style: 'font-size:10.5px;color:' + t[1] }, t[0]),
          LAB.el('span', { class: 'mono', style: 'font-size:10.5px;color:#3ee68f' }, '+' + Math.round(x.myGain)),
          LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px' }, `them ${x.theirGain >= 0 ? '+' : ''}${Math.round(x.theirGain)}`)),
        x.why ? LAB.el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:1px' }, 'Their angle: ' + x.why) : '',
        LAB.el('div', { class: 'flex', style: 'gap:5px;margin-top:4px;flex-wrap:wrap' },
          LAB.el('button', { style: 'font-size:10.5px;padding:1px 8px', onclick: () => navigator.clipboard.writeText(pitchText(x)).then(() => LAB.toast('pitch copied — paste into league chat', 'good')) }, '📋 pitch'),
          LAB.el('button', { style: 'font-size:10.5px;padding:1px 8px', onclick: () => setStatus(x.h, st === 'sent' ? null : 'sent') }, st === 'sent' ? '📤 sent ✓' : '📤 mark sent'),
          LAB.el('button', { style: 'font-size:10.5px;padding:1px 8px', title: 'kill this option — the next-best takes its place; reset from the section header', onclick: () => setStatus(x.h, 'dead') }, '💀 dead'),
          LAB.el('button', { style: 'font-size:10.5px;padding:1px 8px', onclick: () => loadProposal(x.rid, x) }, '⚗ builder'),
          LAB.el('button', { style: 'font-size:10.5px;padding:1px 8px', onclick: () => { ui.topOpen = open ? null : x.h; render(); } }, open ? '▾ hide' : '▸ details')),
        open ? card(x) : '');
    };

    const sectionEl = (S, si, contentEls) => {
      const el = LAB.el('div', { style: 'border:1.5px solid var(--accent);border-radius:10px;padding:8px 12px 10px;margin-top:10px;background:rgba(255,106,43,.05)' },
        LAB.el('div', { class: 'flex', style: 'gap:8px;align-items:baseline;flex-wrap:wrap' },
          LAB.el('b', { class: 'mono', style: 'color:var(--accent);font-size:15px' }, (si + 1) + '.'),
          LAB.el('b', { style: 'font-family:var(--font-display);font-size:15px' }, S.title),
          LAB.el('span', { class: 'mono muted', style: 'font-size:10.5px' }, S.meta),
          S.dead && S.dead.length ? LAB.el('button', {
            style: 'font-size:9.5px;padding:0 7px;margin-left:auto', title: 'un-kill these options and surface them again',
            onclick: () => { S.dead.forEach(x => delete statuses[x.h]); save(K_PROPS, statuses); render(); },
          }, `💀 ${S.dead.length} dead — reset`) : ''));
      contentEls.forEach(c => el.append(c));
      return el;
    };

    // build the action list
    const me0 = L.rosters.find(r => r.rid === C.myRid);
    const slate0 = new Set(C.slate(me0.players, 'true').map(s => s.p.id));
    const spares = me0.players.map(pid => C.byId[pid])
      .filter(p => p && C.eligible(p) && !slate0.has(p.id) && (C.surplusSlots(p, 'true') ?? 0) > 3)
      .sort((a, b2) => (C.surplusSlots(b2, 'true') ?? 0) - (C.surplusSlots(a, 'true') ?? 0));
    const used = new Set();
    const secs = [];
    for (const p of spares) {
      const opts = props.filter(x => passes(x) && x.give.some(a => a.kind === 'player' && a.id === p.id)).sort(byScore);
      opts.forEach(x => used.add(x.h));
      const live = opts.filter(x => !stOf(x));
      const sent = opts.filter(x => stOf(x) === 'sent' || stOf(x) === 'countered');
      const dead = opts.filter(x => stOf(x) === 'dead');
      secs.push({
        key: 'sell:' + p.id, title: 'Sell ' + p.name,
        meta: `K R${C.costRd(p)} · +${Math.round(C.surplusSlots(p, 'true') ?? 0)} true — surplus you keep only by trading him`,
        live, sent, dead, rank: sent.length ? 9.5 : (live[0]?.score ?? -1),
      });
    }
    const other = props.filter(x => passes(x) && !used.has(x.h)).sort(byScore);
    if (other.length) {
      secs.push({
        key: 'other', title: 'Other moves', meta: 'pick consolidations & slate buys the sells above don\'t cover',
        live: other.filter(x => !stOf(x)),
        sent: other.filter(x => stOf(x) === 'sent' || stOf(x) === 'countered'),
        dead: other.filter(x => stOf(x) === 'dead'),
        rank: (other.find(x => !stOf(x))?.score ?? 0) - 2.5,
      });
    }
    secs.sort((a, b2) => b2.rank - a.rank);

    secs.forEach((S, si) => {
      const parts = [];
      S.sent.forEach(x => parts.push(optionRow(x)));
      const shown = ui.expand[S.key] ? S.live : S.live.slice(0, 3);
      shown.forEach(x => parts.push(optionRow(x)));
      if (!S.live.length && !S.sent.length) parts.push(LAB.el('p', { class: 'muted', style: 'font-size:11.5px;margin:6px 0 0' },
        S.dead.length ? 'every option is marked dead — reset above to retry them, or wait for the board to shift' : 'no live buyer right now — their slates are full'));
      if (S.live.length > 3) parts.push(LAB.el('button', {
        style: 'font-size:10.5px;margin-top:5px',
        onclick: () => { ui.expand[S.key] = !ui.expand[S.key]; render(); },
      }, ui.expand[S.key] ? '▴ fewer' : `▾ ${S.live.length - 3} more option${S.live.length - 3 > 1 ? 's' : ''}`));
      feedCol.append(sectionEl(S, si, parts));
    });

    // pick balance rides as the final numbered action
    const pairs = (LAB.pickPairs(C, L) || []).filter(pr => !ui.exclTeams.has(pr.over.rid) && !ui.exclTeams.has(pr.under.rid));
    if (pairs.length) {
      const parts = (ui.expand.pairs ? pairs.slice(0, 4) : pairs.slice(0, 1)).map(pairCard);
      if (pairs.length > 1) parts.push(LAB.el('button', {
        style: 'font-size:10.5px;margin-top:5px',
        onclick: () => { ui.expand.pairs = !ui.expand.pairs; render(); },
      }, ui.expand.pairs ? '▴ fewer' : `▾ ${Math.min(pairs.length, 4) - 1} more pair combos`));
      feedCol.append(sectionEl({ title: 'Balance the pick ledger', meta: 'two pick-only trades accepted together — consolidate up with an over-16 team, shed to a short one' }, secs.length, parts));
    }
    if (!secs.length && !pairs.length) feedCol.append(LAB.el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:10px' },
      'Nothing actionable — no spare keepers with surplus and no workable pick pairs. Loosen a dial or clear exclusions.'));

    row.append(feedCol);
    row.append(campaignRail());
    root.append(row);
  }

  init();
})();
