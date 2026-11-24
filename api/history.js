'use strict';
/*
 * GET /api/history — public. Recent completed tournaments, newest first
 * (capped at 100). Entries are built from public tournament fields only:
 * no organizer key or key hash is ever part of a history entry.
 */
const history = require('../lib/history');
const api = require('../lib/api-common');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return api.sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const entries = await history.readHistory(100);
    return api.sendJson(res, 200, { history: entries });
  } catch (e) {
    return api.sendJson(res, 500, { error: 'Could not load the history.' });
  }
};
