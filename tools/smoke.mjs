#!/usr/bin/env node
/**
 * Browser smoke test: loads the real page in headless Chromium and drives it the way a person
 * would, on a flat screen and inside an emulated Oculus Quest 1.
 *
 *   npm run smoke
 *
 * The VR part uses Meta's Immersive Web Emulation Runtime (iwer), which stands in for the
 * headset: it supplies navigator.xr, a tracked head and two Touch controllers with the Quest 1's
 * real grip offsets. It is injected by this test only; the page itself never loads it.
 * This checks our WebXR code path. It is not a substitute for trying the real headset.
 *
 * Screenshots go to test-results/.
 */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { listen } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results');
const IWER = path.join(ROOT, 'node_modules', 'iwer', 'build', 'iwer.min.js');
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const results = [];
let current = '';

async function check(name, fn) {
  current = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok    ' + name + '  (' + (Date.now() - started) + ' ms)');
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('  FAIL  ' + name + '\n        ' + String(err && err.stack ? err.stack : err).split('\n').join('\n        '));
  }
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, (label || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual);

/** Open a page and record everything that would count as a JavaScript or loading error. */
async function open(browser, url, options) {
  const o = options || {};
  const context = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 800 },
    deviceScaleFactor: o.mobile ? 2 : 1,
    isMobile: !!o.mobile,
    hasTouch: !!o.mobile,
  });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console.error: ' + m.text());
    if (m.type() === 'warning' && !/GPU stall|WebGL-|GL Driver Message|iwer|IWER/i.test(m.text())) problems.push('console.warn: ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('requestfailed', (r) => problems.push('request failed: ' + r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push('HTTP ' + r.status() + ': ' + r.url());
  });
  page.on('request', (r) => requests.push(r.url()));
  if (o.xr) {
    await page.addInitScript({ path: IWER });
    await page.addInitScript((stereo) => {
      /* global IWER */
      const device = new IWER.XRDevice(IWER.oculusQuest1, { stereoEnabled: stereo });
      // Headless Chromium has a native navigator.xr with no headset behind it: replace it.
      device.installRuntime({ forceInstall: true });
      window.__xrDevice = device;
    }, !!o.stereo);
  }
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vrj && window.__vrj.state.pattern, null, { timeout: 15000 });
  return { page, context, problems, requests };
}

const app = (page, fn, arg) => page.evaluate(fn, arg);
const frames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const v = window.__vrj;
        const start = v.stage.renderer.info.render.frame;
        const tick = () => (v.stage.renderer.info.render.frame >= start + count ? resolve() : setTimeout(tick, 8));
        tick();
      }),
    n || 3
  );

// ---------------------------------------------------------------------------------------------

