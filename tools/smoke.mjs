#!/usr/bin/env node
/**
 * Browser smoke test: loads the real page in headless Chromium and drives it the way a person
 * would, on a flat screen and inside an emulated Oculus Quest 1.
 *
 *   npm run smoke
 *   SMOKE_ONLY=flat,quest1 npm run smoke     some of the parts: flat, phone, path, gestures,
 *                                            quest1, edges, hands, no3d
 *   SMOKE_CHANNEL=chrome npm run smoke       in the installed Google Chrome instead
 *   SMOKE_EXECUTABLE=/path/to/chrome npm run smoke    in any Chromium build, an old one say
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
  if (o.pre) await page.addInitScript(o.pre, o.preArg);
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

  await check('7 balls shows the computed numbers with the juggling_coach numbers beside them', async () => {
    await page.click('#presets [data-pattern="7"]');
    const text = (await page.textContent('#infoBody')).replace(/\s+/g, ' ');
    for (const expected of ['0.42 s', 'W = 2.80', '1.70 m', '65.0 cm', '23.2 cm', '1.45']) {
      assert.ok(text.includes(expected), 'info panel shows ' + expected + ' in: ' + text);
    }
    assert.match(await page.textContent('#infoTag'), /spatial optimum/i);
    // One table row per quantity: label, computed here, printed in the book.
    const rows = await page.$$eval('#infoBody table tr', (trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent)));
    assert.deepEqual(rows[0], ['', 'Here', 'Book']);
    const row = (label) => rows.find((r) => r[0].startsWith(label));
    assert.deepEqual(row('Height above the hands H'), ['Height above the hands H', '1.70 m', '1.7 m']);
    assert.deepEqual(row('Arc separation P'), ['Arc separation P', '26.3 cm', '27 cm']);
    assert.deepEqual(row('Pattern width'), ['Pattern width F + P', '91.3 cm', '92 cm']);
    assert.deepEqual(row('Throw error allowed'), ['Throw error allowed Emax', '1.45°', '1.4°']);
    assert.match(text, /Not reproduced at the printed precision: P, the width, Emax/);
  });

  await check('the page says what the math covers: unchecked table rows, the measured 3-ball cascade, the hand-across', async () => {
    assert.match(await page.textContent('#panel .sub'), /Cascades and fountains the optimal way; any other siteswap with exact timing and heights/);
    assert.doesNotMatch(await page.textContent('#panel header'), /Any siteswap, juggled the optimal way/);
    await page.click('#presets [data-pattern="5"]');
    assert.match(await page.textContent('#infoTag'), /table row unchecked/i);
    assert.match(await page.textContent('#infoBody'), /read from search snippets.*not been checked against the book/);
    await page.click('#presets [data-pattern="3"]');
    assert.match(await page.textContent('#infoTag'), /measured cascade/i);
    const three = (await page.textContent('#infoBody')).replace(/\s+/g, ' ');
    assert.match(three, /28\.1 cm/);
    assert.match(three, /Kalvan measured his peak at 33 cm/);
    await page.click('#presets [data-pattern="441"]');
    assert.match((await page.textContent('#infoBody')).replace(/\s+/g, ' '), /handed across 6\.0 cm/);
    // The tag pill and the three-column table fit the panel (nothing spills sideways).
    for (const n of ['3', '5', '6', '7']) {
      await page.click('#presets [data-pattern="' + n + '"]');
      const fit = await page.evaluate(() => {
        const section = document.getElementById('infoBody').parentElement;
        const inside = (node) => node.getBoundingClientRect().right <= section.getBoundingClientRect().right + 0.5;
        return { tag: inside(document.getElementById('infoTag')), table: inside(document.querySelector('#infoBody table')), scroll: document.getElementById('panel').scrollWidth <= document.getElementById('panel').clientWidth };
      });
      assert.deepEqual(fit, { tag: true, table: true, scroll: true }, n + ' balls');
    }
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
    await enter('10');
    assert.match(await page.textContent('#siteswapError'), /lands on beat 2, where the pattern has a 0.*If you meant 10 balls, type a/);
    assert.equal(await app(page, () => window.__vrj.state.pattern.text), '531', 'a refused entry leaves the pattern alone');
    assert.match(await page.textContent('#panel'), /Ten and up are letters: a is 10/);

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

  await check('changing a volume, mute, solo or the speed never makes a sound play twice', async () => {
    // Sounds are handed to the audio clock early, by the output latency. A change of setting used
    // to cancel only those that had not started, then hand all of them over again: every catch
    // inside the latency window sounded twice, and dragging a slider made the rhythm rattle.
    await page.click('#presets [data-pattern="3"]'); // one catch, release and peak per beat, never two at one instant
    await page.click('#speedChips [data-speed="1"]');
    await page.waitForTimeout(600);
    await app(page, () => {
      const v = window.__vrj;
      window.__heard = [];
      const play = v.audio.play;
      v.audio.play = function (type, when, pan, height, sim) {
        const ok = play.call(this, type, when, pan, height, sim);
        if (ok) window.__heard.push(this.pending[this.pending.length - 1]); // the board's own record, cancelled or not
        return ok;
      };
    });
    const measure = async (label, action, options) => {
      await app(page, () => {
        window.__heard.length = 0;
        window.__sim0 = window.__vrj.state.simTime;
      });
      await action();
      await page.waitForTimeout(250);
      const r = await app(page, () => {
        const v = window.__vrj;
        const heard = window.__heard.filter((p) => !p.cancelled).map((p) => ({ type: p.type, sim: p.sim }));
        return { heard, scheduled: window.__heard.length, sim0: window.__sim0, sim1: v.state.simTime, beat: v.state.pattern.beat, horizon: v.schedule.horizon };
      });
      const counts = new Map();
      for (const h of r.heard) {
        const key = h.type + ' at ' + h.sim.toFixed(6);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const doubled = Array.from(counts).filter(([, n]) => n > 1).map(([k]) => k);
      assert.deepEqual(doubled, [], label + ': sounded twice');
      if (!(options && options.someSilent)) {
        // And none went missing: three events a beat over the stretch that was scheduled.
        const expected = ((r.horizon - r.sim0 - 0.2) / r.beat) * 3;
        assert.ok(Math.abs(counts.size - expected) <= 4, label + ': ' + counts.size + ' sounds for about ' + expected.toFixed(0) + ' events');
      }
      return { heard: counts.size, scheduled: r.scheduled };
    };
    const drag = (selector, lo, hi, ms) => async () => {
      await page.locator(selector).scrollIntoViewIfNeeded();
      const box = await page.locator(selector).boundingBox();
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * hi, y);
      await page.mouse.down();
      const t0 = Date.now();
      for (let i = 0; Date.now() - t0 < ms; i++) {
        await page.mouse.move(box.x + box.width * ((lo + hi) / 2 + ((hi - lo) / 2) * Math.sin(i / 5)), y);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    };
    const quiet = await measure('untouched', () => page.waitForTimeout(1500));
    assert.equal(quiet.scheduled, quiet.heard, 'left alone, nothing is scheduled twice or cancelled');
    const volume = await measure('dragging the catch volume slider', drag('.sound[data-sound="catch"] input', 0.3, 0.95, 2200));
    assert.equal(volume.scheduled, volume.heard, 'a volume change schedules nothing again');
    await measure('arrow keys on the release slider', async () => {
      await page.focus('.sound[data-sound="release"] input');
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowLeft');
        await page.waitForTimeout(30);
      }
    });
    await measure(
      'mute and solo',
      async () => {
        for (const button of ['.sound[data-sound="peak"] .mute', '.sound[data-sound="release"] .solo', '.sound[data-sound="release"] .solo', '.sound[data-sound="peak"] .mute']) {
          await page.click(button);
          await page.waitForTimeout(220);
        }
      },
      { someSilent: true }
    );
    await measure('ten clicks on the speed chips', async () => {
      for (let k = 0; k < 10; k++) {
        await page.click('#speedChips [data-speed="' + (k % 2 ? '1' : '0.75') + '"]');
        await page.waitForTimeout(180);
      }
    });
    const speed = await measure('dragging the speed slider', drag('#speed', 0.45, 0.98, 2200));
    assert.ok(speed.scheduled > speed.heard, 'a speed change does cancel and reschedule what had not started');
    await page.click('#speedChips [data-speed="1"]');
    const state = await app(page, () => JSON.parse(JSON.stringify(window.__vrj.audio.settings)));
    assert.ok(state.catch.on && state.release.on && state.peak.on && !state.release.solo, 'mute and solo are back as they were');
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
        if (tweak) tweak(board.settings);
        board.attach(off, { compressor: false });
        Object.defineProperty(board, 'running', { get: () => true });
        board.play(type, 0.05, pan, height, 0);
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
      // The noise in the catch and the release is random: levels are averaged over several renders.
      const level = async (type, tweak) => {
        const runs = 10;
        const mean = { peak: 0, energy: 0 };
        for (let i = 0; i < runs; i++) {
          const one = await render(type, 0, 0, tweak);
          mean.peak += one.peak / runs;
          mean.energy += one.energy / runs;
        }
        return mean;
      };
      return {
        levels: {
          catch: await level('catch'),
          release: await level('release'),
          halfCatch: await level('catch', (s) => { s.catch.volume = 0.4; }),
          equalRelease: await level('release', (s) => { s.release.volume = 0.8; }),
        },
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
    const L = r.levels;
    assert.ok(L.release.energy < L.catch.energy * 0.5, 'release carries less energy than catch at the default volumes');
    // "A little quieter than catch", and audible. On a plain peak meter the release reads about
    // 10 dB under the catch (it was 18 dB under); as the ear and a small speaker hear it, about
    // 4 dB under (README, "Sound levels"; tools/sound-levels.mjs measures that).
    const peakDb = 20 * Math.log10(L.release.peak / L.catch.peak);
    console.log('          release against catch at the default volumes: ' + peakDb.toFixed(1) + ' dB peak');
    assert.ok(peakDb < -7.5 && peakDb > -13, 'release peak ' + peakDb.toFixed(1) + ' dB against the catch');
    // The sliders are a square law, applied on the bus: half the slider is a quarter of the level.
    near(L.halfCatch.peak / L.catch.peak, (0.4 * 0.4) / (0.8 * 0.8), 0.04, 'catch at 40% against 80%');
    near(L.equalRelease.peak / L.release.peak, (0.8 * 0.8) / (0.65 * 0.65), 0.25, 'release at 80% against 65%');
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
        palmBalls: v.xr.controllers.map((c) => c.ball.visible),
        provisional: v.state.provisional,
        renderPath: v.xr.renderPath,
        saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')),
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
    assert.match(s.prompt, /Hold both controllers where you catch/);
    assert.deepEqual(s.palmBalls, [true, true], 'a ball rests in each hand, to show where a ball will land');
    // Until then the hands are a guess 0.6 m below the head. A guess is shown, never remembered.
    near(s.anchor.handHeight, 1.62 - 0.6, 0.01, 'provisional hand height');
    assert.equal(s.provisional, true);
    assert.equal(s.saved.calibrated, false);
    near(s.saved.handHeight, 1.05, 1e-9, 'what is remembered is still the default');
    assert.equal(s.renderPath, 'XRWebGLLayer');
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

  await check('calibration needs both hands: with one controller it says which is missing and records nothing', async () => {
    // Hold the controllers where a juggler catches: in front of the body, either side.
    await app(page, () => {
      const d = window.__xrDevice;
      d.controllers.left.position.set(0.3 - 0.24, 1.02, 0.2 - 0.4);
      d.controllers.right.position.set(0.3 + 0.24, 1.0, 0.2 - 0.38);
      d.controllers.left.connected = false; // put down, or out of the cameras' sight
    });
    await frames(page, 4);
    const before = await app(page, () => Object.assign({}, window.__vrj.state.anchor));
    await pull(page, 'right');
    const s = await app(page, () => {
      const v = window.__vrj;
      return { calibrating: v.state.vr.calibrating, done: v.state.calibration.done, prompt: v.xr.promptLabel.text, anchor: Object.assign({}, v.state.anchor), saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')) };
    });
    assert.equal(s.calibrating, true, 'still asking');
    assert.equal(s.done, false);
    assert.match(s.prompt, /The left controller is not tracked yet/);
    assert.match(s.prompt, /Hold both where you catch, then\npull a trigger/);
    assert.deepEqual(s.anchor, before, 'the pattern has not moved onto the one hand');
    assert.equal(s.saved.calibrated, false);
    await app(page, () => {
      window.__xrDevice.controllers.left.connected = true;
    });
    await frames(page, 4);
  });

  await check('trigger calibrates: records hand height and distance from the body', async () => {
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
        anchor: Object.assign({}, v.state.anchor),
        panel: v.xr.panel.group.visible,
        prompt: v.xr.promptLabel.text,
        patternY: v.stage.anchor.position.y,
        saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')),
        calibrated: v.state.calibration.done,
        provisional: v.state.provisional,
        palmStep: v.state.vr.palmStep,
        palmBalls: v.xr.controllers.map((c) => c.ball.visible),
        inView: v.xr.panelInView(),
      };
    });
    assert.equal(s.calibrating, false);
    assert.equal(s.calibrated, true);
    assert.equal(s.provisional, false);
    near(s.anchor.handHeight, expected.height, 0.005, 'hand height');
    near(s.anchor.distance, expected.out, 0.005, 'distance from the body');
    near(s.patternY, expected.height, 0.005, 'the pattern is built from the hand height');
    near(s.anchor.spotX, expected.headX, 0.005);
    near(s.anchor.spotZ, expected.headZ, 0.005);
    near(s.anchor.yaw, 0, 0.03, 'facing the way the hands are held');
    assert.ok(s.anchor.handHeight > 0.9 && s.anchor.handHeight < 1.1);
    assert.match(s.prompt, /^Calibrated: hands \d\.\d\d m high, 0\.\d\d m out\./);
    assert.equal(s.saved.calibrated, true, 'calibration is remembered');
    near(s.saved.handHeight, expected.height, 0.005, 'remembered hand height');
    near(s.saved.eyeHeight, 1.62, 0.01, 'with the eye height it was made at');
    assert.equal(s.saved.frames.length, 2, 'and how the hands were held');
    // The first time, calibration goes on to the palm (spec: "calibration includes nudging that
    // point until a virtual ball resting in the hand feels like it sits in the real palm").
    assert.equal(s.palmStep, true);
    assert.deepEqual(s.palmBalls, [true, true], 'a ball rests in each hand');
    assert.match(s.prompt, /Is the ball in each palm\? If not, nudge it\non the board\. Then press A or X\./);
    assert.equal(s.panel, true);
    assert.equal(s.inView, true, 'the board is in front, where the nudge buttons can be reached');
  });

  await check('the palm step: a nudge moves the pattern with the palm point; A or X ends it', async () => {
    // The hands as they were when the trigger was pulled.
    const pose = await app(page, () => {
      const c = window.__xrDevice.controllers;
      const q = (k) => [k.quaternion.x, k.quaternion.y, k.quaternion.z, k.quaternion.w];
      return { left: q(c.left), right: q(c.right) };
    });
    const read = () =>
      app(page, (pose) => {
        const v = window.__vrj;
        const c = window.__xrDevice.controllers;
        // Hold the hands that way again (pointing at the board turned the right one).
        c.left.quaternion.set(...pose.left);
        c.right.quaternion.set(...pose.right);
        return new Promise((resolve) =>
          setTimeout(() => {
            const sample = v.xr.sample();
            const mid = sample.palms[0].clone().add(sample.palms[1]).multiplyScalar(0.5);
            const a = v.state.anchor;
            resolve({ palmY: mid.y, palmOut: Math.hypot(mid.x - a.spotX, mid.z - a.spotZ), handHeight: a.handHeight, distance: a.distance, nudge: Object.assign({}, v.state.nudge), saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')) });
          }, 120)
        );
      }, pose);
    const before = await read();
    near(before.handHeight, before.palmY, 1e-4, 'the catch height is the palm height');
    near(before.distance, before.palmOut, 1e-4, 'and the catch point is where the palms are');
    for (const button of ['nudge:palm:+', 'nudge:palm:+', 'nudge:palm:+', 'nudge:palm:+', 'nudge:wrist:-', 'nudge:wrist:-', 'nudge:wrist:-', 'nudge:thumb:+', 'nudge:thumb:+']) await press(page, button);
    const after = await read();
    near(after.nudge.palm, 0.02, 1e-9);
    near(after.nudge.wrist, -0.015, 1e-9);
    near(after.nudge.thumb, 0.01, 1e-9);
    const moved = Math.hypot(after.palmY - before.palmY, after.palmOut - before.palmOut);
    assert.ok(moved > 0.004, 'the palm point really moved: ' + (moved * 1000).toFixed(1) + ' mm');
    // The pattern went with it: a ball still lands in the palm of a hand held as at calibration.
    near(after.handHeight, after.palmY, 2e-4, 'catch height after the nudge');
    near(after.distance, after.palmOut, 2e-4, 'catch distance after the nudge');
    near(after.saved.handHeight, after.handHeight, 1e-9, 'and that is what is remembered');
    near(after.saved.distance, after.distance, 1e-9);
    assert.equal(await app(page, () => window.__vrj.state.vr.palmStep), true, 'nudging does not end the step');

    await pull(page, 'right', 'a-button');
    const s = await app(page, () => {
      const v = window.__vrj;
      return { palmStep: v.state.vr.palmStep, palmBalls: v.xr.controllers.map((c) => c.ball.visible), panel: v.xr.panel.group.visible, inView: v.xr.panelInView(), prompt: v.xr.promptLabel.text, saved: JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')) };
    });
    assert.equal(s.palmStep, false);
    assert.deepEqual(s.palmBalls, [false, false]);
    assert.match(s.prompt, /Controls: on your left/);
    assert.equal(s.panel, true, 'the control board stays, off to the side');
    assert.equal(s.inView, false, 'out of the way of the pattern');
    assert.equal(s.saved.palmChecked, true, 'the palm step is not asked for again');
    // Back to no nudge for the checks that follow.
    await app(page, () => {
      const v = window.__vrj;
      for (const key of ['palm', 'wrist', 'thumb']) v.ui.h.onNudge(key, 0);
    });
    const reset = await read();
    near(reset.handHeight, before.handHeight, 1e-6, 'undoing the nudge undoes the move');
    near(reset.distance, before.distance, 1e-6);
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

  await check('recalibrating from the board works, A cancels it, and the palm step is not repeated', async () => {
    const saved = () => app(page, () => JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')));
    const before = await saved();
    await press(page, 'calibrate');
    assert.equal(await app(page, () => window.__vrj.state.vr.calibrating), true);
    assert.equal(await app(page, () => window.__vrj.xr.panel.group.visible), false);
    assert.deepEqual(await app(page, () => window.__vrj.xr.controllers.map((c) => c.ball.visible)), [true, true]);
    await pull(page, 'left', 'x-button');
    assert.equal(await app(page, () => window.__vrj.state.vr.calibrating), false);
    assert.equal(await app(page, () => window.__vrj.xr.panel.group.visible), true);
    assert.deepEqual(await app(page, () => window.__vrj.xr.controllers.map((c) => c.ball.visible)), [false, false]);
    assert.deepEqual(await saved(), before, 'a cancelled calibration records nothing');
    // This time go through with it.
    await press(page, 'calibrate');
    await pull(page, 'right');
    const s = await app(page, () => {
      const v = window.__vrj;
      const head = v.xr.headPosition(new v.THREE.Vector3());
      return { calibrating: v.state.vr.calibrating, palmStep: v.state.vr.palmStep, prompt: v.xr.promptLabel.text, inView: v.xr.panelInView(), panel: v.xr.panel.group.visible, spot: [v.state.anchor.spotX, v.state.anchor.spotZ], head: [head.x, head.z], balls: v.xr.controllers.map((c) => c.ball.visible) };
    });
    assert.equal(s.calibrating, false);
    assert.equal(s.palmStep, false, 'the palm was checked the first time');
    assert.match(s.prompt, /Calibrated: hands .* m high, .* m out\.\nControls: on your left, or press A or X/);
    assert.deepEqual([s.panel, s.inView], [true, false], 'the control board comes back, off to the side');
    assert.deepEqual(s.balls, [false, false]);
    near(s.spot[0], s.head[0], 1e-6, "the juggler's spot is where the person stands now");
    near(s.spot[1], s.head[1], 1e-6);
  });

  await check('frames keep coming in VR and the scene is drawn for the headset', async () => {
    const a = await app(page, () => ({ f: window.__vrj.xr.frames, calls: window.__vrj.stage.renderer.info.render.calls }));
    await page.waitForTimeout(500);
    const b = await app(page, () => ({ f: window.__vrj.xr.frames }));
    assert.ok(b.f > a.f + 2, 'XR frames advanced by ' + (b.f - a.f));
    assert.ok(a.calls > 5);
  });

  await check('if something in VR breaks, the view still follows the head', async () => {
    const head = () => app(page, () => window.__vrj.xr.headPosition(new window.__vrj.THREE.Vector3()).toArray());
    const device = () => app(page, () => [window.__xrDevice.position.x, window.__xrDevice.position.y, window.__xrDevice.position.z]);
    const h0 = await head();
    const d0 = await device();
    await app(page, () => {
      const v = window.__vrj;
      v.keepSetModel = v.xr.panel.setModel;
      v.xr.panel.setModel = () => {
        throw new Error('smoke test: the board failed');
      };
      window.__xrDevice.position.set(window.__xrDevice.position.x + 0.2, window.__xrDevice.position.y - 0.1, window.__xrDevice.position.z);
    });
    await frames(page, 5);
    const h1 = await head();
    const d1 = await device();
    near(h1[1] - h0[1], d1[1] - d0[1], 1e-3, 'the head height follows the headset');
    near(Math.hypot(h1[0] - h0[0], h1[2] - h0[2]), 0.2, 1e-3, 'the head position follows the headset');
    await app(page, () => {
      const v = window.__vrj;
      v.xr.panel.setModel = v.keepSetModel;
      window.__xrDevice.position.set(window.__xrDevice.position.x - 0.2, window.__xrDevice.position.y + 0.1, window.__xrDevice.position.z);
    });
    await frames(page, 3);
    // It is reported once, not once per frame.
    const reports = problems.filter((p) => /VR update failed/.test(p));
    assert.equal(reports.length, 1);
    problems.splice(0, problems.length, ...problems.filter((p) => !/VR update failed|smoke test: the board failed/.test(p)));
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
    // How the session ran is on the page afterwards (for the first try in a real headset).
    assert.match(await page.textContent('#vrNote'), /^Last VR session: \d+ frames a second on average, slowest frame \d+ ms, drawn through XRWebGLLayer\.$/);
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

  // Sitting and standing. In tracking space: the head, and the hands 0.6 m below it.
  const posture = (eyes) =>
    app(page, (y) => {
      const d = window.__xrDevice;
      d.position.set(0.3, y, 0.2);
      d.controllers.left.position.set(0.3 - 0.24, y - 0.6, 0.2 - 0.38);
      d.controllers.right.position.set(0.3 + 0.24, y - 0.6, 0.2 - 0.38);
      d.controllers.left.quaternion.set(0, 0, 0, 1);
      d.controllers.right.quaternion.set(0, 0, 0, 1);
    }, eyes);
  const enter = async () => {
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 4);
  };
  const leave = async () => {
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    await frames(page, 3);
  };
  const remembered = () =>
    app(page, () => {
      const s = JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1'));
      return { handHeight: s.handHeight, distance: s.distance, eyeHeight: s.eyeHeight, calibrated: s.calibrated };
    });
  const now = () =>
    app(page, () => {
      const v = window.__vrj;
      return { asked: v.state.vr.calibrating, provisional: v.state.provisional, handHeight: v.state.anchor.handHeight, distance: v.state.anchor.distance };
    });

  await check('a calibration made standing is not used sitting down; skipping the prompt does not overwrite it', async () => {
    const standing = await remembered();
    near(standing.eyeHeight, 1.62, 0.01);
    await posture(1.15); // sat down
    await enter();
    let s = await now();
    assert.equal(s.asked, true, 'asks to calibrate in the new posture');
    assert.equal(s.provisional, true);
    near(s.handHeight, 0.55, 0.01, 'shows a guess, 0.6 m below the head');
    await pull(page, 'right', 'a-button'); // skip
    assert.equal((await now()).asked, false);
    await leave();
    assert.deepEqual(await remembered(), standing, 'the real calibration is untouched by a session that only guessed');
    // The flat page shows the remembered calibration again, not the guess.
    const flat = await app(page, () => Object.assign({}, window.__vrj.state.anchor));
    near(flat.handHeight, standing.handHeight, 1e-9);
    near(flat.eyeHeight, standing.eyeHeight, 1e-9);
    assert.equal(await page.textContent('#handHeightVal'), standing.handHeight.toFixed(2) + ' m');

    await posture(1.62); // standing again
    await enter();
    s = await now();
    assert.equal(s.asked, false, 'standing again: the standing calibration fits, no prompt');
    near(s.handHeight, standing.handHeight, 1e-9);
    near(s.distance, standing.distance, 1e-9);
    await leave();
    assert.deepEqual(problems, []);
  });

  await check('a calibration made sitting is not used standing up (the pattern is not built 40 cm too low)', async () => {
    await posture(1.25);
    await enter();
    assert.equal((await now()).asked, true);
    await pull(page, 'right'); // trigger: calibrate sitting, hands 0.6 m below the eyes
    const sitting = await remembered();
    assert.equal(sitting.calibrated, true);
    near(sitting.eyeHeight, 1.25, 0.01);
    near(sitting.handHeight, 0.634, 0.02);
    assert.equal(await app(page, () => window.__vrj.state.vr.palmStep), false);
    await leave();
    for (const eyes of [1.65, 1.78]) {
      await posture(eyes);
      await enter();
      const s = await now();
      assert.equal(s.asked, true, 'standing at ' + eyes + ' m: asks again');
      near(s.handHeight, eyes - 0.6, 0.01, 'and guesses from this head height, not ' + sitting.handHeight.toFixed(2) + ' m');
      await pull(page, 'right', 'a-button');
      await leave();
      assert.deepEqual(await remembered(), sitting);
    }
    // Adjusting a guess by hand in VR does make it the calibration for that posture.
    await posture(1.62);
    await enter();
    await pull(page, 'right', 'a-button'); // skip the prompt; the board comes in front
    await press(page, 'height:+');
    const manual = await remembered();
    assert.equal(manual.calibrated, true);
    near(manual.eyeHeight, 1.62, 0.01, 'remembered with the eye height it was set at');
    near(manual.handHeight, 1.03, 0.011);
    near(manual.distance, 0.35, 1e-9);
    assert.equal((await now()).provisional, false);
    await leave();
    await enter();
    assert.equal((await now()).asked, false, 'and it is used the next time in that posture');
    await leave();
    assert.deepEqual(problems, []);
  });

  await context.close();
}

/** Scripts injected before the page, to imitate things a real headset does that the emulator does not. */
const imitate = {
  // No head pose for the first frames of every session (three.js itself allows for this).
  latePose: () => {
    const original = XRFrame.prototype.getViewerPose;
    window.__poseCalls = 0;
    window.__posesWithheld = 0;
    XRFrame.prototype.getViewerPose = function (space) {
      if (++window.__poseCalls <= 8) {
        window.__posesWithheld++;
        return null;
      }
      return original.call(this, space);
    };
    const xr = navigator.xr;
    const request = xr.requestSession;
    xr.requestSession = function (mode, init) {
      window.__poseCalls = 0; // a new session: withhold its first poses too
      return request.call(xr, mode, init);
    };
  },
  // An input source with no grip space: a gaze or screen source, as on a phone in a viewer.
  noGrip: () => {
    const real = Object.getOwnPropertyDescriptor(XRInputSource.prototype, 'gripSpace');
    Object.defineProperty(XRInputSource.prototype, 'gripSpace', { get: () => null, configurable: true });
    // The emulator needs its own grip space back before it can end the session.
    window.__restoreGrip = () => Object.defineProperty(XRInputSource.prototype, 'gripSpace', real);
  },
  // A headset takes a moment to start a session, and refuses a second request meanwhile.
  slowStart: () => {
    const xr = navigator.xr;
    const real = xr.requestSession;
    let pending = false;
    window.__requests = [];
    xr.requestSession = function (mode, init) {
      window.__requests.push(JSON.parse(JSON.stringify(init || {})));
      if (pending) return Promise.reject(new DOMException('There is already a pending immersive session request.', 'InvalidStateError'));
      pending = true;
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          real.call(xr, mode, init).then(
            (session) => {
              pending = false;
              resolve(session);
            },
            (err) => {
              pending = false;
              reject(err);
            }
          );
        }, 700)
      );
    };
  },
  // A browser that has WebXR Layers (a Quest does; the emulator does not): three.js then takes
  // its projection-layer path, which the emulator cannot serve.
  hasLayers: () => {
    const xr = navigator.xr;
    const real = xr.requestSession;
    window.__requests = [];
    xr.requestSession = function (mode, init) {
      window.__requests.push(JSON.parse(JSON.stringify(init || {})));
      return real.call(xr, mode, init).then((session) => {
        Object.defineProperty(Object.getPrototypeOf(session.renderState), 'layers', { get: () => [], configurable: true });
        return session;
      });
    };
  },
};

