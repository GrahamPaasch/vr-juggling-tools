import test from 'node:test';
import assert from 'node:assert/strict';

import { G, buildPattern, eventsBetween, throwAtBeat, flightState } from '../src/physics.js';
import { buildHandTimeline, sceneAt } from '../src/hands.js';
import { advanceClock, clampSpeed, SoundSchedule } from '../src/schedule.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );

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

// ---------------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------------

test('the clock: simulation time advances by real time x speed, and by nothing else', () => {
  assert.equal(advanceClock(10, 0.5, 1), 10.5);
  assert.equal(advanceClock(10, 0.5, 0.5), 10.25);
  assert.equal(advanceClock(10, 0, 0.5), 10);
  // Four real seconds at 0.25x are one simulated second, whatever the frame rate.
  for (const fps of [30, 72, 90, 144]) {
    let sim = 0;
    for (let k = 0; k < 4 * fps; k++) sim = advanceClock(sim, 1 / fps, 0.25);
    near(sim, 1, 1e-9, fps + ' frames a second');
  }
});

test('the speeds on offer run from 0.1x to real speed, never faster', () => {
  assert.equal(clampSpeed(1), 1);
  assert.equal(clampSpeed(0.5), 0.5);
  assert.equal(clampSpeed(0.254), 0.25);
  assert.equal(clampSpeed(3), 1);
  assert.equal(clampSpeed(0), 0.1);
  assert.equal(clampSpeed(-1), 0.1);
  assert.equal(clampSpeed('0.75'), 0.75);
  assert.equal(clampSpeed(NaN), 1, 'nonsense means real speed');
  assert.equal(clampSpeed(undefined), 1);
});

test('slow motion is a clock change only: the picture at 0.25x is the same picture, later', () => {
  const pattern = buildPattern('531');
  const timeline = buildHandTimeline(pattern);
  // Run the frame loop the way main.js does, at real speed and at quarter speed.
  const run = (speed, realSeconds) => {
    let sim = 0;
    const seen = [];
    for (let k = 0; k < Math.round(realSeconds * 72); k++) {
      sim = advanceClock(sim, 1 / 72, speed);
      seen.push(sim);
    }
    return seen;
  };
  const slow = run(0.25, 8);
  const real = run(1, 2);
  near(slow[slow.length - 1], real[real.length - 1], 1e-9, 'four times as long covers the same stretch of the pattern');
  // The highest point any ball reaches is the height of the 5, at either speed.
  const top = (times) => {
    let y = 0;
    for (const t of times) for (const b of sceneAt(pattern, timeline, t).balls) y = Math.max(y, b.y);
    return y;
  };
  near(top(slow), pattern.heightByValue[5], 2e-4, 'peak seen at 0.25x');
  near(top(real), pattern.heightByValue[5], 3e-3, 'peak seen at real speed (coarser sampling)');
  // Every instant shown in slow motion is an instant of the same model: the picture at a given
  // simulated time does not know the speed.
  const at = sceneAt(pattern, timeline, slow[100]);
  const again = sceneAt(pattern, timeline, slow[100]);
  assert.deepEqual(at.balls, again.balls);
  // And a ball's acceleration in simulated time is g: gravity is never scaled.
  const rec = throwAtBeat(pattern, 0);
  const h = 1e-3;
  const mid = rec.tThrow + rec.flight / 2;
  const a = (flightState(rec, mid + h).y - 2 * flightState(rec, mid).y + flightState(rec, mid - h).y) / (h * h);
  near(a, -G, 1e-6, 'acceleration');
  assert.equal(G, 9.81);
});

// ---------------------------------------------------------------------------------------------
// Which sounds are due
// ---------------------------------------------------------------------------------------------

// One event: which sound, of which throw. (Two throws can peak at the very same instant, as the 5
// and the 3 of 531 do, so the time alone would not tell events apart.)
const key = (e) => e.type + ' of beat ' + e.beat;

test('sound schedule: an untouched run hands every event over exactly once, in order, ahead of time', () => {
  for (const text of ['3', '531', '7', '441', '501']) {
    const pattern = buildPattern(text);
    const schedule = new SoundSchedule(0.2);
    let sim = 0;
    schedule.restart(sim, -Infinity);
    const handed = [];
    for (let k = 0; k < 72 * 6; k++) {
      sim = advanceClock(sim, 1 / 72, 1);
      for (const e of schedule.due(pattern, sim, 1)) {
        assert.ok(e.time > sim - 1e-9, text + ': handed over before its moment');
        assert.ok(e.time <= sim + 0.2 + 1e-9, text + ': and not further ahead than the look-ahead');
        handed.push(e);
      }
    }
    const expected = eventsBetween(pattern, 0, sim + 0.2);
    assert.deepEqual(handed.map(key), expected.map(key), text);
  }
});

test('sound schedule: most frames return at once, without looking at the pattern', () => {
  const pattern = buildPattern('7');
  let scans = 0;
  const watched = new Proxy(pattern, {
    get(target, property) {
      if (property === 'maxThrow') scans++; // eventsBetween reads this once per scan
      return target[property];
    },
  });
  const schedule = new SoundSchedule(0.2);
  schedule.restart(0, -Infinity);
  let sim = 0;
  let events = 0;
  const frames = 72 * 10;
  for (let k = 0; k < frames; k++) {
    sim = advanceClock(sim, 1 / 72, 1);
    events += schedule.due(watched, sim, 1).length;
  }
  assert.ok(events > 120, 'events handed over: ' + events);
  // 7 balls make 14 or so events a second; the look-ahead bound lets most of the 72 frames skip.
  assert.ok(scans < frames * 0.5, scans + ' scans in ' + frames + ' frames');
  assert.ok(scans <= events + 2, 'no more scans than events (' + scans + ' for ' + events + ')');
});

