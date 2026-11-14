import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RIGHT,
  LEFT,
  DEFAULT_PLACEMENT,
  HAND_BELOW_EYES,
  POSTURE_TOLERANCE,
  clampNudge,
  fitsPosture,
  provisionalPlacement,
  measure,
  nudgeOffset,
  nudgeShift,
  multiply,
  rotate,
  restoreCalibration,
} from '../src/calibration.js';
import * as physics from '../src/physics.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (label || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );

const aboutAxis = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const Y = [0, 1, 0];
const Z = [0, 0, 1];
const NO_NUDGE = { palm: 0, wrist: 0, thumb: 0 };

/**
 * Controllers held palm up where a juggler catches. Palm frame: out of the palm is -X on the
 * right hand and +X on the left, so turning the right frame -90 degrees about Z (and the left
 * +90 degrees) points "out of the palm" straight up.
 */
const PALM_UP = [aboutAxis(Z, -Math.PI / 2), aboutAxis(Z, Math.PI / 2)];

/** A person at `head` facing `yaw`, grips `out` metres ahead and `apart` to each side. */
function person(options) {
  const o = Object.assign({ head: { x: 0, y: 1.62, z: 0 }, yaw: 0, out: 0.36, apart: 0.24, gripY: 1.0, nudge: NO_NUDGE }, options);
  const turn = aboutAxis(Y, o.yaw);
  const frames = [multiply(turn, PALM_UP[RIGHT]), multiply(turn, PALM_UP[LEFT])];
  const palm = (side) => {
    const local = [side === RIGHT ? o.apart : -o.apart, 0, -o.out]; // in the person's own frame
    const grip = rotate(turn, local);
    const offset = rotate(frames[side], nudgeOffset(side, o.nudge));
    return { x: o.head.x + grip[0] + offset[0], y: o.gripY + grip[1] + offset[1], z: o.head.z + grip[2] + offset[2] };
  };
  return { head: o.head, headYaw: o.yaw, palms: [palm(RIGHT), palm(LEFT)], frames, trackable: true };
}

test('the two modules agree which hand is which', () => {
  assert.equal(RIGHT, physics.RIGHT);
  assert.equal(LEFT, physics.LEFT);
});

test('a trigger pull records hand height and distance from the body, facing the way the hands are', () => {
  const m = measure(person({ head: { x: 0.3, y: 1.62, z: 0.2 }, out: 0.36, gripY: 1.01 }));
  assert.equal(m.ok, true);
  near(m.handHeight, 1.01, 1e-12, 'hand height');
  near(m.distance, 0.36, 1e-12, 'distance from the body');
  near(m.yaw, 0, 1e-12, 'facing');
  assert.equal(m.spotX, 0.3);
  assert.equal(m.spotZ, 0.2);
  assert.equal(m.eyeHeight, 1.62);
  // The same person turned 50 degrees to the left gives the same calibration, turned.
  const turned = measure(person({ head: { x: 0.3, y: 1.62, z: 0.2 }, out: 0.36, gripY: 1.01, yaw: (50 * Math.PI) / 180 }));
  near(turned.handHeight, 1.01, 1e-12);
  near(turned.distance, 0.36, 1e-12);
  near(turned.yaw, (50 * Math.PI) / 180, 1e-12);
  // How the hands were held is kept relative to the pattern, so it does not turn with the person.
  for (const side of [RIGHT, LEFT]) for (let i = 0; i < 4; i++) near(turned.frames[side][i], m.frames[side][i], 1e-12, 'palm frame');
  for (const side of [RIGHT, LEFT]) for (let i = 0; i < 4; i++) near(m.frames[side][i], PALM_UP[side][i], 1e-12);
});

test('hands of unequal height or reach are averaged; values stay inside what the sliders allow', () => {
  const s = person({});
  s.palms[RIGHT].y = 1.04;
  s.palms[LEFT].y = 0.98;
  near(measure(s).handHeight, 1.01, 1e-12);
  assert.equal(measure(person({ gripY: 2.6 })).handHeight, 1.9);
  assert.equal(measure(person({ gripY: -0.3 })).handHeight, 0.1);
  assert.equal(measure(person({ out: 1.4 })).distance, 0.8);
  // Hands right under the chin give no direction: the pattern faces the way the head does.
  const close = measure(person({ out: 0.02, yaw: 0.7 }));
  near(close.yaw, 0.7, 1e-12);
  assert.equal(close.distance, 0.15);
});

