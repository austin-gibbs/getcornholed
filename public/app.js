'use strict';
/* Get Cornholed — client app. The server is the single source of truth for
 * bracket state; this file renders it and (for the organizer only) scores. */

const $ = (sel) => document.querySelector(sel);

const app = {
  mode: 'random',
  format: 'double',
  players: [], // [{name, gender}]
  tournamentId: null,
  organizerKey: null,
  state: null,
  isOrganizer: false,
  tab: 'matches',
  pollTimer: null,
  championShownFor: null,
  drawTimers: [],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms || 2600);
}

function teamById(state, id) {
  if (!id) return null;
  return state.teams.find((t) => t.id === id) || (state.byeTeam && state.byeTeam.id === id ? state.byeTeam : null);
}

function teamDisplayName(team) {
  if (!team) return 'To be decided';
  let name = team.players.join(' & ');
  if (team.walker && team.players.length === 1) name += ' — Walker (solo)';
  if (team.byePending) name += ' — first-round bye';
  return name;
}

function slotTeam(state, match, slot) {
  const src = slot === 'A' ? match.srcA : match.srcB;
  if (!src) return { team: null, resolved: true };
  if (src.kind === 'team') return { team: teamById(state, src.teamId), resolved: true };
  if (src.kind === 'bye') return { team: null, resolved: true };
  const target = state.matches.find((m) => m.id === src.match);
  if (!target || (target.status !== 'complete' && target.status !== 'bye')) return { team: null, resolved: false };
  const id = src.kind === 'winner' ? target.winner : target.loser;
  return { team: id ? teamById(state, id) : null, resolved: true };
}

function destLabel(state, dest, isWin) {
  if (!dest) return isWin ? '' : 'Eliminated';
  if (dest === 'champion') return 'Champion';
  const target = state.matches.find((m) => m.id === dest.match);
  if (!target) return '';
  if (target.playIn) return isWin ? 'Play-in winner' : '';
  return target.label.replace('Winners · ', '');
}

function matchFootText(state, match) {
  if (match.status === 'bye') return match.winner ? 'Bye — advances automatically' : '';
  if (match.conditionalReset) return 'Only played if the Second Chance champion wins the Grand Final';
  const parts = [];
  const w = destLabel(state, match.winTo, true);
  const l = destLabel(state, match.loseTo, false);
  if (match.status === 'complete') {
    if (w) parts.push('Winner → ' + w);
    if (state.format === 'double' && match.loser) parts.push(l ? 'Loser → ' + l : 'Loser eliminated');
    else if (match.loser) parts.push('Loser eliminated');
  } else {
    if (w) parts.push('Winner → ' + w);
    if (state.format === 'double' && match.loseTo) parts.push('Loser → ' + l);
    else if (state.format === 'double' && match.bracket === 'L') parts.push('Loser eliminated');
    else if (state.format === 'single') parts.push('Loser eliminated');
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Setup view
// ---------------------------------------------------------------------------

function parseNames() {
  const raw = $('#namesInput').value;
  const parts = raw.split(/[\n,]+/).map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean);
  const seen = new Set();
  const names = [];
  let dupes = 0;
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) {
      dupes++;
      continue;
    }
    seen.add(key);
    names.push(p);
  }
  return { names, dupes };
}

function syncPlayersFromSetup() {
  const { names, dupes } = parseNames();
  const previous = new Map(app.players.map((p) => [p.name.toLowerCase(), p]));
  app.players = names.map((name) => {
    const old = previous.get(name.toLowerCase());
    return { name, gender: old ? old.gender : null };
  });
  $('#dupeNote').textContent = dupes ? dupes + (dupes === 1 ? ' duplicate removed' : ' duplicates removed') : '';
  renderPlayerList();
  renderCounter();
}

function renderCounter() {
  const n = app.players.length;
  let teams;
  if (app.mode === 'coed') {
    const m = app.players.filter((p) => p.gender === 'M').length;
    const f = app.players.filter((p) => p.gender === 'F').length;
    const untagged = n - m - f;
    teams = Math.min(m, f);
    const leftover = Math.abs(m - f);
    let text = n + (n === 1 ? ' player' : ' players') + ' → ' + teams + (teams === 1 ? ' team' : ' teams');
    if (leftover === 1) text += ' + 1 first-round bye';
    else if (leftover > 1) text += ' + ' + (leftover - 1) + ' more teams + 1 bye';
    if (untagged) text += ' · ' + untagged + ' need a tag';
    $('#playerCounter').textContent = text;
  } else {
    teams = Math.ceil(n / 2);
    let text = n + (n === 1 ? ' player' : ' players') + ' → ' + teams + (teams === 1 ? ' team' : ' teams');
    if (n % 2 === 1 && n > 0) text += ' (one Walker plays solo)';
    $('#playerCounter').textContent = text;
  }
  // Rough match estimate.
  const t = app.mode === 'coed' ? Math.max(teams, 2) : teams;
  let est = '';
  if (t >= 2) {
    const matches = app.format === 'double' ? 2 * t - 2 : t - 1;
    est = 'About ' + matches + ' games' + (app.format === 'double' && $('#resetToggle').checked ? ' (plus a reset game if needed)' : '') + ' · roughly ' + Math.max(15, Math.round((matches * 20) / 60) * 15) + '+ minutes on one set of boards.';
  }
  $('#estimateLine').textContent = est;
}

