/* THE LAB — in-season: command center, waivers, trade radar, league pulse */
(async function () {
  LAB.nav('Season');
  const { players, leagues, lookup, meta, sos } = await LAB.loadData(['players', 'leagues', 'lookup', 'meta', 'sos']);
  const byId = LAB.playersById(players);
  const board = LAB.getBoardOrSeed(players);
  const oRanks = LAB.overallRanks(board);
  const root = LAB.$('#root');

  const liveCache = {};
  async function liveGet(path) {
    if (!liveCache[path]) liveCache[path] = LAB.live(path);
    return liveCache[path];
  }

  let nflState = meta.state;
  try { nflState = await liveGet('/state/nfl'); } catch (e) {}
  const inSeason = nflState.season_type === 'regular';
  const week = Math.max(1, nflState.display_week || 1);

  let tab = 'command';
  LAB.$$('#tabs button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.t;
    LAB.$$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }));

  function lk(pid) { // resolve any player id
    if (byId[pid]) return { name: byId[pid].name, pos: byId[pid].pos, team: byId[pid].team, pool: byId[pid] };
    const l = lookup[pid];
    return l ? { name: l[0], pos: l[1], team: l[2], pool: null } : { name: pid, pos: '?', team: '', pool: null };
  }

  async function liveLeague(tag) {
    const L = leagues[tag];
    const [rosters, users] = await Promise.all([
      liveGet(`/league/${L.id}/rosters`), liveGet(`/league/${L.id}/users`)]);
    const userMap = {};
    users.forEach(u => (userMap[u.user_id] = { name: u.display_name, team: (u.metadata || {}).team_name }));
    return { ...L, liveRosters: rosters, userMap };
  }

  // ---------- COMMAND CENTER ----------
  async function renderCommand() {
    root.innerHTML = '';
    if (!inSeason) {
      root.append(LAB.el('div', { class: 'card' },
        LAB.el('h2', {}, 'Preseason mode'),
        LAB.el('p', { class: 'dim' }, `The command center goes live in the regular season (kickoff Sep 10). Current phase: ${nflState.season_type}. Until then:`),
        LAB.el('ul', { class: 'dim', style: 'line-height:1.9' },
          LAB.el('li', {}, LAB.el('a', { href: 'board.html' }, 'Build your tiers'), ' — the whole site runs on them'),
          LAB.el('li', {}, LAB.el('a', { href: 'keepers.html' }, 'Lock keeper decisions'), ' — GGG deadline Aug 31'),
          LAB.el('li', {}, LAB.el('a', { href: 'draft.html' }, 'Run mock drafts'), ' from your real slot once order posts'))));
    }
    for (const tag of ['ggg', 'lob']) {
      const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' }, LAB.el('h2', {}, leagues[tag].name));
      root.append(card);
      try {
        const L = await liveLeague(tag);
        const my = L.liveRosters.find(r => r.owner_id === L.myUserId);
        if (!my) { card.append(LAB.el('div', { class: 'empty' }, 'Roster not found')); continue; }
        const flags = [];
        (my.players || []).forEach(pid => {
          const info = lk(pid);
          const p = info.pool;
          if (!p) return;
          const isStarter = (my.starters || []).includes(pid);
          if (p.status && isStarter) flags.push(`${p.name} is ${p.status.toUpperCase()} and in your lineup`);
          if (inSeason && p.bye === week && isStarter) flags.push(`${p.name} is on BYE this week and in your lineup`);
        });
        if (inSeason && (my.starters || []).includes(null)) flags.push('You have an EMPTY starting slot');
        if (flags.length) {
          card.append(LAB.el('div', { class: 'card raised', style: 'border-color:var(--warn);margin-bottom:10px' },
            LAB.el('b', { class: 'warn' }, '⚠ Decisions needed'),
            LAB.el('ul', { style: 'margin:6px 0 0;padding-left:18px' }, flags.map(f => LAB.el('li', {}, f)))));
        } else {
          card.append(LAB.el('div', { class: 'good', style: 'font-size:12.5px;font-weight:600;margin-bottom:8px' }, '✓ No lineup alarms'));
        }
        // matchup (in season)
        if (inSeason) {
          const matchups = await liveGet(`/league/${L.id}/matchups/${week}`);
          const mineM = matchups.find(m => m.roster_id === my.roster_id);
          const opp = matchups.find(m => m.matchup_id === mineM?.matchup_id && m.roster_id !== my.roster_id);
          if (mineM && opp) {
            const oppRoster = L.liveRosters.find(r => r.roster_id === opp.roster_id);
            const oppName = L.userMap[oppRoster?.owner_id]?.name || '?';
            card.append(LAB.el('div', { class: 'tiles', style: 'grid-template-columns:1fr 1fr;margin-bottom:10px' },
              LAB.el('div', { class: 'tile' }, LAB.el('div', { class: 't-label' }, `Week ${week} — me`),
                LAB.el('div', { class: 't-value' }, (mineM.points || 0).toFixed(1))),
              LAB.el('div', { class: 'tile' }, LAB.el('div', { class: 't-label' }, `vs ${oppName}`),
                LAB.el('div', { class: 't-value' }, (opp.points || 0).toFixed(1)))));
          }
        }
        // roster table
        const tbl = LAB.el('table', { class: 'lab' },
          LAB.el('thead', {}, LAB.el('tr', {},
            LAB.el('th', {}, ''), LAB.el('th', {}, 'Player'), LAB.el('th', {}, ''),
            LAB.el('th', { class: 'num' }, 'Bye'), LAB.el('th', { class: 'num' }, "'26 proj"),
            LAB.el('th', { class: 'num' }, 'My rank'))));
        const tb = LAB.el('tbody');
        const sortedPids = [...(my.players || [])].sort((a, b) => (oRanks[a] || 999) - (oRanks[b] || 999));
        sortedPids.forEach(pid => {
          const info = lk(pid);
          const p = info.pool;
          const isStarter = (my.starters || []).includes(pid);
          tb.append(LAB.el('tr', { style: p ? 'cursor:pointer' : '', onclick: p ? (() => LAB.playerCard(pid)) : null },
            LAB.el('td', {}, LAB.headshot(pid)),
            LAB.el('td', {}, LAB.el('div', { class: 'flex' },
              LAB.el('b', {}, info.name), LAB.posBadge(info.pos),
              isStarter ? LAB.el('span', { class: 'badge mine' }, 'START') : '',
              (my.keepers || []).includes(pid) ? LAB.el('span', { class: 'badge keeper' }, 'K') : '',
              p && p.status ? LAB.el('span', { class: 'badge status' }, p.status.slice(0, 3).toUpperCase()) : '')),
            LAB.el('td', {}, info.team || ''),
            LAB.el('td', { class: 'num' }, p ? (p.bye || '–') : '–'),
            LAB.el('td', { class: 'num' }, p ? LAB.fmt0(p.proj) : '–'),
            LAB.el('td', { class: 'num' }, oRanks[pid] ? '#' + oRanks[pid] : '–')));
        });
        tbl.append(tb);
        card.append(tbl);
      } catch (e) {
        card.append(LAB.el('div', { class: 'empty' }, 'Live fetch failed: ' + e.message));
      }
    }
  }

  // ---------- WAIVERS ----------
  async function renderWaivers() {
    root.innerHTML = '';
    let trendingMap = {};
    try {
      const trending = await liveGet('/players/nfl/trending/add?limit=100');
      trending.forEach(t => (trendingMap[t.player_id] = t.count));
    } catch (e) {}
    for (const tag of ['ggg', 'lob']) {
      const otherTag = tag === 'ggg' ? 'lob' : 'ggg';
      const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
        LAB.el('h2', {}, leagues[tag].name + ' — best available'));
      root.append(card);
      try {
        const L = await liveLeague(tag);
        const Lo = await liveLeague(otherTag);
        const taken = new Set();
        L.liveRosters.forEach(r => (r.players || []).forEach(pid => taken.add(pid)));
        const takenOther = new Set();
        Lo.liveRosters.forEach(r => (r.players || []).forEach(pid => takenOther.add(pid)));
        const myOther = Lo.liveRosters.find(r => r.owner_id === Lo.myUserId);
        const mineOther = new Set(myOther?.players || []);
        const fas = players
          .filter(p => !taken.has(p.id))
          .sort((a, b) => (oRanks[a.id] || 999) - (oRanks[b.id] || 999))
          .slice(0, 40);
        const tbl = LAB.el('table', { class: 'lab' },
          LAB.el('thead', {}, LAB.el('tr', {},
            LAB.el('th', {}, ''), LAB.el('th', {}, 'Player'),
            LAB.el('th', { class: 'num' }, 'My rank'), LAB.el('th', { class: 'num' }, "'26 proj"),
            LAB.el('th', { class: 'num' }, '🔥 adds'), LAB.el('th', {}, 'Elsewhere'))));
        const tb = LAB.el('tbody');
        fas.forEach(p => {
          tb.append(LAB.el('tr', { style: 'cursor:pointer', onclick: () => LAB.playerCard(p.id) },
            LAB.el('td', {}, LAB.headshot(p.id)),
            LAB.el('td', {}, LAB.el('div', { class: 'flex' }, LAB.el('b', {}, p.name), LAB.posBadge(p.pos),
              p.status ? LAB.el('span', { class: 'badge status' }, p.status.slice(0, 3).toUpperCase()) : '')),
            LAB.el('td', { class: 'num' }, oRanks[p.id] ? '#' + oRanks[p.id] : '–'),
            LAB.el('td', { class: 'num' }, LAB.fmt0(p.proj)),
            LAB.el('td', { class: 'num' }, trendingMap[p.id] ? trendingMap[p.id].toLocaleString() : ''),
            LAB.el('td', { class: 'muted', style: 'font-size:11.5px' },
              mineOther.has(p.id) ? LAB.el('span', { class: 'badge mine' }, 'MINE IN ' + otherTag.toUpperCase())
                : takenOther.has(p.id) ? `taken in ${otherTag.toUpperCase()}` : 'free in both')));
        });
        tbl.append(tb);
        card.append(tbl);
      } catch (e) {
        card.append(LAB.el('div', { class: 'empty' }, 'Live fetch failed: ' + e.message));
      }
    }
  }

  // ---------- TRADE RADAR ----------
  const STARTER_NEED = { QB: 1, RB: 3, WR: 3, TE: 1, DEF: 1 }; // startable depth incl. flex share
  async function renderTrades() {
    root.innerHTML = '';
    for (const tag of ['ggg', 'lob']) {
      const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
        LAB.el('h2', {}, leagues[tag].name + ' — trade radar'));
      root.append(card);
      try {
        const L = await liveLeague(tag);
        const strength = r => {
          const byPos = { QB: [], RB: [], WR: [], TE: [], DEF: [] };
          (r.players || []).forEach(pid => {
            const p = byId[pid];
            if (p) byPos[p.pos].push(p.proj || 0);
          });
          Object.values(byPos).forEach(a => a.sort((x, y) => y - x));
          return byPos;
        };
        const my = L.liveRosters.find(r => r.owner_id === L.myUserId);
        if (!my) { card.append(LAB.el('div', { class: 'empty' }, 'Roster not found')); continue; }
        const myS = strength(my);
        const myNeed = [], mySurplus = [];
        for (const pos of LAB.SKILL) {
          const depth = myS[pos].filter(v => v > 80).length;
          if (depth < STARTER_NEED[pos]) myNeed.push(pos);
          if (depth > STARTER_NEED[pos] + (pos === 'QB' || pos === 'TE' ? 0 : 1)) mySurplus.push(pos);
        }
        card.append(LAB.el('p', { class: 'dim', style: 'margin:4px 0 10px' },
          `My needs: ${myNeed.length ? myNeed.join(', ') : 'none glaring'} · my surplus: ${mySurplus.length ? mySurplus.join(', ') : 'none'}`));
        for (const r of L.liveRosters) {
          if (r.owner_id === L.myUserId) continue;
          const name = L.userMap[r.owner_id]?.name || '?';
          const s = strength(r);
          const theirSurplus = [], theirNeed = [];
          for (const pos of LAB.SKILL) {
            const depth = s[pos].filter(v => v > 80).length;
            if (depth > STARTER_NEED[pos] + (pos === 'QB' || pos === 'TE' ? 0 : 1)) theirSurplus.push(pos);
            if (depth < STARTER_NEED[pos]) theirNeed.push(pos);
          }
          const give = mySurplus.filter(pos => theirNeed.includes(pos));
          const get = theirSurplus.filter(pos => myNeed.includes(pos));
          if (!give.length && !get.length) continue;
          const targets = get.flatMap(pos => (r.players || [])
            .map(pid => byId[pid]).filter(p => p && p.pos === pos)
            .sort((a, b) => (b.proj || 0) - (a.proj || 0)).slice(1, 3)); // their 2nd/3rd best = gettable
          card.append(LAB.el('div', { class: 'intel-card' },
            LAB.el('div', { class: 'i-name' }, name),
            LAB.el('div', { class: 'i-traits' },
              get.length ? LAB.el('span', { class: 'trait hot' }, `they have ${get.join('/')} you need`) : '',
              give.length ? LAB.el('span', { class: 'trait' }, `they need your ${give.join('/')}`) : '',
              targets.map(p => LAB.el('span', { class: 'trait', style: 'cursor:pointer', onclick: () => LAB.playerCard(p.id) }, `target: ${p.name}`)))));
        }
      } catch (e) {
        card.append(LAB.el('div', { class: 'empty' }, 'Live fetch failed: ' + e.message));
      }
    }
  }

  // ---------- LEAGUE PULSE ----------
  async function renderPulse() {
    root.innerHTML = '';
    for (const tag of ['ggg', 'lob']) {
      const card = LAB.el('div', { class: 'card', style: 'margin-top:14px' },
        LAB.el('h2', {}, leagues[tag].name + ' — standings'));
      root.append(card);
      try {
        const L = await liveLeague(tag);
        const rows = L.liveRosters.map(r => ({
          name: L.userMap[r.owner_id]?.name || '?',
          teamName: L.userMap[r.owner_id]?.team || '',
          me: r.owner_id === L.myUserId,
          w: (r.settings || {}).wins || 0, l: (r.settings || {}).losses || 0,
          fpts: ((r.settings || {}).fpts || 0) + ((r.settings || {}).fpts_decimal || 0) / 100,
          fpa: ((r.settings || {}).fpts_against || 0) + ((r.settings || {}).fpts_against_decimal || 0) / 100,
        })).sort((a, b) => b.w - a.w || b.fpts - a.fpts);
        if (!inSeason) card.append(LAB.el('p', { class: 'dim' }, 'Standings populate once games start.'));
        const tbl = LAB.el('table', { class: 'lab' },
          LAB.el('thead', {}, LAB.el('tr', {},
            LAB.el('th', {}, '#'), LAB.el('th', {}, 'Team'),
            LAB.el('th', { class: 'num' }, 'W'), LAB.el('th', { class: 'num' }, 'L'),
            LAB.el('th', { class: 'num' }, 'PF'), LAB.el('th', { class: 'num' }, 'PA'))));
        const tb = LAB.el('tbody');
        rows.forEach((r, i) => {
          tb.append(LAB.el('tr', { style: r.me ? 'background:var(--accent-soft)' : '' },
            LAB.el('td', { class: 'num' }, i + 1),
            LAB.el('td', {}, LAB.el('b', {}, r.name), r.teamName ? LAB.el('span', { class: 'muted', style: 'margin-left:6px;font-size:11.5px' }, r.teamName) : ''),
            LAB.el('td', { class: 'num' }, r.w), LAB.el('td', { class: 'num' }, r.l),
            LAB.el('td', { class: 'num' }, r.fpts.toFixed(1)), LAB.el('td', { class: 'num' }, r.fpa.toFixed(1))));
        });
        tbl.append(tb);
        card.append(tbl);
      } catch (e) {
        card.append(LAB.el('div', { class: 'empty' }, 'Live fetch failed: ' + e.message));
      }
    }
  }

  function render() {
    root.innerHTML = '<div class="empty">Loading…</div>';
    ({ command: renderCommand, waivers: renderWaivers, trades: renderTrades, pulse: renderPulse })[tab]();
  }
  render();
})();