test('calibration needs both hands: with one it says which is missing and records nothing', () => {
  const s = person({});
  const left = measure(Object.assign({}, s, { palms: [s.palms[RIGHT], null] }));
  assert.deepEqual(left, { ok: false, reason: 'left' });
  const right = measure(Object.assign({}, s, { palms: [null, s.palms[LEFT]] }));
  assert.deepEqual(right, { ok: false, reason: 'right' });
  assert.deepEqual(measure(Object.assign({}, s, { palms: [null, null] })), { ok: false, reason: 'both' });
  // One hand alone would have put the whole pattern on that hand, 36 degrees off to the side.
  const oneHand = Math.atan2(-s.palms[RIGHT].x, -s.palms[RIGHT].z);
  near((oneHand * 180) / Math.PI, -33.7, 0.1);
  // A device with nothing to hold (a phone in a viewer) is told apart from "not tracked yet".
  assert.deepEqual(measure(Object.assign({}, s, { palms: [null, null], trackable: false })), { ok: false, reason: 'untrackable' });
  assert.equal(measure(null).ok, false);
});

test('a remembered calibration is used again only in the posture it was made in', () => {
  const standing = { done: true, eyeHeight: 1.62, handHeight: 1.0, distance: 0.33 };
  assert.equal(fitsPosture(standing, 1.62), true);
  assert.equal(fitsPosture(standing, 1.57), true, 'looking down a little');
  assert.equal(fitsPosture(standing, 1.7), true);
  assert.equal(fitsPosture(standing, 1.25), false, 'sitting down');
  assert.equal(fitsPosture(standing, 1.1), false);
  // The case that used to slip through: calibrated sitting (eyes 1.25 m, hands 0.75 m), back
  // standing. The hand height itself looked plausible for a standing person; the posture is not.
  const sitting = { done: true, eyeHeight: 1.25, handHeight: 0.75, distance: 0.3 };
  assert.equal(fitsPosture(sitting, 1.65), false);
  assert.equal(fitsPosture(sitting, 1.78), false);
  assert.equal(fitsPosture(sitting, 1.2), true);
  assert.equal(POSTURE_TOLERANCE, 0.1);
  near(1.62 + POSTURE_TOLERANCE, 1.72, 1e-12);
  assert.equal(fitsPosture(standing, 1.62 + POSTURE_TOLERANCE + 0.001), false);
  // Never calibrated, or no head height yet.
  assert.equal(fitsPosture({ done: false, eyeHeight: 1.62 }, 1.62), false);
  assert.equal(fitsPosture(null, 1.62), false);
  assert.equal(fitsPosture(standing, NaN), false);
});

test('before calibration the hands are guessed below the head, and the guess stays inside the range', () => {
  assert.deepEqual(provisionalPlacement(1.62), { handHeight: 1.62 - HAND_BELOW_EYES, distance: DEFAULT_PLACEMENT.distance });
  assert.equal(provisionalPlacement(0.4).handHeight, 0.1);
  assert.equal(provisionalPlacement(3).handHeight, 1.9);
});

test('palm nudge: the offset is mirrored between the hands', () => {
  const nudge = { palm: 0.02, wrist: 0.01, thumb: 0.005 };
  assert.deepEqual(nudgeOffset(RIGHT, nudge), [-0.02, 0.01, -0.005]);
  assert.deepEqual(nudgeOffset(LEFT, nudge), [0.02, 0.01, -0.005]);
  assert.equal(clampNudge(0.2), 0.06);
  assert.equal(clampNudge(-0.2), -0.06);
});

test('palm nudge moves the pattern with the palm point, for hands held as they were at calibration', () => {
  const m = measure(person({}));
  // Palms up: "to palm" lifts the landing point, "to thumb" pushes it away from the body, and
  // "to wrist" moves the two hands opposite ways sideways, which cancels.
  let shift = nudgeShift(m.frames, NO_NUDGE, { palm: 0.02, wrist: 0, thumb: 0 });
  near(shift.up, 0.02, 1e-12);
  near(shift.out, 0, 1e-12);
  shift = nudgeShift(m.frames, NO_NUDGE, { palm: 0, wrist: 0, thumb: 0.015 });
  near(shift.up, 0, 1e-12);
  near(shift.out, 0.015, 1e-12);
  shift = nudgeShift(m.frames, NO_NUDGE, { palm: 0, wrist: 0.03, thumb: 0 });
  near(shift.up, 0, 1e-12);
  near(shift.out, 0, 1e-12);
  // It is a difference: going back undoes it.
  const there = nudgeShift(m.frames, NO_NUDGE, { palm: 0.02, wrist: -0.015, thumb: 0.01 });
  const back = nudgeShift(m.frames, { palm: 0.02, wrist: -0.015, thumb: 0.01 }, NO_NUDGE);
  near(there.up + back.up, 0, 1e-12);
  near(there.out + back.out, 0, 1e-12);
  // No record of how the hands were held (calibrated by the sliders only): nothing moves.
  assert.deepEqual(nudgeShift(null, NO_NUDGE, { palm: 0.02, wrist: 0, thumb: 0 }), { up: 0, out: 0 });
});

