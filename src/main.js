/**
 * main.js: wires the pieces together.
 *
 *   physics.js  the math (pure)            hands.js   ghost hand paths (pure)
 *   scene.js    three.js drawing           view.js    flat-screen camera
 *   xr.js       WebXR, controllers         vrpanel.js the control board inside VR
 *   audio.js    the three sounds           ui.js      the on-page controls
 *
 * There is exactly one clock: simulation time advances by (real time x speed). Slow motion is
 * that and nothing else, so arcs, heights and gravity are identical at every speed.
 */

import { buildPattern, findCollisions, eventsBetween } from './physics.js';
import { buildHandTimeline } from './hands.js';
import { Stage, THREE } from './scene.js';
import { FlatView } from './view.js';
import { SoundBoard, SOUND_TYPES } from './audio.js';
import { XRControl } from './xr.js';
import { FlatUI } from './ui.js';

const STORAGE_KEY = 'vr-juggling-visualizer.v1';
const AUDIO_LOOKAHEAD = 0.2; // seconds of real time scheduled ahead on the audio clock
const AUDIO_MARGIN = 0.05; // of which this much is never spent on compensating output latency

/**
 * Where the pattern sits before anyone calibrates. Placeholders for a standing adult, not physics:
 * the math only cares about height above the hands. Calibration and the sliders replace them.
 */
const DEFAULT_ANCHOR = { spotX: 0, spotZ: 0, yaw: 0, handHeight: 1.05, distance: 0.35, eyeHeight: 1.65 };
const HAND_BELOW_EYES = 0.6; // provisional hand height in VR before calibration: this far below the head
const HAND_HEIGHT_RANGE = [0.1, 1.9]; // metres above the floor (low enough for sitting on a bed)
const DISTANCE_RANGE = [0.15, 0.8]; // metres in front of the head

const state = {
  pattern: null,
  timeline: null,
  collisions: null,
  description: null,
  speed: 1, // never saved: the page always opens at real speed
  simTime: 0,
  view: 'eye',
  show: { ghost: true, arcs: true, mine: true },
  anchor: Object.assign({}, DEFAULT_ANCHOR),
  calibrated: false,
  nudge: { palm: 0, wrist: 0, thumb: 0 },
  handTracking: false,
  palmBall: false,
  typed: '',
  vrMessage: '',
  vrMessageUntil: 0,
  vr: { checking: true, supported: false, presenting: false, reason: '', error: '', calibrating: false },
  audioHorizon: 0,
  displayLead: 0, // seconds from now until the current frame is shown (VR only), for diagnostics
};

let stage;
let view;
let audio;
let xr;
let ui;

let audioWasRunning = false;
let soundFailed = false;

const tmpWorld = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpRight = new THREE.Vector3();

