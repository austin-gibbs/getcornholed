'use strict';
const crypto = require('crypto');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 512 * 1024) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function checkOrganizer(req, doc) {
  const provided = req.headers['x-organizer-key'] || '';
  if (!provided || !doc.organizerKeyHash) return false;
  const a = Buffer.from(hashKey(provided));
  const b = Buffer.from(doc.organizerKeyHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function queryParam(req, name) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get(name);
  } catch (e) {
    return null;
  }
}

// Validate and normalize the player list from a create request.
// Returns { players } or { error }.
function normalizePlayers(input, mode) {
  if (!Array.isArray(input)) return { error: 'Player list is required.' };
  const seen = new Set();
  const players = [];
  let duplicates = 0;
  for (const raw of input) {
    const rawName = typeof raw === 'string' ? raw : raw && raw.name;
    const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) {
      duplicates++;
      continue;
    }
    seen.add(dedupeKey);
    const gender = mode === 'coed' ? (raw && raw.gender === 'M' || raw && raw.gender === 'F' ? raw.gender : null) : null;
    players.push({ name, gender });
  }
  if (players.length < 4) {
    return { error: 'You need at least 4 players to run a tournament. Add a few more names.' };
  }
  if (players.length > 64) {
    return { error: 'That is more than 64 players. Split it into two tournaments.' };
  }
  if (mode === 'coed') {
    const males = players.filter((p) => p.gender === 'M').length;
    const females = players.filter((p) => p.gender === 'F').length;
    if (males === 0 || females === 0) {
      return { error: 'Male/Female mode needs at least one player tagged Male and one tagged Female.' };
    }
    if (players.some((p) => !p.gender)) {
      return { error: 'Every player needs a Male or Female tag in Male/Female mode.' };
    }
  }
  return { players, duplicates };
}

module.exports = { sendJson, readBody, hashKey, checkOrganizer, queryParam, normalizePlayers };
