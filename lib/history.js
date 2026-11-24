'use strict';
/*
 * Tournament history sync.
 *
 * Recording is an upsert keyed by tournament id, driven from the scoring
 * endpoint (the only place a champion can appear or disappear):
 * - champion decided      -> the entry is inserted at the front, or the
 *                            existing entry for that tournament is replaced
 *                            and moved to the front. Never a duplicate.
 * - champion undone       -> the entry is removed; if the tournament is
 *                            later re-decided, it is recorded again with
 *                            the final champion.
 * - no champion yet       -> nothing is recorded.
 * The list is capped at the 100 most recent completions.
 */
const engine = require('./engine');
const store = require('./store');

const MAX_HISTORY = 100;

async function syncTournamentHistory(doc) {
  const entries = await store.getHistory();
  const idx = entries.findIndex((e) => e.id === doc.id);
  if (!doc.championTeamId) {
    if (idx >= 0) {
      entries.splice(idx, 1);
      await store.putHistory(entries);
    }
    return entries;
  }
  const entry = engine.buildHistoryEntry(doc);
  if (!entry || !entry.id) return entries;
  entry.completedAt = new Date().toISOString();
  if (idx >= 0) entries.splice(idx, 1);
  entries.unshift(entry);
  const trimmed = entries.slice(0, MAX_HISTORY);
  await store.putHistory(trimmed);
  return trimmed;
}

async function readHistory(limit) {
  const entries = await store.getHistory();
  const cap = Math.min(Number(limit) || MAX_HISTORY, MAX_HISTORY);
  return entries.slice(0, cap);
}

module.exports = { syncTournamentHistory, readHistory, MAX_HISTORY };
