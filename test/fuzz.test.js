import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSiteswap, buildPattern, throwAtBeat, ballStates, eventsBetween, findCollisions } from '../src/physics.js';
import { buildHandTimeline, sceneAt } from '../src/hands.js';
import { describePattern } from '../src/describe.js';

/** Small seeded generator, so a failure can be reproduced. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random valid siteswap: pick where each beat's throw lands (a permutation), then add laps. */
function randomSiteswap(random) {
  const n = 1 + Math.floor(random() * 7);
  const landing = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [landing[i], landing[j]] = [landing[j], landing[i]];
  }
  const throws = landing.map((slot, i) => {
    let v = (((slot - i) % n) + n) % n;
    const laps = Math.floor(random() * 3);
    v += n * laps;
    while (v > 13) v -= n; // keep to throws with published numbers
    return Math.max(v, 0);
  });
  return throws.map((v) => v.toString(36)).join('');
}

test('500 random valid siteswaps: the whole model stays sane', () => {
  const random = rng(20261113);
  let built = 0;
  let collided = 0;
  for (let k = 0; k < 500; k++) {
    const text = randomSiteswap(random);
    const parsed = parseSiteswap(text);
    if (!parsed.ok) {
      assert.equal(parsed.code, 'zero', text + ' was generated valid, so only "zero balls" may refuse it: ' + parsed.error);
      continue;
    }
    built++;
    const pattern = buildPattern(text);
    assert.equal(pattern.ok, true, text);
    const timeline = buildHandTimeline(pattern);
    const collisions = findCollisions(pattern);
    assert.ok(collisions.minDistance >= 0, text);
    if (collisions.collides) collided++;
    for (const hit of collisions.hits) {
      assert.ok(Number.isFinite(hit.x) && Number.isFinite(hit.y) && hit.distance < pattern.ballDiameter, text);
    }
    const words = describePattern(pattern, collisions);
    assert.ok(words.title.length > 0 && words.notes.length > 0, text);
    assert.equal(!!(words.collision && words.collision.bad), collisions.collides, text + ': the warning matches the check');

    // Flight times are positive for anything thrown, and heights follow from them.
    for (const row of pattern.throwTable) {
      if (row.type === 'empty' || row.type === 'hold') assert.equal(row.flight, 0, text);
      else assert.ok(row.flight > 0 && row.height > 0 && Number.isFinite(row.height), text + ' throw ' + row.value);
    }

    for (let s = 0; s < 40; s++) {
      const t = (random() * 4 - 1) * pattern.cycleTime * 3;
      const scene = sceneAt(pattern, timeline, t);
      assert.equal(scene.balls.length, pattern.balls, text + ' at t=' + t);
      const ids = new Set();
      const held = [0, 0];
      for (const b of scene.balls) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), text + ': ball position at t=' + t);
        assert.ok(Math.abs(b.x) < 3 && b.y > -1.5 && b.y < 12, text + ': ball in a believable place at t=' + t);
        ids.add(b.ball);
        if (!b.air) held[b.hand]++;
      }
      assert.equal(ids.size, pattern.balls, text + ': distinct balls');
      assert.ok(held[0] <= 1 && held[1] <= 1, text + ': one ball per hand at t=' + t);
      for (const h of scene.hands) {
        assert.ok(Number.isFinite(h.x) && Number.isFinite(h.y), text + ': hand position');
        assert.ok(Math.abs(h.x) < 2.5 && Math.abs(h.y) < 1.5, text + ': hand in a believable place (' + h.x + ', ' + h.y + ')');
      }
    }

    const events = eventsBetween(pattern, 0, pattern.cycleTime);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].time >= events[i - 1].time, text);
    assert.equal(events.filter((e) => e.type === 'catch').length, events.filter((e) => e.type === 'release').length, text);

    // Every ball that is thrown is thrown again `value` beats later by the hand it landed in.
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (rec.value === 0) continue;
      const next = throwAtBeat(pattern, i + rec.value);
      assert.equal(next.ball, rec.ball, text);
      assert.equal(next.hand, rec.toHand, text);
    }
    assert.equal(ballStates(pattern, 0).length, pattern.balls);
  }
  assert.ok(built > 400, 'patterns built: ' + built);
  assert.ok(collided > 0 && collided < built, 'some collide and some do not (' + collided + ' of ' + built + ')');
});

test('random garbage never throws: it is refused with a message', () => {
  const random = rng(7);
  const alphabet = '0123456789abcxyz()[]*, -!?';
  for (let k = 0; k < 2000; k++) {
    const length = Math.floor(random() * 9);
    let text = '';
    for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)];
    const result = buildPattern(text);
    if (!result.ok) {
      assert.ok(typeof result.error === 'string' && result.error.length > 10, JSON.stringify(text));
      assert.ok(['empty', 'sync', 'multiplex', 'char', 'invalid', 'zero', 'toolong'].includes(result.code), result.code);
    } else {
      assert.ok(result.balls >= 1 && Number.isInteger(result.balls), JSON.stringify(text));
    }
  }
});