function renderPlayerList() {
  const list = $('#playerList');
  if (!app.players.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = app.players
    .map((p, i) => {
      const gender =
        app.mode === 'coed'
          ? '<span class="gender-toggle">' +
            '<button type="button" class="gender-btn' + (p.gender === 'M' ? ' on' : '') + '" data-i="' + i + '" data-g="M">M</button>' +
            '<button type="button" class="gender-btn' + (p.gender === 'F' ? ' on' : '') + '" data-i="' + i + '" data-g="F">F</button>' +
            '</span>'
          : '';
      return (
        '<div class="player-row"><span class="player-name">' + esc(p.name) + '</span>' + gender +
        '<button type="button" class="remove-btn" data-remove="' + i + '" aria-label="Remove ' + esc(p.name) + '">×</button></div>'
      );
    })
    .join('');
  list.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      app.players[Number(btn.dataset.i)].gender = btn.dataset.g;
      renderPlayerList();
      renderCounter();
    });
  });
  list.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const removed = app.players[Number(btn.dataset.remove)];
      const lines = $('#namesInput').value.split('\n').filter((line) => line.trim().toLowerCase() !== removed.name.toLowerCase());
      $('#namesInput').value = lines.join('\n');
      syncPlayersFromSetup();
    });
  });
}

function showSetupError(msg) {
  const el = $('#setupError');
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function startDraw() {
  showSetupError('');
  if (app.players.length < 4) {
    showSetupError('You need at least 4 players to run a tournament. Add a few more names.');
    return;
  }
  if (app.mode === 'coed') {
    const untagged = app.players.filter((p) => !p.gender).length;
    if (untagged) {
      showSetupError('Tag every player Male or Female first — ' + untagged + (untagged === 1 ? ' player still needs' : ' players still need') + ' a tag.');
      return;
    }
    const m = app.players.filter((p) => p.gender === 'M').length;
    const f = app.players.filter((p) => p.gender === 'F').length;
    if (!m || !f) {
      showSetupError('Male + Female mode needs at least one player tagged Male and one tagged Female.');
      return;
    }
  }
  const btn = $('#drawButton');
  btn.disabled = true;
  btn.textContent = 'Drawing…';
  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#tournamentName').value.trim(),
        format: app.format,
        mode: app.mode,
        reset: $('#resetToggle').checked,
        players: app.players,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the tournament.');
    app.tournamentId = data.id;
    app.organizerKey = data.organizerKey;
    app.state = data.tournament;
    app.isOrganizer = true;
    try {
      localStorage.setItem('gc-key-' + data.id, data.organizerKey);
    } catch (e) {}
    history.replaceState(null, '', '/?t=' + data.id + '&k=' + data.organizerKey);
    runDrawReveal();
  } catch (e) {
    showSetupError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draw Teams';
  }
}

// ---------------------------------------------------------------------------
// Draw reveal
// ---------------------------------------------------------------------------