function start() {
  const canvas = document.getElementById('stage');
  try {
    stage = new Stage(canvas);
  } catch (err) {
    document.getElementById('vrNote').textContent =
      'This browser could not start WebGL, which the 3D view needs. (' + (err && err.message ? err.message : err) + ')';
    console.error(err);
    return;
  }
  view = new FlatView(stage);
  audio = new SoundBoard();

  const saved = load();
  if (saved) {
    if (saved.show) Object.assign(state.show, saved.show);
    if (saved.sound) {
      for (const type of SOUND_TYPES) {
        const s = saved.sound[type];
        if (!s) continue;
        if (typeof s.volume === 'number') audio.settings[type].volume = Math.min(Math.max(s.volume, 0), 1);
        if (typeof s.on === 'boolean') audio.settings[type].on = s.on;
        // Solo is a training mode for one sitting; like the speed, it is not restored.
      }
    }
    if (typeof saved.handHeight === 'number') state.anchor.handHeight = saved.handHeight;
    if (typeof saved.distance === 'number') state.anchor.distance = saved.distance;
    if (typeof saved.eyeHeight === 'number') state.anchor.eyeHeight = saved.eyeHeight;
    if (saved.nudge) Object.assign(state.nudge, saved.nudge);
    state.calibrated = !!saved.calibrated;
    state.handTracking = !!saved.handTracking;
  }

  ui = new FlatUI({
    onPattern: (text) => setPattern(text),
    onSpeed: (v) => setSpeed(v),
    onView: (mode) => setView(mode),
    onShow: (key, on) => setShow(key, on),
    onSound: (type, patch) => setSound(type, patch),
    onCalibration: (key, value) => setCalibrationValue(key, value),
    onNudge: (key, value) => setNudge(key, value),
    onHandTracking: (on) => {
      state.handTracking = on;
      xr.handTracking = on;
      save();
    },
    onResetCalibration: () => resetCalibration(),
    onEnterVR: () => toggleVR(),
    onLayout: () => layout(),
    onGesture: () => {
      audio.unlock();
    },
  });

  xr = new XRControl(stage, {
    onSessionStart: () => {
      state.vr.presenting = true;
      audio.unlock();
      ui.setVR(state.vr);
      xr.setSpeedLabel(state.speed);
    },
    onSessionEnd: () => {
      state.vr.presenting = false;
      state.vr.calibrating = false;
      // Back on the flat screen the juggler's spot is the origin again. Hand height, eye height
      // and distance stay as measured, so the flat juggler's-eye view matches the person.
      state.anchor.spotX = 0;
      state.anchor.spotZ = 0;
      state.anchor.yaw = 0;
      applyAnchor(true);
      save();
      ui.setVR(state.vr);
      layout();
    },
    onFirstPose: (sample) => placeInVR(sample),
    onTrigger: () => {
      if (state.vr.calibrating) calibrate(xr.sample());
    },
    onPanel: (id) => panelAction(id),
    onMenu: () => {
      if (state.vr.calibrating) {
        state.vr.calibrating = false;
        xr.prompt('', 0);
        xr.summonPanel('front');
      } else {
        xr.togglePanel();
      }
    },
  });
  xr.handTracking = state.handTracking;
  xr.setNudge(state.nudge);
  xr.setShowMyHands(state.show.mine);

  // First pattern: ?s= in the address, else the last one used, else the 3-ball cascade.
  const params = new URLSearchParams(location.search);
  const requested = params.get('s') || params.get('siteswap');
  const first = [requested, saved && saved.text, '3'].filter(Boolean);
  let loaded = false;
  for (const text of first) {
    if (setPattern(text, { silent: text !== requested })) {
      loaded = true;
      break;
    }
  }
  if (!loaded) setPattern('3');
  if (params.get('view') === 'orbit') state.view = 'orbit';
  applyAnchor(true);

  ui.setSpeed(state.speed);
  ui.setShow(state.show);
  ui.setSound(audio.settings, audio.running);
  ui.setCalibration(state.anchor, state.nudge, state.handTracking);
  ui.setVR(state.vr);
  stage.setShowArcs(state.show.arcs);
  stage.setShowGhostHands(state.show.ghost);
  setView(state.view);

  xr.checkSupport().then(() => {
    state.vr.checking = false;
    state.vr.supported = xr.supported;
    state.vr.reason = xr.reason;
    ui.setVR(state.vr);
  });

  window.addEventListener('resize', layout);
  layout();

  let last = performance.now();
  stage.renderer.setAnimationLoop((time, xrFrame) => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    state.simTime += dt * state.speed;
    // A headset shows this frame a little later, at a time it tells us. Draw the balls where
    // they will be then, so they line up with the tracked hands and with the sound.
    let lead = 0;
    if (xrFrame && typeof xrFrame.predictedDisplayTime === 'number') {
      const ahead = (xrFrame.predictedDisplayTime - now) / 1000;
      if (ahead > 0 && ahead < 0.1) lead = ahead;
    }
    state.displayLead = lead;
    frame(dt, now, lead);
  });

  // For the smoke test and for poking at the app from a console.
  window.__vrj = { state, stage, view, audio, xr, ui, setPattern, setSpeed, setView, calibrate, panelAction, THREE };
}

function frame(dt, now, lead) {
  if (xr.presenting) {
    xr.update(dt);
    // Show the faint head at the juggler's spot once the person has stepped away from it.
    const head = xr.headPosition(tmpCam);
    stage.ghostHead.visible = Math.hypot(head.x - state.anchor.spotX, head.z - state.anchor.spotZ) > 0.6;
    if (state.vrMessage && performance.now() > state.vrMessageUntil) state.vrMessage = '';
    xr.panel.setModel(panelModel());
  } else {
    view.apply();
  }
  stage.update(state.simTime + lead * state.speed);
  try {
    scheduleSounds(now);
  } catch (err) {
    // Sound must never take the picture down with it.
    if (!soundFailed) console.warn('Sound scheduling failed; carrying on without it.', err);
    soundFailed = true;
  }
  stage.render();
  if (audio.running !== audioWasRunning) {
    audioWasRunning = audio.running;
    ui.setSound(audio.settings, audio.running); // hides the "tap to switch sound on" hint
  }
}

