import test from 'node:test';
import assert from 'node:assert/strict';

import {
  G,
  BALL_DIAMETER,
  DWELL_RATIO,
  parseSiteswap,
  shannonResidual,
  ballsInFlightPerHand,
  flightTime,
  dwellAfter,
  peakHeight,
  launchSpeed,
  arcSeparation,
  crossingClearance,
  maxAngleError,
  uniformPattern,
  buildPattern,
  throwAtBeat,
  flightState,
  ballStates,
  eventsBetween,
  findCollisions,
} from '../src/physics.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );

// ---------------------------------------------------------------------------------------------
// Siteswap validation
// ---------------------------------------------------------------------------------------------

test('siteswap: the presets and the spec examples are valid, with the right ball counts', () => {
  const expected = { 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 531: 3, 456: 5, 441: 3, 423: 3, 51: 3, 97531: 5, 7131: 3 };
  for (const [text, balls] of Object.entries(expected)) {
    const p = parseSiteswap(text);
    assert.equal(p.ok, true, text + ' should be valid');
    assert.equal(p.balls, balls, text + ' ball count');
    assert.equal(p.period, text.length);
  }
});

test('siteswap: letters mean 10-35, spaces and commas are separators, case is ignored', () => {
  assert.deepEqual(parseSiteswap('b').throws, [11]);
  assert.equal(parseSiteswap('B').balls, 11);
  assert.deepEqual(parseSiteswap(' 5 3 1 ').throws, [5, 3, 1]);
  assert.deepEqual(parseSiteswap('5,3,1').throws, [5, 3, 1]);
  assert.equal(parseSiteswap('5 3 1').text, '531');
  assert.equal(parseSiteswap('a').maxThrow, 10);
});

test('siteswap: throws that land together are rejected, and the message says which', () => {
  for (const text of ['543', '432', '54', '21', '85', '513', '7772']) {
    const p = parseSiteswap(text);
    assert.equal(p.ok, false, text + ' should be invalid');
    assert.equal(p.code, 'invalid');
    assert.match(p.error, /not a valid siteswap/);
    assert.match(p.error, /land in the same hand at the same time/);
  }
  // 543: the 5 (throw 1), the 4 (throw 2) and the 3 (throw 3) all land together.
  assert.match(parseSiteswap('543').error, /the 5 \(throw 1\) and the 4 \(throw 2\)/);
  // A non-integer average gets the extra hint.
  assert.match(parseSiteswap('54').error, /average 4\.50/);
});

test('siteswap: an integer average is not enough (the landing test decides)', () => {
  // 3 + 2 + 1 = 6 averages 2, but all three throws land on the same beat.
  const p = parseSiteswap('321');
  assert.equal(p.ok, false);
  assert.equal(p.code, 'invalid');
  assert.doesNotMatch(p.error, /average/);
});

test('siteswap: synchronous patterns are rejected with a clear "version 2" message', () => {
  for (const text of ['(4,4)', '(6x,4)*', '(4,2x)(2x,4)', '(2x,4x)']) {
    const p = parseSiteswap(text);
    assert.equal(p.ok, false, text);
    assert.equal(p.code, 'sync', text);
    assert.match(p.error, /Synchronous/);
    assert.match(p.error, /version 2/);
  }
});

test('siteswap: multiplex patterns are rejected with a clear "out of scope" message', () => {
  for (const text of ['[43]23', '[33]', '4[43]1', '([44],2)']) {
    const p = parseSiteswap(text);
    assert.equal(p.ok, false, text);
    assert.equal(p.code, 'multiplex', text);
    assert.match(p.error, /Multiplex/);
    assert.match(p.error, /out of scope/);
  }
});

