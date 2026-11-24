# Get Cornholed

A dead-simple cornhole tournament app. Paste the player names, draw random
teams, and run a single or double elimination tournament from your phone —
with a live bracket link anyone can follow.

**Live:** deployed on Vercel (see the project `get-cornholed`).

## How it works

1. **Set up** — name the tournament, paste player names (one per line), pick
   Full Random or Male + Female draw, pick Single or Double Elimination.
2. **Draw** — teams are drawn with a Fisher–Yates shuffle driven by
   `crypto.getRandomValues()` (rejection sampling, no modulo bias). Two
   shuffles: players into pairs, then teams into bracket seeds, so the order
   names were typed in can never leak into pairings, byes, or matchups.
   The organizer can **Randomize Again** as many times as they like before
   the tournament starts; the draw locks the moment it starts or the first
   score goes in.
3. **Play** — tap the winning team on any game card, in the Matches list or
   right in the March Madness style bracket tree. Winners advance along the
   connectors; the champion path lights up in lime.
4. **Share** — every tournament gets an unguessable spectator link (plus a QR
   code). Spectators watch the bracket update live and can never score:
   score writes require the organizer key, kept only on the organizer's
   device.

## Rules baked in

- Doubles teams of 2. Odd player in a full random draw = the **Walker**, a
  solo team that throws from both ends.
- Male + Female mode pairs one male with one female per team. If the counts
  are uneven, one unpaired player takes a **first-round bye** and is teamed
  with the female player from the first team that loses; the new team enters
  through a play-in game (in double elimination her former partner continues
  in the Second Chance bracket as a solo Walker).
- Bracket size is the next power of two; byes go to the first teams in the
  shuffled seed order, never bye vs bye.
- Double elimination uses crossed losers-bracket routing (no instant
  rematches) and a Grand Final with an optional championship reset game,
  on by default.

## Tech

Zero-dependency Node.js. Serverless API functions under `api/` run on
Vercel; the bracket engine lives in `lib/engine.js` and is the single source
of truth for the draw, bracket generation, advancement, transfer, redraw and
locking. `lib/store.js` stores each tournament as one JSON document:

- **Production:** a REST key-value store (Upstash Redis / Vercel KV) via
  `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or the
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` pair).
- **Local:** JSON files under `data/` (override with `CORNHOLE_DATA_DIR`).

## Run it locally

```bash
npm start          # http://localhost:4173
npm test           # full engine + API test suite
```

## Layout

- `public/` — the single-page app (setup, draw reveal, matches, tree, champion)
- `api/` — `create`, `tournament` (spectator read), `score`, `redraw` endpoints
- `lib/engine.js` — draw + bracket + advancement engine
- `lib/store.js` — document store (Redis REST or local files)
- `tests/run-tests.js` — fairness, bracket math, play-throughs, transfer,
  redraw/lock and API authorization tests
