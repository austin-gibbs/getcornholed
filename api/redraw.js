'use strict';
/*
 * POST /api/redraw — organizer only.
 *   { id }                 -> re-run the full draw (rejected once locked)
 *   { id, action: 'start' } -> start the tournament, locking the draw
 *   { id, action: 'courts', gamesAtATime: 1|2 }
 *                            -> set how many games run at once (any time;
 *                               the court queue re-derives on the next read)
 */
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
    return api.sendJson(res, 403, { error: 'Only the tournament organizer can change the draw.' });
  }
  try {
    if (body.action === 'courts') {
      const value = Number(body.gamesAtATime);
      if (value !== 1 && value !== 2) {
        return api.sendJson(res, 400, { error: 'Games at a time must be 1 or 2.' });
      }
      doc.gamesAtATime = value;
      doc.version = (doc.version || 1) + 1;
    } else if (body.action === 'start') {
      doc.locked = true;
      doc.version = (doc.version || 1) + 1;
    } else {
      engine.redrawTournament(doc); // throws when locked
      doc.snapshots = [];
    }
    doc.updatedAt = new Date().toISOString();
    await store.putTournament(id, doc);
    return api.sendJson(res, 200, { tournament: engine.publicState(doc) });
  } catch (e) {
    return api.sendJson(res, 409, { error: e.message || 'The draw is locked.' });
  }
};
