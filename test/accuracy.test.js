/**
 * Throw colours: how a recording of the person's palm through one scoop is judged against the
 * ghost hand, and how the colours follow the balls (white in the hand, coloured in flight).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPattern, RIGHT, LEFT } from '../src/physics.js';
import { buildHandTimeline, handState, sceneAt, scoopWindow } from '../src/hands.js';
import { GRADE, THRESHOLDS, ThrowScorer, positionLimits, scoopLength, scoreThrow } from '../src/accuracy.js';

const FPS = 72; // a Quest 1

function setup(text) {
  const pattern = buildPattern(text);
  assert.ok(pattern.ok, text);
  return { pattern, timeline: buildHandTimeline(pattern) };
}

/** The first whole scoop of a hand after time `after`: { start, release }. */
function firstScoop(timeline, hand, after) {
  let t = after;
  // Step out of a scoop that is already under way, then into the next one.
  while (scoopWindow(timeline, hand, t).active) t += 0.001;
  while (!scoopWindow(timeline, hand, t).active) t += 0.001;
  const w = scoopWindow(timeline, hand, t);
  return { start: w.start, release: w.release };
}

/**
 * Record a made-up hand through one scoop at `fps` frames a second of real time and `speed`.
 * `where(t, ghostAt)` returns { x, y, z }, or null for a frame with no palm.
 */
function record(timeline, hand, scoop, where, options) {
  const o = options || {};
  const dt = (o.speed || 1) / (o.fps || FPS);
  const rec = { n: 0, seen: 0, missed: 0, t: [], x: [], y: [], z: [] };
  const ghostAt = (t) => handState(timeline, hand, t);
  for (let t = scoop.start + dt * 0.37; t < scoop.release; t += dt) {
    rec.seen++;
    const p = where(t, ghostAt);
    if (!p) {
      rec.missed++;
      continue;
    }
    rec.t.push(t);
    rec.x.push(p.x);
    rec.y.push(p.y);
    rec.z.push(p.z || 0);
    rec.n++;
  }
  return rec;
}

const follow = (lag, dx, dy, dz) => (t, ghostAt) => {
  const g = ghostAt(t - (lag || 0));
  return { x: g.x + (dx || 0), y: g.y + (dy || 0), z: dz || 0 };
};

function judge(text, where, options) {
  const { timeline } = setup(text);
  const hand = options && options.hand !== undefined ? options.hand : RIGHT;
  const scoop = firstScoop(timeline, hand, 0.01);
  const rec = record(timeline, hand, scoop, where, options);
  const result = scoreThrow(timeline, hand, scoop.start, scoop.release, rec);
  result.duration = scoop.release - scoop.start;
  return result;
}

test('the limits are in order, and documented values are what the code uses', () => {
  for (const key of ['position', 'positionFloor', 'timing', 'direction']) {
    assert.ok(THRESHOLDS[key].green > 0 && THRESHOLDS[key].green < THRESHOLDS[key].yellow, key);
  }
  assert.deepEqual(THRESHOLDS.position, { green: 0.15, yellow: 0.35 });
  assert.deepEqual(THRESHOLDS.positionFloor, { green: 0.04, yellow: 0.08 });
  assert.deepEqual(THRESHOLDS.timing, { green: 0.2, yellow: 0.4 });
  assert.deepEqual(THRESHOLDS.direction, { green: 35, yellow: 70 });
});

