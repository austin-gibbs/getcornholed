'use strict';
const engine = require('../lib/engine');
const store = require('../lib/store');
const api = require('../lib/api-common');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return api.sendJson(res, 405, { error: 'Method not allowed' });
  const id = api.queryParam(req, 'id');
  if (!id || !/^[a-z0-9]+$/.test(id)) return api.sendJson(res, 400, { error: 'Missing tournament id' });
  try {
    const doc = await store.getTournament(id);
    if (!doc) return api.sendJson(res, 404, { error: 'Tournament not found' });
    // Spectator-safe: publicState strips snapshots; the organizer key hash
    // is removed here as well. The key itself is never stored or returned.
    const pub = engine.publicState(doc);
    delete pub.organizerKeyHash;
    return api.sendJson(res, 200, { tournament: pub });
  } catch (e) {
    return api.sendJson(res, 500, { error: 'Could not load the tournament.' });
  }
};