/**
 * A stand-in for the sound board: it schedules each sound early by the output latency, and like
 * the real one it can only take back sounds that have not started.
 */
class FakeBoard {
  constructor(latency) {
    this.latency = latency;
    this.all = [];
    this.pending = [];
  }
  play(e, sim, speed, now) {
    const item = { key: key(e), sim: e.time, when: Math.max(now + (e.time - sim) / speed - this.latency, now + 0.001), cancelled: false };
    this.all.push(item);
    this.pending.push(item);
  }
  cancelPending(now) {
    let kept = -Infinity;
    for (const p of this.pending) {
      if (p.when > now + 0.005) p.cancelled = true;
      else if (p.sim > kept) kept = p.sim;
    }
    this.pending = [];
    return kept;
  }
  heard() {
    return this.all.filter((p) => !p.cancelled);
  }
}

test('sound schedule: changing the speed never makes a sound play twice, and never loses one', () => {
  // The bug this guards against: sounds are handed over early by the output latency (50 ms or
  // so). On a speed change the ones that had started could not be cancelled, and the schedule
  // used to rewind to "now" and hand them over a second time.
  const speeds = [1, 0.75, 0.5, 0.25, 0.1];
  for (const text of ['3', '531', '7']) {
    for (const latency of [0, 0.02, 0.05, 0.15]) {
      const random = rng(text.length * 1000 + Math.round(latency * 1000));
      const pattern = buildPattern(text);
      const schedule = new SoundSchedule(0.2);
      const board = new FakeBoard(latency);
      let sim = 0;
      let now = 0;
      let speed = 1;
      let changes = 0;
      schedule.restart(sim, -Infinity);
      for (let k = 0; k < 72 * 30; k++) {
        now += 1 / 72;
        sim = advanceClock(sim, 1 / 72, speed);
        // A drag on the speed slider: a burst of changes on consecutive frames, now and then.
        if (random() < (k % 300 < 40 ? 0.7 : 0.02)) {
          speed = speeds[Math.floor(random() * speeds.length)];
          schedule.restart(sim, board.cancelPending(now));
          changes++;
        }
        for (const e of schedule.due(pattern, sim, speed)) board.play(e, sim, speed, now);
      }
      assert.ok(changes > 100, 'speed changes: ' + changes);
      const heard = board.heard();
      const counts = new Map();
      for (const p of heard) counts.set(p.key, (counts.get(p.key) || 0) + 1);
      const doubled = Array.from(counts).filter(([, n]) => n > 1);
      assert.deepEqual(doubled, [], text + ', latency ' + latency + ': sounded twice');
      // Nothing lost either: everything up to the last horizon was heard exactly once.
      const expected = eventsBetween(pattern, 0, schedule.horizon).map(key);
      assert.deepEqual(Array.from(counts.keys()).sort(), expected.slice().sort(), text + ', latency ' + latency);
    }
  }
});

test('sound schedule: restart never goes back before a sound that has already started', () => {
  const pattern = buildPattern('3');
  const schedule = new SoundSchedule(0.2);
  schedule.restart(1.0, -Infinity);
  const first = schedule.due(pattern, 1.0, 1);
  assert.ok(first.length > 0);
  const kept = first[0].time; // say the first of them has started and cannot be taken back
  schedule.restart(1.0, kept);
  const again = schedule.due(pattern, 1.0, 1);
  assert.ok(again.every((e) => e.time > kept), 'nothing at or before the kept sound comes round again');
  assert.deepEqual(again.map(key), first.filter((e) => e.time > kept).map(key), 'everything after it does');
  // With nothing kept, a schedule starts from now.
  const plain = new SoundSchedule(0.2);
  plain.restart(1.0, -Infinity);
  assert.deepEqual(plain.due(pattern, 1.0, 1).map(key), first.map(key));
  // A kept time in the past changes nothing: the schedule never goes back before now.
  const fresh = new SoundSchedule(0.2);
  fresh.restart(1.0, 0.2);
  assert.deepEqual(fresh.due(pattern, 1.0, 1).map(key), first.map(key));
  // A started sound stays started through further restarts, for as long as it is ahead of the
  // clock: slow down right after it started, change again, and it must still not come round.
  const slow = new SoundSchedule(0.2);
  slow.restart(1.0, kept);
  slow.restart(1.0005, -Infinity); // a second change one slow frame later, nothing new had started
  assert.ok(kept > 1.0005, 'the started sound is still ahead of the clock');
  const after = slow.due(pattern, 1.0005, 1);
  assert.ok(after.length > 0 && after.every((e) => e.time > kept), 'it is not handed over again');
  slow.restart(kept + 0.001, -Infinity); // once the clock has passed it, it no longer matters
  assert.equal(slow.horizon, kept + 0.001);
});

test('sound schedule: after a stall, what was missed is skipped instead of played late in a burst', () => {
  const pattern = buildPattern('3');
  const schedule = new SoundSchedule(0.2);
  schedule.restart(0, -Infinity);
  let sim = 0;
  for (let k = 0; k < 72; k++) {
    sim = advanceClock(sim, 1 / 72, 1);
    schedule.due(pattern, sim, 1);
  }
  sim += 5; // the tab was hidden for five seconds
  const events = schedule.due(pattern, sim, 1);
  assert.ok(events.length > 0 && events.length < 6, 'only the next fifth of a second: ' + events.length);
  assert.ok(events.every((e) => e.time > sim - 0.02));
});
