import test from 'node:test';
import assert from 'node:assert/strict';

import { RIGHT, LEFT, buildPattern, throwAtBeat } from '../src/physics.js';
import { buildHandTimeline, handState, handPath, sceneAt } from '../src/hands.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );

const PATTERNS = ['3', '4', '5', '6', '7', '531', '441', '456', '423', '51', '7131', '522', '42', '501', '97531'];

function setup(text) {
  const pattern = buildPattern(text);
  return { pattern, timeline: buildHandTimeline(pattern) };
}

test('ghost hand is exactly at the release point, moving with the ball, when it lets go', () => {
  for (const text of PATTERNS) {
    const { pattern, timeline } = setup(text);
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (!rec.air) continue;
      const hand = handState(timeline, rec.hand, rec.tThrow);
      near(hand.x, rec.x0, 1e-9, text + ' release x');
      near(hand.y, 0, 1e-9, text + ' release y');
      // The hand has to match the ball's velocity at release.
      const before = handState(timeline, rec.hand, rec.tThrow - 1e-6);
      near(before.vx, rec.vx, 1e-3, text + ' release vx');
      near(before.vy, rec.vy, 1e-3, text + ' release vy');
      assert.equal(before.carrying, true, text + ': holding the ball just before release');
    }
  }
});

test('ghost hand is exactly at the catch point when the ball lands', () => {
  for (const text of PATTERNS) {
    const { pattern, timeline } = setup(text);
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (!rec.air) continue;
      const hand = handState(timeline, rec.toHand, rec.tCatch);
      near(hand.x, rec.x1, 1e-9, text + ' catch x');
      near(hand.y, 0, 1e-9, text + ' catch y');
      const justBefore = handState(timeline, rec.toHand, rec.tCatch - 1e-6);
      assert.equal(justBefore.carrying, false, text + ': the hand is empty when the ball arrives');
      const justAfter = handState(timeline, rec.toHand, rec.tCatch + 1e-6);
      assert.equal(justAfter.carrying, true, text + ': and holding it afterwards');
    }
  }
});

test('the scoop goes the right way: in and under while holding, out and over while empty', () => {
  for (const text of ['3', '4', '5', '6', '7']) {
    const { pattern, timeline } = setup(text);
    for (const hand of [RIGHT, LEFT]) {
      const side = hand === RIGHT ? 1 : -1;
      const path = handPath(timeline, hand, 400);
      let lowest = 0;
      let highest = 0;
      for (const p of path) {
        if (p.carrying) assert.ok(p.y <= 1e-9, text + ': a carried ball is at or below the catch height');
        else assert.ok(p.y >= -1e-9, text + ': the empty hand returns at or above it');
        lowest = Math.min(lowest, p.y);
        highest = Math.max(highest, p.y);
        assert.ok(p.x * side > 0, text + ': each hand stays on its own side');
      }
      assert.ok(lowest < -0.05 && highest > 0.02, text + ': a real dip and a real return');
      // Signed area (shoelace). Seen by the juggler (x right, y up) the right hand circles
      // clockwise (negative area) and the left hand counter-clockwise: both scoop inward.
      let area = 0;
      for (let k = 1; k < path.length; k++) area += path[k - 1].x * path[k].y - path[k].x * path[k - 1].y;
      assert.equal(Math.sign(area), -side, text + ' hand ' + hand + ' circles inward');
    }
    // Catch outside, release inside.
    assert.ok(pattern.layout.xC > pattern.layout.xT && pattern.layout.xT > 0, text);
  }
});

test('the hands alternate: one release per beat, right, left, right, left', () => {
  const { pattern, timeline } = setup('3');
  for (let i = 0; i < 6; i++) {
    const t = i * pattern.beat;
    const thrower = i % 2;
    const other = 1 - thrower;
    // At its own beat a hand is at its release point; the other hand is somewhere else.
    near(Math.abs(handState(timeline, thrower, t).x), pattern.layout.xT, 1e-9);
    assert.ok(Math.abs(handState(timeline, other, t).x) > pattern.layout.xT + 0.01);
    assert.equal(throwAtBeat(pattern, i).hand, thrower);
  }
  // The two hands do the same thing half a hand period apart, mirrored.
  for (let k = 0; k < 50; k++) {
    const t = (k / 50) * pattern.cycleTime;
    const r = handState(timeline, RIGHT, t);
    const l = handState(timeline, LEFT, t + pattern.beat);
    near(l.x, -r.x, 1e-9);
    near(l.y, r.y, 1e-9);
  }
});

test('no ball ever teleports: positions are continuous through every catch and release', () => {
  for (const text of PATTERNS) {
    const { pattern, timeline } = setup(text);
    const dt = 1 / 2000;
    const steps = Math.ceil((pattern.cycleTime * 2) / dt);
    let prev = null;
    let fastest = 0;
    for (let k = 0; k <= steps; k++) {
      const scene = sceneAt(pattern, timeline, k * dt);
      assert.equal(scene.balls.length, pattern.balls);
      const byBall = new Map(scene.balls.map((b) => [b.ball, b]));
      if (prev) {
        for (const [id, b] of byBall) {
          const p = prev.get(id);
          const jump = Math.hypot(b.x - p.x, b.y - p.y);
          fastest = Math.max(fastest, jump / dt);
          // Nothing in these patterns moves faster than 15 m/s; a teleport would be far more.
          assert.ok(jump < 15 * dt, text + ': ball ' + id + ' jumped ' + jump.toFixed(4) + ' m at t=' + (k * dt).toFixed(4));
        }
      }
      prev = byBall;
    }
    assert.ok(fastest > 0 || pattern.maxThrow <= 2, text);
  }
});

