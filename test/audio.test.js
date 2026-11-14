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

test('events are timed on the audio clock without the block jitter of currentTime', () => {
  // A fake audio context whose currentTime only moves in 128-sample blocks (2.9 ms at 44.1 kHz),
  // read from frames that arrive every 13.9 ms (72 Hz).
  const board = new SoundBoard();
  const block = 128 / 44100;
  const offset = 5.4321; // audio clock = page clock + offset
  let page = 0; // seconds
  board.ctx = {
    get currentTime() {
      return Math.floor((page + offset) / block) * block;
    },
    outputLatency: 0,
    baseLatency: 0,
  };
  const errors = [];
  for (let k = 0; k < 600; k++) {
    page = k / 72;
    const ahead = 0.1; // an event 100 ms in the future
    const when = board.timeFor((page + ahead) * 1000, page * 1000, 0);
    errors.push(when - (page + ahead + offset));
  }
  const settled = errors.slice(200);
  const spread = Math.max(...settled) - Math.min(...settled);
  assert.ok(spread < 0.0006, 'timing spread after warm-up: ' + (spread * 1000).toFixed(3) + ' ms');
  assert.ok(Math.abs(settled[0]) < block, 'never off by more than one block');
  // Reading currentTime directly would have jittered by a whole block.
  const naive = [];
  for (let k = 200; k < 600; k++) {
    page = k / 72;
    naive.push(board.ctx.currentTime + 0.1 - (page + 0.1 + offset));
  }
  assert.ok(Math.max(...naive) - Math.min(...naive) > block * 0.8);
});

test('reported output latency moves sounds earlier, but never past the allowed advance', () => {
  const board = new SoundBoard();
  board.ctx = { currentTime: 10, outputLatency: 0.03, baseLatency: 0.01 };
  const plain = board.timeFor(1000, 0, 0);
  const advanced = board.timeFor(1000, 0, 0.07);
  assert.ok(Math.abs(plain - advanced - 0.04) < 1e-9, 'moved 40 ms earlier');
  const capped = board.timeFor(1000, 0, 0.02);
  assert.ok(Math.abs(plain - capped - 0.02) < 1e-9, 'capped at the allowed 20 ms');
});

test('nothing plays and nothing throws before the browser has unlocked audio', () => {
  const board = new SoundBoard();
  assert.equal(board.running, false);
  board.play('catch', 0, 0, 0);
  board.cancelPending();
  assert.deepEqual(board.played, { catch: 0, release: 0, peak: 0 });
});
