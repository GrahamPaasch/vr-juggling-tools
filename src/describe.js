/**
 * describe.js: the words. What is being shown for a pattern, which numbers are exact, and what
 * the math does not cover. Pure (no DOM), so the wording is unit tested and shared by the on-page
 * panel and the control board inside VR.
 */

import { SOURCE_LABELS } from './physics.js';

/** "0.5x". Any speed other than real time is always labelled on screen. */
export function formatSpeed(speed) {
  return (Math.round(speed * 100) / 100).toString() + 'x';
}

export const fmt = {
  seconds: (s) => s.toFixed(3) + ' s',
  metres: (m) => (m < 0.995 ? (m * 100).toFixed(1) + ' cm' : m.toFixed(2) + ' m'),
  cm: (m) => (m * 100).toFixed(1) + ' cm',
  degrees: (d) => d.toFixed(2) + '°',
};

/** Words for one pattern: what is shown, what is exact, what is not covered. Shared with VR. */
export function describePattern(pattern, collisions) {
  const D = pattern.ballDiameter;
  if (pattern.uniform) {
    const u = pattern.spatial;
    const name = pattern.balls + '-ball ' + u.kind;
    const published = u.source === 'KL18' || u.source === 'K96m';
    let tag = "Kalvan's spatial optimum";
    if (!published) tag = 'No published values: ' + u.source;
    else if (u.D1 === null) tag = "Kalvan's measured cascade";
    else if (u.kind === 'fountain') tag = "Kalvan's optimum, hand spacing assumed";
    const rows = [
      ['Hand period T', u.T.toFixed(2) + ' s'],
      ['Dwell ratio r', u.dwellRatio.toFixed(2) + ' (W = ' + u.W.toFixed(2) + ')'],
      ['Flight time f', fmt.seconds(u.flight)],
      ['Height above the hands H', fmt.metres(u.H)],
      ['Flight distance F', fmt.cm(u.F)],
      ['Spacing on one arc D1', u.D1 === null ? 'none (W < 1)' : fmt.cm(u.D1)],
      [u.kind === 'cascade' ? 'Arc separation P' : 'Between the hands P', fmt.cm(u.P)],
      ['Pattern width F + P', fmt.cm(u.width)],
      ['Throw error allowed Emax', u.emaxDeg === null ? 'not defined' : fmt.degrees(u.emaxDeg)],
      ['Closest two balls come', fmt.cm(collisions.minDistance)],
    ];
    const notes = [];
    if (u.source === 'KL18') {
      notes.push('T and F are from Kalvan and Lewbel’s table of good patterns. Everything else follows from the formulas, with real gravity.');
    } else if (u.source === 'K96m') {
      notes.push('T and F are Kalvan’s measurements of a real juggler. Everything else follows from the formulas, with real gravity.');
    } else {
      notes.push('Careful: ' + SOURCE_LABELS[u.source] + '.');
    }
    if (u.D1 === null) {
      notes.push('With 3 balls there is less than one ball in the air per hand, so balls on the same arc never meet. Kalvan’s arc spacing and error limit do not exist here; P is his measured value.');
    }
    if (u.kind === 'fountain') {
      notes.push('Kalvan’s math fixes each hand’s arc but leaves the gap between the hands free. Here the two inside throw points are one D1 apart: our assumption, not his.');
    }
    return {
      title: name,
      short: name,
      tag,
      tagClass: published ? '' : 'mixed',
      rows,
      header: null,
      notes,
      collision: null,
      vrStatus: tag,
      vrStatusKind: published ? 'good' : 'plain',
    };
  }

  const ref = pattern.reference;
  const rows = pattern.throwTable.map((t) => {
    if (t.type === 'empty') return ['0', 'empty hand', ''];
    if (t.type === 'hold') return ['2', 'held', ''];
    return [t.value.toString(36), fmt.seconds(t.flight), fmt.metres(t.height) + (t.type === 'pass' ? ' (handed across)' : '')];
  });
  const refName = ref.balls + '-ball ' + ref.kind;
  const notes = [
    'Flight times and heights are exact (beat ' + pattern.beat.toFixed(3) + ' s, dwell ratio ' + pattern.dwellRatio.toFixed(2) + ', real gravity).',
    'The spatial optimum is only derived for uniform cascades and fountains. This pattern borrows the hand positions and tempo of Kalvan’s ' + refName + ', so its highest throw is exactly that throw.',
  ];
  if (ref.source !== 'KL18' && ref.source !== 'K96m') {
    notes.push('Careful: for a ' + refName + ' there are ' + SOURCE_LABELS[ref.source].replace(/^.*\(|\)$/g, '') + ', so its tempo and spacing are ' + ref.source + '.');
  }
  let collision;
  let vrStatus = 'exact timing, standard layout';
  let vrStatusKind = 'plain';
  if (collisions.collides) {
    const hit = collisions.hits[0];
    collision = {
      bad: true,
      text:
        'Balls would collide on this layout: the ' + hit.first.value.toString(36) + ' and the ' + hit.second.value.toString(36) +
        ' pass ' + fmt.cm(hit.distance) + ' apart (centres), closer than one ' + fmt.cm(D) + ' ball. Red rings mark where. Throwing one of them outside fixes it; that is planned for version 2.',
      short: 'Balls would collide: the ' + hit.first.value.toString(36) + ' and the ' + hit.second.value.toString(36) + ' pass ' + fmt.cm(hit.distance) + ' apart.',
    };
    vrStatus = 'COLLISION: ' + hit.first.value.toString(36) + ' hits ' + hit.second.value.toString(36);
    vrStatusKind = 'warn';
  } else if (collisions.closest) {
    collision = {
      bad: false,
      text: 'No collisions: balls never come closer than ' + fmt.cm(collisions.minDistance) + ' (centres; the ball is ' + fmt.cm(D) + ').',
    };
  } else {
    collision = { bad: false, text: 'No collisions: there are never two balls in the air together.' };
  }
  return {
    title: pattern.text + ' · ' + pattern.balls + (pattern.balls === 1 ? ' ball' : ' balls'),
    short: pattern.text,
    tag: 'Exact timing, standard layout',
    tagClass: 'mixed',
    rows,
    header: ['Throw', 'Flight', 'Height above the hands'],
    notes,
    collision,
    vrStatus,
    vrStatusKind,
  };
}
