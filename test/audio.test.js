import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPattern } from '../src/physics.js';
import { SoundBoard, DEFAULT_SOUND, SOUND_TYPES, peakFrequency, effectiveVolume } from '../src/audio.js';

const copy = (o) => JSON.parse(JSON.stringify(o));

test('three sounds, each with its own volume; release is on and quieter than catch by default', () => {
  assert.deepEqual(SOUND_TYPES, ['catch', 'release', 'peak']);
  assert.equal(DEFAULT_SOUND.catch.on, true);
  assert.equal(DEFAULT_SOUND.release.on, true);
  assert.ok(DEFAULT_SOUND.release.volume < DEFAULT_SOUND.catch.volume);
  for (const type of SOUND_TYPES) assert.equal(DEFAULT_SOUND[type].solo, false);
});

test('mute silences one sound and leaves the others alone', () => {
  const s = copy(DEFAULT_SOUND);
  s.catch.on = false;
  assert.equal(effectiveVolume(s, 'catch'), 0);
  assert.equal(effectiveVolume(s, 'release'), s.release.volume);
  assert.equal(effectiveVolume(s, 'peak'), s.peak.volume);
});

test('solo release mutes the catches so the ear can train on the release', () => {
  const s = copy(DEFAULT_SOUND);
  s.release.solo = true;
  assert.equal(effectiveVolume(s, 'release'), s.release.volume);
  assert.equal(effectiveVolume(s, 'catch'), 0);
  assert.equal(effectiveVolume(s, 'peak'), 0);
  // Solo wins over mute on the soloed sound.
  s.release.on = false;
  assert.equal(effectiveVolume(s, 'release'), s.release.volume);
});

test('peak pitch follows throw height: a 5 sounds higher than a 3, a 3 higher than a 1', () => {
  const p = buildPattern('531');
  const hz = [5, 3, 1].map((v) => peakFrequency(p.heightByValue[v]));
  assert.ok(hz[0] > hz[1] && hz[1] > hz[2], hz.join(' > '));
  // The pitch depends on the real height, so the same throw value at a slower tempo sounds higher.
  const slow3 = buildPattern('3').heightByValue[3];
  assert.ok(peakFrequency(slow3) > hz[1]);
  // Monotonic and inside the range small speakers can play.
  let last = 0;
  for (let h = 0; h <= 4; h += 0.05) {
    const f = peakFrequency(h);
    assert.ok(f > last);
    assert.ok(f >= 220 && f < 1200);
    last = f;
  }
  // Even steps in throw value (3 and up) are even steps in pitch, because flight time goes with
  // the square root of height.
  const big = buildPattern('97531');
  const steps = [9, 7, 5].map((v) => peakFrequency(big.heightByValue[v]) - peakFrequency(big.heightByValue[v - 2]));
  assert.ok(Math.max(...steps) / Math.min(...steps) < 1.001, 'steps: ' + steps.map((x) => x.toFixed(1)).join(', '));
});

/** Run `seconds` of 72 Hz frames; returns timeFor(100 ms ahead) minus `ideal(page)` per frame. */
function runFrames(board, clock, seconds, maxAdvance, ideal) {
  const out = [];
  const frames = Math.round(seconds * 72);
  for (let k = 0; k < frames; k++) {
    clock.page += 1 / 72;
    const target = clock.page + 0.1;
    out.push(board.timeFor(target * 1000, clock.page * 1000, maxAdvance) - ideal(target));
  }
  return out;
}
const spreadOf = (a) => Math.max(...a) - Math.min(...a);

test('events are timed on the audio clock without the block jitter of currentTime', () => {
  // A fake audio context whose currentTime only moves in 10 ms device buffers, read from frames
  // that arrive every 13.9 ms (72 Hz).
  const board = new SoundBoard();
  const block = 0.01;
  const offset = 5.4321; // audio clock = page clock + offset
  const clock = { page: 0 };
  const raw = () => Math.floor((clock.page + offset) / block) * block;
  board.ctx = {
    get currentTime() {
      return raw();
    },
    outputLatency: 0,
    baseLatency: 0,
  };
  runFrames(board, clock, 4, 0, (t) => t + offset); // settle
  const errors = runFrames(board, clock, 6, 0, (t) => t + offset);
  assert.equal(board.clock, 'currentTime');
  assert.ok(spreadOf(errors) < 0.0005, 'timing spread: ' + (spreadOf(errors) * 1000).toFixed(3) + ' ms');
  assert.ok(Math.abs(errors[0]) < block, 'off by a constant of less than one block');
  // Reading currentTime directly would have jittered by nearly a whole block.
  const naive = [];
  for (let k = 0; k < 400; k++) {
    clock.page += 1 / 72;
    naive.push(raw() - (clock.page + offset));
  }
  assert.ok(spreadOf(naive) > block * 0.8);
});

