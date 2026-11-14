/**
 * physics.js: the ideal-juggling math. Pure functions only (no DOM, no three.js, no clock).
 *
 * Sources (see README.md for the full citations and for which lines are assumptions):
 *   [S]    Claude Shannon's juggling theorem: h (d + f) = n (d + e).
 *   [K96]  Jack Kalvan, "Optimal Juggling", 1996. http://www.juggling.org/papers/OJ/
 *   [KL18] Jack Kalvan & Arthur Lewbel, "When Balls Collide", 2018 (table of good patterns, p. 78;
 *          the 7-ball row is the one quoted in GrahamPaasch/juggling_coach README.txt).
 *
 * Units: SI (metres, seconds). Angles are radians unless the name ends in "Deg".
 *
 * Pattern frame: x = the juggler's right, y = up, measured from the height at which every ball is
 * thrown and caught (the calibrated hand height). Flights stay in the plane z = 0, because the ideal
 * patterns in [K96] are strictly two-dimensional.
 *
 * Hands: 0 = right, 1 = left. Beat i is thrown by hand (i mod 2): throws alternate, right hand first.
 */

/** Gravity, m/s^2. The value Kalvan uses. Never scaled: slow motion scales the clock instead. */
export const G = 9.81;

/** Ball diameter, m. The 6 cm ball of the [KL18] table row quoted in juggling_coach. */
export const BALL_DIAMETER = 0.06;

/**
 * Dwell ratio r = d / (d + e): the fraction of the hand period a hand is holding a ball.
 * Every row of the [KL18] table has W = b/2 - 0.7, i.e. r = 0.7 (7 balls: W = 2.8).
 * [K96] reports preferred values "near 2/3"; 0.7 is the value behind the numbers this app must show.
 */
export const DWELL_RATIO = 0.7;

export const RIGHT = 0;
export const LEFT = 1;

const EPS = 1e-9;

export function mod(a, n) {
  return ((a % n) + n) % n;
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

/** +1 for the right hand, -1 for the left: the sign of that hand's side of the pattern. */
export function handSign(hand) {
  return hand === RIGHT ? 1 : -1;
}

// ---------------------------------------------------------------------------------------------
// Siteswap parsing and validation (vanilla asynchronous only)
// ---------------------------------------------------------------------------------------------

export const MAX_PERIOD = 48;

/**
 * Parse and validate a vanilla (asynchronous, one ball per throw) siteswap.
 * Returns { ok: true, text, throws, period, balls, maxThrow } or { ok: false, code, error }.
 */
export function parseSiteswap(input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  if (raw === '') {
    return fail('empty', 'Type a siteswap, for example 3, 531 or 441.');
  }
  if (/[\[\]]/.test(raw)) {
    return fail(
      'multiplex',
      'Multiplex siteswaps (two balls in one throw, like [43]23) are out of scope. ' +
        'Enter a vanilla siteswap such as 531.'
    );
  }
  if (/[()*]/.test(raw)) {
    return fail(
      'sync',
      'Synchronous siteswaps such as (4,4) or (6x,4)* are not in version 1. They are planned for ' +
        'version 2. Enter a vanilla (alternating hands) siteswap such as 531.'
    );
  }
  const text = raw.replace(/[\s,]+/g, '');
  if (text === '') {
    return fail('empty', 'Type a siteswap, for example 3, 531 or 441.');
  }
  const bad = text.match(/[^0-9a-z]/);
  if (bad) {
    return fail(
      'char',
      '"' + bad[0] + '" is not a siteswap throw. Use digits 0-9 (letters a-z mean 10-35), for example 531.'
    );
  }
  if (text.length > MAX_PERIOD) {
    return fail('toolong', 'That pattern is too long (limit ' + MAX_PERIOD + ' throws).');
  }

  const throws = Array.from(text, (ch) => parseInt(ch, 36));
  const n = throws.length;
  const sum = throws.reduce((a, b) => a + b, 0);

  // A siteswap is valid exactly when no two throws land on the same beat.
  const landedBy = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const slot = (i + throws[i]) % n;
    if (landedBy[slot] !== -1) {
      const j = landedBy[slot];
      let msg =
        text + ' is not a valid siteswap: the ' + text[j] + ' (throw ' + (j + 1) + ') and the ' +
        text[i] + ' (throw ' + (i + 1) + ') would land in the same hand at the same time.';
      if (sum % n !== 0) {
        msg +=
          ' Its throws average ' + (sum / n).toFixed(2) +
          '; a valid siteswap averages a whole number of balls.';
      }
      return fail('invalid', msg);
    }
    landedBy[slot] = i;
  }

  const balls = sum / n;
  if (balls === 0) {
    return fail('zero', 'That is zero balls: a 0 is an empty hand, so there is nothing to juggle.');
  }
  return {
    ok: true,
    text,
    throws,
    period: n,
    balls,
    maxThrow: Math.max.apply(null, throws),
  };
}