async function quest1Edges(browser, base) {
  console.log('\nEmulated Quest 1: things that go differently on a real headset');
  const seed = () => {
    // Someone who calibrated standing on an earlier visit.
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('vr-juggling-visualizer.v1', JSON.stringify({ text: '3', handHeight: 1.0, distance: 0.34, eyeHeight: 1.62, calibrated: true, palmChecked: true, nudge: { palm: 0, wrist: 0, thumb: 0 } }));
  };
  const stand = (page) =>
    app(page, () => {
      const d = window.__xrDevice;
      d.position.set(1.2, 1.62, -0.8);
      d.controllers.left.position.set(0.96, 1.0, -1.16);
      d.controllers.right.position.set(1.44, 1.0, -1.16);
    });
  const saved = (page) => app(page, () => JSON.parse(localStorage.getItem('vr-juggling-visualizer.v1')));

  await check("the juggler's spot waits for the first real head pose (none on the first frames)", async () => {
    const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, pre: imitate.latePose });
    await app(page, seed);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__vrj && window.__vrj.state.pattern && !window.__vrj.state.vr.checking);
    await stand(page);
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 3);
    const s = await app(page, () => {
      const v = window.__vrj;
      return { poseCalls: window.__poseCalls, withheld: window.__posesWithheld, anchor: Object.assign({}, v.state.anchor), asked: v.state.vr.calibrating, provisional: v.state.provisional };
    });
    assert.ok(s.poseCalls > 8 && s.withheld >= 8, 'the first frames really had no pose');
    // Placed where the head is, not at the origin of the room with the eyes on the floor.
    near(s.anchor.spotX, 1.2, 0.01, 'spot x');
    near(s.anchor.spotZ, -0.8, 0.01, 'spot z');
    near(s.anchor.eyeHeight, 1.62, 0.01, 'eye height');
    near(s.anchor.handHeight, 1.0, 1e-9, 'the remembered calibration is kept');
    assert.equal(s.asked, false, 'and no needless prompt');
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    const after = await saved(page);
    assert.deepEqual([after.handHeight, after.distance, after.eyeHeight, after.calibrated], [1.0, 0.34, 1.62, true]);
    near(await app(page, () => window.__vrj.stage.camera.position.y), 1.62, 0.05, 'the flat view is at eye height, not on the floor');

    // A second session, somewhere else in the room: three.js still holds the cameras of the
    // first one, so "there are cameras" would not mean "there is a pose".
    await app(page, () => {
      const d = window.__xrDevice;
      d.position.set(-0.9, 1.6, 0.7);
      d.controllers.left.position.set(-1.14, 1.0, 0.34);
      d.controllers.right.position.set(-0.66, 1.0, 0.34);
      window.__posesWithheld = 0;
    });
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 3);
    const second = await app(page, () => ({ withheld: window.__posesWithheld, anchor: Object.assign({}, window.__vrj.state.anchor) }));
    assert.ok(second.withheld >= 8, 'the second session also began without a pose');
    near(second.anchor.spotX, -0.9, 0.01, 'second session: spot x is where the head is now, not where it was');
    near(second.anchor.spotZ, 0.7, 0.01, 'second session: spot z');
    near(second.anchor.eyeHeight, 1.6, 0.01);
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.deepEqual(problems, []);
    await context.close();
  });

  await check('with no grip pose there is no palm: nothing is ever calibrated from the pointing ray', async () => {
    const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, pre: imitate.noGrip });
    await stand(page);
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 4);
    const before = await app(page, () => {
      const v = window.__vrj;
      const c = v.xr.controllers.find((k) => k.handedness === 'right');
      const cupDrawn = (o) => {
        for (let p = o; p; p = p.parent) if (!p.visible) return false;
        return true;
      };
      return { ray: c.ray.visible, palm: v.xr.palmPosition(0, new v.THREE.Vector3()), cup: cupDrawn(c.cup), asked: v.state.vr.calibrating, anchor: Object.assign({}, v.state.anchor) };
    });
    assert.equal(before.ray, true, 'the pointing ray is tracked');
    assert.equal(before.palm, null, 'but it is not a palm');
    assert.equal(before.cup, false, 'and no hand is drawn at it');
    assert.equal(before.asked, true);
    await pull(page, 'right');
    const s = await app(page, () => {
      const v = window.__vrj;
      return { done: v.state.calibration.done, asked: v.state.vr.calibrating, prompt: v.xr.promptLabel.text, anchor: Object.assign({}, v.state.anchor), panel: v.xr.panel.group.visible };
    });
    assert.equal(s.done, false, 'nothing is recorded');
    assert.equal(s.asked, false, 'and the person is not left with a prompt they cannot satisfy');
    assert.match(s.prompt, /No hand controllers here\.\nThe pattern stays in a standard place/);
    assert.deepEqual(s.anchor, before.anchor, 'the pattern stays where it was');
    assert.equal(s.panel, true);
    assert.equal((await saved(page)).calibrated, false);
    await app(page, () => window.__restoreGrip());
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.deepEqual(problems, []);
    await context.close();
  });

  await check('a second press of Enter VR while the session is starting asks nothing twice and leaves no error', async () => {
    const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, pre: imitate.slowStart });
    await stand(page);
    await page.click('#enterVR');
    assert.equal(await page.textContent('#enterVR'), 'Starting VR');
    assert.equal(await page.isDisabled('#enterVR'), true);
    // A press that gets through anyway (a controller trigger on the button, say).
    await app(page, () => window.__vrj.ui.h.onEnterVR());
    await page.waitForFunction(() => window.__vrj.state.vr.presenting, null, { timeout: 10000 });
    assert.equal(await app(page, () => window.__requests.length), 1, 'one session request');
    assert.equal(await app(page, () => window.__vrj.state.vr.error), '');
    await page.waitForFunction(() => window.__vrj.xr.placed);
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.equal(await page.textContent('#enterVR'), 'Enter VR');
    assert.doesNotMatch(await page.textContent('#vrNote'), /Could not start|pending/);
    assert.deepEqual(problems, []);
    await context.close();
  });

  await check('an earlier failure to start is not shown after a session that worked', async () => {
    const { page, context } = await open(browser, base, { xr: true, stereo: true });
    await stand(page);
    await app(page, () => {
      const xr = navigator.xr;
      const real = xr.requestSession;
      let first = true;
      xr.requestSession = function (mode, init) {
        if (first) {
          first = false;
          return Promise.reject(new DOMException('The headset was busy.', 'InvalidStateError'));
        }
        return real.call(xr, mode, init);
      };
    });
    await page.click('#enterVR');
    await page.waitForFunction(() => /Could not start VR: The headset was busy/.test(document.getElementById('vrNote').textContent));
    assert.equal(await page.textContent('#enterVR'), 'Enter VR', 'the button is live again');
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    assert.doesNotMatch(await page.textContent('#vrNote'), /Could not start/);
    await context.close();
  });

  await check('where the projection layer cannot be set up, VR falls back to a plain WebGL layer', async () => {
    const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, pre: imitate.hasLayers });
    await stand(page);
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 4);
    const s = await app(page, () => {
      const v = window.__vrj;
      return { asked: window.__requests[0].optionalFeatures, path: v.xr.renderPath, error: v.state.vr.error, frames: v.xr.frames, layersNow: v.xr.session.renderState.layers !== undefined, calls: v.stage.renderer.info.render.calls };
    });
    assert.ok(s.asked.includes('layers'), 'layers are asked for by default: ' + s.asked.join(', '));
    assert.equal(s.path, 'XRWebGLLayer');
    assert.equal(s.error, '');
    assert.ok(s.frames > 3 && s.calls > 5, 'and it draws');
    assert.equal(s.layersNow, true, 'the session itself is left as the browser made it');
    const warned = problems.filter((p) => /projection layer could not be set up/.test(p));
    assert.equal(warned.length, 1, 'said once in the console: ' + JSON.stringify(problems));
    assert.deepEqual(problems.filter((p) => !/projection layer could not be set up/.test(p)), []);
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    await context.close();
  });

  await check('?layers=off draws through the plain WebGL layer from the start', async () => {
    const { page, context, problems } = await open(browser, base + '?layers=off', { xr: true, stereo: true, pre: imitate.hasLayers });
    await stand(page);
    await page.click('#enterVR');
    await page.waitForFunction(() => window.__vrj.state.vr.presenting && window.__vrj.xr.placed, null, { timeout: 10000 });
    await frames(page, 4);
    const s = await app(page, () => ({ asked: window.__requests[0].optionalFeatures, path: window.__vrj.xr.renderPath, frames: window.__vrj.xr.frames }));
    assert.ok(!s.asked.includes('layers'), 'layers are not asked for: ' + s.asked.join(', '));
    assert.equal(s.path, 'XRWebGLLayer');
    assert.ok(s.frames > 3);
    assert.deepEqual(problems, [], 'no failed first attempt');
    await app(page, () => window.__vrj.xr.exit());
    await page.waitForFunction(() => !window.__vrj.state.vr.presenting);
    await context.close();
  });
}

