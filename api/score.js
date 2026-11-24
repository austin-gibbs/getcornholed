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
  const id = body.id;
  if (!id || !/^[a-z0-9]+$/.test(id)) return api.sendJson(res, 400, { error: 'Missing tournament id' });
  let doc;
  try {
    doc = await store.getTournament(id);
  } catch (e) {
    return api.sendJson(res, 500, { error: 'Could not load the tournament.' });
  }
  if (!doc) return api.sendJson(res, 404, { error: 'Tournament not found' });
  if (!api.checkOrganizer(req, doc)) {
    return api.sendJson(res, 403, { error: 'Only the tournament organizer can enter scores.' });
  }

  try {
    if (body.action === 'undo') {
      const snapshots = doc.snapshots || [];
      if (!snapshots.length) return api.sendJson(res, 400, { error: 'Nothing to undo.' });
      const previous = snapshots.pop();
      const restored = Object.assign({}, doc, previous, { snapshots });
      restored.updatedAt = new Date().toISOString();
      await store.putTournament(id, restored);
      const pub = engine.publicState(restored);
      delete pub.organizerKeyHash;
      return api.sendJson(res, 200, { tournament: pub });
    }

    const matchId = String(body.matchId || '');
    const winnerTeamId = String(body.winnerTeamId || '');
    if (!matchId || !winnerTeamId) return api.sendJson(res, 400, { error: 'matchId and winnerTeamId are required.' });

    // Snapshot for undo before mutating.
    const snapshot = JSON.parse(
      JSON.stringify({
        teams: doc.teams,
        byeTeam: doc.byeTeam,
        matches: doc.matches,
        championTeamId: doc.championTeamId,
        transfer: doc.transfer,
        scoresCount: doc.scoresCount,
        version: doc.version,
      })
    );
    engine.applyScore(doc, matchId, winnerTeamId);
    doc.snapshots = (doc.snapshots || []).concat([snapshot]).slice(-60);
    doc.updatedAt = new Date().toISOString();
    await store.putTournament(id, doc);
    const pub = engine.publicState(doc);
    delete pub.organizerKeyHash;
    return api.sendJson(res, 200, { tournament: pub });
  } catch (e) {
    return api.sendJson(res, 400, { error: e.message || 'Could not record that score.' });
  }
};