test('siteswap: empty input, stray characters, zero balls and absurd lengths are rejected', () => {
  assert.equal(parseSiteswap('').code, 'empty');
  assert.equal(parseSiteswap('   ').code, 'empty');
  assert.equal(parseSiteswap(null).code, 'empty');
  assert.equal(parseSiteswap('5-3').code, 'char');
  assert.match(parseSiteswap('5-3').error, /"-" is not a siteswap throw/);
  assert.equal(parseSiteswap('3!').code, 'char');
  assert.equal(parseSiteswap('0').code, 'zero');
  assert.equal(parseSiteswap('000').code, 'zero');
  assert.equal(parseSiteswap('3'.repeat(49)).code, 'toolong');
  assert.equal(parseSiteswap('3'.repeat(48)).ok, true);
});

test('siteswap: buildPattern passes the validation error through untouched', () => {
  const p = buildPattern('(4,4)');
  assert.equal(p.ok, false);
  assert.equal(p.code, 'sync');
});

// ---------------------------------------------------------------------------------------------
// Shannon's theorem
// ---------------------------------------------------------------------------------------------

/** Measure flight, dwell and empty times from the generated throws (not from the formulas). */
function measureUniform(pattern) {
  const first = throwAtBeat(pattern, 0); // a right-hand throw
  const flight = first.tCatch - first.tThrow;
  // The ball thrown on beat 0 is thrown again on beat 0 + value.
  const next = throwAtBeat(pattern, first.value);
  assert.equal(next.ball, first.ball);
  const dwell = next.tThrow - first.tCatch;
  // The right hand throws on beat 0 and next catches the ball it will throw on beat 2.
  let arriving = null;
  for (let i = -pattern.maxThrow; i < 2; i++) {
    const rec = throwAtBeat(pattern, i);
    if (rec.air && rec.beat + rec.value === 2) arriving = rec;
  }
  const empty = arriving.tCatch - first.tThrow;
  return { flight, dwell, empty };
}

test("Shannon's theorem h(d+f) = n(d+e) holds for every uniform pattern, measured from the throws", () => {
  for (let b = 3; b <= 13; b++) {
    const pattern = buildPattern(b.toString(36));
    const m = measureUniform(pattern);
    const residual = shannonResidual({ hands: 2, balls: b, dwell: m.dwell, flight: m.flight, empty: m.empty });
    near(residual, 0, 1e-12, b + ' balls: h(d+f) - n(d+e)');
    // Kalvan's form of the same statement: T = d + e, W = f / T = b/h - r.
    near(m.dwell + m.empty, pattern.T, 1e-12, b + ' balls: d + e = T');
    near(m.flight / pattern.T, b / 2 - DWELL_RATIO, 1e-12, b + ' balls: W = b/2 - r');
    near(m.dwell / (m.dwell + m.empty), DWELL_RATIO, 1e-12, b + ' balls: dwell ratio');
  }
});

test("Shannon's theorem with the juggling_coach 7-ball numbers", () => {
  const u = uniformPattern(7);
  // T = .42 s and W = 2.8 are the README values; d and e follow from r = 0.7.
  const residual = shannonResidual({ hands: 2, balls: 7, dwell: u.dwell, flight: u.flight, empty: u.empty });
  near(residual, 0, 1e-12);
  near(u.dwell + u.empty, 0.42, 1e-12, 'T');
  near(u.flight / (u.dwell + u.empty), 2.8, 1e-12, 'W');
  near(ballsInFlightPerHand(7, 0.7), 2.8, 1e-12);
});

test("Shannon's theorem does not depend on the dwell ratio or tempo chosen", () => {
  for (const r of [0.5, 0.6, 2 / 3, 0.7, 0.8]) {
    for (const T of [0.3, 0.42, 0.6]) {
      const pattern = buildPattern('5', { dwellRatio: r, T });
      const m = measureUniform(pattern);
      near(shannonResidual({ hands: 2, balls: 5, dwell: m.dwell, flight: m.flight, empty: m.empty }), 0, 1e-12);
    }
  }
});