test('a jump in the audio clock is absorbed gradually, not in one beat', () => {
  const board = new SoundBoard();
  const clock = { page: 0 };
  let offset = 1;
  board.ctx = {
    get currentTime() {
      return clock.page + offset;
    },
  };
  runFrames(board, clock, 5, 0, (t) => t + offset);
  offset += 0.004; // the device clock slips 4 ms
  const after = runFrames(board, clock, 0.275, 0, (t) => t + offset - 0.004); // one beat later
  const moved = after[after.length - 1];
  assert.ok(moved > 0 && moved < 0.001, 'one beat absorbs only ' + (moved * 1000).toFixed(2) + ' ms of a 4 ms slip');
  // ...but it does get there, so sound and picture stay together.
  const later = runFrames(board, clock, 8, 0, (t) => t + offset);
  assert.ok(Math.abs(later[later.length - 1]) < 0.0001);
});

test('with a believable output timestamp, sounds are heard on time: latency is compensated', () => {
  // Fake context: the render clock jumps in 10 ms device buffers and runs 35 ms ahead of what
  // is at the speaker. getOutputTimestamp reports a consistent pair, refreshed once per buffer.
  const board = new SoundBoard();
  const buffer = 0.01;
  const latency = 0.035;
  const offset = 2.5; // audio time at the speaker = page time + offset
  const clock = { page: 1 };
  board.ctx = {
    get currentTime() {
      return Math.floor((clock.page + offset + latency) / buffer) * buffer;
    },
    getOutputTimestamp() {
      const stale = Math.floor(clock.page / buffer) * buffer; // slightly old, but a true pair
      return { contextTime: stale + offset, performanceTime: stale * 1000 };
    },
  };
  runFrames(board, clock, 4, 0.15, (t) => t + offset);
  const onTime = runFrames(board, clock, 5, 0.15, (t) => t + offset);
  assert.equal(board.clock, 'output timestamp');
  assert.ok(Math.max(...onTime.map(Math.abs)) < 1e-6, 'heard on time: ' + Math.max(...onTime.map(Math.abs)));
  assert.ok(Math.abs(board.latency - latency) < buffer, 'latency estimate ' + (board.latency * 1000).toFixed(1) + ' ms');

  // With no room to advance, it is late by about the latency, but still perfectly even.
  const late = runFrames(board, clock, 5, 0, (t) => t + offset);
  assert.ok(spreadOf(late) < 0.0005, 'even to within ' + (spreadOf(late) * 1000).toFixed(3) + ' ms');
  assert.ok(Math.abs(late[late.length - 1] - latency) < buffer, 'a constant delay of about the latency');
});

test('stale or wild output timestamps are ignored, and a lone glitch does not move the schedule', () => {
  const board = new SoundBoard();
  const clock = { page: 10 };
  const good = () => ({ contextTime: clock.page + 3 - 0.03, performanceTime: clock.page * 1000 });
  let stamp = () => ({ contextTime: 0, performanceTime: 1 }); // what browsers return at start-up
  board.ctx = {
    get currentTime() {
      return clock.page + 3;
    },
    getOutputTimestamp: () => stamp(),
  };
  runFrames(board, clock, 0.5, 0.15, (t) => t);
  assert.equal(board.clock, 'currentTime', 'a stale stamp is not used');

  stamp = good;
  const steady = runFrames(board, clock, 4, 0.15, (t) => t + 3 - 0.03);
  assert.equal(board.clock, 'output timestamp');
  assert.ok(Math.abs(steady[steady.length - 1]) < 1e-6);

  // One frame with a stamp that is 40 ms off: nothing moves.
  stamp = () => ({ contextTime: clock.page + 3 - 0.03 + 0.04, performanceTime: clock.page * 1000 });
  const glitch = runFrames(board, clock, 1 / 72, 0.15, (t) => t + 3 - 0.03);
  assert.ok(Math.abs(glitch[0]) < 1e-6, 'glitch moved the schedule by ' + glitch[0]);
  stamp = good;
  assert.ok(Math.abs(runFrames(board, clock, 0.2, 0.15, (t) => t + 3 - 0.03).pop()) < 1e-6);
});

test('without output timestamps the reported latency is used, never past the allowed advance', () => {
  const make = () => {
    const board = new SoundBoard();
    board.ctx = { currentTime: 10, outputLatency: 0.03, baseLatency: 0.01 };
    return board;
  };
  const plain = make().timeFor(1000, 0, 0);
  const advanced = make().timeFor(1000, 0, 0.07);
  assert.ok(Math.abs(plain - advanced - 0.04) < 1e-9, 'moved 40 ms earlier');
  const capped = make().timeFor(1000, 0, 0.02);
  assert.ok(Math.abs(plain - capped - 0.02) < 1e-9, 'capped at the allowed 20 ms');
});

test('nothing plays and nothing throws before the browser has unlocked audio', () => {
  const board = new SoundBoard();
  assert.equal(board.running, false);
  board.play('catch', 0, 0, 0);
  board.cancelPending();
  assert.deepEqual(board.played, { catch: 0, release: 0, peak: 0 });
});