// ---------------------------------------------------------------------------------------------
// Pattern, speed, view
// ---------------------------------------------------------------------------------------------

function setPattern(text, options) {
  const pattern = buildPattern(String(text));
  if (!pattern.ok) {
    if (!(options && options.silent)) {
      ui.showError(pattern.error);
      state.vrMessage = shortError(pattern);
      state.vrMessageUntil = performance.now() + 6000;
    }
    return false;
  }
  state.pattern = pattern;
  state.timeline = buildHandTimeline(pattern);
  state.collisions = findCollisions(pattern);
  state.vrMessage = '';
  stage.setPattern(pattern, state.timeline, state.collisions);
  state.description = ui.setPattern(pattern, state.collisions);
  view.setTarget(state.anchor, patternHeight(), false);
  view.retarget();
  audio.cancelPending();
  state.audioHorizon = state.simTime;

  try {
    const url = new URL(location.href);
    url.searchParams.set('s', pattern.text);
    history.replaceState(null, '', url);
  } catch (err) {
    // address bar update is a nicety
  }
  save();
  return true;
}

function shortError(result) {
  if (result.code === 'sync') return 'synchronous patterns come in version 2';
  if (result.code === 'multiplex') return 'multiplex is out of scope';
  if (result.code === 'invalid') return 'not a valid siteswap';
  if (result.code === 'zero') return 'that is zero balls';
  return 'type a siteswap first';
}

function patternHeight() {
  return state.pattern ? state.pattern.heightByValue[state.pattern.maxThrow] : 1;
}

function setSpeed(value) {
  const v = Math.min(Math.max(Math.round(value * 100) / 100, 0.1), 1);
  state.speed = v;
  ui.setSpeed(v);
  xr.setSpeedLabel(v);
  audio.cancelPending();
  state.audioHorizon = state.simTime;
}

function setView(mode) {
  state.view = mode === 'orbit' ? 'orbit' : 'eye';
  view.setTarget(state.anchor, patternHeight(), false);
  view.setMode(state.view);
  ui.setView(state.view);
}

function setShow(key, on) {
  state.show[key] = on;
  stage.setShowArcs(state.show.arcs);
  stage.setShowGhostHands(state.show.ghost);
  xr.setShowMyHands(state.show.mine);
  ui.setShow(state.show);
  save();
}

function setSound(type, patch) {
  const s = audio.settings[type];
  if (patch.volume !== undefined) s.volume = Math.min(Math.max(patch.volume, 0), 1);
  if (patch.toggle === 'on') s.on = !s.on;
  if (patch.toggle === 'solo') {
    const next = !s.solo;
    for (const t of SOUND_TYPES) audio.settings[t].solo = false; // one solo at a time
    s.solo = next;
  }
  // Re-schedule what is already queued, so the change is heard at once.
  audio.cancelPending();
  state.audioHorizon = state.simTime;
  ui.setSound(audio.settings, audio.running);
  save();
}

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

function applyAnchor(resetLook) {
  stage.setAnchor(state.anchor);
  view.setTarget(state.anchor, patternHeight(), false);
  if (resetLook) view.resetLook();
  else view.retarget();
  ui.setCalibration(state.anchor, state.nudge, state.handTracking);
}

function setCalibrationValue(key, value) {
  if (key === 'handHeight') state.anchor.handHeight = Math.min(Math.max(value, HAND_HEIGHT_RANGE[0]), HAND_HEIGHT_RANGE[1]);
  if (key === 'distance') state.anchor.distance = Math.min(Math.max(value, DISTANCE_RANGE[0]), DISTANCE_RANGE[1]);
  applyAnchor(false);
  save();
}

function setNudge(key, value) {
  state.nudge[key] = Math.min(Math.max(value, -0.06), 0.06);
  xr.setNudge(state.nudge);
  ui.setCalibration(state.anchor, state.nudge, state.handTracking);
  save();
}