test('Shannon accounting for mixed siteswaps: every ball is always in the air or in one hand', () => {
  for (const text of ['531', '441', '456', '423', '51', '7131', '522', '42', '501', '97531', '2', '1']) {
    const pattern = buildPattern(text);
    let airTime = 0;
    const steps = 4000;
    const span = pattern.cycleTime * 3;
    for (let k = 0; k < steps; k++) {
      const t = ((k + 0.5) / steps) * span;
      const states = ballStates(pattern, t);
      assert.equal(states.length, pattern.balls, text + ': ball count at t=' + t);
      assert.equal(new Set(states.map((s) => s.ball)).size, pattern.balls, text + ': ball ids are distinct');
      const held = [0, 0];
      for (const s of states) {
        if (s.air) airTime += span / steps;
        else held[s.hand]++;
      }
      assert.ok(held[0] <= 1 && held[1] <= 1, text + ': a hand never holds two balls (t=' + t + ')');
    }
    // Average number of balls in the air = (total flight time thrown per cycle) / (cycle time).
    let flights = 0;
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (rec.air) flights += rec.flight;
    }
    near(airTime / span, flights / pattern.cycleTime, 0.01, text + ': average balls in the air');
  }
});

// ---------------------------------------------------------------------------------------------
// Kalvan's optimum: the juggling_coach numbers
// ---------------------------------------------------------------------------------------------

test('7-ball optimum reproduces the juggling_coach README numbers', () => {
  // README.txt: "a perfect 7 ball pattern using 6cm diameter balls has the values:
  //   T = .42s  W = 2.8  H = 1.7m  F = .65m  D1 = .23m  P = .27m  Pattern Width = .92m  Emax = 1.4 deg"
  const u = uniformPattern(7);
  assert.equal(u.kind, 'cascade');
  assert.equal(u.ballDiameter, 0.06);
  assert.equal(u.T, 0.42); // input
  assert.equal(u.F, 0.65); // input
  near(u.W, 2.8, 1e-12, 'W');
  near(u.H, 1.7, 0.05, 'H');
  near(u.D1, 0.23, 0.005, 'D1');
  near(u.P, 0.27, 0.01, 'P');
  near(u.width, 0.92, 0.01, 'Pattern Width');
  near(u.emaxDeg, 1.4, 0.1, 'Emax');
  // The README's own definitions.
  near(u.W, u.flight / u.T, 1e-12, 'W = f / T');
  near(u.F, u.W * u.D1, 1e-12, 'F = W * D1');
  near(u.width, u.F + u.P, 1e-12, 'Pattern Width = F + P');
  near(u.emaxRad, (u.D1 - 0.06) / (4 * u.H), 1e-12, 'Emax = (D1 - D) / 4H');
  // Hand positions follow from F and P.
  near(u.xC, u.width / 2, 1e-12);
  near(u.xT + u.xC, u.F, 1e-12);
  near(u.xC - u.xT, u.P, 1e-12);
});