function runDrawReveal(fast) {
  $('#view-setup').hidden = true;
  $('#view-play').hidden = true;
  $('#view-draw').hidden = false;
  window.scrollTo(0, 0);
  const state = app.state;
  const teams = state.teams.slice().sort((a, b) => a.seed - b.seed);
  const cards = $('#drawCards');
  cards.innerHTML = '';
  $('#drawReceipt').hidden = true;
  $('#drawActions').hidden = true;
  $('#drawSkip').hidden = false;
  $('#drawTitle').textContent = 'Drawing teams…';

  const items = teams.map((t) => ({ team: t }));
  if (state.byeTeam) items.push({ team: state.byeTeam, bye: true });
  if (state.transfer && state.transfer.status === 'done' && state.transfer.byeTeamId) {
    const t = state.teams.find((x) => x.id === state.transfer.byeTeamId);
    if (t) items.push({ team: t, bye: true, done: true });
  }

  let idx = 0;
  const finish = () => {
    app.drawTimers.forEach(clearTimeout);
    app.drawTimers = [];
    // Make sure every card is visible.
    if (cards.children.length < items.length) {
      cards.innerHTML = items.map((it, i) => drawCardHtml(it, i)).join('');
    }
    $('#drawTitle').textContent = 'The teams are set';
    $('#drawSkip').hidden = true;
    $('#drawActions').hidden = false;
    const when = new Date(state.drawnAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const receipt = $('#drawReceipt');
    receipt.textContent =
      'Drawn ' + when + ' · ' + state.players.length + ' players · Secure random draw (Fisher–Yates) · Draw #' + (state.drawCount || 1) +
      (state.locked ? ' · locked in' : ' · not locked yet — re-draw freely until you start');
    receipt.hidden = false;
  };
  const step = () => {
    if (idx >= items.length) return finish();
    cards.insertAdjacentHTML('beforeend', drawCardHtml(items[idx], idx));
    idx++;
    const delay = fast ? (idx <= 8 ? 300 : 170) : idx <= 8 ? 750 : 420;
    app.drawTimers.push(setTimeout(step, delay));
  };
  $('#drawSkip').onclick = finish;
  step();
}

function drawCardHtml(item, i) {
  const t = item.team;
  let cls = 'draw-card';
  let tag = 'Team ' + (i + 1);
  if (t.walker && t.players.length === 1) {
    cls += ' walker-card';
    tag = 'The Walker — plays solo, throws from both ends';
  }
  if (item.bye) {
    cls += ' bye-card';
    tag = item.done ? 'First-round bye — partner joined from the first losing team' : 'First-round bye — gets the female player from the first team that loses';
  }
  return (
    '<div class="' + cls + '"><span class="draw-num">' + (i + 1) + '</span>' +
    '<span><span class="draw-names">' + esc(t.players.join(' & ')) + '</span><br>' +
    '<span class="draw-tag">' + esc(tag) + '</span></span></div>'
  );
}

// ---------------------------------------------------------------------------
// Play view
// ---------------------------------------------------------------------------

function showPlay() {
  $('#view-setup').hidden = true;
  $('#view-draw').hidden = true;
  $('#view-play').hidden = false;
  renderPlay();
  startPolling();
}

function startPolling() {
  stopPolling();
  app.pollTimer = setInterval(pollOnce, 3000);
}
function stopPolling() {
  if (app.pollTimer) clearInterval(app.pollTimer);
  app.pollTimer = null;
}

async function pollOnce() {
  if (!app.tournamentId || $('#view-play').hidden) return;
  try {
    const res = await fetch('/api/tournament?id=' + encodeURIComponent(app.tournamentId));
    if (!res.ok) return;
    const data = await res.json();
    if (data.tournament && data.tournament.version !== app.state.version) {
      app.state = data.tournament;
      const ind = $('#liveIndicator');
      ind.classList.add('flash');
      setTimeout(() => ind.classList.remove('flash'), 600);
      renderPlay();
    }
  } catch (e) {
    /* keep polling quietly */
  }
}

function spectatorLink() {
  return location.origin + '/?t=' + app.tournamentId;
}
function organizerLink() {
  return location.origin + '/?t=' + app.tournamentId + (app.organizerKey ? '&k=' + app.organizerKey : '');
}

function renderPlay() {
  const state = app.state;
  if (!state) return;
  $('#playTitle').textContent = state.name;
  const fmt = state.format === 'double' ? 'Double Elimination' : 'Single Elimination';
  const mode = state.mode === 'coed' ? 'Male + Female Draw' : 'Blind Draw';
  const done = state.matches.filter((m) => m.status === 'complete').length;
  const total = state.matches.filter((m) => m.status !== 'dormant' && m.status !== 'not-needed').length;
  $('#playMeta').textContent = fmt + ' · ' + mode + ' · ' + done + ' of ' + total + ' games done';
  $('#topbarRight').innerHTML = app.isOrganizer
    ? '<span class="organizer-badge">Organizer</span>'
    : '<span>Spectator</span>';
  $('#undoButton').hidden = !(app.isOrganizer && state.scoresCount > 0 && !state.championTeamId);
  $('#shareLink').value = spectatorLink();
  renderNotices();
  renderChampionBanner();
  if (app.tab === 'matches') {
    $('#matchesView').hidden = false;
    $('#bracketView').hidden = true;
    renderMatches();
  } else {
    $('#matchesView').hidden = true;
    $('#bracketView').hidden = false;
    renderTree();
  }
  if (state.championTeamId && app.championShownFor !== state.championTeamId) {
    app.championShownFor = state.championTeamId;
    showChampion();
  }
}

function renderNotices() {
  const state = app.state;
  const area = $('#noticeArea');
  let html = '';
  if (!state.locked && !state.championTeamId) {
    if (app.isOrganizer) {
      html +=
        '<div class="notice-card"><strong>Not started yet.</strong> Share the spectator link, preview the bracket, re-draw if you want — the draw locks when you start.' +
        '<div class="notice-actions">' +
        '<button type="button" class="ghost-btn" id="noticeRandomize">Randomize Again</button>' +
        '<button type="button" class="primary-btn" id="noticeStart">Start Tournament</button>' +
        '</div></div>';
    } else {
      html += '<div class="notice-card">The organizer has not started this tournament yet — teams may still change.</div>';
    }
  }
  if (state.byeTeam && state.transfer && state.transfer.status === 'pending') {
    html +=
      '<div class="notice-card"><strong>' + esc(state.byeTeam.players[0]) + ' drew the first-round bye.</strong> ' +
      'When the first game is decided, the female player from the losing team joins them, and the new team enters the bracket through a play-in game.' +
      (state.format === 'double' ? ' Her former partner keeps playing in the Second Chance bracket as a solo Walker.' : '') +
      '</div>';
  }
  if (state.transfer && state.transfer.status === 'done') {
    const team = teamById(state, state.transfer.byeTeamId);
    if (team) {
      html +=
        '<div class="notice-card"><strong>The bye team is complete:</strong> ' + esc(state.transfer.player) +
        ' joined ' + esc(team.players[0]) + ' after the first game. Watch for their play-in game in the bracket.</div>';
    }
  }
  area.innerHTML = html;
  const nr = $('#noticeRandomize');
  if (nr) nr.addEventListener('click', randomizeAgain);
  const ns = $('#noticeStart');
  if (ns) ns.addEventListener('click', startTournament);
}

function teamRecord(state, team) {
  let w = 0;
  let l = 0;
  state.matches.forEach((m) => {
    if (m.status !== 'complete') return;
    if (m.winner === team.id) w++;
    if (m.loser === team.id) l++;
  });
  return { w, l };
}

function renderChampionBanner() {
  const state = app.state;
  const el = $('#championBanner');
  if (!state.championTeamId) {
    el.innerHTML = '';
    return;
  }
  const champ = teamById(state, state.championTeamId);
  if (!champ) {
    el.innerHTML = '';
    return;
  }
  const rec = teamRecord(state, champ);
  el.innerHTML =
    '<div class="champion-banner"><p class="micro-label accent">Champions</p>' +
    '<div class="cb-name">' + esc(teamDisplayName(champ)) + '</div>' +
    '<p class="qr-note">' + rec.w + ' wins · ' + rec.l + (rec.l === 1 ? ' loss' : ' losses') + ' · ' + esc(state.name) + '</p></div>';
}

// --- Match card (shared by list and tree) ---

function teamRowHtml(state, match, slot) {
  const { team, resolved } = slotTeam(state, match, slot);
  const canScore = app.isOrganizer && match.status === 'ready' && team;
  let cls = 'team-row';
  let inner;
  if (!resolved) {
    inner = '<span class="team-name">Winner of an earlier game</span>';
    cls += ' tbd static';
  } else if (!team) {
    inner = '<span class="team-name">Bye</span>';
    cls += ' tbd static';
  } else {
    let tags = '';
    if (team.walker && team.players.length === 1) tags += '<span class="walker-tag">Walker</span>';
    if (state.format === 'double' && team.losses === 1 && match.status !== 'complete') tags += '<span class="team-tag loss">1 loss</span>';
    if (team.eliminated && match.status !== 'complete') tags += '<span class="team-tag loss">Out</span>';
    let check = '';
    if (match.status === 'complete' || match.status === 'bye') {
      if (match.winner === team.id) {
        cls += ' winner';
        check = '<span class="win-check">✓</span>';
      } else if (match.loser === team.id) {
        cls += ' loser';
      }
    }
    inner = '<span class="team-name">' + esc(teamDisplayName(team)) + tags + '</span>' + check;
  }
  if (canScore) {
    return '<button type="button" class="' + cls + '" data-score-match="' + match.id + '" data-score-team="' + team.id + '">' + inner + '</button>';
  }
  return '<div class="' + cls + ' static">' + inner + '</div>';
}

function matchCardHtml(state, match, num) {
  let cls = 'match';
  if (match.conditionalReset) cls += ' reset-match';
  if (match.status === 'bye') cls += ' bye-match';
  if (state.championTeamId) {
    const champ = state.championTeamId;
    if (match.status === 'complete' && match.winner === champ) cls += ' champ-path';
  }
  const foot = matchFootText(state, match);
  return (
    '<div class="' + cls + '" data-match-card="' + match.id + '">' +
    '<div class="match-meta"><span>' + esc(match.label) + '</span><span>' + (num ? 'Game ' + num : '') + '</span></div>' +
    teamRowHtml(state, match, 'A') +
    teamRowHtml(state, match, 'B') +
    (foot ? '<div class="match-foot">' + esc(foot) + '</div>' : '') +
    '</div>'
  );
}

function wireScoreButtons(container) {
  container.querySelectorAll('[data-score-match]').forEach((btn) => {
    btn.addEventListener('click', () => scoreMatch(btn.dataset.scoreMatch, btn.dataset.scoreTeam));
  });
}

function renderMatches() {
  const state = app.state;
  const view = $('#matchesView');
  const playable = state.matches.filter((m) => m.status !== 'dormant' && m.status !== 'not-needed');
  const order = { W: 0, L: 1, GF: 2, R: 3 };
  const sorted = playable.slice().sort((a, b) => order[a.bracket] - order[b.bracket] || a.round - b.round || a.index - b.index);
  let num = 0;
  const numberOf = new Map();
  sorted.forEach((m) => {
    if (m.status !== 'bye') numberOf.set(m.id, ++num);
  });
  const ready = sorted.filter((m) => m.status === 'ready');
  const upNext = sorted.filter((m) => m.status === 'pending');
  const done = sorted.filter((m) => m.status === 'complete' || m.status === 'bye');
  let html = '';
  html += '<p class="section-label">Now Playing — tap the winning team</p>';
  html += ready.length
    ? '<div class="match-list">' + ready.map((m) => matchCardHtml(state, m, numberOf.get(m.id))).join('') + '</div>'
    : '<p class="empty-note">' + (state.championTeamId ? 'The tournament is finished.' : 'No games are ready right now.') + '</p>';
  if (upNext.length) {
    html += '<p class="section-label">Up Next</p><div class="match-list">' + upNext.map((m) => matchCardHtml(state, m, numberOf.get(m.id))).join('') + '</div>';
  }
  if (done.length) {
    html += '<p class="section-label">Finished</p><div class="match-list">' + done.map((m) => matchCardHtml(state, m, numberOf.get(m.id))).join('') + '</div>';
  }
  view.innerHTML = html;
  wireScoreButtons(view);
}

// --- March Madness tree ---

function treeColumns(state, bracket) {
  const rounds = new Map();
  state.matches
    .filter((m) => m.bracket === bracket)
    .forEach((m) => {
      if (!rounds.has(m.round)) rounds.set(m.round, []);
      rounds.get(m.round).push(m);
    });
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, ms]) => ({ round, matches: ms.sort((a, b) => a.index - b.index) }));
}

