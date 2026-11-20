import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPattern, throwAtBeat, flightState, G } from '../src/physics.js';
import { guideLines } from '../src/guides.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/** Where a crossing throw of this value passes x = 0, found by bisection on the simulated path. */
function simulatedCrossing(pattern, value) {
  for (let i = 0; i < pattern.cycleBeats; i++) {
    const rec = throwAtBeat(pattern, i);
    if (!rec.air || rec.value !== value || rec.x0 * rec.x1 >= 0) continue;
    let lo = rec.tThrow;
    let hi = rec.tCatch;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (Math.sign(flightState(rec, mid).x) === Math.sign(rec.x0)) lo = mid;
      else hi = mid;
    }
    return flightState(rec, (lo + hi) / 2).y;
  }
  return NaN;
}

for (const n of [3, 5, 7, 9]) {
  test(`guides: ${n}-ball cascade crosses where the simulated balls cross, edges at the catch points`, () => {
    const p = buildPattern(String(n));
    const g = guideLines(p);
    assert.equal(g.crossing, true);
    assert.equal(g.crossValue, n);
    near(g.crossY, simulatedCrossing(p, n), 1e-6, 'crossing height');
    assert.ok(g.crossY > 0 && g.crossY < p.heightByValue[n], 'between the hands and the peak');
    near(g.right, p.layout.xC, 1e-12, 'right edge = catch point');
    near(g.left, -p.layout.xC, 1e-12, 'left edge = catch point');
    assert.equal(g.center, 0);
    assert.ok(g.bottom < 0 && g.top > p.heightByValue[n], 'vertical lines span the pattern');
  });
}

test('guides: 7-ball cascade edges are half the published width apart from the centre', () => {
  const p = buildPattern('7');
  const g = guideLines(p);
  near(g.right - g.left, p.reference.width, 1e-9, 'edge to edge = F + P');
});

test('guides: the crossing is exact for a cascade: x linear, y parabolic', () => {
  const p = buildPattern('3');
  const g = guideLines(p);
  // Released at xT inside, caught at xC outside on the other side: crosses at fraction xT/(xT+xC).
  const f = p.flightByValue[3];
  const s = (f * p.layout.xT) / (p.layout.xT + p.layout.xC);
  near(g.crossY, (G * f * s) / 2 - (G * s * s) / 2, 1e-9, 'closed form');
});

for (const n of [4, 6]) {
  test(`guides: ${n}-ball fountain has no crossing, so the line marks the top of the throws`, () => {
    const p = buildPattern(String(n));
    const g = guideLines(p);
    assert.equal(g.crossing, false);
    near(g.crossY, p.heightByValue[n], 1e-12, 'peak');
    assert.ok(g.right > 0 && g.left === -g.right);
  });
}

test('guides: 531 uses the highest crossing throw (the 5); 456 the 5', () => {
  const a = guideLines(buildPattern('531'));
  assert.equal(a.crossValue, 5);
  near(a.crossY, simulatedCrossing(buildPattern('531'), 5), 1e-6, '531 crossing');
  const b = guideLines(buildPattern('456'));
  assert.equal(b.crossValue, 5);
  assert.ok(b.top > buildPattern('456').heightByValue[6], 'lines reach above the 6');
});

test('guides: 441 has only 1s crossing (handed across), so the line marks the top of the 4s', () => {
  const p = buildPattern('441');
  const g = guideLines(p);
  assert.equal(g.crossing, false);
  near(g.crossY, p.heightByValue[4], 1e-12, 'peak of the 4');
});

test('guides: follow the pattern: more balls, higher crossing and wider edges', () => {
  const g3 = guideLines(buildPattern('3'));
  const g7 = guideLines(buildPattern('7'));
  assert.ok(g7.crossY > g3.crossY);
  assert.ok(g7.top > g3.top);
});