async function flatScreen(browser, base) {
  console.log('\nFlat screen (laptop)');
  const { page, context, problems, requests } = await open(browser, base);

  await check('page loads and draws with no JavaScript errors', async () => {
    await frames(page, 5);
    const info = await app(page, () => {
      const v = window.__vrj;
      return { text: v.state.pattern.text, calls: v.stage.renderer.info.render.calls, sim: v.state.simTime };
    });
    assert.equal(info.text, '3', 'first visit opens the 3-ball cascade');
    assert.ok(info.calls > 5, 'draw calls: ' + info.calls);
    assert.ok(info.sim > 0, 'the clock is running');
    assert.deepEqual(problems, []);
  });

  await check('the 3D view is not blank', async () => {
    const colours = await app(page, () => {
      const v = window.__vrj;
      return new Promise((resolve) => {
        const original = v.stage.render.bind(v.stage);
        v.stage.render = () => {
          original();
          v.stage.render = original;
          const c = document.createElement('canvas');
          c.width = 96;
          c.height = 60;
          const ctx = c.getContext('2d');
          ctx.drawImage(v.stage.canvas, 0, 0, 96, 60);
          const data = ctx.getImageData(0, 0, 96, 60).data;
          const seen = new Set();
          for (let i = 0; i < data.length; i += 4) seen.add((data[i] >> 3) + ',' + (data[i + 1] >> 3) + ',' + (data[i + 2] >> 3));
          resolve(seen.size);
        };
      });
    });
    assert.ok(colours > 8, 'distinct colours in the frame: ' + colours);
  });

  await check('nothing is fetched from another host (three.js is vendored, no CDN)', async () => {
    const origin = new URL(base).origin;
    const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    assert.deepEqual(foreign, []);
    assert.ok(requests.some((u) => u.endsWith('/vendor/three.module.min.js')), 'three.js came from ./vendor');
  });

  await check('there is a favicon', async () => {
    const href = await page.getAttribute('link[rel="icon"]', 'href');
    assert.ok(href && href.startsWith('data:image/svg+xml'), 'inline SVG favicon');
  });

  await check('presets 3, 4, 5, 6, 7 each load the right uniform pattern', async () => {
    for (const n of [4, 5, 6, 7, 3]) {
      await page.click('#presets [data-pattern="' + n + '"]');
      const p = await app(page, () => {
        const s = window.__vrj.state.pattern;
        return { text: s.text, balls: s.balls, kind: s.kind, uniform: s.uniform, shown: window.__vrj.stage.balls.filter((b) => b.visible).length };
      });
      assert.equal(p.text, String(n));
      assert.equal(p.balls, n);
      assert.equal(p.uniform, true);
      assert.equal(p.kind, n % 2 ? 'cascade' : 'fountain');
      assert.equal(p.shown, n, 'one ball drawn per ball');
      assert.match(await page.textContent('#infoTitle'), new RegExp(n + '-ball ' + p.kind));
    }
  });

  await check('7 balls shows the juggling_coach numbers', async () => {
    await page.click('#presets [data-pattern="7"]');
    const text = (await page.textContent('#infoBody')).replace(/\s+/g, ' ');
    for (const expected of ['0.42 s', 'W = 2.80', '1.70 m', '65.0 cm', '23.2 cm', '1.45']) {
      assert.ok(text.includes(expected), 'info panel shows ' + expected + ' in: ' + text);
    }
    assert.match(await page.textContent('#infoTag'), /spatial optimum/i);
  });

  await check('typing a siteswap works; invalid, sync and multiplex input is refused with a reason', async () => {
    const enter = async (text) => {
      await page.fill('#siteswap', text);
      await page.click('#siteswapForm button');
    };
    await enter('531');
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '531');
    assert.equal(await page.isHidden('#siteswapError'), true);
    assert.match(await page.textContent('#infoTag'), /standard layout/i);

    await enter('(4,2x)(2x,4)');
    assert.match(await page.textContent('#siteswapError'), /Synchronous.*version 2/);
    await enter('[43]23');
    assert.match(await page.textContent('#siteswapError'), /Multiplex.*out of scope/);
    await enter('543');
    assert.match(await page.textContent('#siteswapError'), /not a valid siteswap/);
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '531', 'a refused entry leaves the pattern alone');

    await enter('441');
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '441');
    assert.equal(await page.isHidden('#siteswapError'), true, 'the error clears after a valid entry');
  });

  await check('456 gets the collision warning, 531 does not', async () => {
    await page.click('#presets [data-pattern="456"]');
    assert.equal(await page.isVisible('#collisionBanner'), true);
    assert.match(await page.textContent('#collisionBanner'), /Collision warning.*the 5 and the 6/);
    assert.ok((await app(page, () => window.__vrj.stage.collisionMarks.children.length)) > 0, 'red rings mark the place');
    await page.click('#presets [data-pattern="531"]');
    assert.equal(await page.isHidden('#collisionBanner'), true);
    assert.equal(await app(page, () => window.__vrj.stage.collisionMarks.children.length), 0);
    assert.match((await page.textContent('#infoBody')).replace(/\s+/g, ' '), /No collisions/);
  });

  await check('slow motion slows the clock only, and always shows its label', async () => {
    assert.equal(await page.isHidden('#speedBadge'), true, 'no label at real speed');
    const heights = () => app(page, () => window.__vrj.state.pattern.heightByValue.slice());
    const before = await heights();
    await page.click('#speedChips [data-speed="0.5"]');
    assert.equal(await page.isVisible('#speedBadge'), true);
    assert.match(await page.textContent('#speedBadge'), /^0\.5x/);
    assert.deepEqual(await heights(), before, 'heights are untouched by slow motion');
    // Simulated seconds per real second, measured frame by frame the way the app's clock does
    // (so a slow test machine does not change the answer).
    const rate = await app(
      page,
      () =>
        new Promise((resolve) => {
          const v = window.__vrj;
          let last = performance.now();
          let real = 0;
          let n = 0;
          const s0 = v.state.simTime;
          const tick = () => {
            const now = performance.now();
            real += Math.min((now - last) / 1000, 0.1);
            last = now;
            if (++n < 50) requestAnimationFrame(tick);
            else resolve((v.state.simTime - s0) / real);
          };
          requestAnimationFrame(tick);
        })
    );
    near(rate, 0.5, 0.06, 'simulated seconds per real second at 0.5x');
    await page.fill('#speed', '25');
    assert.match(await page.textContent('#speedBadge'), /^0\.25x/);
    await page.click('#speedChips [data-speed="1"]');
    assert.equal(await page.isHidden('#speedBadge'), true);
  });

  await check('it always opens at real speed, but remembers the pattern', async () => {
    await page.click('#presets [data-pattern="5"]');
    await page.click('#speedChips [data-speed="0.25"]');
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__vrj && window.__vrj.state.pattern);
    const s = await app(page, () => ({ speed: window.__vrj.state.speed, text: window.__vrj.state.pattern.text }));
    assert.equal(s.speed, 1);
    assert.equal(s.text, '5');
    assert.equal(await page.isHidden('#speedBadge'), true);
  });

  await check("starts at the juggler's eye; stepping out orbits the pattern", async () => {
    const cam = () =>
      app(page, () => {
        const v = window.__vrj;
        const p = v.stage.camera.position;
        return { view: v.state.view, x: p.x, y: p.y, z: p.z, eye: v.state.anchor.eyeHeight };
      });
    await frames(page, 2);
    const eye = await cam();
    assert.equal(eye.view, 'eye');
    near(eye.x, 0, 1e-6);
    near(eye.z, 0, 1e-6);
    near(eye.y, eye.eye, 1e-6, "camera at the juggler's eye height");

    await page.click('#viewButtons [data-view="orbit"]');
    await frames(page, 2);
    const out = await cam();
    assert.equal(out.view, 'orbit');
    assert.ok(Math.hypot(out.x, out.z) > 1.5, 'the camera has stepped away from the spot');

    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7 + 220, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await frames(page, 2);
    const moved = await cam();
    assert.ok(Math.hypot(moved.x - out.x, moved.z - out.z) > 0.3, 'dragging walks around the pattern');

    await page.click('#viewButtons [data-view="eye"]');
    await frames(page, 2);
    near((await cam()).z, 0, 1e-6);
  });

  await check('three sounds, each with its own volume; release is quieter by default', async () => {
    const s = await app(page, () => JSON.parse(JSON.stringify(window.__vrj.audio.settings)));
    assert.deepEqual(Object.keys(s).sort(), ['catch', 'peak', 'release']);
    assert.ok(s.catch.on && s.release.on, 'catch and release are on by default');
    assert.ok(s.release.volume < s.catch.volume, 'release is quieter than catch');
    // The click below is the user gesture that lets the browser start audio.
    await page.click('#presets [data-pattern="531"]');
    await page.waitForFunction(() => window.__vrj.audio.running, null, { timeout: 5000 });
    await page.waitForTimeout(1300);
    const played = await app(page, () => Object.assign({}, window.__vrj.audio.played));
    assert.ok(played.catch > 0 && played.release > 0 && played.peak > 0, 'all three sounded: ' + JSON.stringify(played));
    assert.equal(await page.isHidden('#soundHint'), true);

    // Each sound's volume is its own.
    await page.fill('.sound[data-sound="peak"] input', '20');
    const after = await app(page, () => JSON.parse(JSON.stringify(window.__vrj.audio.settings)));
    assert.equal(after.peak.volume, 0.2);
    assert.equal(after.catch.volume, s.catch.volume);
    assert.equal(after.release.volume, s.release.volume);
  });

  await check('solo release mutes the catches (and the peak tone)', async () => {
    await page.click('.sound[data-sound="release"] .solo');
    await page.waitForTimeout(250);
    const a = await app(page, () => Object.assign({}, window.__vrj.audio.played));
    await page.waitForTimeout(1200);
    const b = await app(page, () => Object.assign({}, window.__vrj.audio.played));
    assert.ok(b.release > a.release, 'release keeps sounding');
    assert.equal(b.catch, a.catch, 'catch is silent while release is soloed');
    assert.equal(b.peak, a.peak, 'peak is silent while release is soloed');
    await page.click('.sound[data-sound="release"] .solo');
    // Mute is separate from solo.
    await page.click('.sound[data-sound="catch"] .mute');
    assert.equal(await app(page, () => window.__vrj.audio.settings.catch.on), false);
    await page.click('.sound[data-sound="catch"] .mute');
  });

  await check('the catch rhythm is even on the audio clock, and each hand sounds from its own side', async () => {
    await page.click('#presets [data-pattern="3"]');
    const log = await app(
      page,
      () =>
        new Promise((resolve) => {
          const v = window.__vrj;
          const calls = [];
          const original = v.audio.play;
          v.audio.play = function (type, when, pan, height) {
            calls.push({ type, when, pan, lead: when - v.audio.ctx.currentTime });
            return original.call(this, type, when, pan, height);
          };
          setTimeout(() => {
            v.audio.play = original;
            resolve({ calls, beat: v.state.pattern.beat, xC: v.state.pattern.layout.xC, clock: v.audio.clock, latency: v.audio.latency });
          }, 6500);
        })
    );
    // Skip the first two seconds: the audio clock is still being learned just after sound starts.
    const catches = log.calls.filter((c) => c.type === 'catch' && c.when > log.calls[0].when + 2);
    assert.ok(catches.length >= 12, 'catches heard: ' + catches.length);
    const gaps = catches.slice(1).map((c, i) => c.when - catches[i].when);
    const worst = Math.max(...gaps.map((g) => Math.abs(g - log.beat)));
    const spread = Math.max(...gaps) - Math.min(...gaps);
    console.log(
      '          audio clock: ' + log.clock + ', latency ' + (log.latency === null ? 'n/a' : (log.latency * 1000).toFixed(1) + ' ms') +
        ', gap error up to ' + (worst * 1000).toFixed(2) + ' ms, gap-to-gap spread ' + (spread * 1000).toFixed(2) + ' ms'
    );
    // Headless Chromium's stand-in audio device runs about 0.4% off the page clock, which alone
    // is ~1.2 ms per beat here. Both limits are well under what an ear can pick out (a few ms).
    assert.ok(worst < 0.0025, 'one catch per beat (' + log.beat + ' s), worst gap error ' + (worst * 1000).toFixed(2) + ' ms');
    assert.ok(spread < 0.002, 'the gaps are even: spread ' + (spread * 1000).toFixed(2) + ' ms');
    // Right after a pattern change the first sounds cannot be scheduled early; after that all are.
    const steady = log.calls.filter((c) => c.when > log.calls[0].when + 0.5);
    assert.ok(steady.length > 15 && steady.every((c) => c.lead > 0 && c.lead < 0.3), 'every sound is scheduled ahead of time, none is late');
    // Right hand catches come from the right, left from the left, alternating.
    const expected = (log.xC / 0.5) * 0.8;
    for (let i = 1; i < catches.length; i++) near(catches[i].pan, -catches[i - 1].pan, 1e-6, 'catches alternate sides');
    near(Math.abs(catches[0].pan), expected, 1e-6, 'pan follows where the hand is');
  });

  await check('the synthesised sounds are real: short, not clipped, release quieter, pitch as designed', async () => {
    const r = await app(page, async () => {
      const base = document.querySelector('script[type=module]').src.replace(/src\/main\.js.*$/, '');
      const { SoundBoard, peakFrequency } = await import(base + 'src/audio.js');
      const rate = 44100;
      async function render(type, height, pan, tweak) {
        const off = new OfflineAudioContext(2, rate * 0.6, rate);
        const board = new SoundBoard();
        board.ctx = off;
        board.master = off.createGain();
        board.master.connect(off.destination);
        board.noise = board.makeNoise();
        Object.defineProperty(board, 'running', { get: () => true });
        if (tweak) tweak(board.settings);
        board.play(type, 0.05, pan, height);
        const buf = await off.startRendering();
        const L = buf.getChannelData(0);
        const R = buf.getChannelData(1);
        let peak = 0;
        let sum = 0;
        let sumL = 0;
        let sumR = 0;
        for (let i = 0; i < L.length; i++) {
          const m = (L[i] + R[i]) / 2;
          peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
          sum += m * m;
          sumL += L[i] * L[i];
          sumR += R[i] * R[i];
        }
        let first = -1;
        let last = -1;
        for (let i = 0; i < L.length; i++) {
          if (Math.abs(L[i]) + Math.abs(R[i]) > peak * 0.1) {
            if (first < 0) first = i;
            last = i;
          }
        }
        // Pitch from zero crossings over 80 ms after the attack.
        const a0 = first + Math.floor(rate * 0.01);
        const a1 = Math.min(L.length - 1, a0 + Math.floor(rate * 0.08));
        let crossings = 0;
        for (let i = a0 + 1; i <= a1; i++) if (L[i - 1] < 0 !== L[i] < 0) crossings++;
        return { peak, energy: sum, left: sumL, right: sumR, start: first / rate, length: (last - first) / rate, hz: crossings / 2 / ((a1 - a0) / rate) };
      }
      return {
        catch: await render('catch', 0, 0),
        release: await render('release', 0, 0),
        low: await render('peak', 0.19, 0),
        high: await render('peak', 0.95, 0),
        lowHz: peakFrequency(0.19),
        highHz: peakFrequency(0.95),
        left: await render('catch', 0, -0.8),
        muted: await render('catch', 0, 0, (s) => { s.catch.on = false; }),
        soloed: await render('catch', 0, 0, (s) => { s.release.solo = true; }),
        zero: await render('peak', 1, 0, (s) => { s.peak.volume = 0; }),
      };
    });
    for (const name of ['catch', 'release', 'low', 'high']) {
      assert.ok(r[name].peak > 0.02 && r[name].peak < 1, name + ' peak level ' + r[name].peak.toFixed(3));
      near(r[name].start, 0.05, 0.004, name + ' starts when scheduled');
    }
    assert.ok(r.catch.length < 0.25, 'catch is a short thud: ' + r.catch.length.toFixed(3) + ' s');
    assert.ok(r.release.length < 0.12, 'release is shorter still: ' + r.release.length.toFixed(3) + ' s');
    assert.ok(r.low.length < 0.35, 'peak tone is a short ping: ' + r.low.length.toFixed(3) + ' s');
    assert.ok(r.release.energy < r.catch.energy * 0.5, 'release carries less energy than catch at the default volumes');
    near(r.low.hz, r.lowHz, r.lowHz * 0.06, 'measured pitch of a 0.19 m throw');
    near(r.high.hz, r.highHz, r.highHz * 0.06, 'measured pitch of a 0.95 m throw');
    assert.ok(r.high.hz > r.low.hz * 1.3, 'the higher throw sounds clearly higher');
    assert.ok(r.left.left > r.left.right * 3, 'a left-hand catch is louder in the left ear');
    assert.ok(r.muted.peak < 1e-6 && r.soloed.peak < 1e-6 && r.zero.peak < 1e-6, 'mute, another sound soloed, and zero volume are silent');
  });

  await check('peak pitch follows throw height: in 531 the 5 is highest, the 1 lowest', async () => {
    await page.click('#presets [data-pattern="531"]');
    const hz = await app(page, async () => {
      const { peakFrequency } = await import(new URL('src/audio.js', document.querySelector('script[type=module]').src.replace(/src\/main\.js.*$/, '')).href);
      const h = window.__vrj.state.pattern.heightByValue;
      return [peakFrequency(h[5]), peakFrequency(h[3]), peakFrequency(h[1])];
    });
    assert.ok(hz[0] > hz[1] && hz[1] > hz[2], 'Hz for 5, 3, 1: ' + hz.map((x) => x.toFixed(0)).join(', '));
  });

  await check('manual calibration sliders move the pattern (height and distance from the body)', async () => {
    const anchor = () =>
      app(page, () => {
        const v = window.__vrj;
        return { y: v.stage.anchor.position.y, z: v.stage.anchor.position.z, h: v.state.anchor.handHeight, d: v.state.anchor.distance };
      });
    await page.fill('#handHeight', '90');
    await page.fill('#distance', '45');
    const a = await anchor();
    near(a.h, 0.9, 1e-9);
    near(a.y, 0.9, 1e-9, 'the pattern sits at the hand height');
    near(a.d, 0.45, 1e-9);
    near(a.z, -0.45, 1e-9, 'and that far in front of the juggler');
    await page.click('#resetCalib');
    near((await anchor()).h, 1.05, 1e-9);
  });

  await check('nothing lets you break the physics, and nothing keeps score', async () => {
    const page_text = (await page.textContent('body')).toLowerCase();
    assert.ok(!/score|points|streak/.test(page_text.replace(/scoring/g, '')), 'no scoring anywhere on the page');
    const ids = await page.$$eval('input', (nodes) => nodes.map((n) => n.id || n.getAttribute('aria-label')));
    const banned = ids.filter((id) => /gravity|height$|throwHeight|beat|dwell/i.test(String(id)) && id !== 'handHeight');
    assert.deepEqual(banned, [], 'no control edits gravity, throw height, beat or dwell');
    assert.equal(await app(page, async () => (await import(new URL('src/physics.js', document.querySelector('script[type=module]').src.replace(/src\/main\.js.*$/, '')).href)).G), 9.81);
  });

  await mkdir(OUT, { recursive: true });
  await page.click('#presets [data-pattern="7"]');
  await page.click('#viewButtons [data-view="orbit"]');
  await frames(page, 4);
  await page.screenshot({ path: path.join(OUT, 'flat-7-step-out.png') });
  await page.click('#viewButtons [data-view="eye"]');
  await frames(page, 4);
  await page.screenshot({ path: path.join(OUT, 'flat-7-jugglers-eye.png') });

  await check('still no errors after all of that', async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function phone(browser, base) {
  console.log('\nFlat screen (phone)');
  const { page, context, problems } = await open(browser, base + '?s=441', { viewport: { width: 390, height: 780 }, mobile: true });
  await check('loads on a phone-sized touch screen; controls can be hidden and shown', async () => {
    await frames(page, 4);
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '441', '?s= in the address picks the pattern');
    await page.tap('#panelClose');
    assert.equal(await page.isHidden('#panel'), true);
    await page.tap('#viewButtons [data-view="orbit"]');
    assert.equal(await app(page, () => window.__vrj.state.view), 'orbit');
    await frames(page, 3);
    await page.screenshot({ path: path.join(OUT, 'phone-441.png') });
    await page.tap('#panelOpen');
    assert.equal(await page.isVisible('#panel'), true);
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function liveSitePath(browser) {
  console.log('\nServed the way the live site serves it (/juggling/vr, no trailing slash)');
  const { server, port } = await listen({ mount: '/juggling/vr' });
  try {
    for (const suffix of ['/juggling/vr', '/juggling/vr/', '/juggling/vr/index.html']) {
      await check('loads at ' + suffix, async () => {
        const { page, context, problems } = await open(browser, 'http://localhost:' + port + suffix);
        await frames(page, 3);
        assert.equal(await app(page, () => window.__vrj.state.pattern.text), '3');
        assert.deepEqual(problems, []);
        await context.close();
      });
    }
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------

/** Point a controller's ray at a button on the VR control board. */
async function aim(page, hand, buttonId) {
  await app(
    page,
    ({ hand, buttonId }) => {
      const { xr, THREE, stage } = window.__vrj;
      const local = xr.panel.buttonCentre(buttonId);
      if (!local) throw new Error('no such button: ' + buttonId);
      xr.panel.group.updateMatrixWorld(true);
      const target = local.applyMatrix4(xr.panel.group.matrixWorld);
      target.applyMatrix4(new THREE.Matrix4().copy(stage.rig.matrixWorld).invert()); // into tracking space
      const c = window.__xrDevice.controllers[hand];
      const origin = new THREE.Vector3(c.position.x, c.position.y, c.position.z);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(origin, target, new THREE.Vector3(0, 1, 0)));
      c.quaternion.set(q.x, q.y, q.z, q.w);
    },
    { hand, buttonId }
  );
  await frames(page, 3);
}

async function pull(page, hand, button) {
  await app(page, ({ hand, button }) => window.__xrDevice.controllers[hand].updateButtonValue(button, 1), { hand, button: button || 'trigger' });
  await frames(page, 3);
  await app(page, ({ hand, button }) => window.__xrDevice.controllers[hand].updateButtonValue(button, 0), { hand, button: button || 'trigger' });
  await frames(page, 3);
}

async function press(page, buttonId) {
  await aim(page, 'right', buttonId);
  const hovered = await app(page, () => {
    const v = window.__vrj.xr;
    const c = v.controllers.find((k) => k.handedness === 'right');
    const h = v.panel.hover[c.index];
    return h ? h.id : null;
  });
  assert.equal(hovered, buttonId, 'the ray is on the button');
  await pull(page, 'right');
}

async function quest1(browser, base) {
  console.log('\nInside an emulated Oculus Quest 1 (WebXR immersive-vr)');
  const { page, context, problems } = await open(browser, base, { xr: true, viewport: { width: 1280, height: 720 } });

  await check('the page offers VR when a headset is present', async () => {
    await page.waitForFunction(() => !window.__vrj.state.vr.checking);
    assert.equal(await app(page, () => window.__vrj.state.vr.supported), true);
    assert.equal(await page.textContent('#enterVR'), 'Enter VR');
    assert.equal(await page.isEnabled('#enterVR'), true);
    assert.match(await app(page, () => navigator.userAgent), /Quest 1/);
  });

  await check('Enter VR starts an immersive session on a floor-level reference space', async () => {
    // Stand the emulated person up, hands down by their sides.
    await app(page, () => {
      const d = window.__xrDevice;
      d.position.set(0.3, 1.62, 0.2);
      d.controllers.left.position.set(0.05, 0.8, 0.1);
      d.controllers.right.position.set(0.55, 0.8, 0.1);
    });
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    const s = await app(page, () => {
      const v = window.__vrj;
      return {
        type: v.xr.referenceSpaceType,
        isPresenting: v.stage.renderer.xr.isPresenting,
        calibrating: v.state.vr.calibrating,
        panel: v.xr.panel.group.visible,
        prompt: v.xr.promptLabel.text,
        promptVisible: v.xr.promptLabel.mesh.visible,
        anchor: Object.assign({}, v.state.anchor),
        hands: v.xr.controllers.map((c) => c.handedness).sort(),
      };
    });
    assert.equal(s.type, 'local-floor');
    assert.equal(s.isPresenting, true);
    assert.deepEqual(s.hands, ['left', 'right'], 'both controllers are connected');
    // Starts in the juggler's spot: the spot is under the head.
    near(s.anchor.spotX, 0.3, 0.01, 'spot x');
    near(s.anchor.spotZ, 0.2, 0.01, 'spot z');
    near(s.anchor.eyeHeight, 1.62, 0.01, 'eye height');
    // Not calibrated yet: it asks, and the control board stays out of the way of the trigger.
    assert.equal(s.calibrating, true);
    assert.equal(s.panel, false);
    assert.equal(s.promptVisible, true);
    assert.match(s.prompt, /where you catch/);
    assert.deepEqual(problems, []);
  });

  await check('balls land at the grip pose (the palm), not at the controller tip', async () => {
    await frames(page, 3);
    const d = await app(page, () => {
      const v = window.__vrj;
      const c = v.xr.controllers.find((k) => k.handedness === 'right');
      const palm = v.xr.palmPosition(0, new v.THREE.Vector3());
      const grip = c.grip.getWorldPosition(new v.THREE.Vector3());
      const tip = c.ray.getWorldPosition(new v.THREE.Vector3());
      return { palmToGrip: palm.distanceTo(grip), palmToTip: palm.distanceTo(tip) };
    });
    near(d.palmToGrip, 0, 1e-6, 'with no nudge the palm point is the grip origin');
    assert.ok(d.palmToTip > 0.03, 'and it is not the pointing-ray origin (' + d.palmToTip.toFixed(3) + ' m away)');
  });

  await check('trigger calibrates: records hand height and distance from the body', async () => {
    // Hold the controllers where a juggler catches: in front of the body, either side.
    await app(page, () => {
      const d = window.__xrDevice;
      d.controllers.left.position.set(0.3 - 0.24, 1.02, 0.2 - 0.4);
      d.controllers.right.position.set(0.3 + 0.24, 1.0, 0.2 - 0.38);
    });
    await frames(page, 3);
    const expected = await app(page, () => {
      const s = window.__vrj.xr.sample();
      const mid = s.palms[0].clone().add(s.palms[1]).multiplyScalar(0.5);
      return { height: mid.y, out: Math.hypot(mid.x - s.head.x, mid.z - s.head.z), headX: s.head.x, headZ: s.head.z };
    });
    await pull(page, 'right');
    const s = await app(page, () => {
      const v = window.__vrj;
      return {
        calibrating: v.state.vr.calibrating,
        calibrated: v.state.calibrated,
        anchor: Object.assign({}, v.state.anchor),
        panel: v.xr.panel.group.visible,
        prompt: v.xr.promptLabel.text,
        patternY: v.stage.anchor.position.y,
        saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')),
      };
    });
    assert.equal(s.calibrating, false);
    assert.equal(s.calibrated, true);
    near(s.anchor.handHeight, expected.height, 0.005, 'hand height');
    near(s.anchor.distance, expected.out, 0.005, 'distance from the body');
    near(s.patternY, expected.height, 0.005, 'the pattern is built from the hand height');
    near(s.anchor.spotX, expected.headX, 0.005);
    near(s.anchor.spotZ, expected.headZ, 0.005);
    near(s.anchor.yaw, 0, 0.03, 'facing the way the hands are held');
    assert.ok(s.anchor.handHeight > 0.9 && s.anchor.handHeight < 1.1);
    assert.match(s.prompt, /Calibrated/);
    assert.match(s.prompt, /Controls: on your left/);
    assert.equal(s.panel, true, 'the control board comes back, off to the side');
    assert.equal(await app(page, () => window.__vrj.xr.panelInView()), false, 'out of the way of the pattern');
    assert.equal(s.saved.calibrated, true, 'calibration is remembered');
  });

  await check('ghost hands and balls are drawn where the calibration says', async () => {
    await frames(page, 2);
    const d = await app(page, () => {
      const v = window.__vrj;
      const T = v.THREE;
      const scene = v.stage.lastScene;
      const hand = v.stage.ghostHands[0].getWorldPosition(new T.Vector3());
      const a = v.state.anchor;
      return {
        handX: scene.hands[0].x,
        handY: scene.hands[0].y,
        world: [hand.x, hand.y, hand.z],
        expect: [a.spotX + scene.hands[0].x, a.handHeight + scene.hands[0].y, a.spotZ - a.distance],
        ghostVisible: v.stage.ghostHands[0].visible,
        ownCup: v.xr.controllers[0].cup.visible,
      };
    });
    assert.equal(d.ghostVisible, true);
    assert.equal(d.ownCup, true, "the person's own hands are shown");
    for (let i = 0; i < 3; i++) near(d.world[i], d.expect[i], 0.02, 'ghost hand world coordinate ' + i);
  });

  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'vr-quest1-after-calibration.png') });

  await check('point and trigger on the control board: preset, then type 531 on the keypad', async () => {
    await press(page, 'pattern:7');
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '7');
    for (const key of ['key:5', 'key:3', 'key:1']) await press(page, key);
    assert.equal(await app(page, () => window.__vrj.state.typed), '531');
    await press(page, 'key:go');
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '531');
    assert.equal(await app(page, () => window.__vrj.state.typed), '');
    // An invalid entry is refused with a reason on the board.
    for (const key of ['key:5', 'key:4', 'key:3', 'key:go']) await press(page, key);
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '531');
    assert.match(await app(page, () => window.__vrj.xr.panel.model.status), /not a valid siteswap/);
    for (let i = 0; i < 3; i++) await press(page, 'key:back');
    assert.equal(await app(page, () => window.__vrj.state.typed), '');
  });

  await check('slow motion in VR shows a head-locked speed label, real speed hides it', async () => {
    const label = () => app(page, () => ({ visible: window.__vrj.xr.speedLabel.mesh.visible, text: window.__vrj.xr.speedLabel.text, speed: window.__vrj.state.speed, parentIsCamera: window.__vrj.xr.speedLabel.mesh.parent === window.__vrj.stage.camera }));
    assert.equal((await label()).visible, false);
    await press(page, 'speed:0.5');
    const slow = await label();
    assert.equal(slow.speed, 0.5);
    assert.equal(slow.visible, true);
    assert.equal(slow.text, '0.5x');
    assert.equal(slow.parentIsCamera, true, 'the label rides with the head, so it is always in view');
    await page.screenshot({ path: path.join(OUT, 'vr-quest1-slow-motion.png') });
    await press(page, 'speed:1');
    assert.equal((await label()).visible, false);
  });

  await check('sound controls on the board: volume, mute and solo', async () => {
    const before = await app(page, () => window.__vrj.audio.settings.release.volume);
    await press(page, 'vol:release:+');
    near(await app(page, () => window.__vrj.audio.settings.release.volume), before + 0.1, 1e-9);
    await press(page, 'vol:release:-');
    await press(page, 'solo:release');
    assert.equal(await app(page, () => window.__vrj.audio.settings.release.solo), true);
    await press(page, 'solo:release');
    await press(page, 'mute:peak');
    assert.equal(await app(page, () => window.__vrj.audio.settings.peak.on), false);
    await press(page, 'mute:peak');
  });

  await check('palm nudge moves the landing point by 5 mm steps, mirrored for the two hands', async () => {
    await press(page, 'palmball');
    assert.equal(await app(page, () => window.__vrj.xr.controllers[0].ball.visible), true, 'a ball rests in each hand while nudging');
    await press(page, 'nudge:palm:+');
    await press(page, 'nudge:palm:+');
    await press(page, 'nudge:wrist:-');
    const n = await app(page, () => {
      const v = window.__vrj;
      const by = {};
      for (const c of v.xr.controllers) by[c.handedness] = [c.holder.position.x, c.holder.position.y, c.holder.position.z];
      return { nudge: v.state.nudge, by };
    });
    near(n.nudge.palm, 0.01, 1e-9);
    near(n.nudge.wrist, -0.005, 1e-9);
    near(n.by.right[0], -0.01, 1e-9, 'toward the palm is -X on the right hand');
    near(n.by.left[0], 0.01, 1e-9, 'and +X on the left hand');
    near(n.by.right[1], -0.005, 1e-9);
    await press(page, 'nudge:palm:-');
    await press(page, 'nudge:palm:-');
    await press(page, 'nudge:wrist:+');
    await press(page, 'palmball');
  });

  await check('fine-tune buttons on the board adjust height and distance by 1 cm', async () => {
    const a0 = await app(page, () => Object.assign({}, window.__vrj.state.anchor));
    await press(page, 'height:+');
    await press(page, 'distance:-');
    const a1 = await app(page, () => Object.assign({}, window.__vrj.state.anchor));
    near(a1.handHeight - a0.handHeight, 0.01, 1e-9);
    near(a1.distance - a0.distance, -0.01, 1e-9);
    await press(page, 'height:-');
    await press(page, 'distance:+');
  });

  await check('step out with the left stick, see the pattern from outside, and come back', async () => {
    const head = () => app(page, () => window.__vrj.xr.headPosition(new window.__vrj.THREE.Vector3()).toArray());
    const start = await head();
    await app(page, () => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
    await page.waitForFunction((z0) => z0 - window.__vrj.xr.headPosition(new window.__vrj.THREE.Vector3()).z > 0.9, start[2], { timeout: 8000 });
    await app(page, () => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
    await frames(page, 3);
    const walked = await head();
    assert.ok(start[2] - walked[2] > 0.9, 'walked forward: ' + (start[2] - walked[2]).toFixed(2) + ' m');
    near(walked[0], start[0], 0.02, 'straight ahead, no sideways drift');
    near(walked[1], start[1], 1e-6, 'height unchanged');
    assert.equal(await app(page, () => window.__vrj.stage.ghostHead.visible), true, "the juggler's place is marked once you leave it");

    // Snap turn with the right stick keeps the head where it is.
    await app(page, () => window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0));
    await frames(page, 4);
    await app(page, () => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0));
    await frames(page, 3);
    const turned = await head();
    near(turned[0], walked[0], 1e-3);
    near(turned[2], walked[2], 1e-3);
    near(await app(page, () => window.__vrj.stage.rig.rotation.y), -Math.PI / 6, 1e-6, 'turned 30 degrees to the right');
    await page.screenshot({ path: path.join(OUT, 'vr-quest1-stepped-out.png') });

    // The board stayed behind, off to the side. A (or X) brings it in front; A again hides it.
    const board = () => app(page, () => ({ visible: window.__vrj.xr.panel.group.visible, inView: window.__vrj.xr.panelInView() }));
    assert.deepEqual(await board(), { visible: true, inView: false });
    await pull(page, 'right', 'a-button');
    assert.deepEqual(await board(), { visible: true, inView: true });
    await pull(page, 'right', 'a-button');
    assert.deepEqual(await board(), { visible: false, inView: false });
    await pull(page, 'right', 'a-button');
    assert.deepEqual(await board(), { visible: true, inView: true });
    // "my spot" brings you back to the juggler's place.
    await press(page, 'spot');
    const back = await head();
    const spot = await app(page, () => [window.__vrj.state.anchor.spotX, window.__vrj.state.anchor.spotZ]);
    near(back[0], spot[0], 1e-3);
    near(back[2], spot[1], 1e-3);
  });

  await check('recalibrating from the board works, and A cancels it', async () => {
    await press(page, 'calibrate');
    assert.equal(await app(page, () => window.__vrj.state.vr.calibrating), true);
    assert.equal(await app(page, () => window.__vrj.xr.panel.group.visible), false);
    await pull(page, 'left', 'x-button');
    assert.equal(await app(page, () => window.__vrj.state.vr.calibrating), false);
    assert.equal(await app(page, () => window.__vrj.xr.panel.group.visible), true);
  });

  await check('frames keep coming in VR and the scene is drawn for the headset', async () => {
    const a = await app(page, () => ({ f: window.__vrj.xr.frames, calls: window.__vrj.stage.renderer.info.render.calls }));
    await page.waitForTimeout(500);
    const b = await app(page, () => ({ f: window.__vrj.xr.frames }));
    assert.ok(b.f > a.f + 2, 'XR frames advanced by ' + (b.f - a.f));
    assert.ok(a.calls > 5);
  });

  await check('Exit VR returns to the flat page with everything still running', async () => {
    await press(page, 'exit');
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting, null, { timeout: 5000 });
    await frames(page, 4);
    const s = await app(page, () => {
      const v = window.__vrj;
      return { presenting: v.stage.renderer.xr.isPresenting, text: v.state.pattern.text, view: v.state.view, spot: [v.state.anchor.spotX, v.state.anchor.spotZ], camY: v.stage.camera.position.y, eye: v.state.anchor.eyeHeight, label: v.xr.speedLabel.mesh.visible };
    });
    assert.equal(s.presenting, false);
    assert.equal(s.text, '531');
    assert.deepEqual(s.spot, [0, 0]);
    near(s.camY, s.eye, 1e-6, "back at the juggler's eye");
    assert.equal(await page.textContent('#enterVR'), 'Enter VR');
    assert.deepEqual(problems, []);
  });

  await check('a second session reuses the saved calibration instead of asking again', async () => {
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    const s = await app(page, () => ({ calibrating: window.__vrj.state.vr.calibrating, panel: window.__vrj.xr.panel.group.visible, h: window.__vrj.state.anchor.handHeight }));
    assert.equal(s.calibrating, false);
    assert.equal(s.panel, true);
    assert.ok(s.h > 0.9 && s.h < 1.1);
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.deepEqual(problems, []);
  });

  await context.close();
}