function fail(code, error) {
  return { ok: false, code, error };
}

// ---------------------------------------------------------------------------------------------
// Timing: Shannon's theorem and exact flight times
// ---------------------------------------------------------------------------------------------

/**
 * Shannon's theorem [S]: h (d + f) = n (d + e).
 * Returns the left side minus the right side; zero means the theorem holds.
 */
export function shannonResidual(q) {
  return q.hands * (q.dwell + q.flight) - q.balls * (q.dwell + q.empty);
}

/**
 * Kalvan's W (omega in [K96]): the average number of balls in flight per hand.
 * Shannon's theorem rewritten with r = d/(d+e) and W = f/(d+e) is  b/h = W + r.
 */
export function ballsInFlightPerHand(balls, dwellRatio, hands) {
  return balls / (hands === undefined ? 2 : hands) - dwellRatio;
}

/**
 * Exact flight time of a throw of value v.
 *
 * A throw made on beat i is thrown again on beat i + v, and it is caught one dwell time before
 * that. With beat time B (the hand period is T = 2B) and dwell d = r T = 2 r B:
 *
 *     f(v) = v B - d = (v - 2r) B          for v >= 3      [S], [K96]
 *
 * For a uniform pattern (every throw v = b) this is f = (b/2 - r) T = W T: Shannon's theorem.
 *
 * Conventions for the short throws (labelled assumptions, see README "Assumptions"):
 *   v = 0  an empty beat: no ball, no flight.
 *   v = 2  a hold: the ball stays in the hand, no flight.                              (A2)
 *   v = 1  a fast pass straight across. A full dwell of 2rB does not fit in the one beat this
 *          ball has, so the same ratio is applied to that one beat: the receiving hand holds it
 *          for r B and it flies for (1 - r) B.                                         (A1)
 *          It is handed across the middle, from one hand's throw point to the other's
 *          (see throwAtBeat), the way jugglers bring the hands together for a 1.
 */
export function flightTime(value, beat, dwellRatio) {
  const r = dwellRatio === undefined ? DWELL_RATIO : dwellRatio;
  if (value === 0 || value === 2) return 0;
  if (value === 1) return (1 - r) * beat;
  return (value - 2 * r) * beat;
}

/** How long the catching hand holds a ball that arrived as a throw of this value. */
export function dwellAfter(value, beat, dwellRatio) {
  const r = dwellRatio === undefined ? DWELL_RATIO : dwellRatio;
  if (value === 0 || value === 2) return 0;
  if (value === 1) return r * beat;
  return 2 * r * beat;
}

/**
 * Peak height above the hands for a flight of f seconds thrown and caught at the same height:
 * the ball rises for f/2, so H = (1/2) g (f/2)^2 = g f^2 / 8.   [K96]
 */
export function peakHeight(flight) {
  return (G * flight * flight) / 8;
}

/** Vertical launch speed for a flight of f seconds thrown and caught at the same height. [K96] */
export function launchSpeed(flight) {
  return (G * flight) / 2;
}