async function quest1Hands(browser, base) {
  console.log('\nEmulated Quest 1 with the hand-tracking toggle on');
  const { page, context, problems } = await open(browser, base, { xr: true, stereo: true, viewport: { width: 1280, height: 720 } });
  const drawn = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };

  await check('hand tracking is requested only when the toggle is on; the hands are drawn in one draw call', async () => {
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
        dots: v.xr.jointDots ? { count: v.xr.jointDots.count, visible: v.xr.jointDots.visible, instanced: !!v.xr.jointDots.isInstancedMesh } : null,
        meshesPerJoint: c ? Object.values(c.hand.joints).filter((j) => j.children.length > 0).length : -1,
        prompt: v.xr.promptLabel.text,
        usingHands: v.xr.usingHands(),
      };
    });
    assert.ok(s.features.includes('hand-tracking'), 'features: ' + s.features.join(', '));
    assert.equal(s.isHand, true);
    assert.equal(s.joints, 25);
    assert.deepEqual(s.dots, { count: 50, visible: true, instanced: true }, 'both tracked hands are drawn, as one instanced mesh');
    assert.equal(s.meshesPerJoint, 0, 'not as a mesh per joint');
    assert.equal(s.usingHands, true);
    // Hands have no buttons: the prompt asks for a pinch and offers no button to skip with.
    assert.match(s.prompt, /Hold both hands where you catch,\nthen pinch/);
    assert.doesNotMatch(s.prompt, /A or X|trigger|controller/);
  });

  await check('tracked hands: the palm point is in the palm, a ball rests on it, and the nudge moves it', async () => {
    const measure = () =>
      app(page, (drawnSource) => {
        const v = window.__vrj;
        const T = v.THREE;
        const drawn = new Function('return ' + drawnSource)();
        const out = {};
        for (const name of ['right', 'left']) {
          const c = v.xr.controllers.find((k) => k.handedness === name);
          const joint = (n) => c.hand.joints[n].getWorldPosition(new T.Vector3());
          const q = c.hand.joints['middle-finger-metacarpal'].getWorldQuaternion(new T.Quaternion());
          const base = joint('middle-finger-metacarpal');
          const knuckle = joint('middle-finger-phalanx-proximal');
          const palm = v.xr.palmPosition(name === 'right' ? 0 : 1, new T.Vector3());
          const mid = base.clone().add(knuckle).multiplyScalar(0.5);
          const off = palm.clone().sub(mid);
          const outOfPalm = new T.Vector3(0, -1, 0).applyQuaternion(q); // WebXR Hand Input: -Y is out of the palm
          const thumb = joint('thumb-tip').sub(mid);
          out[name] = {
            from: c.palmFrom,
            toBase: palm.distanceTo(base),
            alongNormal: off.dot(outOfPalm),
            offNormal: off.clone().sub(outOfPalm.clone().multiplyScalar(off.dot(outOfPalm))).length(),
            radius: c.hand.joints['middle-finger-metacarpal'].jointRadius,
            palm: palm.toArray(),
            outOfPalm: outOfPalm.toArray(),
            thumbSide: thumb.normalize().toArray(),
            cup: drawn(c.cup),
            ball: drawn(c.ball),
            grip: c.grip.visible,
          };
        }
        return out;
      }, drawn.toString());
    const before = await measure();
    for (const name of ['right', 'left']) {
      const h = before[name];
      assert.equal(h.from, 'hand', name + ': the palm frame comes from the hand joints');
      assert.equal(h.grip, false, name + ': three.js gives a tracked hand no grip pose');
      assert.ok(h.toBase > 0.03, name + ': not the joint at the heel of the hand (' + (h.toBase * 100).toFixed(1) + ' cm from it)');
      // Halfway along the palm bone, lifted out of the palm by the bone radius plus a ball radius.
      near(h.alongNormal, h.radius + 0.03, 1e-4, name + ': a ball there rests on the skin of the palm');
      assert.ok(h.offNormal < 1e-4, name + ': straight out of the palm');
      assert.equal(h.cup, true, name + ': the own-hand cup is drawn');
      assert.equal(h.ball, true, name + ': and the palm ball, during calibration');
    }
    // The three nudges move the palm point along the hand's own axes, mirrored between the hands.
    const nudged = async (key) => {
      await app(page, (k) => window.__vrj.ui.h.onNudge(k, 0.03), key);
      await frames(page, 3);
      const after = await measure();
      await app(page, (k) => window.__vrj.ui.h.onNudge(k, 0), key);
      await frames(page, 3);
      const move = (name) => after[name].palm.map((x, i) => x - before[name].palm[i]);
      return { right: move('right'), left: move('left') };
    };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const palm = await nudged('palm');
    for (const name of ['right', 'left']) {
      near(Math.hypot(...palm[name]), 0.03, 1e-4, name + ': a 3 cm nudge moves the palm point 3 cm');
      near(dot(palm[name], before[name].outOfPalm), 0.03, 1e-4, name + ': "to palm" is out of the palm');
    }
    const thumb = await nudged('thumb');
    for (const name of ['right', 'left']) {
      near(Math.hypot(...thumb[name]), 0.03, 1e-4);
      assert.ok(dot(thumb[name], before[name].thumbSide) > 0.02, name + ': "to thumb" goes toward the thumb');
    }
    const wrist = await nudged('wrist');
    for (const name of ['right', 'left']) near(Math.hypot(...wrist[name]), 0.03, 1e-4);
  });

  await check('tracked hands: a pinch calibrates from the palm points, then the palm step ends on the board', async () => {
    const expected = await app(page, () => {
      const s = window.__vrj.xr.sample();
      const mid = s.palms[0].clone().add(s.palms[1]).multiplyScalar(0.5);
      return { height: mid.y, out: Math.hypot(mid.x - s.head.x, mid.z - s.head.z), frames: s.frames.every(Boolean), trackable: s.trackable };
    });
    assert.equal(expected.frames, true);
    assert.equal(expected.trackable, true);
    // A pinch is the hand's trigger.
    await app(page, () => window.__xrDevice.hands.right.updatePinchValue(1));
    await frames(page, 4);
    await app(page, () => window.__xrDevice.hands.right.updatePinchValue(0));
    await frames(page, 3);
    const s = await app(page, () => {
      const v = window.__vrj;
      return { done: v.state.calibration.done, anchor: Object.assign({}, v.state.anchor), palmStep: v.state.vr.palmStep, prompt: v.xr.promptLabel.text, hands: v.xr.panel.model.hands };
    });
    assert.equal(s.done, true);
    near(s.anchor.handHeight, expected.height, 0.005, 'hand height is the height of the palm points');
    near(s.anchor.distance, expected.out, 0.005);
    assert.equal(s.palmStep, true);
    assert.match(s.prompt, /Then press "palm ball"\./);
    assert.doesNotMatch(s.prompt, /A or X/);
    assert.equal(s.hands, true, 'the board explains pointing and pinching, not buttons');
    await app(page, () => window.__vrj.panelAction('palmball'));
    await frames(page, 2);
    const done = await app(page, () => ({ palmStep: window.__vrj.state.vr.palmStep, prompt: window.__vrj.xr.promptLabel.text, balls: window.__vrj.xr.controllers.map((c) => c.ball.visible) }));
    assert.equal(done.palmStep, false);
    assert.equal(done.prompt, 'Controls: on your left');
    assert.deepEqual(done.balls, [false, false]);
    // Few draw calls, hands included (a mesh per joint made this 134).
    await app(page, () => {
      const q = window.__xrDevice.quaternion;
      const half = (-50 * Math.PI) / 360; // look down at the pattern
      q.set(Math.sin(half), 0, 0, Math.cos(half));
      window.__vrj.setPattern('3');
    });
    await frames(page, 4);
    const calls = await app(page, () => window.__vrj.stage.renderer.info.render.calls);
    console.log('          draw calls with both hands tracked, both eyes, looking at the 3-ball pattern: ' + calls);
    assert.ok(calls > 10 && calls < 80, 'draw calls: ' + calls);
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

/**
 * Sound and gestures. Playwright's evaluate() counts as a user gesture, so this part reads the
 * page through the debugger protocol with the gesture flag off, and touches it only with real
 * (synthesised) key presses and clicks.
 */
async function gestures(browser, base) {
  console.log('\nSound waits for a real gesture');
  const session = async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    const warnings = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
    });
    const client = await context.newCDPSession(page);
    const probe = async (expression) => {
      const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false });
      if (r.exceptionDetails) throw new Error('probe failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    await page.goto(base, { waitUntil: 'load' });
    for (let i = 0; i < 100 && !(await probe('!!(window.__vrj && window.__vrj.state.pattern)')); i++) await page.waitForTimeout(50);
    await page.waitForTimeout(300);
    const state = () =>
      probe('({ ctx: window.__vrj.audio.ctx ? window.__vrj.audio.ctx.state : null, active: navigator.userActivation.hasBeenActive, chip: !document.getElementById("soundChip").hidden })');
    return { context, page, warnings, state };
  };

  await check('a key that is not a gesture (Escape, Shift) starts nothing: no audio context, no browser warning', async () => {
    for (const key of ['Escape', 'Shift']) {
      const { context, page, warnings, state } = await session();
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      const s = await state();
      assert.equal(s.active, false, key + ' is not a gesture to the browser');
      assert.equal(s.ctx, null, key + ': no audio context was made');
      assert.equal(s.chip, true, 'the page still says that sound is off');
      assert.deepEqual(warnings.filter((w) => /AudioContext/.test(w)), [], key);
      // The next real click starts sound cleanly.
      await page.mouse.click(700, 350);
      await page.waitForTimeout(400);
      const after = await state();
      assert.equal(after.ctx, 'running', 'sound starts on the first real click after ' + key);
      assert.equal(after.chip, false);
      assert.deepEqual(warnings.filter((w) => /AudioContext/.test(w)), []);
      await context.close();
    }
  });

  await check('a key that is a gesture (a letter) starts sound', async () => {
    const { context, page, warnings, state } = await session();
    await page.keyboard.press('a');
    await page.waitForTimeout(400);
    const s = await state();
    assert.equal(s.active, true);
    assert.equal(s.ctx, 'running');
    assert.deepEqual(warnings.filter((w) => /AudioContext/.test(w)), []);
    await context.close();
  });
}

