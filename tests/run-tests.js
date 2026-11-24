'use strict';
/*
 * Get Cornholed test suite.
 * Covers: randomizer fairness, bracket generation (single + double),
 * full play-throughs, the coed bye-player transfer, redraw/lock rules,
 * and the HTTP API including organizer-key enforcement.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const engine = require('../lib/engine');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ' — ' + e.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ' — ' + e.message);
  }
}

function players(n, prefix) {
  return Array.from({ length: n }, (_, i) => ({ name: (prefix || 'Player') + ' ' + (i + 1), gender: null }));
}
function readyMatches(state) {
  return state.matches.filter((m) => m.status === 'ready');
}
function scoreFirstReady(state, pick) {
  const ready = readyMatches(state);
  assert(ready.length > 0, 'no ready matches but no champion either');
  const m = ready[0];
  const { A, B } = engine.matchTeams(state, m);
  const winner = pick === 'B' ? B.teamId : A.teamId;
  engine.applyScore(state, m.id, winner);
  return m;
}
function playToChampion(state, pick) {
  let scored = 0;
  let guard = 0;
  while (!state.championTeamId && guard++ < 1000) {
    scoreFirstReady(state, pick || 'A');
    scored++;
  }
  assert(state.championTeamId, 'tournament ended without a champion');
  return scored;
}

// ---------------------------------------------------------------------------
console.log('\n1. Randomizer fairness');
// ---------------------------------------------------------------------------

check('shuffle: every element lands in every position roughly evenly (120k shuffles of 6)', () => {
  const N = 120000;
  const counts = Array.from({ length: 6 }, () => 0);
  for (let i = 0; i < N; i++) {
    const s = engine.shuffle([0, 1, 2, 3, 4, 5]);
    counts[s.indexOf(0)]++;
  }
  const expected = N / 6;
  for (let pos = 0; pos < 6; pos++) {
    const dev = Math.abs(counts[pos] - expected) / expected;
    assert(dev < 0.035, 'position ' + pos + ' got ' + counts[pos] + ' (expected ~' + expected + ')');
  }
});

check('draw: partner distribution is uniform, no alphabetical/entry-order leakage (20k draws, 8 players A-H)', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const roster = names.map((name) => ({ name, gender: null }));
  const N = 20000;
  const partnerCounts = {};
  names.slice(1).forEach((n) => (partnerCounts[n] = 0));
  for (let i = 0; i < N; i++) {
    const { teams } = engine.drawTeams(roster, 'random');
    const teamA = teams.find((t) => t.players.includes('A'));
    const partner = teamA.players.find((p) => p !== 'A');
    partnerCounts[partner]++;
  }
  const expected = N / 7;
  for (const n of names.slice(1)) {
    const dev = Math.abs(partnerCounts[n] - expected) / expected;
    assert(dev < 0.08, 'A paired with ' + n + ' ' + partnerCounts[n] + ' times (expected ~' + Math.round(expected) + ')');
  }
});

check('draw: seeding is independent of pairing order (seed of a fixed team is uniform)', () => {
  const roster = players(8);
  const N = 20000;
  const seedCounts = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const { teams } = engine.drawTeams(roster, 'random');
    const t = teams.find((x) => x.players.includes('Player 1'));
    seedCounts[t.seed - 1]++;
  }
  const expected = N / 4;
  seedCounts.forEach((c, i) => {
    const dev = Math.abs(c - expected) / expected;
    assert(dev < 0.06, 'seed ' + (i + 1) + ' count ' + c + ' (expected ~' + expected + ')');
  });
});

check('shuffle: never returns the input sorted when input is sorted (sanity, 200 runs)', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  let identity = 0;
  for (let i = 0; i < 200; i++) {
    const s = engine.shuffle(input);
    if (s.every((v, j) => v === input[j])) identity++;
  }
  assert(identity <= 1, 'identity permutation appeared ' + identity + ' times in 200 runs');
});

// ---------------------------------------------------------------------------
console.log('\n2. Bracket generation: 4,5,6,7,8,9,12,16 teams, both formats');
// ---------------------------------------------------------------------------

const TABLE = {
  4: { S: 4, byes: 0, single: 3, double: 6 },
  5: { S: 8, byes: 3, single: 4, double: 8 },
  6: { S: 8, byes: 2, single: 5, double: 10 },
  7: { S: 8, byes: 1, single: 6, double: 12 },
  8: { S: 8, byes: 0, single: 7, double: 14 },
  9: { S: 16, byes: 7, single: 8, double: 16 },
  12: { S: 16, byes: 4, single: 11, double: 22 },
  16: { S: 16, byes: 0, single: 15, double: 30 },
};

for (const n of Object.keys(TABLE).map(Number)) {
  const row = TABLE[n];
  check(n + ' teams single: size ' + row.S + ', ' + row.byes + ' byes to seeds 1..' + row.byes + ', no bye-vs-bye', () => {
    const state = engine.createTournament({ name: 'T', format: 'single', mode: 'random', resetEnabled: false, players: players(2 * n) });
    assert.strictEqual(state.bracketSize, row.S);
    const r1 = state.matches.filter((m) => m.bracket === 'W' && m.round === 1);
    assert.strictEqual(r1.length, row.S / 2);
    const byeMatches = r1.filter((m) => m.status === 'bye');
    assert.strictEqual(byeMatches.length, row.byes, 'expected ' + row.byes + ' bye matches, got ' + byeMatches.length);
    byeMatches.forEach((m) => assert(m.winner, 'bye match must have exactly one team advancing'));
    const byeSeeds = byeMatches.map((m) => state.teams.find((t) => t.id === m.winner).seed).sort((a, b) => a - b);
    assert.deepStrictEqual(byeSeeds, Array.from({ length: row.byes }, (_, i) => i + 1));
  });
  check(n + ' teams double: structure counts and losers-bracket rounds', () => {
    const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: true, players: players(2 * n) });
    assert.strictEqual(state.bracketSize, row.S);
    const k = Math.log2(row.S);
    const lbRounds = state.matches.filter((m) => m.bracket === 'L');
    const lbRoundNums = [...new Set(lbRounds.map((m) => m.round))];
    assert.strictEqual(lbRoundNums.length, 2 * (k - 1), 'losers rounds');
    assert(state.matches.find((m) => m.id === 'GF'), 'grand final exists');
    assert(state.matches.find((m) => m.id === 'RST'), 'reset card exists');
    const r1 = state.matches.filter((m) => m.bracket === 'W' && m.round === 1);
    assert.strictEqual(r1.filter((m) => m.status === 'bye').length, row.byes);
  });
}

// ---------------------------------------------------------------------------
console.log('\n3. Full play-throughs');
// ---------------------------------------------------------------------------

for (const n of [4, 5, 7, 8, 12, 16]) {
  check(n + ' teams single: play-through scores exactly ' + TABLE[n].single + ' games, champion undefeated', () => {
    const state = engine.createTournament({ name: 'T', format: 'single', mode: 'random', resetEnabled: false, players: players(2 * n) });
    const scored = playToChampion(state, 'A');
    assert.strictEqual(scored, TABLE[n].single);
    const champ = state.teams.find((t) => t.id === state.championTeamId);
    assert.strictEqual(champ.losses, 0);
  });
  check(n + ' teams double: play-through scores exactly ' + TABLE[n].double + ' games, nobody out after one loss', () => {
    const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: true, players: players(2 * n) });
    const scored = playToChampion(state, 'A');
    assert.strictEqual(scored, TABLE[n].double);
    state.teams.forEach((t) => {
      if (t.id !== state.championTeamId) assert.strictEqual(t.losses, 2, 'non-champion ' + t.id + ' must have exactly 2 losses');
    });
    const champ = state.teams.find((t) => t.id === state.championTeamId);
    assert(champ.losses <= 1);
  });
}

check('double: losers-bracket comeback forces the reset game, 2n-1 games, reset winner is champion', () => {
  const n = 8;
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: true, players: players(2 * n) });
  let scored = 0;
  let guard = 0;
  // Play everything except GF/RST with slot A winning.
  while (guard++ < 500) {
    const ready = readyMatches(state).filter((m) => m.id !== 'GF' && m.id !== 'RST');
    if (!ready.length) break;
    scoreFirstReady(state, 'A');
    scored++;
  }
  const gf = state.matches.find((m) => m.id === 'GF');
  assert.strictEqual(gf.status, 'ready');
  const gfTeams = engine.matchTeams(state, gf);
  const wbChamp = gfTeams.A.teamId;
  const lbChamp = gfTeams.B.teamId;
  assert.strictEqual(state.teams.find((t) => t.id === wbChamp).losses, 0, 'winners champion must be undefeated');
  assert.strictEqual(state.teams.find((t) => t.id === lbChamp).losses, 1, 'second-chance champion must carry one loss');
  // Second-chance champion wins the grand final -> reset required.
  engine.applyScore(state, 'GF', lbChamp);
  scored++;
  assert(!state.championTeamId, 'no champion before the reset game');
  const rst = state.matches.find((m) => m.id === 'RST');
  assert.strictEqual(rst.status, 'ready', 'reset game must become ready');
  engine.applyScore(state, 'RST', lbChamp);
  scored++;
  assert.strictEqual(state.championTeamId, lbChamp, 'comeback team wins the reset and the tournament');
  assert.strictEqual(scored, 2 * n - 1);
});

check('double: unbeaten winners champion wins the Grand Final — reset match settles as not-needed', () => {
  const n = 8;
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: true, players: players(2 * n) });
  const scored = playToChampion(state, 'A');
  assert.strictEqual(scored, 2 * n - 2);
  const rst = state.matches.find((m) => m.id === 'RST');
  assert.strictEqual(rst.status, 'not-needed', 'reset card must settle as not-needed, got ' + rst.status);
  const gf = state.matches.find((m) => m.id === 'GF');
  assert.strictEqual(state.championTeamId, gf.winner);
});

check('double with reset OFF: second-chance champion winning the final takes the title, 2n-2 games', () => {
  const n = 6;
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: false, players: players(2 * n) });
  let guard = 0;
  while (guard++ < 500) {
    const ready = readyMatches(state).filter((m) => m.id !== 'GF');
    if (!ready.length) break;
    scoreFirstReady(state, 'A');
  }
  const gf = state.matches.find((m) => m.id === 'GF');
  const lbChamp = engine.matchTeams(state, gf).B.teamId;
  engine.applyScore(state, 'GF', lbChamp);
  assert.strictEqual(state.championTeamId, lbChamp);
  assert(!state.matches.find((m) => m.id === 'RST'), 'no reset match when reset is off');
});

check('full random with odd players: last drawn player is a solo Walker team', () => {
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'random', resetEnabled: true, players: players(9) });
  assert.strictEqual(state.teams.length, 5);
  const walkers = state.teams.filter((t) => t.walker);
  assert.strictEqual(walkers.length, 1);
  assert.strictEqual(walkers[0].players.length, 1);
  playToChampion(state, 'B');
});

// ---------------------------------------------------------------------------
console.log('\n4. Coed Male/Female mode and the bye-player transfer');
// ---------------------------------------------------------------------------

function coedRoster(males, females) {
  const roster = [];
  for (let i = 0; i < males; i++) roster.push({ name: 'Man ' + (i + 1), gender: 'M' });
  for (let i = 0; i < females; i++) roster.push({ name: 'Woman ' + (i + 1), gender: 'F' });
  return roster;
}

for (const format of ['single', 'double']) {
  check('coed 7M/6F ' + format + ': 6 coed teams + bye player; transfer fires on first scored game; bracket completes', () => {
    const state = engine.createTournament({ name: 'T', format, mode: 'coed', resetEnabled: true, players: coedRoster(7, 6) });
    assert.strictEqual(state.teams.length, 6);
    state.teams.forEach((t) => {
      const genders = t.players.map((p) => state.players.find((pl) => pl.name === p).gender).sort().join('');
      assert.strictEqual(genders, 'FM', 'every starting team is one male + one female');
    });
    assert(state.byeTeam, 'bye team exists');
    assert.strictEqual(state.byeTeam.players.length, 1);
    assert(state.byeTeam.players[0].startsWith('Man'), 'the uneven player is the extra male');
    assert.strictEqual(state.transfer.status, 'pending');

    // Score the first game; the loser must surrender its female player.
    const first = readyMatches(state)[0];
    const { A, B } = engine.matchTeams(state, first);
    const loserId = B.teamId; // A wins
    const loserTeamBefore = state.teams.find((t) => t.id === loserId);
    const femaleName = loserTeamBefore.players.find((p) => p.startsWith('Woman'));
    engine.applyScore(state, first.id, A.teamId);

    assert.strictEqual(state.transfer.status, 'done');
    assert.strictEqual(state.transfer.player, femaleName);
    assert.strictEqual(state.byeTeam, null);
    const newTeam = state.teams.find((t) => t.id === state.transfer.byeTeamId);
    assert(newTeam, 'new team joined the bracket teams');
    assert(newTeam.players.includes(femaleName), 'transferred female is on the new team');
    assert.strictEqual(newTeam.players.length, 2);
    const source = state.teams.find((t) => t.id === loserId);
    assert.strictEqual(source.players.length, 1, 'source team is down to one player');
    assert.strictEqual(source.walker, true, 'source player continues as a Walker');
    const playIn = state.matches.find((m) => m.playIn);
    assert(playIn, 'a play-in match was created');
    // The whole tournament, play-in included, must still complete.
    playToChampion(state, 'A');
    assert.strictEqual(playIn.status, 'complete');
  });
}

check('coed even counts: no bye player, no transfer', () => {
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'coed', resetEnabled: true, players: coedRoster(5, 5) });
  assert.strictEqual(state.teams.length, 5);
  assert.strictEqual(state.byeTeam, null);
  assert.strictEqual(state.transfer.status, 'not-applicable');
  playToChampion(state, 'A');
});

check('coed 8M/5F: bye player plus the rest pair among themselves', () => {
  const state = engine.createTournament({ name: 'T', format: 'single', mode: 'coed', resetEnabled: false, players: coedRoster(8, 5) });
  assert(state.byeTeam, 'one bye player');
  // 5 coed teams + 1 leftover-pair team = 6 bracket teams.
  assert.strictEqual(state.teams.length, 6);
});

// ---------------------------------------------------------------------------
console.log('\n5. Redraw and locking');
// ---------------------------------------------------------------------------

check('redraw: re-runs both shuffles, draw count increments, pairings change', () => {
  const state = engine.createTournament({ name: 'T', format: 'double', mode: 'coed', resetEnabled: true, players: coedRoster(7, 6) });
  const signature = (s) => s.teams.map((t) => t.players.slice().sort().join('+')).sort().join('|') + '#' + (s.byeTeam ? s.byeTeam.players[0] : '');
  const seen = new Set([signature(state)]);
  for (let i = 0; i < 3; i++) {
    engine.redrawTournament(state);
    seen.add(signature(state));
  }
  assert.strictEqual(state.drawCount, 4);
  assert.strictEqual(state.locked, false);
  assert(seen.size > 1, 'redraws must change the draw (all signatures identical is not credible)');
  assert.strictEqual(state.scoresCount, 0);
});

check('lock: first score locks the draw; redraw then throws', () => {
  const state = engine.createTournament({ name: 'T', format: 'single', mode: 'random', resetEnabled: false, players: players(8) });
  engine.redrawTournament(state);
  assert.strictEqual(state.drawCount, 2);
  scoreFirstReady(state, 'A');
  assert.strictEqual(state.locked, true);
  assert.throws(() => engine.redrawTournament(state), /locked/);
});

check('lock: starting the tournament (locked flag) blocks redraw even with no scores', () => {
  const state = engine.createTournament({ name: 'T', format: 'single', mode: 'random', resetEnabled: false, players: players(8) });
  state.locked = true; // what POST /api/redraw {action:'start'} does
  assert.throws(() => engine.redrawTournament(state), /locked/);
});

// ---------------------------------------------------------------------------
console.log('\n6. API over HTTP (local server, file store)');
// ---------------------------------------------------------------------------

async function apiTests() {
  const dataDir = '/tmp/get-cornholed-test-data';
  fs.rmSync(dataDir, { recursive: true, force: true });
  const port = 4399;
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CORNHOLE_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const base = 'http://localhost:' + port;
  const waitFor = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(base + '/');
        if (r.ok) return;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  };
  try {
    await waitFor();
    const post = (url, body, key) =>
      fetch(base + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-organizer-key': key } : {}) },
        body: JSON.stringify(body),
      });

    await checkAsync('api: create returns id + organizer key; GET never exposes the key or its hash', async () => {
      const res = await post('/api/create', { name: 'API Test', format: 'double', mode: 'random', reset: true, players: players(8) });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert(data.id && data.organizerKey);
      const getRes = await fetch(base + '/api/tournament?id=' + data.id);
      const raw = await getRes.text();
      assert(!raw.includes('organizerKey'), 'GET response must not mention organizerKey');
      assert(!raw.includes(data.organizerKey), 'GET response must not contain the key value');
      apiTests.ctx = data;
    });

    await checkAsync('api: create also accepts plain string player names', async () => {
      const res = await post('/api/create', { name: 'String Names', format: 'single', mode: 'random', players: ['Ann A', 'Bob B', 'Cat C', 'Dan D', 'Eve E', 'Fin F', 'Gia G', 'Hal H'] });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.tournament.teams.length, 4);
      const allNames = data.tournament.teams.flatMap((t) => t.players);
      assert.strictEqual(allNames.length, 8);
    });

    await checkAsync('api: scoring without a key is rejected; with a wrong key is rejected; with the key works', async () => {
      const { id, organizerKey, tournament } = apiTests.ctx;
      const match = tournament.matches.find((m) => m.status === 'ready');
      const winner = engine.matchTeams(tournament, match).A.teamId;
      let res = await post('/api/score', { id, matchId: match.id, winnerTeamId: winner });
      assert.strictEqual(res.status, 403, 'no key must be 403');
      res = await post('/api/score', { id, matchId: match.id, winnerTeamId: winner }, 'wrong-key-value');
      assert.strictEqual(res.status, 403, 'wrong key must be 403');
      res = await post('/api/score', { id, matchId: match.id, winnerTeamId: winner }, organizerKey);
      assert.strictEqual(res.status, 200, 'organizer key must score');
      const data = await res.json();
      assert.strictEqual(data.tournament.scoresCount, 1);
      assert.strictEqual(data.tournament.locked, true, 'first score locks the draw');
    });

    await checkAsync('api: redraw works before start, is organizer-only, and is rejected after start and after scoring', async () => {
      const res = await post('/api/create', { name: 'Redraw Test', format: 'single', mode: 'random', players: players(8) });
      const { id, organizerKey } = await res.json();
      let r = await post('/api/redraw', { id });
      assert.strictEqual(r.status, 403, 'redraw without key must be 403');
      r = await post('/api/redraw', { id }, organizerKey);
      assert.strictEqual(r.status, 200);
      let data = await r.json();
      assert.strictEqual(data.tournament.drawCount, 2);
      r = await post('/api/redraw', { id, action: 'start' }, organizerKey);
      assert.strictEqual(r.status, 200);
      data = await r.json();
      assert.strictEqual(data.tournament.locked, true);
      r = await post('/api/redraw', { id }, organizerKey);
      assert.strictEqual(r.status, 409, 'redraw after start must be rejected');
    });

    await checkAsync('api: validation — too few players, duplicates deduped, bad tournament 404', async () => {
      let res = await post('/api/create', { name: 'X', format: 'single', mode: 'random', players: players(3) });
      assert.strictEqual(res.status, 400);
      res = await post('/api/create', {
        name: 'Dupes',
        format: 'single',
        mode: 'random',
        players: [{ name: 'Sam' }, { name: 'sam' }, { name: 'Jo' }, { name: 'Al' }, { name: 'Kim' }, { name: 'Pat' }],
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.tournament.players.length, 5, 'duplicate name (case-insensitive) removed');
      res = await fetch(base + '/api/tournament?id=zzzznotreal');
      assert.strictEqual(res.status, 404);
    });

    await checkAsync('api: undo restores the previous state for the organizer', async () => {
      const res = await post('/api/create', { name: 'Undo Test', format: 'single', mode: 'random', players: players(8) });
      const { id, organizerKey, tournament } = await res.json();
      const match = tournament.matches.find((m) => m.status === 'ready');
      const winner = engine.matchTeams(tournament, match).A.teamId;
      let r = await post('/api/score', { id, matchId: match.id, winnerTeamId: winner }, organizerKey);
      assert.strictEqual(r.status, 200);
      r = await post('/api/score', { id, action: 'undo' }, organizerKey);
      assert.strictEqual(r.status, 200);
      const data = await r.json();
      assert.strictEqual(data.tournament.scoresCount, 0);
      assert.strictEqual(data.tournament.matches.find((m) => m.id === match.id).status, 'ready');
    });
  } finally {
    child.kill();
  }
}

(async () => {
  await apiTests();
  console.log('\n==============================================');
  console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(' - ' + f));
  }
  process.exit(failed ? 1 : 0);
})();