// ---------------------------------------------------------------------------------------------
// Kalvan's spatial optimum for uniform cascades and fountains
// ---------------------------------------------------------------------------------------------

/**
 * Published hand periods T and flight distances F, by number of balls.
 *
 *  KL18  "When Balls Collide" table of good patterns (p. 78): 5, 7, 9, 11, 13 ball cascades, 6 cm
 *        balls, W = b/2 - 0.7. The 7-ball row is the juggling_coach README row.
 *  K96m  "Optimal Juggling" index, average measurements from videotape: Kalvan's own 3, 4 and 6
 *        ball patterns and Anthony Gatto's 8 ball fountain. For 3 balls the measured dwell
 *        distance E = 0.20 m is used as the arc separation P (throw and catch at the same height).
 */
export const PUBLISHED = {
  3: { T: 0.55, F: 0.33, P: 0.2, source: 'K96m' },
  4: { T: 0.53, F: 0.25, source: 'K96m' },
  5: { T: 0.49, F: 0.52, source: 'KL18' },
  6: { T: 0.47, F: 0.38, source: 'K96m' },
  7: { T: 0.42, F: 0.65, source: 'KL18' },
  8: { T: 0.38, F: 0.44, source: 'K96m' },
  9: { T: 0.35, F: 0.73, source: 'KL18' },
  11: { T: 0.3, F: 0.8, source: 'KL18' },
  13: { T: 0.27, F: 0.93, source: 'KL18' },
};

export const SOURCE_LABELS = {
  KL18: 'Kalvan & Lewbel 2018, table of good patterns',
  K96m: 'Kalvan 1996, measured from videotape',
  interpolated: 'interpolated between published rows (no published values for this number)',
  extrapolated: 'held at the nearest published row (no published values for this number)',
};

/**
 * Distance between the two parabolic arcs of a cascade when consecutive balls on opposite arcs
 * come exactly `clearance` apart at their closest (centre to centre).   [K96], [KL18] p. 149
 *
 *     (P / D2)^2 = (4 Vh / (g T))^2 + 1
 *
 * Seen from the lower ball, the other ball moves in a straight line: horizontally at 2 Vh (they
 * travel in opposite directions) and vertically at g T / 2 (they were thrown T/2 apart).
 */
export function arcSeparation(clearance, horizontalSpeed, handPeriod) {
  const k = (4 * horizontalSpeed) / (G * handPeriod);
  return clearance * Math.sqrt(k * k + 1);
}

/** Inverse of arcSeparation: the closest approach D2 between balls on opposite cascade arcs. */
export function crossingClearance(arcSep, horizontalSpeed, handPeriod) {
  const k = (4 * horizontalSpeed) / (G * handPeriod);
  return arcSep / Math.sqrt(k * k + 1);
}

/**
 * Largest throw-angle error before two balls on the same arc touch.   [KL18], juggling_coach
 *     Emax = (D1 - D) / (4 H)        (radians)
 * An angle error e moves a ball sideways by 2 H e at the top of its arc; two neighbours erring
 * toward each other close the gap D1 - D at 4 H e.
 */
export function maxAngleError(d1, ballDiameter, height) {
  return (d1 - ballDiameter) / (4 * height);
}

/**
 * Kalvan's spatially optimal uniform pattern for `balls` balls: a cascade when odd, a fountain
 * when even. "Spatially optimal" [K96]: the same room for error at every place balls can collide,
 * i.e. D2 = D1.
 *
 * Inputs Kalvan treats as the juggler's preference (T, r, and how much room for error, set by F)
 * come from the published rows above. Everything else is derived:
 *
 *     W  = b/2 - r                      balls in flight per hand            [S], [K96]
 *     f  = W T                          flight time
 *     H  = g f^2 / 8                    height above the hands
 *     D1 = F / W                        spacing of neighbours on one arc    [K96] "optimal arc"
 *     Vh = F / f                        horizontal speed
 *     P  = D1 sqrt((4 Vh / (g T))^2 + 1)   cascade arc separation, from D2 = D1
 *     width = F + P                     distance between the two catch points
 *     Emax = (D1 - D) / (4 H)
 *
 * Hand positions: catch outside at x = (F + P)/2; throw inside at x = (F - P)/2 for a cascade
 * and (P - F)/2 for a fountain.
 *
 * `overrides` ({ T, F, P, dwellRatio, ballDiameter }) exists for the unit tests, which check the
 * collision detector against Kalvan's closed-form grazing conditions. The app never passes it.
 */
