'use strict';
/*
 * POST /api/edit — organizer only (same key rules as scoring).
 * Live team editing, before or after the tournament starts:
 *   { id, action: 'swap', teamAId, playerA, teamBId, playerB }
 *   { id, action: 'substitute', teamId, outPlayer, inName, gender? }
 *   { id, action: 'rename', from, to }
 * Recorded results stand as played; edits carry the new lineup forward.
 * The champion cannot be edited once the tournament is complete.
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
    return api.sendJson(res, 403, { error: 'Only the tournament organizer can edit teams.' });
  }
  try {
    if (body.action === 'swap') {
      engine.swapPlayers(doc, String(body.teamAId || ''), String(body.playerA || ''), String(body.teamBId || ''), String(body.playerB || ''));
    } else if (body.action === 'substitute') {
      engine.substitutePlayer(doc, String(body.teamId || ''), String(body.outPlayer || ''), body.inName, body.gender);
    } else if (body.action === 'rename') {
      engine.renamePlayer(doc, String(body.from || ''), body.to);
    } else {
      return api.sendJson(res, 400, { error: 'Unknown edit action.' });
    }
    doc.updatedAt = new Date().toISOString();
    await store.putTournament(id, doc);
    return api.sendJson(res, 200, { tournament: engine.publicState(doc) });
  } catch (e) {
    return api.sendJson(res, 400, { error: e.message || 'Could not make that edit.' });
  }
};