test('the scoop window is the carry up to the release, and a hand waiting before a hold is not in it', () => {
  for (const text of ['3', '5', '7', '531', '441']) {
    const { timeline } = setup(text);
    for (const hand of [RIGHT, LEFT]) {
      const scoop = firstScoop(timeline, hand, 0.01);
      assert.ok(scoop.release - scoop.start <= timeline.dwell + 1e-9, text + ': no longer than one dwell');
      assert.equal(handState(timeline, hand, (scoop.start + scoop.release) / 2).carrying, true, text);
      assert.equal(handState(timeline, hand, scoop.release + 1e-4).carrying, false, text + ': it ends at the release');
      assert.equal(scoopWindow(timeline, hand, scoop.release + 1e-4).active, false);
      // The same scoop one cycle later is reported in that later time.
      const later = scoopWindow(timeline, hand, (scoop.start + scoop.release) / 2 + 3 * timeline.cycleTime);
      assert.ok(Math.abs(later.release - (scoop.release + 3 * timeline.cycleTime)) < 1e-9);
    }
  }
  // 423: the hand holding the 2 stands still at the catch point first; that wait is not judged.
  const { timeline } = setup('423');
  let waited = 0;
  for (let t = 0; t < timeline.cycleTime; t += 0.002) {
    for (const hand of [RIGHT, LEFT]) {
      const h = handState(timeline, hand, t);
      if (h.carrying && !scoopWindow(timeline, hand, t).active) {
        waited++;
        assert.ok(Math.hypot(h.vx, h.vy) < 1e-9, 'outside the window a carrying hand is waiting, not moving');
      }
    }
  }
  assert.ok(waited > 10, 'the 2 is held for a while before its scoop starts');
});

test('the exact motion at the exact time is green, with nothing measured wrong', () => {
  for (const text of ['3', '4', '5', '7', '531', '441', '51', '423']) {
    for (const hand of [RIGHT, LEFT]) {
      const r = judge(text, follow(0), { hand });
      assert.equal(r.grade, GRADE.GREEN, text);
      assert.ok(r.position < 1e-4, text + ': position ' + r.position);
      assert.ok(Math.abs(r.lag) < 0.002, text + ': lag ' + r.lag);
      // (The direction is left out where the ghost hardly travels: the hand-across before a 1.)
      if (r.directionGrade === GRADE.NONE) assert.equal(r.angle, -1);
      else assert.ok(r.angle >= 0 && r.angle < 1, text + ': angle ' + r.angle);
      if (text.length === 1) assert.equal(r.directionGrade, GRADE.GREEN, text + ': cascades and fountains always have a direction');
    }
  }
});

test('timing: the same motion made late or early is measured, and graded by the scoop duration', () => {
  const d = judge('3', follow(0)).duration;
  for (const sign of [1, -1]) {
    const small = judge('3', follow(sign * 0.1 * d));
    assert.ok(Math.abs(small.lag - sign * 0.1 * d) < 0.01 * d, 'lag found: ' + small.lag);
    assert.equal(small.timingGrade, GRADE.GREEN);
    assert.equal(small.grade, GRADE.GREEN);

    const medium = judge('3', follow(sign * 0.3 * d));
    assert.ok(Math.abs(medium.lag - sign * 0.3 * d) < 0.01 * d, 'lag found: ' + medium.lag);
    assert.equal(medium.timingGrade, GRADE.YELLOW);
    assert.equal(medium.positionGrade, GRADE.GREEN, 'the path itself was right');
    assert.equal(medium.grade, GRADE.YELLOW);

    const large = judge('3', follow(sign * 0.5 * d));
    assert.equal(large.timingGrade, GRADE.RED);
    assert.equal(large.grade, GRADE.RED);
  }
  // Beyond what the search covers it is still red, never mistaken for on time.
  assert.equal(judge('3', follow(0.9 * d)).grade, GRADE.RED);
});

