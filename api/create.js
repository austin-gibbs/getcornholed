'use strict';
const engine = require('../lib/engine');
const store = require('../lib/store');
const api = require('../lib/api-common');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return api.sendJson(res, 405, { error: 'Method not allowed' });
  let body;
  try {
    body = await api.readBody(req);
  } catch (e) {
    return api.sendJson(res, 400, { error: e.message });
  }
  const format = body.format === 'single' ? 'single' : 'double';
  const mode = body.mode === 'coed' ? 'coed' : 'random';
  const resetEnabled = format === 'double' ? body.reset !== false : false;
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Cornhole Tournament';

  const { players, error } = api.normalizePlayers(body.players, mode);
  if (error) return api.sendJson(res, 400, { error });

  try {
    const state = engine.createTournament({ name, format, mode, resetEnabled, players });
    if (state.teams.length < 2) {
      return api.sendJson(res, 400, { error: 'Those players do not make at least 2 teams. Add more players.' });
    }
    const id = engine.randomToken(10, 10);
    const organizerKey = engine.randomToken(24, 24);
    const doc = Object.assign({}, state, {
      id,
      organizerKeyHash: api.hashKey(organizerKey),
      snapshots: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.putTournament(id, doc);
    return api.sendJson(res, 201, {
      id,
      organizerKey,
      tournament: engine.publicState(doc),
    });
  } catch (e) {
    return api.sendJson(res, 500, { error: 'Could not create the tournament. Please try again.' });
  }
};
