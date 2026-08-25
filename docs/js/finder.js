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

  // seed intel once: Chris (VEROVILLIANZ) wants Pickens
  let intel = store(K_INTEL, null);
  if (!intel) {
    intel = { ggg: {}, lob: {} };
    const L0 = leagues.ggg;
    const vero = L0.rosters.find(r => (L0.users[r.owner]?.name || '').toUpperCase().startsWith('VEROVILLI'));
    if (vero) intel.ggg[vero.rid] = { note: 'Chris — already asked about Pickens', wants: ['8137'], never: false };
    save(K_INTEL, intel);
  }
  let statuses = store(K_PROPS, {});
  let weights = store(K_WEIGHTS, { motivation: 1, propensity: 1, fairness: 1, market: 1, intel: 1 });

  let L, C, props;
  const ui = { sort: 'success', shop: null, target: 'any', minTier: 'all', minGain: 0, aggr: 'ladder', maxAssets: 3, showWeights: false, showDead: false };

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
    ui.shop = null;
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
    const rail = LAB.el('div', { class: 'card', style: 'width:250px;flex:none' }, LAB.el('h2', {}, 'Steer'));
    const label = t => LAB.el('div', { class: 'muted', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px' }, t);
    // shop-a-player
    rail.append(label('Shop an asset'));
    const myAssets = [];
    const me = L.rosters.find(r => r.rid === C.myRid);
    const slateIds = new Set(C.slate(me.players, 'true').map(x => x.p.id));
    me.players.map(pid => C.byId[pid])
      .filter(p => C.eligible(p) && !slateIds.has(p.id) && (C.surplusSlots(p, 'true') ?? 0) > 0)
      .forEach(p => myAssets.push({ key: 'pl:' + p.id, label: p.name }));
    C.openOf(C.myRid).forEach(o => myAssets.push({ key: 'pk:' + o.round + '.' + o.origRid, label: 'R' + o.round + (o.origRid !== C.myRid ? ' ⇄' : '') }));
    const shopRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:4px' });
    const chip = (lbl, on, fn, extra) => LAB.el('button', { class: on ? 'active' : '', style: 'font-size:11px;padding:2px 8px' + (extra || ''), onclick: fn }, lbl);
    shopRow.append(chip('Everything', !ui.shop, () => { ui.shop = null; render(); }));
    myAssets.forEach(a => shopRow.append(chip(a.label, ui.shop === a.key, () => { ui.shop = ui.shop === a.key ? null : a.key; render(); })));
    rail.append(shopRow);
    // target-a-return
    rail.append(label('I want back'));
    const tRow = LAB.el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:4px' });
    [['any', 'Anything'], ['early', 'R1-4 pick'], ['mid', 'R5-8 pick'], ['late', 'R9+ picks'], ['upgrade', 'Slate upgrade'], ['consolidate', 'Consolidate']]
      .forEach(([k, lbl]) => tRow.append(chip(lbl, ui.target === k, () => { ui.target = k; render(); })));
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
    const rail = LAB.el('div', { class: 'card', style: 'width:250px;flex:none;position:sticky;top:10px' }, LAB.el('h2', {}, 'Campaign'));
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
  function matchesUI(x) {
    const st = statuses[x.h]?.status;
    if (st === 'dead' || st === 'accepted') return false; // live feed only
    if (ui.shop) {
      const [kind, key] = ui.shop.split(':');
      const inGive = x.give.some(a => kind === 'pl' ? a.id === key : a.kind === 'pick' && (a.round + '.' + a.origRid) === key);
      if (!inGive) return false;
    }
    if (ui.target !== 'any') {
      const gp = x.get.filter(a => a.kind === 'pick').map(a => a.round);
      if (ui.target === 'early' && !gp.some(r => r <= 4)) return false;
      if (ui.target === 'mid' && !gp.some(r => r >= 5 && r <= 8)) return false;
      if (ui.target === 'late' && !gp.some(r => r >= 9)) return false;
      if (ui.target === 'upgrade' && !x.get.some(a => a.kind === 'player')) return false;
      if (ui.target === 'consolidate' && x.type !== 'picks') return false;
    }
    if (ui.minTier === 'fire' && x.score < 8) return false;
    if (ui.minTier === 'coin' && x.score < 6) return false;
    if (x.myGain < ui.minGain) return false;
    return true;
  }

  function card(x) {
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
      LAB.el('div', { style: 'font-weight:600;font-size:13px;margin-top:3px' }, x.title),
      x.why ? LAB.el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:2px' }, 'Their angle: ' + x.why) : '',
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

  function render() {
    root.innerHTML = '';
    const row = LAB.el('div', { style: 'display:flex;gap:14px;margin-top:14px;align-items:flex-start;flex-wrap:wrap' });
    row.append(controlsRail());
    const feedCol = LAB.el('div', { style: 'flex:1;min-width:340px' });
    // sort seg
    const sortSeg = LAB.el('div', { class: 'seg' },
      [['success', 'Success'], ['gain', 'My value'], ['ev', 'Blend']].map(([k, lbl]) =>
        LAB.el('button', { class: ui.sort === k ? 'active' : '', onclick: () => { ui.sort = k; render(); } }, lbl)));
    feedCol.append(LAB.el('div', { class: 'flex', style: 'gap:10px;align-items:center;flex-wrap:wrap' },
      LAB.el('b', { style: 'font-family:var(--font-display);text-transform:uppercase;letter-spacing:.04em' }, 'Proposals'), sortSeg));
    let list = props.filter(matchesUI);
    list.sort((a, b2) => ui.sort === 'gain' ? b2.myGain - a.myGain
      : ui.sort === 'ev' ? prob(b2.score) * b2.myGain - prob(a.score) * a.myGain
        : b2.score - a.score || b2.myGain - a.myGain);
    if (!list.length) feedCol.append(LAB.el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:10px' }, 'Nothing matches these filters — loosen a dial or clear the shop selection.'));
    list.slice(0, ui.showAll ? 999 : 14).forEach(x => feedCol.append(card(x)));
    if (!ui.showAll && list.length > 14) {
      feedCol.append(LAB.el('button', { style: 'margin-top:8px', onclick: () => { ui.showAll = true; render(); } }, `show all ${list.length}`));
    }
    row.append(feedCol);
    row.append(campaignRail());
    root.append(row);
  }

  init();
})();