export function uniformPattern(balls, overrides) {
  if (!Number.isInteger(balls) || balls < 3) {
    throw new RangeError('uniformPattern needs a whole number of balls, 3 or more');
  }
  const o = overrides || {};
  const r = o.dwellRatio === undefined ? DWELL_RATIO : o.dwellRatio;
  const D = o.ballDiameter === undefined ? BALL_DIAMETER : o.ballDiameter;
  const b = balls;
  const kind = b % 2 === 1 ? 'cascade' : 'fountain';
  const W = ballsInFlightPerHand(b, r);

  const row = publishedRow(b, r);
  const T = o.T === undefined ? row.T : o.T;
  const f = W * T;
  const H = peakHeight(f);
  const F = o.F === undefined ? (row.F !== undefined ? row.F : W * row.D1) : o.F;
  const Vh = F / f;

  // With less than one ball per arc, neighbours on an arc never meet: there is no D1.  [K96]
  const D1 = W >= 1 ? F / W : null;

  const assumptions = [];
  let P;
  if (o.P !== undefined) {
    P = o.P;
  } else if (kind === 'cascade') {
    if (D1 !== null) {
      P = arcSeparation(D1, Vh, T); // D2 = D1
    } else {
      P = row.P; // 3 balls: measured, the theory leaves it free
    }
  } else {
    // Fountain: the hands juggle independently and [K96] leaves P free ("approximately the width
    // of the shoulders"). Assumption A3: keep the two inside throw points one D1 apart.
    P = F + D1;
    assumptions.push('A3');
  }

  const D2 = kind === 'cascade' ? crossingClearance(P, Vh, T) : null;
  // Catch outside, throw inside. A cascade throw crosses (xT + xC = F); a fountain throw stays on
  // its own side (xC - xT = F). Either way the two catch points are F + P apart.
  const xC = (F + P) / 2;
  const xT = kind === 'cascade' ? (F - P) / 2 : (P - F) / 2;
  const emax = D1 !== null ? maxAngleError(D1, D, H) : null;

  return {
    balls: b,
    kind,
    dwellRatio: r,
    ballDiameter: D,
    T,
    beat: T / 2,
    dwell: r * T,
    empty: (1 - r) * T,
    W,
    flight: f,
    H,
    F,
    Vh,
    D1,
    D2,
    P,
    width: F + P,
    emaxRad: emax,
    emaxDeg: emax === null ? null : (emax * 180) / Math.PI,
    xT,
    xC,
    source: row.source,
    sourceLabel: SOURCE_LABELS[row.source],
    borrowedFrom: row.borrowedFrom,
    assumptions,
  };
}

/**
 * The published row for b balls, or a clearly flagged stand-in when none was published:
 * 10 and 12 are interpolated between their neighbours and above 13 the 13-ball values are held.
 */
function publishedRow(b, r) {
  if (PUBLISHED[b]) return Object.assign({}, PUBLISHED[b]);
  const d1Of = (n) => PUBLISHED[n].F / ballsInFlightPerHand(n, r);
  if (b > 13) {
    return { T: PUBLISHED[13].T, D1: d1Of(13), source: 'extrapolated', borrowedFrom: 13 };
  }
  // b is 10 or 12: both neighbours are published cascades.
  return {
    T: (PUBLISHED[b - 1].T + PUBLISHED[b + 1].T) / 2,
    D1: (d1Of(b - 1) + d1Of(b + 1)) / 2,
    source: 'interpolated',
  };
}

// ---------------------------------------------------------------------------------------------
// A complete pattern: timing for every throw, hand positions, ball identities
// ---------------------------------------------------------------------------------------------