test('a held ball sits in its hand; each hand holds at most one', () => {
  for (const text of PATTERNS) {
    const { pattern, timeline } = setup(text);
    for (let k = 0; k < 600; k++) {
      const t = (k / 600) * pattern.cycleTime * 2 + 0.0123;
      const scene = sceneAt(pattern, timeline, t);
      const held = [0, 0];
      for (const b of scene.balls) {
        if (b.air) {
          assert.equal(b.hand, -1);
          assert.ok(b.y >= -1e-9, text + ': a flying ball is never below the hands');
        } else {
          held[b.hand]++;
          near(b.x, scene.hands[b.hand].x, 1e-12);
          near(b.y, scene.hands[b.hand].y, 1e-12);
          assert.equal(scene.hands[b.hand].holding, b.ball);
        }
      }
      assert.ok(held[RIGHT] <= 1 && held[LEFT] <= 1, text + ' t=' + t);
      for (const hand of [RIGHT, LEFT]) {
        assert.equal(scene.hands[hand].carrying, held[hand] === 1, text + ' hand ' + hand + ' t=' + t);
        // Two independent derivations agree about when a hand is full: the hand's own catch and
        // release knots, and the ball states. (A hand with no knots holds its 2 forever.)
        if (timeline.knots[hand].length > 0) {
          assert.equal(handState(timeline, hand, t).carrying, held[hand] === 1, text + ' hand ' + hand + ' t=' + t);
        }
      }
    }
  }
});

test('a 2 is a hold: the hand waits at the catch point, then scoops one normal dwell before release', () => {
  const { pattern, timeline } = setup('423');
  // Beat 1 (left hand) is the 2: the ball that lands there is thrown as a 4 on beat 3.
  const release = throwAtBeat(pattern, 3);
  assert.equal(release.hand, LEFT);
  assert.equal(release.value, 4);
  const waitingAt = 1 * pattern.beat; // on the beat of the 2 itself
  const waiting = handState(timeline, LEFT, waitingAt);
  assert.equal(waiting.carrying, true);
  near(waiting.x, -pattern.layout.xC, 1e-9, 'resting at the catch point');
  near(waiting.y, 0, 1e-9);
  near(Math.hypot(waiting.vx, waiting.vy), 0, 1e-9, 'not moving');
  // One normal dwell before the release the scoop has begun.
  const scooping = handState(timeline, LEFT, release.tThrow - pattern.dwell / 2);
  assert.ok(scooping.y < -0.02);
  // The held ball is the one that gets thrown.
  const scene = sceneAt(pattern, timeline, waitingAt);
  assert.equal(scene.hands[LEFT].holding, release.ball);
});

test('a hand with nothing to do rests, and a permanent hold keeps its ball', () => {
  // 42: the right hand juggles two balls (4s); the left holds one forever (the 2).
  const { pattern, timeline } = setup('42');
  assert.equal(timeline.knots[LEFT].length, 0);
  for (const t of [0, 0.31, 1.7, 9.99]) {
    const scene = sceneAt(pattern, timeline, t);
    near(scene.hands[LEFT].x, -pattern.layout.xC, 1e-12);
    assert.notEqual(scene.hands[LEFT].holding, -1);
    assert.equal(scene.balls.filter((b) => b.hand === LEFT).length, 1);
  }
  // 501: after passing the 1 on beat 2 the right hand has nothing to catch until just before
  // beat 6. It goes to where that ball will land within one normal empty time, and waits.
  const b = setup('501');
  const pass = throwAtBeat(b.pattern, 2);
  assert.equal(pass.value, 1);
  assert.equal(pass.hand, RIGHT);
  const later = handState(b.timeline, RIGHT, pass.tThrow + b.pattern.empty + 0.01);
  assert.equal(later.carrying, false);
  near(Math.hypot(later.vx, later.vy), 0, 1e-9, 'waiting');
  const arriving = throwAtBeat(b.pattern, 5); // the left hand's 1, landing in the right hand
  assert.equal(arriving.toHand, RIGHT);
  near(later.x, arriving.x1, 1e-9, 'already at the next catch point');
});

test('scoop depth is modest and grows with the throw (sanity of the drawing choice)', () => {
  const depth = (text) => {
    const { timeline } = setup(text);
    return -Math.min(...handPath(timeline, RIGHT, 400).map((p) => p.y));
  };
  const d3 = depth('3');
  const d5 = depth('5');
  const d7 = depth('7');
  assert.ok(d3 > 0.05 && d3 < 0.2, '3 balls: ' + d3);
  assert.ok(d7 > d5 && d5 > d3);
  assert.ok(d7 < 0.4, '7 balls: ' + d7);
});
