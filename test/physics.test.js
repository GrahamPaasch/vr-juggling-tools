import test from 'node:test';
import assert from 'node:assert/strict';

import {
  G,
  BALL_DIAMETER,
  DWELL_RATIO,
  PUBLISHED,
  printsAs,
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

test('siteswap: tricky entries. 552 and 75 are valid, 9 and a are uniform, 0, empty and 10 are refused', () => {
  assert.deepEqual([parseSiteswap('552').ok, parseSiteswap('552').balls], [true, 4]);
  assert.deepEqual([parseSiteswap('75').ok, parseSiteswap('75').balls], [true, 6]);
  assert.equal(buildPattern('9').kind, 'cascade');
  assert.equal(buildPattern('a').kind, 'fountain');
  assert.equal(buildPattern('a').balls, 10);
  assert.equal(parseSiteswap('0').code, 'zero');
  assert.equal(parseSiteswap('').code, 'empty');
  assert.equal(parseSiteswap('10').code, 'invalid');
  assert.equal(parseSiteswap('2').balls, 2);
  assert.equal(parseSiteswap('20').balls, 1);
  assert.equal(parseSiteswap('40').balls, 2);
});

test('siteswap: a refusal never says that a 0 lands; it says which throw lands on the empty beat', () => {
  // A 0 is an empty hand that throws nothing. What goes wrong is that another throw arrives on
  // a beat the pattern declares empty.
  const cases = { 10: /the 1 \(throw 1\) lands on beat 2, where the pattern has a 0/, 30: /the 3 \(throw 1\) lands on beat 2, where the pattern has a 0/, 202: /the 2 \(throw 3\) lands on beat 2, where the pattern has a 0/, '03': /the 3 \(throw 2\) lands on beat 1, where the pattern has a 0/ };
  for (const [text, expected] of Object.entries(cases)) {
    const r = parseSiteswap(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.code, 'invalid', text);
    assert.match(r.error, expected, text + ': ' + r.error);
    assert.match(r.error, /an empty hand with nothing to throw/);
    assert.doesNotMatch(r.error, /the 0 \(throw \d+\)/, text + ' must not talk about "the 0" as a throw: ' + r.error);
    assert.doesNotMatch(r.error, /land in the same hand/, text + ': ' + r.error);
  }
});

test('siteswap: typing 10 for ten balls gets the hint that ten is written a', () => {
  assert.match(parseSiteswap('10').error, /If you meant 10 balls, type a\b/);
  assert.match(parseSiteswap('10').error, /letters a to z/);
  assert.match(parseSiteswap('12').error, /If you meant 12 balls, type c\b/);
  // Only for an entry that reads as a number from 10 to 35: those are the throws letters cover.
  assert.doesNotMatch(parseSiteswap('54').error, /If you meant/);
  assert.doesNotMatch(parseSiteswap('543').error, /If you meant/);
  assert.doesNotMatch(parseSiteswap('a1b').error || '', /If you meant/);
  // 11 and 13 are valid siteswaps (one and two balls), so they load; the page explains letters
  // under the entry field.
  assert.equal(parseSiteswap('11').balls, 1);
  assert.equal(parseSiteswap('13').balls, 2);
});

test('siteswap: validation agrees with an independent landing simulation for every digit string up to length 4', () => {
  // Throw the pattern for many periods and count what arrives on every beat: a beat with a
  // throw needs exactly one arrival, an empty beat (0) none.
  const simulate = (t) => {
    const n = t.length;
    const max = Math.max(...t);
    const span = n * (max + 2) * 2 + 4 * n;
    const land = new Array(span + max + 1).fill(0);
    for (let i = 0; i < span; i++) if (t[i % n] > 0) land[i + t[i % n]]++;
    for (let j = max + n; j < span; j++) if (land[j] !== (t[j % n] > 0 ? 1 : 0)) return false;
    return true;
  };
  let checked = 0;
  let valid = 0;
  const walk = (prefix, depth) => {
    if (prefix) {
      const t = Array.from(prefix, Number);
      const expected = simulate(t) && t.some((v) => v > 0);
      assert.equal(parseSiteswap(prefix).ok, expected, prefix);
      checked++;
      if (expected) valid++;
    }
    if (depth) for (const c of '0123456789') walk(prefix + c, depth - 1);
  };
  walk('', 4);
  assert.equal(checked, 11110);
  assert.ok(valid > 1000 && valid < checked, valid + ' of them are valid');
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
    // The dwell ratio is the table's 0.7, except in Kalvan's own measured 3 and 4 ball rows.
    const r = b === 3 ? 0.63 : b === 4 ? 0.68 : DWELL_RATIO;
    assert.equal(pattern.dwellRatio, r, b + ' balls: dwell ratio used');
    near(m.flight / pattern.T, b / 2 - r, 1e-12, b + ' balls: W = b/2 - r');
    near(m.dwell / (m.dwell + m.empty), r, 1e-12, b + ' balls: dwell ratio');
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

test('7 balls: every number is derived from T = .42, F = .65, r = .7, D = 6 cm (re-derived here from scratch)', () => {
  const b = 7;
  const T = 0.42;
  const F = 0.65;
  const r = 0.7;
  const D = 0.06;
  const g = 9.81;
  const W = b / 2 - r; // Shannon: b/h = W + r
  const f = W * T;
  const d = r * T;
  const e = (1 - r) * T;
  near(2 * (d + f) - b * (d + e), 0, 1e-12, 'h(d+f) = n(d+e)');
  const u = uniformPattern(7);
  assert.equal(u.kind, 'cascade');
  assert.equal(u.ballDiameter, D);
  assert.equal(u.T, T); // input
  assert.equal(u.F, F); // input
  assert.equal(u.dwellRatio, r);
  near(u.W, 2.8, 1e-12, 'W');
  near(u.flight, f, 1e-12, 'f = W T');
  near(u.H, (g * f * f) / 8, 1e-12, 'H = g f^2 / 8');
  near(u.D1, F / W, 1e-12, 'D1 = F / W');
  near(u.P, (F / W) * Math.hypot((4 * (F / f)) / (g * T), 1), 1e-12, 'P from D2 = D1 [K96]');
  near(u.width, F + u.P, 1e-12, 'Pattern Width = F + P');
  near(u.emaxRad, (F / W - D) / ((4 * g * f * f) / 8), 1e-12, 'Emax = (D1 - D) / 4H');
  // Hand positions follow from F and P.
  near(u.xC, u.width / 2, 1e-12);
  near(u.xT + u.xC, F, 1e-12);
  near(u.xC - u.xT, u.P, 1e-12);
  // The numbers themselves, so that a change in any of them is noticed.
  near(u.flight, 1.176, 1e-12);
  near(u.H, 1.69587432, 1e-8);
  near(u.D1, 0.2321428571, 1e-9);
  near(u.P, 0.2634525518, 1e-9);
  near(u.width, 0.9134525518, 1e-9);
  near(u.emaxDeg, 1.4539784982, 1e-9);
});

test('7 balls against the juggling_coach README: five of the eight numbers print the same, three do not', () => {
  // README.txt: "a perfect 7 ball pattern using 6cm diameter balls has the values:
  //   T = .42s  W = 2.8  H = 1.7m  F = .65m  D1 = .23m  P = .27m  Pattern Width = .92m  Emax = 1.4 deg"
  const u = uniformPattern(7);
  const printed = PUBLISHED[7].printed;
  assert.equal(PUBLISHED[7].source, 'KL18');
  assert.deepEqual(printed, { H: '1.7', D1: '0.23', P: '0.27', width: '0.92', emaxDeg: '1.4' });
  // Reproduced at the printed precision:
  assert.ok(printsAs(u.T, '0.42'));
  assert.ok(printsAs(u.W, '2.8'));
  assert.ok(printsAs(u.H, printed.H), 'H ' + u.H);
  assert.ok(printsAs(u.F, '0.65'));
  assert.ok(printsAs(u.D1, printed.D1), 'D1 ' + u.D1);
  // Not reproduced. These are known gaps, stated on the page and in the README, not tolerances:
  // P comes out 6.5 mm under the printed .27, and the width with it.
  assert.equal(u.P.toFixed(2), '0.26');
  assert.ok(!printsAs(u.P, printed.P));
  near(Number(printed.P) - u.P, 0.00655, 5e-5, 'the gap in P');
  assert.equal(u.width.toFixed(2), '0.91');
  assert.ok(!printsAs(u.width, printed.width));
  near(Number(printed.width) - u.width, 0.00655, 5e-5, 'the gap in the width');
  // Emax comes out 1.45 degrees where the book prints 1.4. The book's figure is what its own
  // rounded D1 and H give: (0.23 - 0.06) / (4 x 1.7) = 1.43 degrees.
  assert.equal(u.emaxDeg.toFixed(2), '1.45');
  assert.ok(!printsAs(u.emaxDeg, printed.emaxDeg));
  assert.ok(printsAs((maxAngleError(Number(printed.D1), 0.06, Number(printed.H)) * 180) / Math.PI, printed.emaxDeg));
  // With the printed P the crossing would have more room than the arc (D2 = .238 against
  // D1 = .232), so the printed P is not the D2 = D1 value for the printed T and F.
  near(crossingClearance(Number(printed.P), u.Vh, u.T), 0.2379, 1e-4);
  assert.ok(crossingClearance(Number(printed.P), u.Vh, u.T) > u.D1 + 0.005);
});

test('the other table rows: what is reproduced at the printed precision and what is not, row by row', () => {
  // These rows were read from search snippets and are not yet checked against the book (README,
  // assumption A10). The misses below are recorded as they are, not hidden behind a tolerance.
  const misses = {
    5: { emaxDeg: 0.137 },
    6: { emaxDeg: 0.053 },
    8: { H: -0.072 },
    9: { emaxDeg: 0.032 },
    10: { H: -0.078, emaxDeg: 0.026 },
    11: { H: -0.057, P: -0.011, width: -0.011 },
    12: { H: -0.1 },
    13: {},
  };
  for (const [balls, expected] of Object.entries(misses)) {
    const b = Number(balls);
    const u = uniformPattern(b);
    const row = PUBLISHED[b];
    assert.equal(row.source, 'KL18s', balls + ' is marked as an unchecked snippet row');
    assert.equal(u.source, 'KL18s');
    assert.equal(u.kind, b % 2 ? 'cascade' : 'fountain');
    assert.equal(u.T, row.T);
    assert.equal(u.F, row.F);
    assert.equal(u.dwellRatio, DWELL_RATIO, 'the table has W = b/2 - 0.7 on every row');
    const computed = { H: u.H, D1: u.D1, P: u.P, width: u.width, emaxDeg: u.emaxDeg };
    // The table prints P and the width for cascades only (a fountain is "wider than 2F").
    assert.deepEqual(Object.keys(row.printed).sort(), (b % 2 ? ['D1', 'H', 'P', 'emaxDeg', 'width'] : ['D1', 'H', 'emaxDeg']).sort());
    for (const key of Object.keys(row.printed)) {
      const label = balls + ' balls ' + key + ': ' + computed[key] + ' against the printed ' + row.printed[key];
      if (key in expected) {
        assert.ok(!printsAs(computed[key], row.printed[key]), label + ' was expected to miss');
        near(computed[key] - Number(row.printed[key]), expected[key], 6e-4, label);
      } else {
        assert.ok(printsAs(computed[key], row.printed[key]), label);
      }
    }
    if (b % 2 === 0) assert.ok(u.width > 2 * u.F, balls + ': wider than 2F, the hands stay on their own side');
  }
  // D1 = F / W is reproduced in every row, 7 included: the formula and the transcription agree there.
  for (let b = 5; b <= 13; b++) assert.ok(printsAs(uniformPattern(b).D1, PUBLISHED[b].printed.D1), b + ' balls D1');
});

test('what could explain the misses, checked: rounding of T and F does for H and Emax, not for P', () => {
  const g = 9.81;
  // Emax. The book's figure is what its own printed (rounded) D1 and H give: to the printed
  // digit where it prints one decimal, within a hundredth of a degree where it prints two.
  for (let b = 5; b <= 13; b++) {
    const p = PUBLISHED[b].printed;
    const fromPrinted = (maxAngleError(Number(p.D1), 0.06, Number(p.H)) * 180) / Math.PI;
    if (p.emaxDeg.length <= 3) assert.ok(printsAs(fromPrinted, p.emaxDeg), b + ' balls: ' + fromPrinted + ' prints as ' + p.emaxDeg);
    else near(fromPrinted, Number(p.emaxDeg), 0.0101, b + ' balls Emax from the printed D1 and H');
  }
  // H. Each row that comes out low is within reach of a T inside the rounding interval of the
  // printed T (T is printed to two decimals).
  for (const b of [8, 10, 11, 12]) {
    const row = PUBLISHED[b];
    const W = b / 2 - 0.7;
    const highest = (g * (W * (row.T + 0.005)) ** 2) / 8;
    assert.ok(!printsAs(uniformPattern(b).H, row.printed.H));
    assert.ok(highest >= Number(row.printed.H) - 0.05, b + ' balls: H up to ' + highest.toFixed(3) + ' against the printed ' + row.printed.H);
  }
  // P. Scan every T and F that would print as the table prints them.
  const scan = (b) => {
    const row = PUBLISHED[b];
    const W = b / 2 - 0.7;
    let min = Infinity;
    let max = -Infinity;
    let hits = 0;
    const steps = 120;
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const T = row.T - 0.005 + (0.01 * (i + 0.5)) / steps;
        const F = row.F - 0.005 + (0.01 * (j + 0.5)) / steps;
        const P = arcSeparation(F / W, F / (W * T), T);
        min = Math.min(min, P);
        max = Math.max(max, P);
        if (printsAs(P, row.printed.P)) hits++;
      }
    }
    return { min, max, share: hits / (steps * steps) };
  };
  const seven = scan(7);
  near(seven.min, 0.26, 5e-4);
  near(seven.max, 0.267, 5e-4);
  assert.ok(seven.share > 0.1 && seven.share < 0.25, '7 balls: the printed .27 is reached in a corner of the box only (' + (seven.share * 100).toFixed(0) + '%)');
  const eleven = scan(11);
  near(eleven.max, 0.213, 5e-4);
  assert.equal(eleven.share, 0, '11 balls: no T and F within rounding give the printed .22');
  assert.ok(scan(5).share > 0.9 && scan(9).share > 0.9, 'while 5 and 9 balls print as the table does almost anywhere in theirs');
});

test('printsAs compares at the precision of the printed figure', () => {
  assert.ok(printsAs(1.69587, '1.7'));
  assert.ok(!printsAs(1.64, '1.7'));
  assert.ok(printsAs(0.2321, '0.23'));
  assert.ok(!printsAs(0.2635, '0.27'));
  assert.ok(printsAs(0.60088, '0.60'), 'a trailing zero is a printed digit');
  assert.ok(!printsAs(0.606, '0.60'));
  assert.ok(printsAs(3.0072, '3.0'));
});

test("3 and 4 balls are Kalvan's own measured patterns: his tempo, width and dwell ratio; his height is shown beside", () => {
  // [K96] index, "average measurements ... taken from videotapes" (7.5 cm balls):
  //   3 balls: H 0.33 m, E 0.20 m, F 0.33 m, tau 0.55 s, r ~0.63
  //   4 balls: H 0.65 m, E 0.25 m, F 0.25 m, tau 0.53 s, r ~0.68
  const three = uniformPattern(3);
  assert.equal(three.source, 'K96m');
  assert.equal(three.T, 0.55);
  assert.equal(three.F, 0.33);
  assert.equal(three.dwellRatio, 0.63);
  assert.equal(three.measuredDwell, true);
  near(three.P, 0.2, 1e-12, 'with throw and catch at one height the hand travel E is the arc separation P');
  near(three.xC - three.xT, 0.2, 1e-12, 'the hand travels his measured E between catch and throw');
  const four = uniformPattern(4);
  assert.equal(four.source, 'K96m');
  assert.equal(four.T, 0.53);
  assert.equal(four.F, 0.25);
  assert.equal(four.dwellRatio, 0.68);
  near(four.xC - four.xT, 0.25, 1e-12, 'a fountain hand travels E = F');
  // Height: the same-height formula H = g f^2 / 8 from his tempo and dwell ratio. It is not his
  // measured height, and the page shows both (the gap is assumption A6 plus measurement).
  near(three.H, (9.81 * (0.87 * 0.55) ** 2) / 8, 1e-12);
  near(three.H, 0.2808, 1e-4);
  near(four.H, 0.6002, 1e-4);
  assert.deepEqual(PUBLISHED[3].printed, { H: '0.33' });
  assert.deepEqual(PUBLISHED[4].printed, { H: '0.65' });
  near(Number(PUBLISHED[3].printed.H) - three.H, 0.049, 1e-3, 'known gap, 3 balls');
  near(Number(PUBLISHED[4].printed.H) - four.H, 0.05, 1e-3, 'known gap, 4 balls');
  // With the table's 0.7 instead of his 0.63 the 3-ball cascade would be 4 cm lower still.
  near(uniformPattern(3, { dwellRatio: 0.7 }).H, 0.2374, 1e-4);
  // A mixed pattern takes the dwell ratio of the layout it borrows.
  assert.equal(buildPattern('441').dwellRatio, 0.68);
  assert.equal(buildPattern('423').dwellRatio, 0.68);
  assert.equal(buildPattern('31').dwellRatio, 0.63);
  assert.equal(buildPattern('531').dwellRatio, 0.7);
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

test('assumption A6 in numbers: the catch-above-throw tilt of [K96] that this model leaves out', () => {
  // [K96], "The Optimal Cascade": tan(theta) = 2 Vh^2 / (g F), E = P cos(theta). The catch then
  // sits E sin(theta) = P sin(theta) cos(theta) above the throw. The README quotes these figures.
  const tilt = (u) => {
    const theta = Math.atan((2 * u.Vh * u.Vh) / (G * u.F));
    return { deg: (theta * 180) / Math.PI, rise: u.P * Math.sin(theta) * Math.cos(theta) };
  };
  const three = tilt(uniformPattern(3));
  near(three.deg, 16.4, 0.05, '3 balls: dwell angle');
  near(three.rise, 0.054, 5e-4, '3 balls: catch above throw');
  near(three.rise / uniformPattern(3).H, 0.19, 0.005, 'a fifth of the height: not small');
  const seven = tilt(uniformPattern(7));
  near(seven.deg, 5.5, 0.05, '7 balls: dwell angle');
  near(seven.rise, 0.025, 5e-4, '7 balls: catch above throw');
  near(seven.rise / uniformPattern(7).H, 0.015, 0.001, '1.5% of the height');
  // His own height formula with the tilt, H = (F + P sin^2)^2 / (4 F tan), for his 3-ball row:
  const u = uniformPattern(3);
  const theta = Math.atan((2 * u.Vh * u.Vh) / (G * u.F));
  const P = 0.2 / Math.cos(theta); // E = P cos(theta), and E = 0.20 m is what he measured
  near((u.F + P * Math.sin(theta) ** 2) ** 2 / (4 * u.F * Math.tan(theta)), 0.31, 0.005, 'against 0.28 here and 0.33 measured');
});

test('ball counts without a published row are flagged, never silently invented', () => {
  assert.equal(uniformPattern(7).source, 'KL18');
  for (const b of [5, 6, 8, 9, 10, 11, 12, 13]) assert.equal(uniformPattern(b).source, 'KL18s');
  for (const b of [3, 4]) assert.equal(uniformPattern(b).source, 'K96m');
  for (let b = 3; b <= 13; b++) assert.ok(uniformPattern(b).sourceLabel.length > 20, 'every source has a label in words');
  assert.match(uniformPattern(5).sourceLabel, /not yet checked against the book/);
  for (const b of [14, 15, 16, 20, 35]) {
    const u = uniformPattern(b);
    assert.equal(u.source, 'extrapolated');
    // It borrows tempo and spacing from the last published row of the same kind.
    assert.equal(u.borrowedFrom, b % 2 ? 13 : 12);
    assert.equal(u.T, uniformPattern(u.borrowedFrom).T);
    near(u.D1, uniformPattern(u.borrowedFrom).D1, 1e-12);
    assert.equal(u.printed, null, 'nothing is printed anywhere for ' + b + ' balls');
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

  // Uniform patterns at Kalvan's tempos (3 and 4 with his measured dwell ratios, 0.63 and 0.68).
  const expected = { 3: [0.4785, 0.2808], 4: [0.6996, 0.6002], 5: [0.882, 0.9539], 6: [1.058, 1.3726], 7: [1.176, 1.6959] };
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
  // The table's r = 0.7 gives 5.06, just outside the book's "between four and five": that phrase
  // fits dwell ratios from 0.5 (exactly 4) to 0.69 (exactly 5). The value is asserted as it is.
  near(ratio('53', 5, 3), 5.0625, 1e-12);
  near(((5 - 2 * 0.5) / (3 - 2 * 0.5)) ** 2, 4, 1e-12);
  assert.ok(((5 - 2 * 0.69) / (3 - 2 * 0.69)) ** 2 < 5 && ((5 - 2 * 0.7) / (3 - 2 * 0.7)) ** 2 > 5);
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

test('a 1 is a hand-across, not a bullet: one ball diameter across the centre line (A1)', () => {
  for (const text of ['31', '51', '531', '441', '71', '7131', '7531', '91', '97531', 'b1', 'd1', '1']) {
    const p = buildPattern(text);
    let one = 0;
    let top = 0;
    for (let i = 0; i < p.cycleBeats; i++) {
      const rec = throwAtBeat(p, i);
      if (!rec.air) continue;
      const speed = Math.hypot(rec.vx, rec.vy);
      if (rec.value !== 1) {
        top = Math.max(top, speed);
        continue;
      }
      one = Math.max(one, speed);
      // Released half a ball from the centre line on the thrower's side, caught half a ball from
      // it on the other side: the ball crosses by exactly its own width and no hand crosses.
      const side = rec.hand === 0 ? 1 : -1;
      near(rec.x0, (side * BALL_DIAMETER) / 2, 1e-12, text + ' release point of the 1');
      near(rec.x1, (-side * BALL_DIAMETER) / 2, 1e-12, text + ' catch point of the 1');
      near(Math.abs(rec.x1 - rec.x0), BALL_DIAMETER, 1e-12, text + ' travels one ball diameter');
      near(rec.flight, (1 - p.dwellRatio) * p.beat, 1e-12, text + ' flies (1 - r) of a beat');
      assert.ok(rec.height < 0.02, text + ': the 1 stays low (' + rec.height + ' m)');
    }
    assert.ok(one > 0 && one < 1.6, text + ': the 1 moves at walking pace, ' + one.toFixed(2) + ' m/s');
    if (top > 0) assert.ok(one < top, text + ': the 1 leaves at ' + one.toFixed(2) + ' m/s, the highest throw at ' + top.toFixed(2) + ' m/s');
    const row = p.throwTable.find((t) => t.value === 1);
    near(row.distance, BALL_DIAMETER, 1e-12, text + ': the table shows how far the 1 travels');
    near(row.speed, one, 1e-9, text + ': and how fast');
  }
  // 71 is the README's own example: on the 7-ball layout a 1 thrown between the inside throw
  // points would have had to cover 38.7 cm in 63 ms.
  const p = buildPattern('71');
  near(2 * p.layout.xT, 0.3865, 1e-4);
  near(p.flightByValue[1], 0.063, 1e-12);
  assert.equal(p.layout.xP, BALL_DIAMETER / 2);
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

test('reusing the array and the cached throw records changes nothing', () => {
  for (const text of ['3', '7', '531', '441', '423', '97531', '501', '2', 'z1']) {
    const fresh = buildPattern(text);
    const reused = buildPattern(text);
    const scratch = [];
    // Visit times in a scrambled order, far apart and close together, forwards and backwards.
    for (let k = 0; k < 300; k++) {
      const t = (((k * 7919) % 300) / 300 - 0.3) * fresh.cycleTime * 9;
      const a = ballStates(buildPattern(text), t); // a pattern with an empty cache every time
      const b = ballStates(reused, t, scratch);
      assert.equal(b, scratch, 'the same array comes back');
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        assert.equal(b[i].ball, a[i].ball, text);
        assert.equal(b[i].air, a[i].air, text);
        assert.equal(b[i].hand, a[i].hand, text);
        assert.equal(b[i].throw.beat, a[i].throw.beat, text);
        if (a[i].air) {
          near(b[i].x, a[i].x, 0, text);
          near(b[i].y, a[i].y, 0, text);
        } else {
          assert.ok(Number.isNaN(b[i].x) && Number.isNaN(b[i].y), text + ': a held ball has no position of its own');
        }
      }
    }
    // The same beat always gives the same record, however the cache has been used in between.
    for (const i of [0, 1, 63, 64, 65, -1, -64, 1000003, -999999]) {
      const rec = Object.assign({}, throwAtBeat(fresh, i));
      for (const j of [i + 64, i - 64, i + 128]) throwAtBeat(fresh, j); // same slot, other beats
      assert.deepEqual(Object.assign({}, throwAtBeat(fresh, i)), rec, text + ' beat ' + i);
      assert.equal(throwAtBeat(fresh, i).beat, i);
    }
  }
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

test('events: the look-ahead bound is safe (nothing happens before it) and useful (it is ahead)', () => {
  for (const text of ['3', '7', '531', '441', '501', '80', '2', 'b1']) {
    const p = buildPattern(text);
    let t = -0.37;
    let skipped = 0;
    for (let k = 0; k < 400; k++) {
      const info = { next: 0 };
      const step = 0.004 + (k % 7) * 0.003;
      const events = eventsBetween(p, t, t + step, info);
      for (const e of events) assert.ok(e.time > t && e.time <= t + step, text);
      assert.ok(info.next >= t + step, text + ': the bound is not in the past');
      // Nothing may happen strictly between the end of the window and the bound.
      if (info.next > t + step) {
        assert.equal(eventsBetween(p, t + step, info.next - 1e-9).length, 0, text + ': an event before the bound at t=' + t);
        skipped++;
      }
      t += step;
    }
    assert.ok(skipped > 300, text + ': most frames can skip the scan (' + skipped + ' of 400)');
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

/**
 * A second, independent check that shares no code with the detector or with ballStates and
 * throwAtBeat: it takes only the beat, the dwell ratio and the three hand points from the pattern,
 * recomputes every flight from the digits, and steps through time.
 */
function independentMinDistance(text, pattern, steps) {
  const g = 9.81;
  const throws = Array.from(text, (ch) => parseInt(ch, 36));
  const n = throws.length;
  const B = pattern.beat;
  const r = pattern.dwellRatio;
  const { xT, xC, xP } = pattern.layout;
  const flightOf = (v) => (v === 0 || v === 2 ? 0 : v === 1 ? (1 - r) * B : (v - 2 * r) * B);
  const sign = (hand) => (hand === 0 ? 1 : -1);
  const record = (i) => {
    const v = throws[((i % n) + n) % n];
    const hand = ((i % 2) + 2) % 2;
    const to = (((i + v) % 2) + 2) % 2;
    const f = flightOf(v);
    return { f, t0: i * B, x0: sign(hand) * (v === 1 ? xP : xT), x1: sign(to) * (v === 1 ? xP : xC) };
  };
  const maxThrow = Math.max(...throws);
  const period = (n % 2 === 0 ? n : 2 * n) * B;
  let min = Infinity;
  for (let k = 0; k < steps; k++) {
    const t = (k / steps) * period;
    const air = [];
    const beat = Math.floor(t / B);
    for (let i = beat - maxThrow - 1; i <= beat + 1; i++) {
      const R = record(i);
      if (!(R.f > 0) || t < R.t0 || t > R.t0 + R.f) continue;
      const s = t - R.t0;
      air.push([R.x0 + ((R.x1 - R.x0) * s) / R.f, ((g * R.f) / 2) * s - (g * s * s) / 2]);
    }
    for (let a = 0; a < air.length; a++) {
      for (let b = a + 1; b < air.length; b++) min = Math.min(min, Math.hypot(air[a][0] - air[b][0], air[a][1] - air[b][1]));
    }
  }
  return min;
}

test('collision: the detector agrees with a simulator that shares no code with it', () => {
  for (const text of ['3', '5', '7', '9', '531', '441', '456', '552', '75', '73', '855', '97531', 'b97531', '7161616', '86420', '71', '51']) {
    const pattern = buildPattern(text);
    const exact = findCollisions(pattern).minDistance;
    const brute = independentMinDistance(text, pattern, 30000);
    assert.ok(brute >= exact - 1e-9 && brute - exact < 2e-3, text + ': exact ' + exact + ', stepped ' + brute);
  }
});

test('collision: 75, the 6-ball half shower, collides on the standard layout (and 552 does not)', () => {
  const result = findCollisions(buildPattern('75'));
  assert.equal(result.collides, true);
  near(result.minDistance, 0.012, 1e-3, 'centres pass 1.2 cm apart');
  assert.equal(findCollisions(buildPattern('552')).collides, false);
});

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
