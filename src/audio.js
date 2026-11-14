/**
 * audio.js: the three practice sounds, synthesised with the Web Audio API (no audio files).
 *
 *   catch    a ball landing in a palm: a soft, low thud.
 *   release  the ball leaving the hand: a short, light brush. Quieter than the catch by default.
 *   peak     a short tone at the exact top of each arc. Its pitch follows the height above the
 *            hands, so a 5 sounds higher than a 3 and 531 has a melody.
 *
 * Each sound has its own volume, on/off and solo. Events are scheduled on the audio clock a
 * little ahead of time, so the rhythm is as even as the math, not as even as the frame rate.
 *
 * Slow motion never changes the sounds themselves, only how far apart they are.
 */

export const SOUND_TYPES = ['catch', 'release', 'peak'];

export const DEFAULT_SOUND = {
  catch: { on: true, volume: 0.8, solo: false },
  release: { on: true, volume: 0.5, solo: false }, // "a little quieter than catch"
  peak: { on: true, volume: 0.45, solo: false },
};

/** Loudness of each sound at full volume, balanced by ear against each other. */
const BASE_LEVEL = { catch: 0.9, release: 0.5, peak: 0.32 };

/**
 * Pitch of the peak tone for a throw that rises `height` metres above the hands.
 * A sound-design choice, not physics: 220 Hz plus 440 Hz per square-root metre. Flight time
 * goes with the square root of height, so equal steps in throw value are roughly equal steps
 * in pitch. Examples: 0.19 m -> 412 Hz, 0.95 m -> 650 Hz, 1.70 m -> 793 Hz.
 */
export function peakFrequency(height) {
  return 220 + 440 * Math.sqrt(Math.max(height, 0));
}

/** The gain actually applied to one sound type, given mute and solo. */
export function effectiveVolume(settings, type) {
  const anySolo = SOUND_TYPES.some((t) => settings[t].solo);
  const s = settings[type];
  if (anySolo) return s.solo ? s.volume : 0;
  return s.on ? s.volume : 0;
}

export class SoundBoard {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SOUND));
    this.pending = [];
    this.played = { catch: 0, release: 0, peak: 0 }; // counters, handy for tests
    this.lastPeakHz = 0;
    this.clockOffset = null;
    this.clockStamp = 0;
  }

  /** Browsers only start audio after a tap or key press: call this from one. */
  unlock() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.12;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.noise = this.makeNoise();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    } catch (err) {
      console.warn('Audio is not available:', err);
      return false;
    }
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * The audio-clock time at which a sound must be scheduled to be heard at page time `perfMs`
   * (a performance.now() value). Call once per frame with `nowMs` to keep the mapping fresh.
   *
   * ctx.currentTime only advances in blocks, so reading it directly would add a few
   * milliseconds of jitter to every event. Instead the offset between the two clocks is tracked
   * as a slowly leaking maximum, which is steady. Sounds are also moved earlier by the reported
   * output latency, as far as `maxAdvance` (seconds) allows.
   */
  timeFor(perfMs, nowMs, maxAdvance) {
    const sample = this.ctx.currentTime - nowMs / 1000;
    if (this.clockOffset === null || sample > this.clockOffset || this.clockOffset - sample > 0.25) {
      this.clockOffset = sample;
    } else if (nowMs !== this.clockStamp) {
      this.clockOffset -= 2e-5; // leak: lets the estimate follow clock drift
    }
    this.clockStamp = nowMs;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const advance = Math.min(Math.max(latency, 0), Math.max(maxAdvance || 0, 0));
    return perfMs / 1000 + this.clockOffset - advance;
  }

  makeNoise() {
    const length = Math.floor(this.ctx.sampleRate * 0.5);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Schedule one sound. `when` is on the audio clock (seconds); `pan` is -1 (left) to 1 (right);
   * `height` is the peak height in metres (peak tone only).
   */
  play(type, when, pan, height) {
    if (!this.running) return;
    const volume = effectiveVolume(this.settings, type);
    if (volume <= 0) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime + 0.001);
    const level = BASE_LEVEL[type] * volume * volume; // squared: a slider that feels even

    const out = ctx.createGain();
    out.gain.value = 1;
    let tail = out;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.min(Math.max(pan || 0, -1), 1);
      out.connect(p);
      tail = p;
    }
    tail.connect(this.master);

    const sources = [];
    let end = t + 0.3;

    if (type === 'catch') {
      // Skin and beanbag: low-passed noise for the slap, a falling sine for the weight.
      const slap = this.noiseBurst(t, 0.085);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 950;
      lp.Q.value = 0.7;
      const g = this.envelope(t, level, 0.002, 0.08);
      slap.connect(lp);
      lp.connect(g);
      g.connect(out);

      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(150, t);
      thump.frequency.exponentialRampToValueAtTime(70, t + 0.07);
      const tg = this.envelope(t, level * 0.8, 0.002, 0.1);
      thump.connect(tg);
      tg.connect(out);
      thump.start(t);
      thump.stop(t + 0.14);
      sources.push(slap, thump);
      end = t + 0.16;
    } else if (type === 'release') {
      // The ball leaving the fingers: a short, airy band of noise.
      const brush = this.noiseBurst(t, 0.05);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 1.1;
      const g = this.envelope(t, level, 0.004, 0.04);
      brush.connect(bp);
      bp.connect(g);
      g.connect(out);
      sources.push(brush);
      end = t + 0.08;
    } else {
      const hz = peakFrequency(height || 0);
      this.lastPeakHz = hz;
      const tone = ctx.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = hz;
      const over = ctx.createOscillator(); // a quiet octave so small speakers carry low notes
      over.type = 'sine';
      over.frequency.value = hz * 2;
      const og = ctx.createGain();
      og.gain.value = 0.22;
      const g = this.envelope(t, level, 0.004, 0.2);
      tone.connect(g);
      over.connect(og);
      og.connect(g);
      g.connect(out);
      tone.start(t);
      over.start(t);
      tone.stop(t + 0.26);
      over.stop(t + 0.26);
      sources.push(tone, over);
      end = t + 0.28;
    }

    this.played[type]++;
    const entry = { when: t, end, sources, out };
    this.pending.push(entry);
    // Forget finished sounds so the list stays short.
    if (this.pending.length > 64) {
      const now = ctx.currentTime;
      this.pending = this.pending.filter((p) => p.end > now);
    }
  }

  noiseBurst(t, duration) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const offset = Math.random() * (this.noise.duration - duration - 0.01);
    src.start(t, offset, duration + 0.02);
    return src;
  }

  /** A gain node that jumps up at t and dies away: attack then exponential decay. */
  envelope(t, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  /** Drop sounds that were scheduled but have not started (pattern or speed just changed). */
  cancelPending() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const p of this.pending) {
      if (p.when > now + 0.005) {
        try {
          p.out.disconnect();
          for (const s of p.sources) s.stop();
        } catch (err) {
          // already stopped
        }
      }
    }
    this.pending = [];
  }
}