/** A browser that cannot draw 3D at all. */
async function no3D(base) {
  console.log('\nA browser without WebGL');
  const browser = await chromium.launch({ args: ['--disable-3d-apis'] }).catch(() => chromium.launch({ channel: 'chrome', args: ['--disable-3d-apis'] }));
  try {
    await check('says so where the picture would be, and offers no dead controls', async () => {
      const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.classList.contains('no-3d'), null, { timeout: 10000 });
      assert.equal(await page.isVisible('#stageMessage'), true);
      assert.match(await page.textContent('#stageMessage'), /could not start WebGL, which the 3D view needs/);
      const box = await page.locator('#stageMessage').boundingBox();
      assert.ok(box.x >= 350 && box.width > 500, 'the message sits where the 3D view would be');
      assert.equal(await page.textContent('#enterVR'), '3D view not available');
      assert.equal(await page.isDisabled('#enterVR'), true);
      assert.match(await page.textContent('#vrNote'), /What the browser said: /);
      for (const hidden of ['#soundChip', '#soundHint', '#siteswapForm', '#speed', '#viewButtons', '#handHeight']) {
        assert.equal(await page.isVisible(hidden), false, hidden + ' is not offered');
      }
      assert.equal(await page.isVisible('#panel h1'), true, 'the page still says what it is');
      assert.equal(await page.isVisible('#panel footer'), true);
      assert.deepEqual(errors, [], 'no uncaught error');
      await page.screenshot({ path: path.join(OUT, 'flat-no-webgl.png') });
      await context.close();
    });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------

const started = Date.now();
const { server, url } = await listen({});
let browser;
try {
  if (process.env.SMOKE_EXECUTABLE) {
    browser = await chromium.launch({ executablePath: process.env.SMOKE_EXECUTABLE, args: GL_ARGS });
  } else if (process.env.SMOKE_CHANNEL) {
    browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL, args: GL_ARGS });
  } else {
    try {
      browser = await chromium.launch({ args: GL_ARGS });
    } catch (err) {
      console.log('Bundled Chromium not found (' + String(err.message).split('\n')[0] + '); trying the installed Chrome.');
      browser = await chromium.launch({ channel: 'chrome', args: GL_ARGS });
    }
  }
  console.log('Chromium ' + browser.version() + ', page at ' + url);
  // SMOKE_ONLY=flat,quest1 (and so on) runs some of the parts; without it, all of them.
  const only = (process.env.SMOKE_ONLY || '').split(',').filter(Boolean);
  const wanted = (name) => only.length === 0 || only.includes(name);
  if (wanted('flat')) await flatScreen(browser, url);
  if (wanted('phone')) await phone(browser, url);
  if (wanted('path')) await liveSitePath(browser);
  if (wanted('gestures')) await gestures(browser, url);
  if (wanted('quest1')) await quest1(browser, url);
  if (wanted('edges')) await quest1Edges(browser, url);
  if (wanted('hands')) await quest1Hands(browser, url);
  if (wanted('no3d')) await no3D(url);
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