test('the other rows of the "When Balls Collide" table come out within rounding', () => {
  // Cascades as printed (p. 78): balls: [W, T, H, F, D1, P, width, Emax deg].
  const cascades = {
    5: [1.8, 0.49, 1.0, 0.52, 0.29, 0.32, 0.84, 3.3],
    7: [2.8, 0.42, 1.7, 0.65, 0.23, 0.27, 0.92, 1.4],
    9: [3.8, 0.35, 2.2, 0.73, 0.19, 0.23, 0.96, 0.84],
    11: [4.8, 0.3, 2.6, 0.8, 0.17, 0.22, 1.02, 0.6],
    13: [5.8, 0.27, 3.0, 0.93, 0.16, 0.22, 1.15, 0.48],
  };
  for (const [balls, row] of Object.entries(cascades)) {
    const u = uniformPattern(Number(balls));
    const [W, T, H, F, D1, P, width, emax] = row;
    assert.equal(u.kind, 'cascade');
    near(u.W, W, 1e-9, balls + ' W');
    assert.equal(u.T, T);
    assert.equal(u.F, F);
    near(u.H, H, 0.06, balls + ' H');
    near(u.D1, D1, 0.005, balls + ' D1');
    near(u.P, P, 0.015, balls + ' P');
    near(u.width, width, 0.015, balls + ' width');
    near(u.emaxDeg, emax, 0.15, balls + ' Emax');
    assert.equal(u.source, 'KL18');
  }

  // Fountains as printed: balls: [W, T, H, F, D1, Emax deg]. The table gives no P for these,
  // only that the pattern is wider than 2F. T is printed to two decimals, which is why H for
  // 8, 10 and 12 lands up to 0.1 m under the printed H.
  const fountains = {
    6: [2.3, 0.46, 1.4, 0.37, 0.16, 1.0],
    8: [3.3, 0.38, 2.0, 0.45, 0.14, 0.57],
    10: [4.3, 0.32, 2.4, 0.52, 0.12, 0.35],
    12: [5.3, 0.28, 2.8, 0.57, 0.11, 0.25],
  };
  for (const [balls, row] of Object.entries(fountains)) {
    const u = uniformPattern(Number(balls));
    const [W, T, H, F, D1, emax] = row;
    assert.equal(u.kind, 'fountain');
    near(u.W, W, 1e-9, balls + ' W');
    assert.equal(u.T, T);
    assert.equal(u.F, F);
    near(u.H, H, 0.11, balls + ' H');
    near(u.D1, D1, 0.005, balls + ' D1');
    near(u.emaxDeg, emax, 0.06, balls + ' Emax');
    assert.ok(u.width > 2 * F, balls + ': wider than 2F, the hands stay on their own side');
    assert.equal(u.source, 'KL18');
  }
});

test('spatially optimal means D2 = D1: the same clearance at both collision points', () => {
  for (const b of [5, 7, 9, 11, 13]) {
    const u = uniformPattern(b);
    near(u.D2, u.D1, 1e-12, b + ' balls');
    near(crossingClearance(arcSeparation(0.2, 0.5, 0.4), 0.5, 0.4), 0.2, 1e-12);
  }
});

test('3 balls: less than one ball per arc, so no D1 and no Emax (the math does not cover it)', () => {
  const u = uniformPattern(3);
  assert.ok(u.W < 1);
  assert.equal(u.D1, null);
  assert.equal(u.emaxDeg, null);
  assert.equal(u.source, 'K96m');
  near(u.P, 0.2, 1e-12);
  near(u.width, 0.53, 1e-12);
  assert.ok(u.D2 > BALL_DIAMETER);
});

test('fountains: E = F = W * D1, each ball returns to the hand that threw it', () => {
  for (const b of [4, 6, 8, 10, 12]) {
    const u = uniformPattern(b);
    assert.equal(u.kind, 'fountain');
    near(u.F, u.W * u.D1, 1e-12);
    near(u.xC - u.xT, u.F, 1e-12, 'same-side flight distance');
    assert.deepEqual(u.assumptions, ['A3']);
    const rec = throwAtBeat(buildPattern(b.toString(36)), 0); // 10 is "a", 12 is "c"
    assert.equal(rec.toHand, rec.hand);
    assert.ok(rec.x0 > 0 && rec.x1 > rec.x0, 'right hand throws inside and catches outside');
  }
});