function resetCalibration() {
  state.anchor.handHeight = DEFAULT_ANCHOR.handHeight;
  state.anchor.distance = DEFAULT_ANCHOR.distance;
  state.anchor.eyeHeight = DEFAULT_ANCHOR.eyeHeight;
  state.nudge = { palm: 0, wrist: 0, thumb: 0 };
  state.calibrated = false;
  xr.setNudge(state.nudge);
  applyAnchor(false);
  save();
}

/** First head pose of a VR session: stand the juggler where the person is, facing their way. */
function placeInVR(sample) {
  const a = state.anchor;
  a.spotX = sample.head.x;
  a.spotZ = sample.head.z;
  a.yaw = sample.headYaw;
  a.eyeHeight = sample.head.y;
  // A saved calibration is reused only if it still fits this posture (standing vs sitting).
  const fits = state.calibrated && a.handHeight < sample.head.y - 0.2 && a.handHeight > sample.head.y - 1.1;
  if (!fits) {
    a.handHeight = Math.max(HAND_HEIGHT_RANGE[0], sample.head.y - HAND_BELOW_EYES);
    a.distance = DEFAULT_ANCHOR.distance;
  }
  applyAnchor(false);
  if (fits) {
    xr.summonPanel('side');
    xr.prompt('Controls: on your left,\nor press A or X to bring them in front', 6);
  } else {
    beginCalibration();
  }
}

function beginCalibration() {
  state.vr.calibrating = true;
  xr.hidePanel();
  xr.prompt('Hold both controllers where you catch,\nthen pull a trigger   (A or X skips)', 0);
}

/**
 * Trigger press during calibration. Records what the spec asks for: hand height, and how far in
 * front of the body the hands are. The juggler's spot moves to where the person is standing and
 * the pattern faces the way their hands are from their head.
 */
function calibrate(sample) {
  const palms = sample.palms.filter(Boolean);
  if (palms.length === 0) {
    xr.prompt('No controller is tracked yet.\nHold them in view and pull a trigger', 0);
    return false;
  }
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const p of palms) {
    mx += p.x / palms.length;
    my += p.y / palms.length;
    mz += p.z / palms.length;
  }
  const dx = mx - sample.head.x;
  const dz = mz - sample.head.z;
  const out = Math.hypot(dx, dz);
  const a = state.anchor;
  a.spotX = sample.head.x;
  a.spotZ = sample.head.z;
  a.eyeHeight = sample.head.y;
  a.yaw = out > 0.08 ? Math.atan2(-dx, -dz) : sample.headYaw;
  a.distance = Math.min(Math.max(out, DISTANCE_RANGE[0]), DISTANCE_RANGE[1]);
  a.handHeight = Math.min(Math.max(my, HAND_HEIGHT_RANGE[0]), HAND_HEIGHT_RANGE[1]);
  state.calibrated = true;
  state.vr.calibrating = false;
  applyAnchor(false);
  save();
  xr.prompt(
    'Calibrated: hands ' + a.handHeight.toFixed(2) + ' m high, ' + a.distance.toFixed(2) + ' m out.\nControls: on your left, or press A or X',
    6
  );
  xr.summonPanel('side');
  return true;
}

// ---------------------------------------------------------------------------------------------
// VR
// ---------------------------------------------------------------------------------------------

async function toggleVR() {
  if (state.vr.presenting) {
    xr.exit();
    return;
  }
  audio.unlock();
  state.vr.error = '';
  try {
    await xr.enter();
  } catch (err) {
    console.warn('Could not start VR', err);
    state.vr.error = 'Could not start VR: ' + (err && err.message ? err.message : err);
    ui.setVR(state.vr);
  }
}

function panelModel() {
  const d = state.description;
  return {
    title: d.title,
    status: state.vrMessage || d.vrStatus,
    statusKind: state.vrMessage ? 'warn' : d.vrStatusKind,
    pattern: state.pattern.text,
    typed: state.typed,
    speed: state.speed,
    sound: audio.settings,
    calibrating: state.vr.calibrating,
    handHeight: state.anchor.handHeight,
    distance: state.anchor.distance,
    nudge: state.nudge,
    palmBall: state.palmBall,
    showArcs: state.show.arcs,
    showGhost: state.show.ghost,
    showMyHands: state.show.mine,
  };
}