test('position: a hand beside the path is graded against the length of the scoop', () => {
  const { timeline } = setup('3');
  const scoop = firstScoop(timeline, RIGHT, 0.01);
  const length = scoopLength(timeline, RIGHT, scoop.start, scoop.release);
  assert.ok(length > 0.25 && length < 0.45, '3-ball scoop is about a third of a metre: ' + length);
  const limits = positionLimits(length);
  assert.ok(Math.abs(limits.green - 0.15 * length) < 1e-12 && Math.abs(limits.yellow - 0.35 * length) < 1e-12);

  const near = judge('3', follow(0, 0, 0.8 * limits.green));
  assert.ok(Math.abs(near.position - 0.8 * limits.green) < 0.004, 'measures the offset: ' + near.position);
  assert.equal(near.grade, GRADE.GREEN);
  const off = judge('3', follow(0, 0, 0.5 * (limits.green + limits.yellow)));
  assert.equal(off.positionGrade, GRADE.YELLOW);
  assert.equal(off.timingGrade, GRADE.GREEN, 'a sideways offset is not read as a timing error');
  assert.equal(off.grade, GRADE.YELLOW);
  const far = judge('3', follow(0, 0, 1.5 * limits.yellow));
  assert.equal(far.positionGrade, GRADE.RED);
  assert.equal(far.grade, GRADE.RED);
});

test('depth (nearer or farther from the body) counts half', () => {
  const r = judge('3', follow(0, 0, 0, 0.06));
  assert.ok(Math.abs(r.position - 0.03) < 1e-6, 'position ' + r.position);
  assert.equal(r.grade, GRADE.GREEN);
  assert.equal(judge('3', follow(0, 0, 0, 0.6)).grade, GRADE.RED);
});

test('the limits scale with the pattern: the same 7 cm is yellow in 3 balls and green in 7', () => {
  const three = judge('3', follow(0, 0.07, 0));
  const seven = judge('7', follow(0, 0.07, 0));
  assert.equal(three.grade, GRADE.YELLOW);
  assert.equal(seven.grade, GRADE.GREEN);
  assert.ok(seven.pathLength > 1.5 * three.pathLength);
  // A very small motion (the hand-across before a 1 in 31) is held to the floor, not to millimetres.
  const tiny = positionLimits(0.05);
  assert.deepEqual([tiny.green, tiny.yellow], [0.04, 0.08]);
});

test('a hand that does not make the motion is red', () => {
  const { timeline } = setup('3');
  const scoop = firstScoop(timeline, RIGHT, 0.01);
  const catchAt = handState(timeline, RIGHT, scoop.start);
  const releaseAt = handState(timeline, RIGHT, scoop.release - 1e-6);
  // Held still at the catch point, at the release point, and hanging by the person's side.
  const stillCatch = judge('3', () => ({ x: catchAt.x, y: catchAt.y, z: 0 }));
  assert.equal(stillCatch.grade, GRADE.RED);
  assert.equal(stillCatch.angle, -1, 'a still hand has no direction');
  assert.equal(stillCatch.directionGrade, GRADE.RED, 'and made no throwing motion');
  assert.equal(judge('3', () => ({ x: releaseAt.x, y: releaseAt.y, z: 0 })).grade, GRADE.RED);
  assert.equal(judge('3', () => ({ x: 0.3, y: -0.25, z: 0.3 })).grade, GRADE.RED);
  // The scoop run backwards (from the release point to the catch point).
  const backwards = judge('3', (t, ghostAt) => {
    const g = ghostAt(scoop.start + scoop.release - t);
    return { x: g.x, y: g.y, z: 0 };
  });
  assert.equal(backwards.grade, GRADE.RED);
});

test('direction: on the path until the end, then pushed out sideways instead of up and in', () => {
  const { timeline } = setup('3');
  const scoop = firstScoop(timeline, RIGHT, 0.01);
  const d = scoop.release - scoop.start;
  const turn = scoop.release - 0.4 * d;
  const at = handState(timeline, RIGHT, turn);
  const end = handState(timeline, RIGHT, scoop.release - 1e-6);
  const travel = Math.hypot(end.x - at.x, end.y - at.y);
  const r = judge('3', (t, ghostAt) => {
    if (t <= turn) return ghostAt(t);
    const k = (t - turn) / (scoop.release - turn);
    return { x: at.x + travel * k, y: at.y, z: 0 }; // straight out to the side, level
  });
  assert.ok(r.angle > 70, 'angle ' + r.angle);
  assert.equal(r.directionGrade, GRADE.RED);
  assert.equal(r.grade, GRADE.RED);
  assert.notEqual(r.positionGrade, GRADE.RED, 'position alone would have let it pass');
});