test('ball counts without a published row are flagged, never silently invented', () => {
  for (const b of [5, 6, 7, 8, 9, 10, 11, 12, 13]) assert.equal(uniformPattern(b).source, 'KL18');
  for (const b of [3, 4]) assert.equal(uniformPattern(b).source, 'K96m');
  for (const b of [14, 15, 16, 20, 35]) {
    const u = uniformPattern(b);
    assert.equal(u.source, 'extrapolated');
    // It borrows tempo and spacing from the last published row of the same kind.
    assert.equal(u.borrowedFrom, b % 2 ? 13 : 12);
    assert.equal(u.T, uniformPattern(u.borrowedFrom).T);
    near(u.D1, uniformPattern(u.borrowedFrom).D1, 1e-12);
  }
  assert.throws(() => uniformPattern(2), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Flight time and height for each throw value
// ---------------------------------------------------------------------------------------------

test('flight time for each throw value: f(v) = (v - 2r) * beat', () => {
  const beat = 0.25;
  const r = 0.7;
  assert.equal(flightTime(0, beat, r), 0);
  near(flightTime(1, beat, r), 0.3 * beat, 1e-12, 'a 1 flies (1 - r) of a beat');
  assert.equal(flightTime(2, beat, r), 0);
  for (let v = 3; v <= 13; v++) {
    near(flightTime(v, beat, r), (v - 1.4) * beat, 1e-12, 'v=' + v);
    // The ball is thrown again exactly v beats later: flight + dwell = v beats.
    near(flightTime(v, beat, r) + dwellAfter(v, beat, r), v * beat, 1e-12);
  }
  near(flightTime(1, beat, r) + dwellAfter(1, beat, r), beat, 1e-12);
  // The default dwell ratio is the 0.7 behind the juggling_coach numbers.
  assert.equal(DWELL_RATIO, 0.7);
  near(flightTime(7, 0.21), 1.176, 1e-12);
});

test('height for each throw value: H = g f^2 / 8 with real gravity', () => {
  assert.equal(G, 9.81);
  near(peakHeight(1), 9.81 / 8, 1e-12);
  near(peakHeight(2), 4 * peakHeight(1), 1e-12, 'double the flight time, four times the height');
  near(launchSpeed(1), 9.81 / 2, 1e-12);

  // Uniform patterns at Kalvan's tempos.
  const expected = { 3: [0.44, 0.2374], 4: [0.689, 0.5821], 5: [0.882, 0.9539], 6: [1.058, 1.3726], 7: [1.176, 1.6959] };
  for (const [text, [flight, height]] of Object.entries(expected)) {
    const p = buildPattern(text);
    const v = Number(text);
    near(p.flightByValue[v], flight, 1e-9, text + ' flight');
    near(p.heightByValue[v], height, 2e-4, text + ' height');
  }

  // 531 runs at the 5-ball tempo (beat = 0.245 s), so its 5 is exactly the 5-ball cascade throw.
  const p = buildPattern('531');
  near(p.beat, 0.245, 1e-12);
  near(p.flightByValue[5], 3.6 * 0.245, 1e-12);
  near(p.flightByValue[3], 1.6 * 0.245, 1e-12);
  near(p.flightByValue[1], 0.3 * 0.245, 1e-12);
  near(p.heightByValue[5], buildPattern('5').heightByValue[5], 1e-12);
  near(p.heightByValue[5], 0.9539, 2e-4);
  near(p.heightByValue[3], 0.1884, 2e-4);
  near(p.heightByValue[1], 0.0066, 2e-4);
  assert.ok(p.heightByValue[5] > p.heightByValue[3] && p.heightByValue[3] > p.heightByValue[1]);
});

test('heights of mixed throws follow the book: H1 / H2 = ((n1 - 2r) / (n2 - 2r))^2', () => {
  // "When Balls Collide", p. 129: in 5 3 "the high throws are not 5/3 as high as the low throws,
  // but actually between four and five times as high"; "9's are almost twice as high as 7's".
  const ratio = (text, hi, lo) => {
    const p = buildPattern(text);
    return p.heightByValue[hi] / p.heightByValue[lo];
  };
  near(ratio('53', 5, 3), ((5 - 1.4) / (3 - 1.4)) ** 2, 1e-12);
  assert.ok(ratio('53', 5, 3) > 4 && ratio('53', 5, 3) < 5.1, 'four to five times: ' + ratio('53', 5, 3).toFixed(2));
  near(ratio('97531', 9, 7), ((9 - 1.4) / (7 - 1.4)) ** 2, 1e-12);
  assert.ok(ratio('97531', 9, 7) > 1.7 && ratio('97531', 9, 7) < 2, 'almost twice: ' + ratio('97531', 9, 7).toFixed(2));
  // The ratio does not depend on the tempo, only on the dwell ratio.
  near(ratio('53', 5, 3), ratio('753', 5, 3), 1e-12);
});

test('the highest throw of a mixed pattern is exactly that cascade or fountain throw', () => {
  // "When Balls Collide", p. 130: "7 1 is a four ball shower, but one hand does all the work
  // of a seven ball cascade."
  for (const [mixed, top] of [['71', 7], ['7131', 7], ['531', 5], ['51', 5], ['441', 4], ['423', 4], ['66661', 6], ['97531', 9]]) {
    const p = buildPattern(mixed);
    const u = buildPattern(top.toString(36));
    assert.equal(p.T, u.T, mixed + ' runs at the tempo of ' + top);
    near(p.flightByValue[top], u.flightByValue[top], 1e-12, mixed + ' flight of the ' + top);
    near(p.heightByValue[top], u.heightByValue[top], 1e-12, mixed + ' height of the ' + top);
    assert.deepEqual(p.layout, u.layout, mixed + ' uses the same throw and catch points');
    // Same throw, same path: launch point, landing point and launch speed all agree.
    let rec = null;
    for (let i = 0; i < p.cycleBeats && !rec; i++) if (throwAtBeat(p, i).value === top && throwAtBeat(p, i).hand === 0) rec = throwAtBeat(p, i);
    const ref = throwAtBeat(u, 0);
    near(rec.x0, ref.x0, 1e-12);
    near(rec.x1, ref.x1, 1e-12);
    near(rec.vy, ref.vy, 1e-12);
  }
});

test('every thrown ball really flies that long and that high (trajectory check)', () => {
  for (const text of ['3', '7', '531', '441', '456', '97531']) {
    const pattern = buildPattern(text);
    for (let i = 0; i < pattern.cycleBeats; i++) {
      const rec = throwAtBeat(pattern, i);
      if (!rec.air) continue;
      const top = flightState(rec, rec.tPeak);
      near(top.y, pattern.heightByValue[rec.value], 1e-12, text + ' peak height');
      near(top.vy, 0, 1e-12, text + ' vertical speed at the peak');
      const landing = flightState(rec, rec.tCatch);
      near(landing.y, 0, 1e-12, text + ' lands at hand height');
      near(landing.x, rec.x1, 1e-12, text + ' lands at the catch point');
      // Gravity is the only acceleration: sample the path and difference it twice.
      const h = 1e-3;
      const mid = rec.tThrow + rec.flight / 2;
      const a = (flightState(rec, mid + h).y - 2 * flightState(rec, mid).y + flightState(rec, mid - h).y) / (h * h);
      near(a, -9.81, 1e-6, text + ' acceleration');
    }
  }
});

test('0 is an empty beat and 2 is a hold: neither is ever in the air', () => {
  const p = buildPattern('423');
  const hold = throwAtBeat(p, 1);
  assert.equal(hold.value, 2);
  assert.equal(hold.air, false);
  assert.equal(hold.toHand, hold.hand);
  const q = buildPattern('501');
  const empty = throwAtBeat(q, 1);
  assert.equal(empty.value, 0);
  assert.equal(empty.air, false);
  assert.equal(empty.ball, -1);
  // "2" alone: two balls, each sitting in a hand, forever.
  const two = ballStates(buildPattern('2'), 12.345);
  assert.equal(two.length, 2);
  assert.ok(two.every((s) => !s.air));
  assert.deepEqual(two.map((s) => s.hand).sort(), [0, 1]);
});

test('hands alternate, right hand first; odd throws cross, even throws come back', () => {
  const p = buildPattern('531');
  for (let i = -6; i < 12; i++) {
    const rec = throwAtBeat(p, i);
    assert.equal(rec.hand, ((i % 2) + 2) % 2);
    assert.equal(rec.toHand, (rec.hand + rec.value) % 2);
    if (rec.air) assert.equal(Math.sign(rec.x0), rec.hand === 0 ? 1 : -1, 'thrown from its own side');
  }
  const four = throwAtBeat(buildPattern('441'), 0);
  assert.equal(four.toHand, four.hand);
});

test('ball identity: a ball is thrown again exactly `value` beats later', () => {
  for (const text of ['3', '7', '531', '441', '456', '423', '97531', '522', '7131']) {
    const p = buildPattern(text);
    const seen = new Set();
    for (let i = 0; i < p.cycleBeats * 6; i++) {
      const rec = throwAtBeat(p, i);
      if (rec.value === 0) continue;
      assert.equal(throwAtBeat(p, i + rec.value).ball, rec.ball, text + ' beat ' + i);
      seen.add(rec.ball);
    }
    assert.equal(seen.size, p.balls, text + ': exactly ' + p.balls + ' distinct balls');
  }
});

// ---------------------------------------------------------------------------------------------
// Sound events
// ---------------------------------------------------------------------------------------------

test('events: one release, one peak and one catch per throw, in time order', () => {
  for (const text of ['3', '531', '441', '423', '7']) {
    const p = buildPattern(text);
    let throwsPerCycle = 0;
    for (let i = 0; i < p.cycleBeats; i++) if (throwAtBeat(p, i).air) throwsPerCycle++;
    const events = eventsBetween(p, 0, p.cycleTime);
    for (const type of ['release', 'peak', 'catch']) {
      assert.equal(events.filter((e) => e.type === type).length, throwsPerCycle, text + ' ' + type);
    }
    for (let k = 1; k < events.length; k++) assert.ok(events[k].time >= events[k - 1].time);
    // Splitting the window never loses or duplicates an event.
    const cut = p.cycleTime * 0.37;
    assert.equal(eventsBetween(p, 0, cut).length + eventsBetween(p, cut, p.cycleTime).length, events.length);
  }
});

test('events: the peak is at the exact top, and carries the height that sets its pitch', () => {
  const p = buildPattern('531');
  const peaks = eventsBetween(p, 0, p.cycleTime).filter((e) => e.type === 'peak');
  const byValue = {};
  for (const e of peaks) byValue[e.value] = e.height;
  assert.ok(byValue[5] > byValue[3] && byValue[3] > byValue[1], 'a 5 peaks higher than a 3, a 3 higher than a 1');
  for (const e of peaks) {
    const rec = throwAtBeat(p, e.beat);
    near(e.time, rec.tThrow + rec.flight / 2, 1e-12);
    near(e.y, flightState(rec, e.time).y, 1e-12);
  }
  assert.equal(eventsBetween(buildPattern('2'), 0, 10).length, 0, 'holds make no sound');
});

// ---------------------------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------------------------

/** Independent check: step through time and measure every pair of airborne balls. */
function bruteForceMinDistance(pattern, steps) {
  let min = Infinity;
  for (let k = 0; k < steps; k++) {
    const t = (k / steps) * pattern.cycleTime * 2;
    const air = ballStates(pattern, t).filter((s) => s.air);
    for (let a = 0; a < air.length; a++) {
      for (let b = a + 1; b < air.length; b++) {
        min = Math.min(min, Math.hypot(air[a].x - air[b].x, air[a].y - air[b].y));
      }
    }
  }
  return min;
}

test('collision: 456 on the standard layout is a known collision (a 5 meets a 6)', () => {
  const result = findCollisions(buildPattern('456'));
  assert.equal(result.collides, true);
  assert.ok(result.minDistance < BALL_DIAMETER);
  const values = [result.hits[0].first.value, result.hits[0].second.value].sort();
  assert.deepEqual(values, [5, 6]);
  // It is a real crossing in the air, not an artefact at a hand.
  assert.ok(result.hits[0].y > 0.5);
  // 645 and 564 are the same pattern started elsewhere.
  assert.equal(findCollisions(buildPattern('645')).collides, true);
  assert.equal(findCollisions(buildPattern('564')).collides, true);
});

test('collision: the other spec examples and all presets are clear', () => {
  for (const text of ['3', '4', '5', '6', '7', '531', '441', '423', '51']) {
    const result = findCollisions(buildPattern(text));
    assert.equal(result.collides, false, text);
    assert.equal(result.hits.length, 0, text);
    assert.ok(result.minDistance > BALL_DIAMETER, text);
  }
});

test("collision: the detector finds exactly Kalvan's clearance in his optimal cascades", () => {
  for (const b of [5, 7, 9, 11, 13]) {
    const pattern = buildPattern(b.toString(36));
    const result = findCollisions(pattern);
    near(result.minDistance, pattern.spatial.D1, 1e-9, b + ' balls: closest approach = D1 = D2');
    assert.equal(result.collides, false);
  }
  // Fountains: the tightest pair is two neighbours on one arc.
  for (const b of [4, 6, 8, 10, 12]) {
    const pattern = buildPattern(b.toString(36));
    near(findCollisions(pattern).minDistance, pattern.spatial.D1, 1e-9, b + ' balls');
  }
  // 3 balls: only the crossing clearance D2 exists.
  const three = buildPattern('3');
  near(findCollisions(three).minDistance, three.spatial.D2, 1e-9);
});

test('collision: "ideal pattern with no error" grazes, and anything tighter collides', () => {
  const D = BALL_DIAMETER;
  const W = 7 / 2 - DWELL_RATIO;
  const T = 0.42;

  // Kalvan's optimal arc with no room for error: F = W * D, and P from the grazing condition.
  const F = W * D;
  const P = arcSeparation(D, F / (W * T), T);
  const grazing = findCollisions(buildPattern('7', { T, F, P }));
  near(grazing.minDistance, D, 1e-9, 'balls just touch');
  assert.equal(grazing.collides, false);

  // Same arc too short: neighbours on one arc overlap near the top.
  const shortArc = findCollisions(buildPattern('7', { T, F: F * 0.9, P }));
  assert.equal(shortArc.collides, true);
  near(shortArc.minDistance, D * 0.9, 1e-9, 'same-arc spacing is F / W');
  assert.equal(shortArc.hits[0].first.hand, shortArc.hits[0].second.hand, 'two throws from the same hand');

  // Arcs too close together: consecutive balls from opposite hands hit near the crossing.
  const closeArcs = findCollisions(buildPattern('7', { T, F, P: P * 0.8 }));
  assert.equal(closeArcs.collides, true);
  near(closeArcs.minDistance, D * 0.8, 1e-9, 'crossing clearance scales with P');
  assert.notEqual(closeArcs.hits[0].first.hand, closeArcs.hits[0].second.hand, 'throws from opposite hands');
  assert.equal(closeArcs.hits[0].second.beat - closeArcs.hits[0].first.beat, 1, 'consecutive throws');
});

test('collision: the exact pairwise answer matches brute-force time stepping', () => {
  for (const text of ['3', '5', '7', '531', '441', '456', '423', '534', '97531', '75751', '86277']) {
    const pattern = buildPattern(text);
    const exact = findCollisions(pattern).minDistance;
    const brute = bruteForceMinDistance(pattern, 40000);
    near(brute, exact, 2e-3, text);
    assert.ok(brute >= exact - 1e-9, text + ': stepping can never find a pair closer than the exact minimum');
  }
});

test('collision: the threshold is the ball diameter', () => {
  const pattern = buildPattern('456');
  const min = findCollisions(pattern).minDistance;
  assert.equal(findCollisions(pattern, min * 0.99).collides, false, 'smaller balls would clear');
  assert.equal(findCollisions(pattern, min * 1.01).collides, true);
  near(maxAngleError(0.23, 0.06, 1.7) * (180 / Math.PI), 1.43, 0.01, 'Emax from the rounded README values');
});