test('nudging after calibration lands where calibrating with that nudge would have', () => {
  // The same hands, however they are tilted: the anchor after "calibrate, then nudge" equals
  // the anchor of "nudge, then calibrate".
  const tilt = aboutAxis([1, 0, 0], 0.4); // wrists dropped
  const tilted = (nudge, yaw) => {
    const s = person({ nudge: NO_NUDGE, yaw });
    const turn = aboutAxis(Y, yaw);
    s.frames = [multiply(turn, multiply(tilt, PALM_UP[RIGHT])), multiply(turn, multiply(tilt, PALM_UP[LEFT]))];
    for (const side of [RIGHT, LEFT]) {
      const o = rotate(s.frames[side], nudgeOffset(side, nudge));
      s.palms[side] = { x: s.palms[side].x + o[0], y: s.palms[side].y + o[1], z: s.palms[side].z + o[2] };
    }
    return s;
  };
  for (const yaw of [0, 0.9, -2.2]) {
    for (const nudge of [{ palm: 0.02, wrist: 0, thumb: 0 }, { palm: -0.01, wrist: 0.03, thumb: 0.02 }, { palm: 0.06, wrist: -0.06, thumb: -0.06 }]) {
      const first = measure(tilted(NO_NUDGE, yaw));
      const shift = nudgeShift(first.frames, NO_NUDGE, nudge);
      const direct = measure(tilted(nudge, yaw));
      near(first.handHeight + shift.up, direct.handHeight, 1e-9, 'hand height, yaw ' + yaw);
      near(first.distance + shift.out, direct.distance, 1e-9, 'distance, yaw ' + yaw);
      assert.ok(Math.abs(shift.up) + Math.abs(shift.out) > 0.003, 'the nudge matters');
    }
  }
});

test('quaternion helpers: compose and rotate', () => {
  const quarter = aboutAxis(Y, Math.PI / 2); // +90 degrees about the vertical: -Z turns to -X
  const v = rotate(quarter, [0, 0, -1]);
  near(v[0], -1, 1e-12);
  near(v[1], 0, 1e-12);
  near(v[2], 0, 1e-12);
  const half = multiply(quarter, quarter);
  const w = rotate(half, [1, 2, 3]);
  near(w[0], -1, 1e-12);
  near(w[1], 2, 1e-12);
  near(w[2], -3, 1e-12);
  // a * b applies b first.
  const lift = aboutAxis([1, 0, 0], Math.PI / 2); // +Y turns to +Z
  const both = rotate(multiply(quarter, lift), [0, 1, 0]);
  near(both[0], 1, 1e-12, 'lifted to +Z, then turned to +X');
});

test('what is read back from storage is checked, not trusted', () => {
  assert.deepEqual(restoreCalibration(null), { done: false, handHeight: 1.05, distance: 0.35, eyeHeight: 1.65, frames: null, palmChecked: false });
  const good = restoreCalibration({ calibrated: true, handHeight: 0.98, distance: 0.41, eyeHeight: 1.6, frames: PALM_UP, palmChecked: true });
  assert.deepEqual(good, { done: true, handHeight: 0.98, distance: 0.41, eyeHeight: 1.6, frames: PALM_UP, palmChecked: true });
  // A calibration saved with the head "on the floor" (no head pose yet) is not a calibration.
  const floor = restoreCalibration({ calibrated: true, handHeight: 0.1, distance: 0.35, eyeHeight: 0 });
  assert.equal(floor.done, false);
  assert.equal(floor.eyeHeight, 1.65);
  // Rubbish in, defaults out.
  const junk = restoreCalibration({ calibrated: 'yes', handHeight: 'tall', distance: NaN, eyeHeight: null, frames: [[1, 2], 'x'], palmChecked: 1 });
  assert.deepEqual(junk, { done: false, handHeight: 1.05, distance: 0.35, eyeHeight: 1.65, frames: null, palmChecked: false });
  assert.equal(restoreCalibration({ handHeight: 9 }).handHeight, 1.9);
  assert.equal(restoreCalibration({ distance: 0 }).distance, 0.15);
});
