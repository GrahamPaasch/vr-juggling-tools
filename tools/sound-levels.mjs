#!/usr/bin/env node
/**
 * How loud is the release against the catch? Renders both sounds offline in headless Chromium,
 * exactly as the page synthesises them, and measures the loudest 50 ms of each four ways:
 *
 *   peak          the largest sample
 *   RMS           plain energy
 *   A-weighted    the standard weighting for how the ear hears quiet to moderate sound
 *   K-weighted    ITU-R BS.1770, the weighting behind broadcast loudness (LUFS); also through a
 *                 250 Hz high-pass, as a stand-in for a headset, phone or laptop speaker
 *
 *   npm run levels
 *
 * This is where BASE_LEVEL.release in src/audio.js comes from (README, "Sound levels"). The noise
 * in both sounds is random, so every figure is the mean of several renders and moves by about
 * half a decibel from run to run.
 */

import { chromium } from 'playwright-core';
import { listen } from './serve.mjs';

const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const { server, url } = await listen({});
let browser;
try {
  try {
    browser = await chromium.launch({ args: GL_ARGS });
  } catch (err) {
    browser = await chromium.launch({ channel: 'chrome', args: GL_ARGS });
  }
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vrj && window.__vrj.state.pattern);

  const out = await page.evaluate(async () => {
    const base = document.querySelector('script[type=module]').src.replace(/src\/main\.js.*$/, '');
    const A = await import(base + 'src/audio.js');
    const rate = 48000;
    const N = 32768;

    function fft(re, im, inverse) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          [re[i], re[j]] = [re[j], re[i]];
          [im[i], im[j]] = [im[j], im[i]];
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const angle = ((inverse ? -2 : 2) * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let cr = 1;
          let ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const ur = re[i + k];
            const ui = im[i + k];
            const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
            const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
            re[i + k] = ur + vr;
            im[i + k] = ui + vi;
            re[i + k + len / 2] = ur - vr;
            im[i + k + len / 2] = ui - vi;
            const t = cr * wr - ci * wi;
            ci = cr * wi + ci * wr;
            cr = t;
          }
        }
      }
      if (inverse) {
        for (let i = 0; i < n; i++) {
          re[i] /= n;
          im[i] /= n;
        }
      }
    }

    // IEC 61672 A-weighting (magnitude, 0 dB at 1 kHz).
    const aWeight = (f) => {
      if (f <= 0) return 0;
      const f2 = f * f;
      return (1.2589 * (12194 ** 2 * f2 * f2)) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
    };
    // ITU-R BS.1770 K-weighting at 48 kHz: a high shelf and a high-pass, as two biquads.
    const biquad = (b, a, f) => {
      const w = (2 * Math.PI * f) / rate;
      const nr = b[0] + b[1] * Math.cos(w) + b[2] * Math.cos(2 * w);
      const ni = -(b[1] * Math.sin(w) + b[2] * Math.sin(2 * w));
      const dr = 1 + a[0] * Math.cos(w) + a[1] * Math.cos(2 * w);
      const di = -(a[0] * Math.sin(w) + a[1] * Math.sin(2 * w));
      return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    };
    const kWeight = (f) =>
      biquad([1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585], f) *
      biquad([1, -2, 1], [-1.99004745483398, 0.99007225036621], f);
    // A small speaker: a second-order high-pass at 250 Hz.
    const smallSpeaker = (f) => {
      const x = f / 250;
      return (x * x) / Math.sqrt(1 + x * x * x * x);
    };

    const win = Math.round(rate * 0.05);
    const loudest = (x) => {
      let sum = 0;
      let best = 0;
      for (let i = 0; i < x.length; i++) {
        sum += x[i] * x[i];
        if (i >= win) sum -= x[i - win] * x[i - win];
        if (sum > best) best = sum;
      }
      return Math.sqrt(best / win);
    };

    async function render(type, tweak) {
      const off = new OfflineAudioContext(1, N, rate);
      const board = new A.SoundBoard();
      if (tweak) tweak(board.settings);
      board.attach(off, { compressor: false });
      Object.defineProperty(board, 'running', { get: () => true });
      board.play(type, 0.05, 0, 0.5, 0);
      const x = (await off.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      const re = Float64Array.from(x);
      const im = new Float64Array(N);
      fft(re, im, false);
      const weighted = (weight) => {
        const r = Float64Array.from(re);
        const j = Float64Array.from(im);
        for (let k = 0; k < N; k++) {
          const w = weight((k <= N / 2 ? k : N - k) * (rate / N));
          r[k] *= w;
          j[k] *= w;
        }
        fft(r, j, true);
        return loudest(r);
      };
      return { peak, rms: loudest(x), a: weighted(aWeight), k: weighted(kWeight), small: weighted((f) => kWeight(f) * smallSpeaker(f)) };
    }
    const mean = async (type, tweak) => {
      const runs = 16;
      const acc = { peak: 0, rms: 0, a: 0, k: 0, small: 0 };
      for (let i = 0; i < runs; i++) {
        const r = await render(type, tweak);
        for (const key of Object.keys(acc)) acc[key] += r[key] / runs;
      }
      return acc;
    };
    return {
      base: A.BASE_LEVEL,
      defaults: { catch: A.DEFAULT_SOUND.catch.volume, release: A.DEFAULT_SOUND.release.volume },
      atDefaults: { catch: await mean('catch'), release: await mean('release') },
      atEqual: { catch: await mean('catch', (s) => { s.catch.volume = 1; }), release: await mean('release', (s) => { s.release.volume = 1; }) },
    };
  });

  const dB = (a, b) => ((20 * Math.log10(a / b) >= 0 ? '+' : '') + (20 * Math.log10(a / b)).toFixed(1)).padStart(6) + ' dB';
  const line = (pair) =>
    '  peak ' + dB(pair.release.peak, pair.catch.peak) + '   RMS ' + dB(pair.release.rms, pair.catch.rms) + '   A-weighted ' + dB(pair.release.a, pair.catch.a) +
    '   K-weighted ' + dB(pair.release.k, pair.catch.k) + '   K-weighted, small speaker ' + dB(pair.release.small, pair.catch.small);
  console.log('Release against catch, loudest 50 ms (levels at 100%: catch ' + out.base.catch + ', release ' + out.base.release + ')');
  console.log('at the default sliders (catch ' + out.defaults.catch * 100 + '%, release ' + out.defaults.release * 100 + '%):');
  console.log(line(out.atDefaults));
  console.log('with both sliders at the same position:');
  console.log(line(out.atEqual));
} finally {
  if (browser) await browser.close();
  server.close();
}