/**
 * Build everything the renderer and the tests need for one siteswap.
 *
 * Uniform patterns (every throw the same, 3 or more) are Kalvan's optimal cascade or fountain.
 *
 * Any other siteswap gets exact timing and heights on a "standard layout" (assumption A4): the
 * tempo and the throw and catch points of the uniform pattern whose throw equals this pattern's
 * highest throw, so its highest throw is exactly that cascade or fountain throw. Kalvan's spatial
 * optimum is not derived for mixed patterns, so `spatial` is null and findCollisions() reports
 * honestly whether balls would hit each other.
 *
 * Returns { ok: false, code, error } for an invalid siteswap.
 */
export function buildPattern(input, overrides) {
  const parsed = typeof input === 'string' ? parseSiteswap(input) : input;
  if (!parsed.ok) return parsed;

  const o = overrides || {};
  const throws = parsed.throws;
  const n = parsed.period;
  const maxThrow = parsed.maxThrow;
  const uniform = throws.every((v) => v === throws[0]) && throws[0] >= 3;

  const ref = uniformPattern(Math.max(3, maxThrow), o);
  const r = ref.dwellRatio;
  const beat = ref.beat;
  const layout = o.layout || { xT: ref.xT, xC: ref.xC };

  // Orbits: the permutation i -> (i + throw) mod n splits the beats into cycles. A cycle whose
  // throws sum to S carries S/n balls, and each of those balls repeats its path every S beats.
  const cycleOfResidue = new Array(n).fill(-1);
  const stepsToAnchor = new Array(n).fill(0);
  const cycles = [];
  let ballCount = 0;
  for (let p = 0; p < n; p++) {
    if (cycleOfResidue[p] !== -1 || throws[p] === 0) continue;
    const members = [];
    const offsets = [];
    let q = p;
    let sum = 0;
    do {
      cycleOfResidue[q] = cycles.length;
      members.push(q);
      offsets.push(sum);
      sum += throws[q];
      q = (q + throws[q]) % n;
    } while (q !== p);
    for (let k = 0; k < members.length; k++) {
      stepsToAnchor[members[k]] = k === 0 ? 0 : sum - offsets[k];
    }
    const balls = sum / n;
    cycles.push({ anchor: p, members, offsets, sum, balls, firstBall: ballCount });
    ballCount += balls;
  }

  const cycleBeats = lcm(n, 2); // the picture (not ball identity) repeats after this many beats

  const flightByValue = [];
  const heightByValue = [];
  for (let v = 0; v <= maxThrow; v++) {
    flightByValue[v] = flightTime(v, beat, r);
    heightByValue[v] = peakHeight(flightByValue[v]);
  }

  const counts = {};
  throws.forEach((v) => {
    counts[v] = (counts[v] || 0) + 1;
  });
  const throwTable = Object.keys(counts)
    .map(Number)
    .sort((a, b) => b - a)
    .map((v) => ({
      value: v,
      count: counts[v],
      type: throwType(v),
      flight: flightByValue[v],
      height: heightByValue[v],
      dwellAfter: dwellAfter(v, beat, r),
      // Horizontal distance covered, shown for a right-hand throw (the left hand mirrors it).
      distance: v === 0 || v === 2 ? 0 : Math.abs(landingX(layout, v, mod(v, 2)) - layout.xT),
    }));

  return {
    ok: true,
    text: parsed.text,
    throws,
    period: n,
    balls: parsed.balls,
    maxThrow,
    uniform,
    kind: uniform ? ref.kind : 'mixed',
    dwellRatio: r,
    ballDiameter: ref.ballDiameter,
    T: ref.T,
    beat,
    dwell: 2 * r * beat,
    empty: 2 * (1 - r) * beat,
    layout,
    reference: ref,
    spatial: uniform ? ref : null,
    flightByValue,
    heightByValue,
    throwTable,
    cycleBeats,
    cycleTime: cycleBeats * beat,
    cycles,
    cycleOfResidue,
    stepsToAnchor,
    ballCount,
  };
}