test('a careful mimic at 0.5x is green: 80 ms behind, 2 cm off, 1.5 cm of wobble', () => {
  for (const text of ['3', '4', '5', '7', '531', '441']) {
    const { timeline } = setup(text);
    let green = 0;
    let total = 0;
    for (const hand of [RIGHT, LEFT]) {
      let after = 0.01;
      for (let i = 0; i < 6; i++) {
        const scoop = firstScoop(timeline, hand, after);
        after = scoop.release + 0.001;
        const reaction = 0.08 * 0.5; // 80 ms of real time at half speed, in pattern time
        const phase = i * 1.7 + hand;
        const rec = record(
          timeline,
          hand,
          scoop,
          (t, ghostAt) => {
            const g = ghostAt(t - reaction);
            return {
              x: g.x + 0.014 + 0.015 * Math.sin(31 * t + phase),
              y: g.y - 0.014 + 0.015 * Math.cos(23 * t + phase),
              z: 0.03 * Math.sin(17 * t + phase),
            };
          },
          { speed: 0.5 }
        );
        const r = scoreThrow(timeline, hand, scoop.start, scoop.release, rec);
        total++;
        if (r.grade === GRADE.GREEN) green++;
        assert.notEqual(r.grade, GRADE.RED, text);
        assert.notEqual(r.grade, GRADE.NONE, text);
      }
    }
    assert.ok(green >= 0.8 * total, text + ': ' + green + ' of ' + total + ' green');
  }
});

test('slow motion makes the timing easier: 80 ms late is yellow at full speed and green at 0.5x', () => {
  // The green window is a fraction of the scoop: 69 ms either way in the 3-ball cascade.
  assert.equal(judge('3', follow(0.06)).timingGrade, GRADE.GREEN);
  assert.equal(judge('3', follow(0.08)).timingGrade, GRADE.YELLOW);
  assert.equal(judge('3', follow(0.08 * 0.5), { speed: 0.5 }).timingGrade, GRADE.GREEN);
});

test('no colour without a tracked hand: too few samples, gaps, a late start or an early stop', () => {
  const { timeline } = setup('3');
  const scoop = firstScoop(timeline, RIGHT, 0.01);
  const d = scoop.release - scoop.start;
  const score = (where, options) => scoreThrow(timeline, RIGHT, scoop.start, scoop.release, record(timeline, RIGHT, scoop, where, options));
  assert.equal(score(() => null).grade, GRADE.NONE, 'never tracked');
  assert.equal(score(follow(0), { fps: 5 }).grade, GRADE.NONE, 'two samples are not a motion');
  let i = 0;
  assert.equal(score((t, g) => (i++ % 3 === 0 ? null : g(t))).grade, GRADE.NONE, 'a third of the frames missing');
  i = 0;
  assert.equal(score((t, g) => (i++ % 10 === 0 ? null : g(t))).grade, GRADE.GREEN, 'a dropped frame now and then is fine');
  // Tracked only from the middle of the scoop on (hand came into view late), or lost before the end.
  const late = record(timeline, RIGHT, scoop, (t, g) => (t < scoop.start + 0.5 * d ? null : g(t)));
  late.missed = 0;
  late.seen = late.n;
  assert.equal(scoreThrow(timeline, RIGHT, scoop.start, scoop.release, late).grade, GRADE.NONE);
  const early = record(timeline, RIGHT, scoop, (t, g) => (t > scoop.start + 0.5 * d ? null : g(t)));
  early.missed = 0;
  early.seen = early.n;
  assert.equal(scoreThrow(timeline, RIGHT, scoop.start, scoop.release, early).grade, GRADE.NONE);
});

// ---------------------------------------------------------------------------------------------
// The scorer, driven frame by frame as the page drives it
// ---------------------------------------------------------------------------------------------