function roundTitle(state, bracket, round) {
  if (bracket === 'W') {
    const total = state.winnersRounds;
    if (round === total) return 'Final';
    if (round === total - 1) return 'Semifinals';
    if (round === total - 2) return 'Quarterfinals';
    return 'Round ' + round;
  }
  return 'Round ' + round;
}

function renderTree() {
  const state = app.state;
  const winnersEl = $('#winnersTree');
  const losersEl = $('#losersTree');
  const numberOf = new Map();
  let num = 0;
  state.matches
    .filter((m) => m.status !== 'dormant' && m.status !== 'not-needed')
    .slice()
    .sort((a, b) => a.round - b.round)
    .forEach((m) => {
      if (m.status !== 'bye') numberOf.set(m.id, ++num);
    });

  const colHtml = (bracket, round, ms) =>
    '<div class="round-col"><div class="round-title">' + esc(roundTitle(state, bracket, round)) + '</div>' +
    '<div class="round-matches">' + ms.map((m) => matchCardHtml(state, m, numberOf.get(m.id))).join('') + '</div></div>';

  let wHtml = '<p class="tree-section-label">' + (state.format === 'double' ? 'Winners Bracket' : 'Bracket') + '</p><div class="tree">';
  treeColumns(state, 'W').forEach((c) => (wHtml += colHtml('W', c.round, c.matches)));
  // Championship column: grand final (double) or champion slot.
  const champ = state.championTeamId ? teamById(state, state.championTeamId) : null;
  if (state.format === 'double') {
    const gf = state.matches.find((m) => m.id === 'GF');
    const rst = state.matches.find((m) => m.id === 'RST');
    wHtml += '<div class="round-col"><div class="round-title">Championship</div><div class="round-matches">';
    if (gf) wHtml += matchCardHtml(state, gf, numberOf.get('GF'));
    if (rst && rst.status === 'not-needed') {
      wHtml +=
        '<div class="match reset-match reset-settled"><div class="match-meta"><span>Championship Reset</span><span>Settled</span></div>' +
        '<div class="reset-settled-text">Not needed — the unbeaten team won the Grand Final.</div></div>';
    } else if (rst) {
      wHtml += matchCardHtml(state, rst, numberOf.get('RST'));
    }
    wHtml +=
      '<div class="champ-slot" data-champ-slot="1"><div class="cs-label">Champion</div>' +
      (champ ? '<div class="cs-name">' + esc(teamDisplayName(champ)) + '</div>' : '<div class="cs-name tbd">To be decided</div>') +
      '</div></div></div>';
  } else {
    wHtml +=
      '<div class="round-col"><div class="round-title">Champion</div><div class="round-matches">' +
      '<div class="champ-slot" data-champ-slot="1"><div class="cs-label">Champion</div>' +
      (champ ? '<div class="cs-name">' + esc(teamDisplayName(champ)) + '</div>' : '<div class="cs-name tbd">To be decided</div>') +
      '</div></div></div>';
  }
  wHtml += '</div>';
  winnersEl.innerHTML = wHtml;

  if (state.format === 'double') {
    let lHtml = '<p class="tree-section-label">Second Chance Bracket — lose here and you are out</p><div class="tree">';
    treeColumns(state, 'L').forEach((c) => (lHtml += colHtml('L', c.round, c.matches)));
    lHtml += '</div>';
    losersEl.innerHTML = lHtml;
    losersEl.hidden = false;
  } else {
    losersEl.innerHTML = '';
    losersEl.hidden = true;
  }
  wireScoreButtons($('#bracketView'));
  requestAnimationFrame(drawConnectors);
}

