'use strict';
/*
 * Cornhole tournament engine: secure draw + bracket generation + advancement.
 * Single source of truth, shared by the API functions and the test suite.
 *
 * Fairness notes (from the design research):
 * - Fisher-Yates shuffle driven by crypto.getRandomValues() with rejection
 *   sampling. Never Math.random(), never sort-based shuffling.
 * - Two shuffles: players -> pairings, then teams -> bracket seeds, so the
 *   order names were typed in can never leak into pairings, byes or matchups.
 * - Names are never sorted or alphabetized anywhere.
 */

// ---------------------------------------------------------------------------
// Secure randomness
// ---------------------------------------------------------------------------

function secureRandomInt(maxExclusive) {
  // Unbiased integer in [0, maxExclusive) from crypto.getRandomValues(),
  // using rejection sampling to eliminate modulo bias.
  const range = maxExclusive;
  const limit = Math.floor(4294967296 / range) * range; // largest multiple of range <= 2^32
  const buf = new Uint32Array(1);
  let x;
  do {
    globalThis.crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % range;
}

function shuffle(arr) {
  // Fisher-Yates (Durstenfeld): walk from the last index down, swapping each
  // element with one at a uniform random index in [0, i].
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function randomToken(chars, length) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[secureRandomInt(alphabet.length)];
  return out.slice(0, length || chars);
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/*
 * players: [{ name, gender: 'M' | 'F' | null }]
 * mode: 'random' | 'coed'
 * Returns { teams, byeTeam } where teams are bracket-ready team objects and
 * byeTeam is the coed Bye Player's team (or null). Team:
 *   { id, players: [names], walker: bool, byePending: bool, seed }
 */
function drawTeams(players, mode) {
  let teams = [];
  let byeTeam = null;

  if (mode === 'coed') {
    const males = shuffle(players.filter((p) => p.gender === 'M'));
    const females = shuffle(players.filter((p) => p.gender === 'F'));
    const pairCount = Math.min(males.length, females.length);
    for (let i = 0; i < pairCount; i++) {
      teams.push({ players: [males[i].name, females[i].name], walker: false, byePending: false });
    }
    const leftover = males.length > females.length ? males.slice(pairCount) : females.slice(pairCount);
    if (leftover.length === 1) {
      byeTeam = { players: [leftover[0].name], walker: false, byePending: true };
    } else if (leftover.length > 1) {
      // First leftover (shuffled order) is the Bye Player; the rest pair
      // randomly among themselves as regular teams.
      byeTeam = { players: [leftover[0].name], walker: false, byePending: true };
      const rest = leftover.slice(1);
      for (let i = 0; i + 1 < rest.length; i += 2) {
        teams.push({ players: [rest[i].name, rest[i + 1].name], walker: false, byePending: false });
      }
      if (rest.length % 2 === 1) {
        // One player still cannot pair: solo Walker team (cornhole convention).
        teams.push({ players: [rest[rest.length - 1].name], walker: true, byePending: false });
      }
    }
  } else {
    const drawn = shuffle(players);
    for (let i = 0; i + 1 < drawn.length; i += 2) {
      teams.push({ players: [drawn[i].name, drawn[i + 1].name], walker: false, byePending: false });
    }
    if (drawn.length % 2 === 1) {
      // Odd player out: the last name drawn is the Walker, a one-person team.
      teams.push({ players: [drawn[drawn.length - 1].name], walker: true, byePending: false });
    }
  }

  // Second shuffle: seed the formed teams so pair-creation order cannot leak
  // into byes or first-round matchups.
  teams = shuffle(teams);
  teams.forEach((t, i) => {
    t.id = 'T' + (i + 1);
    t.seed = i + 1;
  });
  if (byeTeam) byeTeam.id = 'T' + (teams.length + 1);
  return { teams, byeTeam };
}

// ---------------------------------------------------------------------------
// Bracket topology
// ---------------------------------------------------------------------------

function nextPow2(n) {
  let s = 2;
  while (s < n) s *= 2;
  return s;
}

// Standard seeded slot order: for S=8 -> [1,8,4,5,2,7,3,6].
function seedOrder(S) {
  let order = [1];
  let size = 1;
  while (size < S) {
    const next = [];
    for (const x of order) next.push(x, size * 2 + 1 - x);
    order = next;
    size *= 2;
  }
  return order;
}

function roundName(bracket, round, totalRounds) {
  if (bracket === 'W') {
    if (round === totalRounds) return 'Final';
    if (round === totalRounds - 1) return 'Semifinal';
    if (round === totalRounds - 2) return 'Quarterfinal';
    return 'Round ' + round;
  }
  return 'Second Chance · Round ' + round;
}

function buildBracket(teams, format, resetEnabled) {
  const n = teams.length;
  const S = nextPow2(n);
  const k = Math.round(Math.log2(S)); // winners-bracket rounds
  const bySeed = {};
  teams.forEach((t) => (bySeed[t.seed] = t));
  const order = seedOrder(S);
  const matches = [];
  const byId = {};
  const add = (m) => {
    matches.push(m);
    byId[m.id] = m;
    return m;
  };
  const wid = (r, i) => 'W' + r + '-' + i;
  const lid = (r, i) => 'L' + r + '-' + i;

  // --- Winners bracket ---
  for (let r = 1; r <= k; r++) {
    const count = S / Math.pow(2, r);
    for (let i = 0; i < count; i++) {
      const m = {
        id: wid(r, i),
        bracket: 'W',
        round: r,
        index: i,
        label: 'Winners · ' + roundName('W', r, k),
        srcA: null,
        srcB: null,
        winTo: null,
        loseTo: null,
        winner: null,
        loser: null,
        decided: false,
        auto: false,
        status: 'pending',
        playIn: false,
      };
      if (r === 1) {
        const sA = order[2 * i];
        const sB = order[2 * i + 1];
        m.srcA = sA <= n ? { kind: 'team', teamId: bySeed[sA].id } : { kind: 'bye' };
        m.srcB = sB <= n ? { kind: 'team', teamId: bySeed[sB].id } : { kind: 'bye' };
      } else {
        m.srcA = { kind: 'winner', match: wid(r - 1, 2 * i) };
        m.srcB = { kind: 'winner', match: wid(r - 1, 2 * i + 1) };
      }
      if (r < k) m.winTo = { match: wid(r + 1, Math.floor(i / 2)), slot: i % 2 === 0 ? 'A' : 'B' };
      else if (format === 'single') m.winTo = 'champion';
      else m.winTo = { match: 'GF', slot: 'A' };
      add(m);
    }
  }

  if (format === 'double') {
    // --- Losers (Second Chance) bracket ---
    if (k >= 2) {
      const lbRounds = 2 * (k - 1);
      for (let r = 1; r <= lbRounds; r++) {
        const count = S / Math.pow(2, Math.ceil(r / 2) + 1);
        for (let i = 0; i < count; i++) {
          const m = {
            id: lid(r, i),
            bracket: 'L',
            round: r,
            index: i,
            label: roundName('L', r, lbRounds),
            srcA: null,
            srcB: null,
            winTo: null,
            loseTo: null,
            winner: null,
            loser: null,
            decided: false,
            auto: false,
            status: 'pending',
            playIn: false,
          };
          if (r === 1) {
            m.srcA = { kind: 'loser', match: wid(1, 2 * i) };
            m.srcB = { kind: 'loser', match: wid(1, 2 * i + 1) };
          } else if (r % 2 === 0) {
            // Drop-in round: LB survivors meet teams dropping from the
            // winners bracket, crossed (reversed) to avoid instant rematches.
            const wbRound = r / 2 + 1;
            const wbCount = S / Math.pow(2, wbRound);
            m.srcA = { kind: 'winner', match: lid(r - 1, i) };
            m.srcB = { kind: 'loser', match: wid(wbRound, wbCount - 1 - i) };
          } else {
            m.srcA = { kind: 'winner', match: lid(r - 1, 2 * i) };
            m.srcB = { kind: 'winner', match: lid(r - 1, 2 * i + 1) };
          }
          if (r < lbRounds) {
            if (r % 2 === 1) m.winTo = { match: lid(r + 1, i), slot: 'A' };
            else m.winTo = { match: lid(r + 1, Math.floor(i / 2)), slot: i % 2 === 0 ? 'A' : 'B' };
          } else {
            m.winTo = { match: 'GF', slot: 'B' };
          }
          add(m);
        }
      }
      // Wire winners-bracket loseTo pointers.
      for (let r = 1; r <= k; r++) {
        const count = S / Math.pow(2, r);
        for (let i = 0; i < count; i++) {
          const m = byId[wid(r, i)];
          if (r === 1) m.loseTo = { match: lid(1, Math.floor(i / 2)), slot: i % 2 === 0 ? 'A' : 'B' };
          else {
            const lbRound = 2 * (r - 1);
            const lbCount = S / Math.pow(2, Math.ceil(lbRound / 2) + 1);
            m.loseTo = { match: lid(lbRound, lbCount - 1 - i), slot: 'B' };
          }
        }
      }
    } else {
      // Two teams only: the winners-bracket loser goes straight to the
      // grand final for their second chance.
      byId[wid(1, 0)].loseTo = { match: 'GF', slot: 'B' };
    }

    // --- Grand final (+ optional reset) ---
    const gf = {
      id: 'GF',
      bracket: 'GF',
      round: 1,
      index: 0,
      label: 'Grand Final',
      srcA: { kind: 'winner', match: wid(k, 0) },
      srcB:
        k >= 2
          ? { kind: 'winner', match: lid(2 * (k - 1), 0) }
          : { kind: 'loser', match: wid(1, 0) },
      winTo: 'champion',
      loseTo: null,
      winner: null,
      loser: null,
      decided: false,
      auto: false,
      status: 'pending',
      playIn: false,
    };
    add(gf);
    if (resetEnabled) {
      add({
        id: 'RST',
        bracket: 'R',
        round: 1,
        index: 0,
        label: 'Championship Reset · If Needed',
        srcA: { kind: 'winner', match: 'GF' },
        srcB: { kind: 'loser', match: 'GF' },
        winTo: 'champion',
        loseTo: null,
        winner: null,
        loser: null,
        decided: false,
        auto: false,
        status: 'dormant',
        playIn: false,
        conditionalReset: true,
      });
    }
  }

  return { matches, bracketSize: S, winnersRounds: k };
}

// ---------------------------------------------------------------------------
// Resolution: compute slot values, auto-advance byes, derive champion
// ---------------------------------------------------------------------------

function slotValue(state, src) {
  if (!src) return { resolved: true, teamId: null };
  if (src.kind === 'team') return { resolved: true, teamId: src.teamId };
  if (src.kind === 'bye') return { resolved: true, teamId: null };
  const target = state.matches.find((m) => m.id === src.match);
  if (!target) return { resolved: true, teamId: null };
  if (target.status === 'complete' || target.status === 'bye') {
    return { resolved: true, teamId: src.kind === 'winner' ? target.winner : target.loser };
  }
  return { resolved: false, teamId: null };
}

function matchTeams(state, match) {
  return {
    A: slotValue(state, match.srcA),
    B: slotValue(state, match.srcB),
  };
}

function resolve(state) {
  const byId = {};
  state.matches.forEach((m) => (byId[m.id] = m));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const m of state.matches) {
      if (m.decided) {
        if (m.status !== 'complete') {
          m.status = 'complete';
          changed = true;
        }
        continue;
      }
      if (m.conditionalReset) {
        const gf = byId['GF'];
        const active =
          gf && gf.status === 'complete' && gf.winner && gf.loser && gf.winner === slotValue(state, gf.srcB).teamId;
        if (!active) {
          const desired = gf && gf.status === 'complete' ? 'not-needed' : 'dormant';
          if (m.status !== desired) {
            m.status = desired;
            changed = true;
          }
          continue;
        }
        // Active reset: fall through to normal readiness computation.
      }
      const { A, B } = matchTeams(state, m);
      if (A.resolved && B.resolved) {
        if (!A.teamId && !B.teamId) {
          if (m.status !== 'bye') {
            m.status = 'bye';
            m.winner = null;
            m.loser = null;
            m.auto = true;
            changed = true;
          }
        } else if (!A.teamId || !B.teamId) {
          const w = A.teamId || B.teamId;
          if (m.status !== 'bye' || m.winner !== w) {
            m.status = 'bye';
            m.winner = w;
            m.loser = null;
            m.auto = true;
            changed = true;
          }
        } else if (m.status !== 'ready') {
          m.status = 'ready';
          changed = true;
        }
      } else if (m.status !== 'pending' && !m.conditionalReset) {
        m.status = 'pending';
        changed = true;
      } else if (m.conditionalReset && m.status !== 'ready') {
        // Active reset whose teams are known (GF decided) is ready.
        if (A.resolved && B.resolved && A.teamId && B.teamId) {
          m.status = 'ready';
          changed = true;
        }
      }
    }
  }

  // Champion derivation.
  state.championTeamId = null;
  if (state.format === 'single') {
    const finalMatch = state.matches.find((m) => m.winTo === 'champion');
    if (finalMatch && (finalMatch.status === 'complete' || finalMatch.status === 'bye') && finalMatch.winner) {
      state.championTeamId = finalMatch.winner;
    }
  } else {
    const gf = byId['GF'];
    const rst = byId['RST'];
    if (rst && rst.status === 'complete' && rst.winner) {
      state.championTeamId = rst.winner;
    } else if (gf && gf.status === 'complete' && gf.winner) {
      const wbChampTeam = slotValue(state, gf.srcA).teamId;
      if (gf.winner === wbChampTeam) state.championTeamId = gf.winner;
      else if (!state.resetEnabled) state.championTeamId = gf.winner;
      // else: reset match decides it.
    }
  }

  // Losses / elimination flags (derived, for display).
  const losses = {};
  state.matches.forEach((m) => {
    if ((m.status === 'complete') && m.loser) losses[m.loser] = (losses[m.loser] || 0) + 1;
  });
  state.teams.forEach((t) => {
    t.losses = losses[t.id] || 0;
    t.eliminated = state.format === 'double' ? t.losses >= 2 : t.losses >= 1;
  });
  if (state.byeTeam) {
    state.byeTeam.losses = losses[state.byeTeam.id] || 0;
    state.byeTeam.eliminated = state.format === 'double' ? state.byeTeam.losses >= 2 : state.byeTeam.losses >= 1;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Tournament creation + scoring
// ---------------------------------------------------------------------------

function createTournament({ name, format, mode, resetEnabled, players, gamesAtATime }) {
  const { teams, byeTeam } = drawTeams(players, mode);
  const { matches, bracketSize, winnersRounds } = buildBracket(teams, format, resetEnabled);
  const state = {
    name: name || 'Cornhole Tournament',
    format,
    mode,
    resetEnabled: !!resetEnabled,
    gamesAtATime: normalizeGamesAtATime(gamesAtATime),
    players,
    teams,
    byeTeam: byeTeam || null,
    matches,
    bracketSize,
    winnersRounds,
    championTeamId: null,
    transfer: byeTeam
      ? { status: 'pending', byeTeamId: byeTeam.id, player: null, fromTeamId: null, matchId: null }
      : { status: 'not-applicable' },
    scoresCount: 0,
    drawCount: 1,
    locked: false,
    drawnAt: new Date().toISOString(),
    version: 1,
  };
  resolve(state);
  return state;
}

/*
 * Re-run the full draw from the roster (both shuffles; in coed mode the
 * gender pools are re-shuffled and the Bye Player re-derived). Allowed only
 * before the tournament starts: once it is locked (organizer started it, or
 * the first score is in) the draw can never change again.
 */
function redrawTournament(state) {
  if (state.locked || state.scoresCount > 0) {
    throw new Error('The draw is locked — the tournament has started.');
  }
  const { teams, byeTeam } = drawTeams(state.players, state.mode);
  const { matches, bracketSize, winnersRounds } = buildBracket(teams, state.format, state.resetEnabled);
  state.teams = teams;
  state.byeTeam = byeTeam || null;
  state.matches = matches;
  state.bracketSize = bracketSize;
  state.winnersRounds = winnersRounds;
  state.championTeamId = null;
  state.scoresCount = 0;
  state.transfer = byeTeam
    ? { status: 'pending', byeTeamId: byeTeam.id, player: null, fromTeamId: null, matchId: null }
    : { status: 'not-applicable' };
  state.drawCount = (state.drawCount || 1) + 1;
  state.drawnAt = new Date().toISOString();
  state.version += 1;
  resolve(state);
  return state;
}

/*
 * The coed Bye Player transfer. Fires on the first scored match whose losing
 * team carries a female player: she moves to the Bye Player's team, and the
 * new team enters through a play-in match (winners side in single elim,
 * losers path in double elim, where her former partner continues as Walker).
 */
function fireTransfer(state, triggerMatch) {
  const loserTeam = state.teams.find((t) => t.id === triggerMatch.loser);
  const byeTeam = state.byeTeam;
  if (!loserTeam || !byeTeam) return false;
  const female = loserTeam.players.find((p) => {
    const rec = state.players.find((pl) => pl.name === p);
    return rec && rec.gender === 'F';
  });
  if (!female) return false;

  loserTeam.players = loserTeam.players.filter((p) => p !== female);
  if (loserTeam.players.length === 1) loserTeam.walker = true;
  byeTeam.players = [byeTeam.players[0], female];
  byeTeam.byePending = false;
  state.teams.push(byeTeam);

  const playIn = {
    id: 'PI-1',
    bracket: state.format === 'double' ? 'L' : 'W',
    round: 0,
    index: 0,
    label: state.format === 'double' ? 'Second Chance · Play-In' : 'Play-In',
    srcA: null,
    srcB: null,
    winTo: null,
    loseTo: null,
    winner: null,
    loser: null,
    decided: false,
    auto: false,
    status: 'pending',
    playIn: true,
  };

  if (state.format === 'single') {
    // New team must beat the triggering match's winner to take their slot.
    const target = triggerMatch.winTo;
    playIn.srcA = { kind: 'winner', match: triggerMatch.id };
    playIn.srcB = { kind: 'team', teamId: byeTeam.id };
    playIn.winTo = target;
    triggerMatch.winTo = { match: 'PI-1', slot: 'A' };
    if (target && target !== 'champion') {
      const targetMatch = state.matches.find((m) => m.id === target.match);
      const src = target.slot === 'A' ? 'srcA' : 'srcB';
      targetMatch[src] = { kind: 'winner', match: 'PI-1' };
      playIn.round = targetMatch.round;
      playIn.label = 'Play-In · ' + (targetMatch.label.split('·')[1] || '').trim() || 'Play-In';
    } else {
      playIn.round = triggerMatch.round + 1;
      playIn.label = 'Play-In · Championship';
    }
  } else {
    // New team plays the source (now Walker) team for its losers-bracket slot.
    const target = triggerMatch.loseTo;
    playIn.srcA = { kind: 'team', teamId: byeTeam.id };
    playIn.srcB = { kind: 'loser', match: triggerMatch.id };
    playIn.winTo = target;
    triggerMatch.loseTo = { match: 'PI-1', slot: 'B' };
    if (target) {
      const targetMatch = state.matches.find((m) => m.id === target.match);
      const src = target.slot === 'A' ? 'srcA' : 'srcB';
      targetMatch[src] = { kind: 'winner', match: 'PI-1' };
      playIn.round = targetMatch.round;
    }
  }
  state.matches.push(playIn);
  state.transfer = {
    status: 'done',
    byeTeamId: byeTeam.id,
    player: female,
    fromTeamId: loserTeam.id,
    matchId: triggerMatch.id,
  };
  state.byeTeam = null;
  return true;
}

function applyScore(state, matchId, winnerTeamId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) throw new Error('Match not found');
  if (match.status !== 'ready') throw new Error('Match is not ready to score');
  const { A, B } = matchTeams(state, match);
  if (winnerTeamId !== A.teamId && winnerTeamId !== B.teamId) {
    throw new Error('Winner is not playing in this match');
  }
  match.winner = winnerTeamId;
  match.loser = winnerTeamId === A.teamId ? B.teamId : A.teamId;
  match.decided = true;
  match.auto = false;
  state.scoresCount += 1;
  state.locked = true; // The first score locks the draw for good.
  if (state.transfer && state.transfer.status === 'pending') {
    fireTransfer(state, match);
  }
  state.version += 1;
  resolve(state);
  return state;
}

// ---------------------------------------------------------------------------
// Live team editing (organizer only; enforced at the API layer)
// ---------------------------------------------------------------------------
// Matches reference teams, never player names, so an edit carries the new
// lineup forward without rewriting any recorded result. All three edits
// are one-for-one, so team sizes can never become invalid: 2 players per
// team, 1 for a Walker or the Bye Player's team.

function findTeamAnywhere(state, teamId) {
  return (
    state.teams.find((t) => t.id === teamId) ||
    (state.byeTeam && state.byeTeam.id === teamId ? state.byeTeam : null)
  );
}

function assertTeamsEditable(state) {
  if (state.championTeamId) {
    throw new Error('The tournament is finished — the teams are final.');
  }
}

function cleanPlayerName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function playerNameTaken(state, name, exceptName) {
  const key = name.toLowerCase();
  return state.players.some((p) => p.name.toLowerCase() === key && p.name !== exceptName);
}

function swapPlayers(state, teamAId, playerA, teamBId, playerB) {
  assertTeamsEditable(state);
  if (teamAId === teamBId) throw new Error('Pick players from two different teams to swap.');
  const a = findTeamAnywhere(state, teamAId);
  const b = findTeamAnywhere(state, teamBId);
  if (!a || !b) throw new Error('Team not found.');
  const ia = a.players.indexOf(playerA);
  const ib = b.players.indexOf(playerB);
  if (ia < 0) throw new Error(playerA + ' is not on that team.');
  if (ib < 0) throw new Error(playerB + ' is not on that team.');
  a.players[ia] = playerB;
  b.players[ib] = playerA;
  state.version += 1;
  resolve(state);
  return state;
}

function substitutePlayer(state, teamId, outName, inName, gender) {
  assertTeamsEditable(state);
  const team = findTeamAnywhere(state, teamId);
  if (!team) throw new Error('Team not found.');
  const idx = team.players.indexOf(outName);
  if (idx < 0) throw new Error(outName + ' is not on that team.');
  const name = cleanPlayerName(inName);
  if (!name) throw new Error('Enter the new player name.');
  if (name.toLowerCase() !== outName.toLowerCase() && playerNameTaken(state, name)) {
    throw new Error('That name is already playing in this tournament.');
  }
  team.players[idx] = name;
  const rec = state.players.find((p) => p.name === outName);
  const validGender = gender === 'M' || gender === 'F' ? gender : null;
  if (rec) {
    rec.name = name;
    if (state.mode === 'coed' && validGender) rec.gender = validGender;
  } else {
    state.players.push({
      name,
      gender: state.mode === 'coed' ? validGender || null : null,
    });
  }
  if (state.transfer && state.transfer.player === outName) state.transfer.player = name;
  state.version += 1;
  resolve(state);
  return state;
}

function renamePlayer(state, fromName, toName) {
  assertTeamsEditable(state);
  const name = cleanPlayerName(toName);
  if (!name) throw new Error('Enter the new name.');
  const rec = state.players.find((p) => p.name === fromName);
  if (!rec) throw new Error('Player not found.');
  if (name.toLowerCase() !== fromName.toLowerCase() && playerNameTaken(state, name)) {
    throw new Error('That name is already playing in this tournament.');
  }
  rec.name = name;
  state.teams.forEach((t) => {
    t.players = t.players.map((p) => (p === fromName ? name : p));
  });
  if (state.byeTeam) {
    state.byeTeam.players = state.byeTeam.players.map((p) => (p === fromName ? name : p));
  }
  if (state.transfer && state.transfer.player === fromName) state.transfer.player = name;
  state.version += 1;
  resolve(state);
  return state;
}

/*
 * Build the history entry for a completed tournament (null while there is
 * no champion). The runner-up is the loser of the deciding match: the
 * final in single elimination; in double elimination the reset game when
 * it was played, otherwise the Grand Final. When the deciding match has
 * no loser (a bye final), the runner-up is omitted rather than guessed.
 */
function buildHistoryEntry(state) {
  if (!state.championTeamId) return null;
  const champ = findTeamAnywhere(state, state.championTeamId);
  if (!champ) return null;
  const teamRef = (t) => ({ players: t.players.slice(), walker: !!t.walker && t.players.length === 1 });
  let decider = null;
  if (state.format === 'single') {
    decider =
      state.matches.find(
        (m) => m.winTo === 'champion' && (m.status === 'complete' || m.status === 'bye') && m.winner === state.championTeamId
      ) || null;
  } else {
    const rst = state.matches.find((m) => m.id === 'RST');
    const gf = state.matches.find((m) => m.id === 'GF');
    if (rst && rst.status === 'complete' && rst.winner === state.championTeamId) decider = rst;
    else if (gf && gf.status === 'complete' && gf.winner === state.championTeamId) decider = gf;
  }
  let runnerUp = null;
  if (decider && decider.loser) {
    const rt = findTeamAnywhere(state, decider.loser);
    if (rt) runnerUp = teamRef(rt);
  }
  return {
    id: state.id || null,
    name: state.name,
    format: state.format,
    mode: state.mode,
    playerCount: state.players.length,
    teamCount: state.teams.length,
    gamesPlayed: state.scoresCount,
    champion: teamRef(champ),
    runnerUp,
  };
}

// Count of matches that will actually be played (excludes auto-bye matches
// and the dormant reset card).
function playableMatchCount(state) {
  return state.matches.filter((m) => !m.auto && m.status !== 'bye').length;
}

// ---------------------------------------------------------------------------
// Court queue: how many games run at once, and which ones are on court
// ---------------------------------------------------------------------------

// Only 1 or 2 are valid; anything else (including a missing field on a
// tournament created before this feature existed) means 2.
function normalizeGamesAtATime(value) {
  return value === 1 || value === '1' ? 1 : 2;
}

// The engine's natural match order: winners bracket first, then the Second
// Chance bracket, then the Grand Final, then the reset card; rounds and
// indices ascending inside each bracket. This matches the order the
// Matches view has always sorted by.
const BRACKET_ORDER = { W: 0, L: 1, GF: 2, R: 3 };
function naturalMatchOrder(a, b) {
  return (
    (BRACKET_ORDER[a.bracket] ?? 9) - (BRACKET_ORDER[b.bracket] ?? 9) ||
    a.round - b.round ||
    a.index - b.index
  );
}

/*
 * Derive the court queue from state. A match is READY when both of its
 * teams are decided and it has no winner yet (status 'ready'). The first
 * gamesAtATime ready matches in natural order are ON COURT (Court 1,
 * Court 2); the rest are Up Next. This is computed fresh on every read so
 * the organizer and every spectator always see the same courts, and a
 * recorded result rotates the next ready match onto the freed court.
 */
function courtQueue(state) {
  const limit = normalizeGamesAtATime(state.gamesAtATime);
  const ready = state.matches
    .filter((m) => m.status === 'ready')
    .slice()
    .sort(naturalMatchOrder);
  return {
    gamesAtATime: limit,
    ready: ready.map((m) => m.id),
    onCourt: ready.slice(0, limit).map((m, i) => ({ matchId: m.id, court: i + 1 })),
    upNext: ready.slice(limit).map((m) => m.id),
  };
}

function publicState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.snapshots;
  delete copy.organizerKeyHash;
  // Court designation is derived here, on every read, never stored on the
  // matches themselves, so it cannot drift between writes and reads.
  copy.gamesAtATime = normalizeGamesAtATime(copy.gamesAtATime);
  const queue = courtQueue(copy);
  const courtOf = {};
  queue.onCourt.forEach((entry) => (courtOf[entry.matchId] = entry.court));
  copy.matches.forEach((m) => {
    m.court = courtOf[m.id] || null;
  });
  copy.courts = queue;
  return copy;
}

module.exports = {
  secureRandomInt,
  shuffle,
  randomToken,
  drawTeams,
  buildBracket,
  seedOrder,
  nextPow2,
  createTournament,
  redrawTournament,
  applyScore,
  resolve,
  matchTeams,
  publicState,
  courtQueue,
  naturalMatchOrder,
  normalizeGamesAtATime,
  swapPlayers,
  substitutePlayer,
  renamePlayer,
  findTeamAnywhere,
  buildHistoryEntry,
};