/**
 * Run the scorer for `seconds` of real time. `palmFor(hand, t, ghost)` gives the palm of each
 * hand, or null. Calls `each(scene, scorer, t)` after every frame.
 */
function run(text, palmFor, each, options) {
  const o = options || {};
  const { pattern, timeline } = setup(text);
  const scorer = o.scorer || new ThrowScorer();
  scorer.setPattern(pattern, timeline);
  const palms = [
    { tracked: false, x: 0, y: 0, z: 0 },
    { tracked: false, x: 0, y: 0, z: 0 },
  ];
  const speed = o.speed || 1;
  const dt = speed / (o.fps || FPS);
  let scene;
  const end = (o.seconds || 4) * speed;
  for (let t = o.from || 0; t < (o.from || 0) + end; t += dt) {
    scene = sceneAt(pattern, timeline, t, scene);
    for (const hand of [RIGHT, LEFT]) {
      const p = palmFor(hand, t, scene.hands[hand]);
      palms[hand].tracked = !!p;
      if (p) Object.assign(palms[hand], { x: p.x, y: p.y, z: p.z || 0 });
    }
    scorer.step(scene, t, palms);
    if (each) each(scene, scorer, t);
  }
  return scorer;
}

function tally(text, palmFor, options) {
  const counts = { air: [0, 0, 0, 0], held: [0, 0, 0, 0], throws: 0 };
  const scorer = run(
    text,
    palmFor,
    (scene, s) => {
      for (const b of scene.balls) counts[b.air ? 'air' : 'held'][s.grades[b.ball]]++;
    },
    options
  );
  counts.throws = scorer.last[RIGHT].count + scorer.last[LEFT].count;
  return counts;
}

test('hands on the ghosts: every ball is green from its release to its catch, and white in the hand', () => {
  for (const text of ['3', '4', '5', '7', '531', '441', '423', '51']) {
    const { pattern, timeline } = setup(text);
    const watched = new Set(); // balls seen leaving a hand after the first scoops (which began before we looked)
    const wasHeld = new Set();
    let greenFrames = 0;
    const scorer = run(text, (hand, t, ghost) => ghost, (scene, s, t) => {
      for (const b of scene.balls) {
        const grade = s.grades[b.ball];
        if (!b.air) {
          assert.equal(grade, GRADE.NONE, text + ': a held ball is white');
          watched.delete(b.ball);
          if (t > pattern.dwell + pattern.beat) wasHeld.add(b.ball);
        } else {
          if (wasHeld.delete(b.ball)) watched.add(b.ball);
          if (watched.has(b.ball)) {
            assert.equal(grade, GRADE.GREEN, text + ': a ball in flight after a perfect scoop is green');
            greenFrames++;
          }
        }
      }
    });
    assert.ok(scorer.last[RIGHT].count > 3 && scorer.last[LEFT].count > 3, text + ': throws were judged');
    assert.ok(greenFrames > 50, text + ': green balls were seen in flight (' + greenFrames + ')');
  }
});

test('the colour is set at the release and does not change in flight', () => {
  // The right hand follows its ghost; the left hangs by the side. Each ball keeps the colour of
  // the hand that threw it until it is caught, whatever the hands do meanwhile.
  const { pattern, timeline } = setup('3');
  assert.ok(pattern.ok);
  const thrownBy = new Map();
  let seen = { green: 0, red: 0 };
  let before = null;
  run('3', (hand, t, ghost) => (hand === RIGHT ? ghost : { x: -0.3, y: -0.3, z: 0.2 }), (scene, s, t) => {
    if (t < timeline.cycleTime + pattern.dwell) return;
    for (const b of scene.balls) {
      const was = before && before[b.ball];
      if (b.air && was && !was.air) thrownBy.set(b.ball, was.hand);
      if (b.air && thrownBy.has(b.ball)) {
        const want = thrownBy.get(b.ball) === RIGHT ? GRADE.GREEN : GRADE.RED;
        assert.equal(s.grades[b.ball], want, 'ball ' + b.ball + ' thrown by hand ' + thrownBy.get(b.ball));
        seen[want === GRADE.GREEN ? 'green' : 'red']++;
      }
      if (!b.air) assert.equal(s.grades[b.ball], GRADE.NONE);
    }
    before = scene.balls.map((b) => ({ air: b.air, hand: b.hand }));
  });
  assert.ok(seen.green > 20 && seen.red > 20, JSON.stringify(seen));
});