/**
 * Where a throw of this value lands. Everything is thrown from the inside point xT and caught at
 * the outside point xC, except a 1, which is handed to the other hand's inside point (A1).
 */
function landingX(layout, value, toHand) {
  return handSign(toHand) * (value === 1 ? layout.xT : layout.xC);
}

export function throwType(value) {
  if (value === 0) return 'empty';
  if (value === 2) return 'hold';
  if (value === 1) return 'pass';
  return value % 2 === 1 ? 'cross' : 'same';
}

/**
 * The throw made on beat i (any integer, the pattern runs forever in both directions).
 * `air` is false for an empty beat (0) and for a hold (2).
 */
export function throwAtBeat(pattern, i) {
  const n = pattern.period;
  const residue = mod(i, n);
  const value = pattern.throws[residue];
  const hand = mod(i, 2);
  const toHand = mod(i + value, 2);
  const tThrow = i * pattern.beat;
  const rec = {
    beat: i,
    value,
    hand,
    toHand,
    ball: ballOfBeat(pattern, i, residue),
    tThrow,
    air: value !== 0 && value !== 2,
  };
  if (!rec.air) return rec;

  const flight = pattern.flightByValue[value];
  const x0 = handSign(hand) * pattern.layout.xT;
  const x1 = landingX(pattern.layout, value, toHand);
  rec.flight = flight;
  rec.tCatch = tThrow + flight;
  rec.tPeak = tThrow + flight / 2;
  rec.height = pattern.heightByValue[value];
  rec.x0 = x0;
  rec.x1 = x1;
  rec.vx = (x1 - x0) / flight;
  rec.vy = launchSpeed(flight);
  return rec;
}

/** Which ball (0 .. balls-1) is thrown on beat i; -1 for an empty beat. */
function ballOfBeat(pattern, i, residue) {
  const c = pattern.cycleOfResidue[residue];
  if (c < 0) return -1;
  const cycle = pattern.cycles[c];
  const anchorBeat = i + pattern.stepsToAnchor[residue];
  return cycle.firstBall + (mod(anchorBeat, cycle.sum) - cycle.anchor) / pattern.period;
}

/** Position and velocity of a ball in flight at time t (tThrow <= t <= tCatch). */
export function flightState(rec, t) {
  const s = t - rec.tThrow;
  return {
    x: rec.x0 + rec.vx * s,
    y: rec.vy * s - 0.5 * G * s * s,
    vx: rec.vx,
    vy: rec.vy - G * s,
  };
}

/**
 * Where every ball is at time t. Each entry is
 *   { ball, air: true, x, y, vx, vy, throw }      in flight, or
 *   { ball, air: false, hand, throw }             in a hand (hands.js knows where the hand is).
 * `throw` is the last throw record of that ball (its `value` is 2 while it is being held as a 2).
 */
export function ballStates(pattern, t) {
  const out = [];
  const pos = t / pattern.beat;
  const n = pattern.period;
  for (let c = 0; c < pattern.cycles.length; c++) {
    const cycle = pattern.cycles[c];
    for (let s = 0; s < cycle.balls; s++) {
      // This ball leaves the cycle's anchor beat at  first + k * sum  for every integer k.
      const first = cycle.anchor + n * s;
      const k = Math.floor((pos - first + EPS) / cycle.sum);
      const base = first + k * cycle.sum;
      let m = cycle.members.length - 1;
      while (m > 0 && base + cycle.offsets[m] > pos + EPS) m--;
      const rec = throwAtBeat(pattern, base + cycle.offsets[m]);
      const ball = cycle.firstBall + s;
      if (rec.air && t < rec.tCatch) {
        const st = flightState(rec, Math.max(t, rec.tThrow));
        out.push({ ball, air: true, x: st.x, y: st.y, vx: st.vx, vy: st.vy, throw: rec });
      } else {
        out.push({ ball, air: false, hand: rec.air ? rec.toHand : rec.hand, throw: rec });
      }
    }
  }
  return out;
}