async function quest1Hands(browser, base) {
  console.log('\nEmulated Quest 1 with the hand-tracking toggle on');
  const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, viewport: { width: 1280, height: 720 } });
  await check('hand tracking is requested only when the toggle is on, and hands can calibrate', async () => {
    await page.waitForFunction(() => !window.__vrj.state.vr.checking);
    await page.check('#handTracking');
    await app(page, () => {
      const d = window.__xrDevice;
      d.primaryInputMode = 'hand';
      d.position.set(0, 1.6, 0);
      d.hands.left.position.set(-0.22, 1.05, -0.36);
      d.hands.right.position.set(0.22, 1.05, -0.36);
    });
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 4);
    const s = await app(page, () => {
      const v = window.__vrj;
      const c = v.xr.controllers.find((k) => k.handedness === 'right');
      return {
        features: Array.from(v.xr.session.enabledFeatures || []),
        isHand: !!(c && c.source && c.source.hand),
        joints: c ? Object.keys(c.hand.joints).length : 0,
        dots: c ? Object.values(c.hand.joints).filter((j) => j.userData.dot).length : 0,
        palm: v.xr.palmPosition(0, new v.THREE.Vector3()) !== null,
      };
    });
    assert.ok(s.features.includes('hand-tracking'), 'features: ' + s.features.join(', '));
    assert.equal(s.isHand, true);
    assert.equal(s.joints, 25);
    assert.equal(s.dots, 25, 'the tracked hand is drawn');
    assert.equal(s.palm, true);
    // A pinch is the hand's trigger.
    await app(page, () => window.__xrDevice.hands.right.updatePinchValue(1));
    await frames(page, 4);
    await app(page, () => window.__xrDevice.hands.right.updatePinchValue(0));
    await frames(page, 3);
    assert.equal(await app(page, () => window.__vrj.state.calibrated), true);
    await page.screenshot({ path: path.join(OUT, 'vr-quest1-hands-stereo.png') });
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.deepEqual(problems, []);
  });
  await context.close();

  const plain = await open(browser, base, { xr: true });
  await check('with the toggle off, hand tracking is not requested', async () => {
    await plain.page.waitForFunction(() => !window.__vrj.state.vr.checking);
    await plain.page.click('#enterVR');
    await plain.page.waitForFunction(() => window.__vrj.state.vr.presenting);
    const features = await app(plain.page, () => Array.from(window.__vrj.xr.session.enabledFeatures || []));
    assert.ok(!features.includes('hand-tracking'), 'features: ' + features.join(', '));
    assert.deepEqual(plain.problems, []);
  });
  await plain.context.close();
}

// ---------------------------------------------------------------------------------------------

const started = Date.now();
const { server, url } = await listen({});
let browser;
try {
  try {
    browser = await chromium.launch({ args: GL_ARGS });
  } catch (err) {
    console.log('Bundled Chromium not found (' + String(err.message).split('\n')[0] + '); trying the installed Chrome.');
    browser = await chromium.launch({ channel: 'chrome', args: GL_ARGS });
  }
  console.log('Chromium ' + browser.version() + ', page at ' + url);
  await flatScreen(browser, url);
  await phone(browser, url);
  await liveSitePath(browser);
  await quest1(browser, url);
  await quest1Hands(browser, url);
} finally {
  if (browser) await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + results.length + ' checks in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
if (failed.length) {
  console.log('Failed: ' + failed.map((f) => f.name).join('; ') + (current ? '' : ''));
  process.exit(1);
}