test('no tracked hand, no colour: every ball stays white', () => {
  const c = tally('5', () => null);
  assert.deepEqual(c.air.slice(1), [0, 0, 0]);
  assert.deepEqual(c.held.slice(1), [0, 0, 0]);
  assert.ok(c.throws > 10, 'the throws were looked at and left white');
  // One controller lost: that hand's throws are white, the other hand's are still judged.
  const one = tally('3', (hand, t, ghost) => (hand === RIGHT ? ghost : null));
  assert.ok(one.air[GRADE.GREEN] > 20 && one.air[GRADE.NONE] > 20, JSON.stringify(one.air));
  assert.equal(one.air[GRADE.RED] + one.air[GRADE.YELLOW], 0);
});

test('a hand that loses tracking mid-flight does not recolour a ball already thrown', () => {
  const { timeline } = setup('3');
  const cut = 6 * timeline.cycleTime + 0.01;
  let greenAfter = 0;
  run('3', (hand, t, ghost) => (t < cut ? ghost : null), (scene, s, t) => {
    if (t > cut && t < cut + 0.05) for (const b of scene.balls) if (b.air && s.grades[b.ball] === GRADE.GREEN) greenAfter++;
  });
  assert.ok(greenAfter > 0, 'the ball in the air at the moment tracking stopped is still green');
});

test('very slow motion (0.1x, hundreds of frames a scoop) is judged the same from a fixed-size recording', () => {
  for (const text of ['3', '7']) {
    const good = tally(text, (hand, t, ghost) => ghost, { speed: 0.1, seconds: 30 });
    assert.ok(good.air[GRADE.GREEN] > 100, JSON.stringify(good.air));
    assert.equal(good.air[GRADE.YELLOW] + good.air[GRADE.RED], 0);
    const bad = tally(text, () => ({ x: 0, y: 0.4, z: 0 }), { speed: 0.1, seconds: 30 });
    assert.ok(bad.air[GRADE.RED] > 100, JSON.stringify(bad.air));
    assert.equal(bad.air[GRADE.GREEN] + bad.air[GRADE.YELLOW], 0);
  }
});

test('a headset that drops to 30 frames a second still gets colours at full speed', () => {
  const c = tally('7', (hand, t, ghost) => ghost, { fps: 30 });
  assert.ok(c.air[GRADE.GREEN] > 50, JSON.stringify(c.air));
  assert.equal(c.air[GRADE.RED] + c.air[GRADE.YELLOW], 0);
});

test('changing the pattern, or clearing, makes every ball white again; a jump in time drops the half-made recording', () => {
  const scorer = run('5', () => ({ x: 0, y: 0.5, z: 0 }), null, { seconds: 2 });
  assert.ok(scorer.coloured && scorer.grades.some((g) => g === GRADE.RED));
  scorer.clear();
  assert.ok(!scorer.coloured && scorer.grades.every((g) => g === GRADE.NONE));
  run('5', () => ({ x: 0, y: 0.5, z: 0 }), null, { seconds: 2, scorer });
  assert.ok(scorer.coloured);
  const { pattern, timeline } = setup('3');
  scorer.setPattern(pattern, timeline);
  assert.ok(!scorer.coloured && scorer.grades.every((g) => g === GRADE.NONE));

  // A jump (a hidden tab coming back): the scoop under way is not judged from two halves.
  const s = new ThrowScorer();
  s.setPattern(pattern, timeline);
  const palms = [{ tracked: true, x: 0, y: 0, z: 0 }, { tracked: true, x: 0, y: 0, z: 0 }];
  const scoop = firstScoop(timeline, RIGHT, 0.01);
  const mid = (scoop.start + scoop.release) / 2;
  s.step(sceneAt(pattern, timeline, mid), mid, palms);
  assert.equal(s.hands[RIGHT].active, true);
  const far = mid + 5 * timeline.cycleTime + 0.02;
  s.step(sceneAt(pattern, timeline, far), far, palms);
  assert.equal(s.last[RIGHT].count, 0, 'nothing was judged across the jump');
  assert.equal(s.hands[RIGHT].n, 1, 'recording starts again');
});