function drawConnectors() {
  const canvas = $('#treeCanvas');
  const svg = $('#connectorSvg');
  if (!canvas || $('#bracketView').hidden) return;
  const canvasRect = canvas.getBoundingClientRect();
  const cards = {};
  canvas.querySelectorAll('[data-match-card]').forEach((el) => {
    const r = el.getBoundingClientRect();
    cards[el.dataset.matchCard] = {
      left: r.left - canvasRect.left,
      right: r.right - canvasRect.left,
      cy: r.top - canvasRect.top + r.height / 2,
    };
  });
  const champSlot = canvas.querySelector('[data-champ-slot]');
  let champRect = null;
  if (champSlot) {
    const r = champSlot.getBoundingClientRect();
    champRect = { left: r.left - canvasRect.left, cy: r.top - canvasRect.top + r.height / 2 };
  }
  svg.setAttribute('width', canvas.scrollWidth);
  svg.setAttribute('height', canvas.scrollHeight);
  svg.setAttribute('viewBox', '0 0 ' + canvas.scrollWidth + ' ' + canvas.scrollHeight);
  const state = app.state;
  let paths = '';
  const line = (x1, y1, x2, y2, accent) => {
    const midX = x1 + (x2 - x1) / 2;
    return (
      '<path d="M ' + x1 + ' ' + y1 + ' H ' + midX + ' V ' + y2 + ' H ' + x2 + '" fill="none" stroke="' +
      (accent ? '#BFF747' : 'rgba(255,255,255,0.22)') + '" stroke-width="' + (accent ? 2.2 : 1.2) + '"/>'
    );
  };
  state.matches.forEach((m) => {
    const target = cards[m.id];
    if (!target) return;
    ['srcA', 'srcB'].forEach((key) => {
      const src = m[key];
      if (!src || (src.kind !== 'winner' && src.kind !== 'loser')) return;
      const feeder = cards[src.match];
      if (!feeder) return;
      const feederMatch = state.matches.find((x) => x.id === src.match);
      let accent = false;
      if (feederMatch && (feederMatch.status === 'complete' || feederMatch.status === 'bye')) {
        const advancedId = src.kind === 'winner' ? feederMatch.winner : feederMatch.loser;
        const { team } = slotTeam(state, m, key === 'srcA' ? 'A' : 'B');
        if (advancedId && team && team.id === advancedId) accent = true;
        if (state.championTeamId && advancedId === state.championTeamId) accent = true;
      }
      paths += line(feeder.right, feeder.cy, target.left, target.cy, accent);
    });
  });
  // Final to champion slot.
  if (champRect) {
    const finalMatch = state.format === 'double' ? state.matches.find((m) => m.id === 'RST' && m.status === 'complete') || state.matches.find((m) => m.id === 'GF') : state.matches.filter((m) => m.bracket === 'W').sort((a, b) => b.round - a.round)[0];
    if (finalMatch && cards[finalMatch.id]) {
      paths += line(cards[finalMatch.id].right, cards[finalMatch.id].cy, champRect.left, champRect.cy, !!state.championTeamId);
    }
  }
  svg.innerHTML = paths;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

async function scoreMatch(matchId, winnerTeamId) {
  if (!app.isOrganizer) return;
  const state = app.state;
  const match = state.matches.find((m) => m.id === matchId);
  const winner = teamById(state, winnerTeamId);
  const loser = match ? teamById(state, match.winner === winnerTeamId ? match.loser : null) : null;
  try {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-organizer-key': app.organizerKey },
      body: JSON.stringify({ id: app.tournamentId, matchId, winnerTeamId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not record that result.');
    app.state = data.tournament;
    renderPlay();
    const loserTeam = (() => {
      const m2 = data.tournament.matches.find((m) => m.id === matchId);
      return m2 ? teamById(data.tournament, m2.loser) : null;
    })();
    showUndoToast((winner ? teamDisplayName(winner) : 'Team') + ' beat ' + (loserTeam ? teamDisplayName(loserTeam) : 'the other team'));
  } catch (e) {
    toast(e.message, 3400);
  }
}

let undoTimer = null;
function showUndoToast(text) {
  const el = $('#undoToast');
  $('#undoToastText').textContent = text;
  el.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (el.hidden = true), 5000);
}

async function randomizeAgain() {
  if (!app.isOrganizer || !app.tournamentId) return;
  try {
    const res = await fetch('/api/redraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-organizer-key': app.organizerKey },
      body: JSON.stringify({ id: app.tournamentId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The draw is locked.');
    app.state = data.tournament;
    stopPolling();
    runDrawReveal(true);
  } catch (e) {
    toast(e.message, 3600);
  }
}

async function startTournament() {
  if (!app.isOrganizer || !app.tournamentId) return;
  try {
    const res = await fetch('/api/redraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-organizer-key': app.organizerKey },
      body: JSON.stringify({ id: app.tournamentId, action: 'start' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start the tournament.');
    app.state = data.tournament;
    toast('Tournament started — the draw is locked in');
    showPlay();
  } catch (e) {
    toast(e.message, 3600);
  }
}

function previewBracket() {
  app.tab = window.innerWidth >= 720 ? 'bracket' : 'matches';
  $('#tabMatches').classList.toggle('selected', app.tab === 'matches');
  $('#tabBracket').classList.toggle('selected', app.tab === 'bracket');
  showPlay();
}

async function undoLast() {
  try {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-organizer-key': app.organizerKey },
      body: JSON.stringify({ id: app.tournamentId, action: 'undo' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nothing to undo.');
    app.state = data.tournament;
    app.championShownFor = data.tournament.championTeamId || null;
    $('#undoToast').hidden = true;
    $('#championOverlay').hidden = true;
    renderPlay();
    toast('Last result undone');
  } catch (e) {
    toast(e.message, 3400);
  }
}

// ---------------------------------------------------------------------------
// Champion celebration
// ---------------------------------------------------------------------------

function showChampion() {
  const state = app.state;
  const champ = teamById(state, state.championTeamId);
  if (!champ) return;
  const rec = teamRecord(state, champ);
  $('#championName').textContent = teamDisplayName(champ);
  let story = rec.w + ' wins · ' + rec.l + (rec.l === 1 ? ' loss' : ' losses');
  const rst = state.matches.find((m) => m.id === 'RST');
  if (rst && rst.status === 'complete' && rst.winner === champ.id) {
    story += ' · Came through the Second Chance bracket and won the reset game';
  } else if (state.format === 'double' && rec.l === 1) {
    story += ' · Came through the Second Chance bracket';
  } else if (state.format === 'double' && rec.l === 0) {
    story += ' · Undefeated all night';
  }
  $('#championSub').textContent = story + ' · ' + state.name;
  $('#championOverlay').hidden = false;
  runConfetti();
}

function runConfetti() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('#confettiCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ['#BFF747', '#F5F7F6', '#8FD41F'];
  const pieces = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 5 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vy: 2 + Math.random() * 3.2,
    vx: -1 + Math.random() * 2,
    rot: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      p.y += p.vy;
      p.x += p.vx;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (t < 2600) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })(start);
}

// ---------------------------------------------------------------------------
// Wiring + boot
// ---------------------------------------------------------------------------

function setTab(tab) {
  app.tab = tab;
  $('#tabMatches').classList.toggle('selected', tab === 'matches');
  $('#tabBracket').classList.toggle('selected', tab === 'bracket');
  renderPlay();
}

function defaultTournamentName() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  return days[now.getDay()] + ' Cornhole — ' + now.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function initSetup() {
  $('#tournamentName').value = defaultTournamentName();
  $('#modeRow').querySelectorAll('.choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      app.mode = card.dataset.mode;
      $('#modeRow').querySelectorAll('.choice-card').forEach((c) => c.classList.toggle('selected', c === card));
      $('#coedNote').hidden = app.mode !== 'coed';
      renderPlayerList();
      renderCounter();
    });
  });
  $('#formatRow').querySelectorAll('.choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      app.format = card.dataset.format;
      $('#formatRow').querySelectorAll('.choice-card').forEach((c) => c.classList.toggle('selected', c === card));
      $('#resetRow').style.display = app.format === 'double' ? '' : 'none';
      renderCounter();
    });
  });
  $('#resetToggle').addEventListener('change', renderCounter);
  $('#namesInput').addEventListener('input', syncPlayersFromSetup);
  $('#drawButton').addEventListener('click', startDraw);
  renderCounter();
}