function panelAction(id) {
  const parts = id.split(':');
  const kind = parts[0];
  if (kind === 'pattern') {
    state.typed = '';
    setPattern(parts[1]);
  } else if (kind === 'key') {
    if (parts[1] === 'back') state.typed = state.typed.slice(0, -1);
    else if (parts[1] === 'go') {
      if (setPattern(state.typed)) state.typed = '';
    } else if (state.typed.length < 14) state.typed += parts[1];
  } else if (kind === 'speed') {
    setSpeed(Number(parts[1]));
  } else if (kind === 'vol') {
    const s = audio.settings[parts[1]];
    setSound(parts[1], { volume: Math.round((s.volume + (parts[2] === '+' ? 0.1 : -0.1)) * 10) / 10 });
  } else if (kind === 'mute') {
    setSound(parts[1], { toggle: 'on' });
  } else if (kind === 'solo') {
    setSound(parts[1], { toggle: 'solo' });
  } else if (kind === 'calibrate') {
    beginCalibration();
  } else if (kind === 'height') {
    setCalibrationValue('handHeight', state.anchor.handHeight + (parts[1] === '+' ? 0.01 : -0.01));
  } else if (kind === 'distance') {
    setCalibrationValue('distance', state.anchor.distance + (parts[1] === '+' ? 0.01 : -0.01));
  } else if (kind === 'palmball') {
    state.palmBall = !state.palmBall;
    xr.setPalmBall(state.palmBall);
  } else if (kind === 'nudge') {
    setNudge(parts[1], state.nudge[parts[1]] + (parts[2] === '+' ? 0.005 : -0.005));
  } else if (kind === 'toggle') {
    const key = parts[1];
    setShow(key, !state.show[key]);
  } else if (kind === 'spot') {
    xr.moveHeadTo(state.anchor.spotX, state.anchor.spotZ);
  } else if (kind === 'exit') {
    xr.exit();
  }
}

// ---------------------------------------------------------------------------------------------
// Sound scheduling
// ---------------------------------------------------------------------------------------------

/**
 * Hand every sound event in the next AUDIO_LOOKAHEAD of real time to the audio clock. `now` is
 * the page time (performance.now) that state.simTime corresponds to.
 */
function scheduleSounds(now) {
  if (!audio.running || !state.pattern || !(state.speed > 0)) {
    state.audioHorizon = state.simTime;
    return;
  }
  const horizon = state.simTime + AUDIO_LOOKAHEAD * state.speed;
  if (horizon <= state.audioHorizon) return;
  // After a stall (hidden tab) skip what was missed instead of playing it late in a burst.
  const from = Math.max(state.audioHorizon, state.simTime - 0.02);
  const events = eventsBetween(state.pattern, from, horizon);
  state.audioHorizon = horizon;
  if (events.length === 0) return;

  stage.camera.getWorldPosition(tmpCam);
  tmpRight.setFromMatrixColumn(stage.camera.matrixWorld, 0);
  const limit = Math.min(events.length, 48);
  for (let i = 0; i < limit; i++) {
    const e = events[i];
    const when = audio.timeFor(now + ((e.time - state.simTime) / state.speed) * 1000, now, AUDIO_LOOKAHEAD - AUDIO_MARGIN);
    tmpWorld.set(e.x, e.y, 0);
    stage.anchor.localToWorld(tmpWorld);
    const side = tmpWorld.sub(tmpCam).dot(tmpRight);
    audio.play(e.type, when, Math.min(Math.max(side / 0.5, -1), 1) * 0.8, e.height);
  }
}

// ---------------------------------------------------------------------------------------------
// Layout and storage
// ---------------------------------------------------------------------------------------------

function layout() {
  if (!stage || xr.presenting) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Centre the pattern in the part of the window the control panel does not cover.
  const inset = ui.insets();
  if (inset.left > 0 || inset.bottom > 0) {
    stage.camera.setViewOffset(w, h, -inset.left / 2, inset.bottom / 2, w, h);
  } else {
    stage.camera.clearViewOffset();
  }
  stage.resize(w, h);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        text: state.pattern ? state.pattern.text : '3',
        show: state.show,
        sound: audio.settings,
        handHeight: state.anchor.handHeight,
        distance: state.anchor.distance,
        eyeHeight: state.anchor.eyeHeight,
        calibrated: state.calibrated,
        nudge: state.nudge,
        handTracking: state.handTracking,
      })
    );
  } catch (err) {
    // private mode: nothing is saved, the app still works
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