test('display time that steps back a hair over a release does not lose the colour', () => {
  // A headset predicts when each frame will be shown; the prediction wobbles by a millisecond.
  for (const text of ['3', '4', '423']) {
    const { pattern, timeline } = setup(text);
    const scorer = new ThrowScorer();
    scorer.setPattern(pattern, timeline);
    const palms = [{ tracked: true, x: 0, y: 0, z: 0 }, { tracked: true, x: 0, y: 0, z: 0 }];
    let scene;
    let frame = 0;
    const wasHeld = new Set();
    const watched = new Set();
    let green = 0;
    for (let clock = 0; clock < 4; clock += 1 / FPS, frame++) {
      const t = clock + (frame % 2 ? 0.004 : 0) + 0.003 * Math.sin(frame * 1.3); // steps back often
      scene = sceneAt(pattern, timeline, t, scene);
      for (const hand of [RIGHT, LEFT]) Object.assign(palms[hand], { x: scene.hands[hand].x, y: scene.hands[hand].y });
      scorer.step(scene, t, palms);
      for (const b of scene.balls) {
        if (!b.air) {
          if (clock > 1 && !watched.has(b.ball)) assert.equal(scorer.grades[b.ball], GRADE.NONE, text + ': white in the hand');
          if (clock > 1) wasHeld.add(b.ball);
          // (Within a few ms of its release a ball can be back in the hand, already coloured.)
        } else if (wasHeld.has(b.ball)) {
          watched.add(b.ball);
          assert.equal(scorer.grades[b.ball], GRADE.GREEN, text + ': green in flight at ' + t);
          green++;
        }
      }
      for (const b of scene.balls) {
        // A ball that has been in the air for a while and is held again has been caught.
        if (!b.air && watched.has(b.ball) && scorer.grades[b.ball] === GRADE.NONE) {
          watched.delete(b.ball);
          wasHeld.add(b.ball);
        }
      }
    }
    assert.ok(green > 50, text + ': ' + green);
  }
});

test('a ball caught for a hold (a 2) is white while it waits, also in the hand that threw it', () => {
  const { pattern, timeline } = setup('423');
  let waits = 0;
  run('423', (hand, t, ghost) => ghost, (scene, s) => {
    for (const b of scene.balls) {
      if (!b.air) {
        assert.equal(s.grades[b.ball], GRADE.NONE);
        if (!scoopWindow(timeline, b.hand, s.lastT).active) waits++;
      }
    }
  });
  assert.ok(pattern.ok && waits > 20);
});

test('the frame loop makes no garbage: the recordings are fixed arrays that are reused', () => {
  const scorer = new ThrowScorer();
  const arrays = scorer.hands.map((h) => [h.t, h.x, h.y, h.z]);
  const results = scorer.last.slice();
  run('7', (hand, t, ghost) => ghost, null, { scorer, speed: 0.1, seconds: 20 });
  const grades = scorer.grades;
  run('7', (hand, t, ghost) => ghost, null, { scorer, seconds: 2 });
  assert.equal(scorer.grades, grades, 'the same pattern size keeps the same grade array');
  scorer.hands.forEach((h, i) => {
    assert.deepEqual([h.t, h.x, h.y, h.z].map((a, k) => a === arrays[i][k]), [true, true, true, true]);
    assert.ok(h.n <= 64);
  });
  assert.ok(scorer.last[0] === results[0] && scorer.last[1] === results[1]);
});