async function loadTournamentFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('t');
  if (!id) return false;
  const key = params.get('k') || (() => { try { return localStorage.getItem('gc-key-' + id); } catch (e) { return null; } })();
  try {
    const res = await fetch('/api/tournament?id=' + encodeURIComponent(id));
    if (!res.ok) {
      toast('That tournament link could not be loaded.', 4000);
      return false;
    }
    const data = await res.json();
    app.tournamentId = id;
    app.state = data.tournament;
    if (key) {
      app.organizerKey = key;
      // Organizer status is proven on the first score attempt; assume the
      // link holder is the organizer when a key is present.
      app.isOrganizer = true;
      try {
        localStorage.setItem('gc-key-' + id, key);
      } catch (e) {}
    }
    app.tab = window.innerWidth >= 720 ? 'bracket' : 'matches';
    $('#tabMatches').classList.toggle('selected', app.tab === 'matches');
    $('#tabBracket').classList.toggle('selected', app.tab === 'bracket');
    if (app.state.championTeamId) app.championShownFor = app.state.championTeamId;
    showPlay();
    return true;
  } catch (e) {
    return false;
  }
}

function initPlay() {
  $('#tabMatches').addEventListener('click', () => setTab('matches'));
  $('#tabBracket').addEventListener('click', () => setTab('bracket'));
  $('#shareButton').addEventListener('click', () => {
    const panel = $('#sharePanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderQr();
  });
  $('#copyShare').addEventListener('click', async () => {
    const link = spectatorLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Spectator link copied');
    } catch (e) {
      $('#shareLink').select();
      document.execCommand('copy');
      toast('Spectator link copied');
    }
  });
  $('#undoButton').addEventListener('click', undoLast);
  $('#undoToastButton').addEventListener('click', undoLast);
  $('#newTournament').addEventListener('click', () => location.assign('/'));
  $('#toBracket').addEventListener('click', startTournament);
  $('#randomizeAgain').addEventListener('click', randomizeAgain);
  $('#previewBracket').addEventListener('click', previewBracket);
  $('#championClose').addEventListener('click', () => ($('#championOverlay').hidden = true));
  $('#championShare').addEventListener('click', async () => {
    const champ = teamById(app.state, app.state.championTeamId);
    const text = 'Get Cornholed — ' + app.state.name + ' champions: ' + (champ ? teamDisplayName(champ) : '') + ' ' + spectatorLink();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Get Cornholed', text, url: spectatorLink() });
        return;
      } catch (e) {}
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Result copied — paste it anywhere');
    } catch (e) {
      toast('Copy this link: ' + spectatorLink(), 5000);
    }
  });
  $('#championAgain').addEventListener('click', () => {
    const names = app.state.players.map((p) => p.name).join('\n');
    $('#championOverlay').hidden = true;
    stopPolling();
    history.replaceState(null, '', '/');
    $('#view-play').hidden = true;
    $('#view-draw').hidden = true;
    $('#view-setup').hidden = false;
    $('#namesInput').value = names;
    if (app.state.mode === 'coed') {
      $('#modeRow').querySelector('[data-mode="coed"]').click();
      app.players = app.state.players.map((p) => ({ name: p.name, gender: p.gender }));
      // Rebuild with genders preserved.
      syncPlayersFromSetupPreserve(app.state.players);
    } else {
      syncPlayersFromSetup();
    }
    window.scrollTo(0, 0);
  });
  window.addEventListener('resize', () => {
    if (app.tab === 'bracket' && !$('#view-play').hidden) requestAnimationFrame(drawConnectors);
  });
}

function syncPlayersFromSetupPreserve(saved) {
  const { names } = parseNames();
  const byName = new Map(saved.map((p) => [p.name.toLowerCase(), p]));
  app.players = names.map((name) => {
    const old = byName.get(name.toLowerCase());
    return { name, gender: old ? old.gender : null };
  });
  renderPlayerList();
  renderCounter();
}

function renderQr() {
  const box = $('#qrBox');
  box.innerHTML = '';
  if (typeof window.qrcode === 'function') {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(spectatorLink());
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      return;
    } catch (e) {}
  }
  box.innerHTML = '<span style="color:#333;font-size:12px;text-align:center;padding:8px">QR unavailable offline — use the link</span>';
}

(async function boot() {
  initSetup();
  initPlay();
  const loaded = await loadTournamentFromUrl();
  if (!loaded) {
    $('#view-setup').hidden = false;
  }
})();