/**
 * Sound events with time in (t0, t1]: every release, peak and catch, sorted by time.
 * Holds (2) and empty beats (0) make no sound: nothing is thrown or caught.
 */
export function eventsBetween(pattern, t0, t1) {
  const out = [];
  if (!(t1 > t0)) return out;
  const first = Math.floor(t0 / pattern.beat) - pattern.maxThrow - 1;
  const last = Math.floor(t1 / pattern.beat) + 1;
  for (let i = first; i <= last; i++) {
    const rec = throwAtBeat(pattern, i);
    if (!rec.air) continue;
    if (rec.tThrow > t0 && rec.tThrow <= t1) {
      out.push(event('release', rec.tThrow, rec.x0, 0, rec.hand, rec));
    }
    if (rec.tPeak > t0 && rec.tPeak <= t1) {
      out.push(event('peak', rec.tPeak, (rec.x0 + rec.x1) / 2, rec.height, rec.hand, rec));
    }
    if (rec.tCatch > t0 && rec.tCatch <= t1) {
      out.push(event('catch', rec.tCatch, rec.x1, 0, rec.toHand, rec));
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function event(type, time, x, y, hand, rec) {
  return { type, time, x, y, hand, value: rec.value, height: rec.height, ball: rec.ball, beat: rec.beat };
}

// ---------------------------------------------------------------------------------------------
// Collision check
// ---------------------------------------------------------------------------------------------

/**
 * Closest approach between every pair of balls that are in the air at the same time.
 *
 * Two balls in flight share the same acceleration, so their separation changes linearly with
 * time ([K96] uses exactly this to derive P). The closest approach of each pair is therefore
 * found exactly, with no time stepping.
 *
 * Returns { collides, minDistance, closest, hits }: `hits` lists every pair whose centres come
 * nearer than one ball diameter; `closest` is the tightest pair overall (null if never two
 * balls in the air together).
 *
 * Scope: balls in flight only, in the ideal planar pattern. Balls being carried in a hand are not
 * checked, because the hand path is a drawing choice and not part of the physics.
 */
export function findCollisions(pattern, ballDiameter) {
  const D = ballDiameter === undefined ? pattern.ballDiameter : ballDiameter;
  const hits = [];
  let closest = null;

  for (let i = 0; i < pattern.cycleBeats; i++) {
    const a = throwAtBeat(pattern, i);
    if (!a.air) continue;
    // b is thrown after a. It can only meet a if it is thrown before a lands (flight < value beats).
    for (let j = i + 1; j < i + a.value; j++) {
      const b = throwAtBeat(pattern, j);
      if (!b.air) continue;
      const start = b.tThrow;
      const end = Math.min(a.tCatch, b.tCatch);
      if (end <= start) continue;

      const pa = flightState(a, start);
      const dx = pa.x - b.x0;
      const dy = pa.y;
      const dvx = pa.vx - b.vx;
      const dvy = pa.vy - b.vy;
      const vv = dvx * dvx + dvy * dvy;
      let s = vv > 0 ? -(dx * dvx + dy * dvy) / vv : 0;
      s = Math.min(Math.max(s, 0), end - start);
      const cx = dx + dvx * s;
      const cy = dy + dvy * s;
      const distance = Math.hypot(cx, cy);

      const at = flightState(b, start + s);
      const pair = {
        distance,
        time: start + s,
        x: at.x + cx / 2,
        y: at.y + cy / 2,
        first: { beat: a.beat, value: a.value, hand: a.hand },
        second: { beat: b.beat, value: b.value, hand: b.hand },
      };
      if (closest === null || distance < closest.distance) closest = pair;
      if (distance < D * (1 - 1e-9)) hits.push(pair);
    }
  }

  hits.sort((p, q) => p.distance - q.distance);
  return {
    collides: hits.length > 0,
    minDistance: closest ? closest.distance : Infinity,
    closest,
    hits,
    ballDiameter: D,
  };
}
