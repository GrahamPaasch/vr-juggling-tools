import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPattern } from '../src/physics.js';
import { SoundBoard, DEFAULT_SOUND, BASE_LEVEL, SOUND_TYPES, peakFrequency, effectiveVolume, busGain } from '../src/audio.js';

const copy = (o) => JSON.parse(JSON.stringify(o));

test('three sounds, each with its own volume; release is on and quieter than catch by default', () => {
  assert.deepEqual(SOUND_TYPES, ['catch', 'release', 'peak']);
  assert.equal(DEFAULT_SOUND.catch.on, true);
  assert.equal(DEFAULT_SOUND.release.on, true);
  assert.ok(DEFAULT_SOUND.release.volume < DEFAULT_SOUND.catch.volume);
  for (const type of SOUND_TYPES) assert.equal(DEFAULT_SOUND[type].solo, false);
});

test('release is a little quieter than catch by default, and the two sliders mean the same thing', () => {
  // Slider to gain is a square law.
  assert.equal(busGain(DEFAULT_SOUND, 'catch'), 0.8 * 0.8);
  assert.equal(busGain(DEFAULT_SOUND, 'release'), 0.65 * 0.65);
  // The sliders alone put the release 3.6 dB under the catch (the two sounds are matched at
  // equal slider positions; the browser smoke test measures the rendered sounds).
  const sliderDb = 20 * Math.log10(busGain(DEFAULT_SOUND, 'release') / busGain(DEFAULT_SOUND, 'catch'));
  assert.ok(sliderDb < -3 && sliderDb > -6, 'default sliders: ' + sliderDb.toFixed(1) + ' dB');
  assert.deepEqual(BASE_LEVEL, { catch: 0.9, release: 0.78, peak: 0.32 });
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

test('a nonsense time is dropped instead of reaching the audio engine', () => {
  const board = new SoundBoard();
  board.ctx = { state: 'running', currentTime: 1 }; // any call into it would throw
  for (const when of [NaN, Infinity, -Infinity]) board.play('catch', when, 0, 0);
  assert.deepEqual(board.played, { catch: 0, release: 0, peak: 0 });
});

// ---------------------------------------------------------------------------------------------
// A stand-in audio context: enough of the Web Audio API to follow what the board builds
// ---------------------------------------------------------------------------------------------

function fakeContext() {
  const param = (value) => ({
    value,
    target: null,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime(v) {
      this.target = v;
      this.value = v; // the glide is a few milliseconds; the tests look at where it ends
    },
  });
  const node = (extra) =>
    Object.assign(
      {
        outputs: [],
        connected: true,
        connect(to) {
          this.outputs.push(to);
          return to;
        },
        disconnect() {
          this.connected = false;
        },
      },
      extra
    );
  const ctx = {
    state: 'running',
    currentTime: 100,
    sampleRate: 8000,
    destination: node({ name: 'destination' }),
    sources: [],
    createGain: () => node({ gain: param(1) }),
    createStereoPanner: () => node({ pan: param(0) }),
    createBiquadFilter: () => node({ type: '', frequency: param(0), Q: param(0) }),
    createDynamicsCompressor: () => node({ threshold: param(0), ratio: param(0), attack: param(0), release: param(0) }),
    createBuffer: (channels, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createOscillator() {
      const o = node({ type: '', frequency: param(0), started: null, stopped: null, start(t) { this.started = t; }, stop(t) { this.stopped = t === undefined ? 'now' : t; } });
      ctx.sources.push(o);
      return o;
    },
    createBufferSource() {
      const o = node({ buffer: null, started: null, stopped: null, start(t) { this.started = t; }, stop(t) { this.stopped = t === undefined ? 'now' : t; } });
      ctx.sources.push(o);
      return o;
    },
  };
  return ctx;
}

function boardOn(ctx) {
  const board = new SoundBoard();
  board.attach(ctx, { compressor: true });
  return board;
}

test('each sound type plays through its own gain: volume, mute and solo set that gain and schedule nothing', () => {
  const ctx = fakeContext();
  const board = boardOn(ctx);
  assert.deepEqual(Object.keys(board.bus).sort(), ['catch', 'peak', 'release']);
  for (const type of SOUND_TYPES) assert.equal(board.bus[type].gain.value, busGain(DEFAULT_SOUND, type), type + ' starts at its default');

  // Three sounds are on their way.
  assert.equal(board.play('catch', 100.05, 0.5, 0, 7.0), true);
  assert.equal(board.play('release', 100.06, -0.5, 0, 7.01), true);
  assert.equal(board.play('peak', 100.07, 0, 0.5, 7.02), true);
  const played = Object.assign({}, board.played);
  const sources = ctx.sources.length;
  const pending = board.pending.slice();
  // Every one of them reaches the master through its own bus.
  for (const p of pending) {
    let at = p.out;
    const path = [];
    while (at.outputs && at.outputs.length) {
      at = at.outputs[0];
      path.push(at);
    }
    assert.ok(path.includes(board.bus[p.type]), p.type + ' goes through its bus');
    assert.ok(path.includes(board.master));
    for (const other of SOUND_TYPES) if (other !== p.type) assert.ok(!path.includes(board.bus[other]));
  }

  // Volume.
  board.settings.catch.volume = 0.5;
  board.applySettings();
  assert.equal(board.bus.catch.gain.value, 0.25);
  assert.equal(board.bus.release.gain.value, busGain(DEFAULT_SOUND, 'release'), 'the others are untouched');
  // Mute.
  board.settings.peak.on = false;
  board.applySettings();
  assert.equal(board.bus.peak.gain.value, 0);
  // Solo release: catch and peak go silent, release keeps its own volume.
  board.settings.release.solo = true;
  board.applySettings();
  assert.equal(board.bus.catch.gain.value, 0);
  assert.equal(board.bus.peak.gain.value, 0);
  assert.equal(board.bus.release.gain.value, 0.65 * 0.65);
  board.settings.release.solo = false;
  board.settings.peak.on = true;
  board.applySettings();
  assert.equal(board.bus.catch.gain.value, 0.25);
  assert.equal(board.bus.peak.gain.value, busGain(DEFAULT_SOUND, 'peak'));

  // None of that scheduled, stopped or dropped anything: the sounds on their way are the same.
  assert.deepEqual(board.played, played);
  assert.equal(ctx.sources.length, sources);
  assert.deepEqual(board.pending, pending);
  assert.ok(ctx.sources.every((s) => s.stopped !== 'now'), 'nothing was cut off');
  assert.ok(pending.every((p) => p.out.connected));
});

test('a sound type that is silent right now is not scheduled at all', () => {
  const ctx = fakeContext();
  const board = boardOn(ctx);
  board.settings.catch.on = false;
  assert.equal(board.play('catch', 100.05, 0, 0, 1), false);
  board.settings.peak.volume = 0;
  assert.equal(board.play('peak', 100.05, 0, 1, 1), false);
  board.settings.release.solo = true;
  assert.equal(board.play('release', 100.05, 0, 0, 1), true);
  board.settings.catch.on = true;
  assert.equal(board.play('catch', 100.05, 0, 0, 1), false, 'another sound is soloed');
  assert.deepEqual(board.played, { catch: 0, release: 1, peak: 0 });
});

test('cancelPending takes back only what has not started, and reports the latest sound that has', () => {
  const ctx = fakeContext();
  const board = boardOn(ctx);
  // Scheduled early by the output latency: the first two have started (or are within 5 ms of
  // it) although their moments in the simulation, 7.00 and 7.03, may still be ahead.
  board.play('catch', 99.99, 0, 0, 7.0); // clamped to "now"
  board.play('release', 100.002, 0, 0, 7.03);
  board.play('peak', 100.05, 0, 1, 7.08);
  board.play('catch', 100.1, 0, 0, 7.13);
  const [a, b, c, d] = board.pending;
  const kept = board.cancelPending();
  assert.equal(kept, 7.03, 'the latest sound that could not be taken back');
  assert.ok(a.out.connected && b.out.connected, 'started sounds play on');
  assert.ok(a.sources.every((s) => s.stopped !== 'now') && b.sources.every((s) => s.stopped !== 'now'));
  assert.ok(!c.out.connected && !d.out.connected, 'sounds that had not started are disconnected');
  assert.deepEqual([a.cancelled, b.cancelled, c.cancelled, d.cancelled], [false, false, true, true]);
  assert.ok(c.sources.every((s) => s.stopped === 'now') && d.sources.every((s) => s.stopped === 'now'));
  assert.deepEqual(board.pending, []);
  // Nothing pending: nothing kept.
  assert.equal(board.cancelPending(), -Infinity);
  // A sound that has even finished still counts while its moment is ahead (a short release
  // with a long output latency).
  board.play('release', 100.001, 0, 0, 7.5);
  ctx.currentTime = 100.12; // the 80 ms sound is over; the latency was 150 ms
  assert.equal(board.cancelPending(), 7.5);
  // A sound scheduled without a simulation time never holds the schedule back.
  board.play('catch', 100.121, 0, 0);
  assert.equal(board.cancelPending(), -Infinity);
});

test('the list of pending sounds stays short without forgetting a sound whose moment is still ahead', () => {
  const ctx = fakeContext();
  const board = boardOn(ctx);
  // A long run with no change of speed: the list is trimmed as it goes.
  for (let k = 0; k < 500; k++) {
    ctx.currentTime = 100 + k * 0.05;
    board.play('catch', ctx.currentTime + 0.04, 0, 0, k);
    assert.ok(board.pending.length <= 65, 'pending: ' + board.pending.length);
  }
  board.cancelPending();

  // A release scheduled 150 ms early (a long output latency). It lasts 80 ms, so 100 ms later
  // it is over, with its moment in the simulation still 50 ms ahead.
  ctx.currentTime = 200;
  board.play('release', 200.001, 0, 0, 7.5);
  const release = board.pending[0];
  // Meanwhile a burst of later events is scheduled (enough to make the list trim itself).
  for (let k = 0; k < 70; k++) board.play('peak', 200.2 + k * 0.01, 0, 1, 8 + k);
  ctx.currentTime = 200.1;
  board.play('peak', 201, 0, 1, 99);
  assert.ok(release.end < ctx.currentTime, 'the release has ended');
  assert.ok(board.pending.includes(release), 'and is still on the list');
  // A change of speed now must be told about it, or it would be scheduled and heard again.
  assert.equal(board.cancelPending(), 7.5);
});

test('unlock waits for a real gesture: no audio context is made before the browser has seen one', () => {
  const real = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  let made = 0;
  let resumed = 0;
  const activation = { hasBeenActive: false, isActive: false };
  class Context {
    constructor() {
      made++;
      Object.assign(this, fakeContext(), { state: 'suspended' });
    }
    resume() {
      resumed++;
      this.state = 'running';
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: { userActivation: activation }, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { AudioContext: Context }, configurable: true });
  try {
    const board = new SoundBoard();
    // Escape, a modifier key, or the end of a scroll: an event, but not a gesture to the browser.
    assert.equal(board.unlock(), false);
    assert.equal(made, 0, 'no context, so no autoplay warning and no suspended context');
    assert.equal(board.running, false);
    // A real tap or click.
    activation.hasBeenActive = true;
    assert.equal(board.unlock(), true);
    assert.equal(made, 1);
    assert.equal(resumed, 1);
    assert.equal(board.running, true);
    assert.equal(board.unlock(), true);
    assert.equal(made, 1, 'only ever one context');
    // A browser without navigator.userActivation is not held back.
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const other = new SoundBoard();
    assert.equal(other.unlock(), true);
    assert.equal(made, 2);
  } finally {
    if (real.navigator) Object.defineProperty(globalThis, 'navigator', real.navigator);
    else delete globalThis.navigator;
    if (real.window) Object.defineProperty(globalThis, 'window', real.window);
    else delete globalThis.window;
  }
});
