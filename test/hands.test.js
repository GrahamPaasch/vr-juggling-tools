import test from 'node:test';
import assert from 'node:assert/strict';

import { RIGHT, LEFT, buildPattern, throwAtBeat, findCollisions } from '../src/physics.js';
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

/**
 * How far a carrying hand strays outside the stretch between where it caught and where it will
 * release, per carry: [{ catchValue, throwValue, outward, inward }] (metres, on the hand's own side).
 */
function carryExcursions(text) {
  const { pattern, timeline } = setup(text);
  const out = [];
  for (const hand of [RIGHT, LEFT]) {
    const side = hand === RIGHT ? 1 : -1;
    const knots = timeline.knots[hand];
    for (let k = 0; k + 1 < knots.length; k++) {
      const a = knots[k];
      const b = knots[k + 1];
      if (a.type !== 'catch' || b.type !== 'throw' || a.t < 0 || a.t >= pattern.cycleTime) continue;
      const lo = Math.min(a.x * side, b.x * side);
      const hi = Math.max(a.x * side, b.x * side);
      let outward = 0;
      let inward = 0;
      for (let j = 0; j <= 400; j++) {
        const x = handState(timeline, hand, a.t + ((b.t - a.t) * j) / 400).x * side;
        outward = Math.max(outward, x - hi);
        inward = Math.max(inward, lo - x);
      }
      out.push({ catchValue: a.value, throwValue: b.value, outward, inward });
    }
  }
  return out;
}

test('a hand about to hand a ball across carries it straight in: no swing outward past the catch point', () => {
  // With the 1 thrown between the two inside throw points (38.7 cm apart on the 7-ball layout)
  // the release was a 6 m/s sideways flick, and the hand wound up 9.5 cm outward for it in 71,
  // 19 cm in 97531 and 26 cm in b1. A hand-across of one ball width needs no wind-up.
  for (const text of ['71', '7131', '7531', '97531', 'b1', 'd1', '531', '441', '51', '31']) {
    const carries = carryExcursions(text).filter((c) => c.throwValue === 1 && c.catchValue !== 1);
    assert.ok(carries.length > 0, text + ' has a hand that catches a throw and hands it across');
    for (const c of carries) {
      assert.ok(c.outward < 1e-6, text + ': carrying a ' + c.catchValue + ' to a 1 goes ' + (c.outward * 100).toFixed(1) + ' cm outward past its catch point');
      assert.ok(c.inward < 0.01, text + ': and does not overshoot the pass point (' + (c.inward * 100).toFixed(1) + ' cm)');
    }
  }
  // No carry in the presets and the spec's examples strays more than a small wind-up.
  for (const text of PATTERNS) {
    for (const c of carryExcursions(text)) {
      assert.ok(c.outward < 0.025 && c.inward < 0.025, text + ': a carry strays ' + (Math.max(c.outward, c.inward) * 100).toFixed(1) + ' cm outside its stretch');
    }
  }
});

test('the receiving hand is at the pass point, empty, when a 1 arrives; neither hand crosses the centre line', () => {
  for (const text of ['531', '441', '51', '71', '7131', '312', '1']) {
    const { pattern, timeline } = setup(text);
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (rec.value !== 1) continue;
      const giver = handState(timeline, rec.hand, rec.tThrow);
      const taker = handState(timeline, rec.toHand, rec.tCatch);
      near(Math.abs(giver.x), pattern.layout.xP, 1e-9, text + ': the giving hand is at its pass point');
      near(Math.abs(taker.x), pattern.layout.xP, 1e-9, text + ': the taking hand is at its pass point');
      assert.ok(giver.x * taker.x < 0, text + ': on opposite sides of the centre line');
      assert.equal(handState(timeline, rec.toHand, rec.tCatch - 1e-6).carrying, false, text + ': the taking hand is empty');
    }
    for (const hand of [RIGHT, LEFT]) {
      const side = hand === RIGHT ? 1 : -1;
      for (const p of handPath(timeline, hand, 800)) assert.ok(p.x * side > 0, text + ': hand ' + hand + ' stays on its own side');
    }
  }
});

test('drawn scene: a held ball never overlaps another ball unless the pattern carries a collision warning', () => {
  // findCollisions covers balls in flight. This covers the rest of the picture: a ball in a
  // ghost hand against every other ball, held or flying.
  for (const text of ['3', '4', '5', '6', '7', '531', '441', '456', '423', '51', '71', '7131', '552', '75', '97531', '312', '831', '52512', '1', '11', '501']) {
    const { pattern, timeline } = setup(text);
    const warned = findCollisions(pattern).collides;
    let min = Infinity;
    for (let k = 0; k < 6000; k++) {
      const s = sceneAt(pattern, timeline, (k / 6000) * pattern.cycleTime * 2);
      for (let a = 0; a < s.balls.length; a++) {
        for (let q = a + 1; q < s.balls.length; q++) {
          if (s.balls[a].air && s.balls[q].air) continue;
          min = Math.min(min, Math.hypot(s.balls[a].x - s.balls[q].x, s.balls[a].y - s.balls[q].y));
        }
      }
    }
    assert.ok(warned || min >= pattern.ballDiameter, text + ': a held ball comes within ' + min.toFixed(3) + ' m of another, with no warning');
  }
});

test('the draw loop can reuse the scene object: same picture, no new objects', () => {
  for (const text of ['3', '7', '531', '423', '42', '501']) {
    const { pattern, timeline } = setup(text);
    let scratch;
    for (let k = 0; k < 200; k++) {
      const t = ((k * 37) % 200) * 0.013 - 0.4;
      const fresh = sceneAt(pattern, timeline, t);
      const reused = sceneAt(pattern, timeline, t, scratch);
      if (scratch) assert.equal(reused, scratch, 'the same object comes back');
      scratch = reused;
      assert.equal(reused.balls.length, fresh.balls.length);
      for (let i = 0; i < fresh.balls.length; i++) {
        for (const key of ['ball', 'air', 'x', 'y', 'hand', 'value']) assert.equal(reused.balls[i][key], fresh.balls[i][key], text + ' ball ' + key);
      }
      for (const hand of [RIGHT, LEFT]) {
        for (const key of ['x', 'y', 'vx', 'vy', 'carrying', 'holding']) assert.equal(reused.hands[hand][key], fresh.hands[hand][key], text + ' hand ' + key);
      }
    }
  }
});
