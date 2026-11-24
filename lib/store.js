'use strict';
/*
 * Tournament document store.
 *
 * Production: a REST key-value store (Upstash Redis REST API, or a Vercel KV
 * REST endpoint) configured purely through environment variables:
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 * Local development: falls back to JSON files on disk so the whole app runs
 * and can be tested with no external account.
 */
const fs = require('fs');
const path = require('path');

const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || null;
const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || null;

const localDir =
  process.env.CORNHOLE_DATA_DIR ||
  (process.env.VERCEL ? '/tmp/get-cornholed-data' : path.join(__dirname, '..', 'data'));

async function redisCommand(command) {
  const res = await fetch(restUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + restToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error('Store request failed (' + res.status + ')');
  const data = await res.json();
  if (data.error) throw new Error('Store error: ' + data.error);
  return data.result;
}

function keyFor(id) {
  return 'getcornholed:tournament:' + id;
}

function localPath(id) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error('Invalid tournament id');
  return path.join(localDir, id + '.json');
}

async function getTournament(id) {
  if (restUrl && restToken) {
    const raw = await redisCommand(['GET', keyFor(id)]);
    return raw ? JSON.parse(raw) : null;
  }
  try {
    const raw = fs.readFileSync(localPath(id), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function putTournament(id, doc) {
  if (restUrl && restToken) {
    await redisCommand(['SET', keyFor(id), JSON.stringify(doc)]);
    return;
  }
  fs.mkdirSync(localDir, { recursive: true });
  const target = localPath(id);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Tournament history: one JSON list, newest first, in the same store.
// ---------------------------------------------------------------------------

const HISTORY_KEY = 'getcornholed:history';

function localHistoryPath() {
  return path.join(localDir, 'history.json');
}

async function getHistory() {
  if (restUrl && restToken) {
    const raw = await redisCommand(['GET', HISTORY_KEY]);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(localHistoryPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function putHistory(entries) {
  if (restUrl && restToken) {
    await redisCommand(['SET', HISTORY_KEY, JSON.stringify(entries)]);
    return;
  }
  fs.mkdirSync(localDir, { recursive: true });
  const target = localHistoryPath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries));
  fs.renameSync(tmp, target);
}

function backendName() {
  return restUrl && restToken ? 'redis-rest' : 'local-file';
}

module.exports = { getTournament, putTournament, getHistory, putHistory, backendName };
