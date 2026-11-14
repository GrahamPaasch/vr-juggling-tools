/**
 * xr.js: WebXR. Entering and leaving immersive VR, the person's own hands, pointing at the
 * control board, thumbstick movement, and the measurements calibration needs.
 *
 * Proprioception guard (spec): a ball lands at the WebXR *grip* pose, which is the pose "used to
 * render virtual objects such that they appear to be held in the user's hand", near the centre of
 * the curled fingers. It never lands at the controller tip or the pointing ray. The palm point
 * is the grip origin plus a small offset the person can nudge until a virtual ball resting there
 * feels like it sits in the real palm.
 *
 * Grip space axes (WebXR): the back of the right hand faces +X and the back of the left hand faces
 * -X, so "toward the palm" is -X on the right and +X on the left. -Z runs along the handle
 * toward the thumb, and +Y points back toward the wrist.
 */

import { THREE, makeHandCup, OWN_HAND_COLOR, TextLabel } from './scene.js';
import { RIGHT, LEFT } from './physics.js';
import { VRPanel } from './vrpanel.js';
import { formatSpeed } from './describe.js';

const STICK_DEADZONE = 0.5; // high on purpose: a thumb resting on the stick must not move you
const MOVE_SPEED = 1.4; // m/s, a slow walk
const SNAP_ANGLE = Math.PI / 6;
const BUTTON_AX = 4; // xr-standard gamepad: A on the right controller, X on the left
const BUTTON_BY = 5;

const JOINT_FOR_PALM = 'middle-finger-metacarpal';
const UP = new THREE.Vector3(0, 1, 0);

export class XRControl {
  /**
   * handlers: { onSessionStart(), onSessionEnd(), onFirstPose(sample), onTrigger(), onPanel(id),
   *             onMenu() }
   */
  constructor(stage, handlers) {
    this.stage = stage;
    this.handlers = handlers;
    this.supported = false;
    this.reason = '';
    this.session = null;
    this.presenting = false;
    this.referenceSpaceType = 'local-floor';
    this.handTracking = false;
    this.nudge = { palm: 0, wrist: 0, thumb: 0 };
    this.showMyHands = true;
    this.palmBall = false;
    this.frames = 0;
    this.placed = false;
    this.jointGeometry = null;
    this.jointMaterial = null;

    this.panel = new VRPanel();
    stage.scene.add(this.panel.group);

    // Head-locked labels. They are children of the camera, so they stay in view.
    this.speedLabel = new TextLabel({ pxWidth: 320, pxHeight: 128, height: 0.085, depthTest: false, color: '#ff9f43' });
    this.speedLabel.mesh.position.set(0, -0.32, -1.1);
    this.speedLabel.mesh.visible = false;
    this.promptLabel = new TextLabel({
      pxWidth: 1024,
      pxHeight: 256,
      height: 0.18,
      depthTest: false,
      font: '600 58px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    });
    this.promptLabel.mesh.position.set(0, -0.1, -1.1);
    this.promptLabel.mesh.visible = false;
    stage.camera.add(this.speedLabel.mesh, this.promptLabel.mesh);
    this.promptUntil = 0;

    this.controllers = [0, 1].map((i) => this.makeController(i));

    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
    this.tmpEye = new THREE.Vector3();
    this.tmpQ = new THREE.Quaternion();

    stage.renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
    stage.renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());
  }

  /** Is immersive VR available here? Resolves to true or false and records why not. */
  async checkSupport() {
    if (!window.isSecureContext) {
      this.reason = 'VR needs a secure page (https).';
      return (this.supported = false);
    }
    if (!navigator.xr || !navigator.xr.isSessionSupported) {
      this.reason = 'This browser has no WebXR. Open this page in the headset browser.';
      return (this.supported = false);
    }
    try {
      this.supported = await navigator.xr.isSessionSupported('immersive-vr');
      if (!this.supported) this.reason = 'No VR headset found. Open this page in the headset browser.';
    } catch (err) {
      this.supported = false;
      this.reason = 'VR is blocked on this page: ' + (err && err.message ? err.message : err);
    }
    return this.supported;
  }

  async enter() {
    if (this.session || !this.supported) return false;
    const optionalFeatures = ['local-floor', 'bounded-floor', 'layers'];
    if (this.handTracking) optionalFeatures.push('hand-tracking');
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures });
    this.session = session;
    // Prefer a floor-level origin so heights are real heights. Fall back to 'local' if refused.
    let type = 'local-floor';
    try {
      await session.requestReferenceSpace('local-floor');
    } catch (err) {
      type = 'local';
    }
    this.referenceSpaceType = type;
    const xr = this.stage.renderer.xr;
    xr.setReferenceSpaceType(type);
    try {
      await xr.setSession(session);
    } catch (err) {
      // Do not leave a half-started session behind.
      this.session = null;
      session.end().catch(() => {});
      throw err;
    }
    return true;
  }

  exit() {
    if (this.session) this.session.end();
  }

  onSessionStart() {
    const stage = this.stage;
    this.presenting = true;
    this.frames = 0;
    this.placed = false;
    stage.rig.position.set(0, this.referenceSpaceType === 'local' ? 1.6 : 0, 0);
    stage.rig.rotation.set(0, 0, 0);
    // We update the XR camera ourselves each frame, before anything reads the head pose.
    stage.renderer.xr.cameraAutoUpdate = false;
    stage.ghostHead.visible = false;
    this.handlers.onSessionStart();
  }

  onSessionEnd() {
    this.presenting = false;
    this.session = null;
    this.hidePanel();
    this.speedLabel.mesh.visible = false;
    this.promptLabel.mesh.visible = false;
    this.stage.renderer.xr.cameraAutoUpdate = true;
    this.stage.rig.position.set(0, 0, 0);
    this.stage.rig.rotation.set(0, 0, 0);
    this.handlers.onSessionEnd();
  }

  makeController(index) {
    const stage = this.stage;
    const xr = stage.renderer.xr;
    const ray = xr.getController(index);
    const grip = xr.getControllerGrip(index);
    const hand = xr.getHand(index);
    stage.rig.add(ray, grip, hand);

    const c = {
      index,
      ray,
      grip,
      hand,
      source: null,
      handedness: null,
      side: index === 0 ? RIGHT : LEFT,
      menuDown: false,
      snapReady: true,
    };

    // The person's own hand: a solid cup at the palm point, plus the handle of the controller.
    c.holder = new THREE.Group();
    grip.add(c.holder);
    c.cup = makeHandCup(OWN_HAND_COLOR, false);
    c.holder.add(c.cup);
    c.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 20, 14),
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666 })
    );
    c.ball.visible = false;
    c.holder.add(c.ball);
    c.handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, 0.11, 12),
      new THREE.MeshBasicMaterial({ color: 0x8894aa, transparent: true, opacity: 0.35, depthWrite: false })
    );
    c.handle.rotation.x = Math.PI / 2; // the handle runs along grip Z
    grip.add(c.handle);

    // Pointing ray, shown only while it is on the control board.
    c.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    c.line.visible = false;
    ray.add(c.line);

    ray.addEventListener('connected', (e) => {
      c.source = e.data;
      c.handedness = e.data.handedness;
      if (c.handedness === 'right') c.side = RIGHT;
      else if (c.handedness === 'left') c.side = LEFT;
      this.applyHandLook(c);
    });
    ray.addEventListener('disconnected', () => {
      c.source = null;
      c.handedness = null;
      c.line.visible = false;
      this.panel.clearPointer(index);
    });
    ray.addEventListener('selectstart', () => this.onSelect(c));

    this.applyHandLook(c);
    return c;
  }

  /** Palm offset, orientation and visibility of one own-hand marker. */
  applyHandLook(c) {
    const toPalm = c.side === RIGHT ? -1 : 1; // palm is -X on the right hand, +X on the left
    c.holder.position.set(toPalm * this.nudge.palm, this.nudge.wrist, -this.nudge.thumb);
    // The cup opens along its local +Y; turn that to face out of the palm.
    c.holder.rotation.set(0, 0, c.side === RIGHT ? Math.PI / 2 : -Math.PI / 2);
    c.cup.visible = this.showMyHands;
    c.handle.visible = this.showMyHands;
    c.ball.visible = this.palmBall;
  }

  setNudge(nudge) {
    this.nudge = { palm: nudge.palm, wrist: nudge.wrist, thumb: nudge.thumb };
    this.controllers.forEach((c) => this.applyHandLook(c));
  }

  setShowMyHands(on) {
    this.showMyHands = on;
    this.controllers.forEach((c) => this.applyHandLook(c));
  }

  setPalmBall(on) {
    this.palmBall = on;
    this.controllers.forEach((c) => this.applyHandLook(c));
  }

  onSelect(c) {
    const button = this.panel.hover[c.index];
    if (button) {
      this.pulse(c, 0.5, 25);
      this.handlers.onPanel(button.id);
      return;
    }
    this.handlers.onTrigger();
  }

  pulse(c, strength, ms) {
    try {
      const gp = c.source && c.source.gamepad;
      const act = gp && gp.hapticActuators && gp.hapticActuators[0];
      const done = act && act.pulse ? act.pulse(strength, ms) : null;
      if (done && done.catch) done.catch(() => {});
    } catch (err) {
      // haptics are a nicety
    }
  }

  /**
   * Show a head-locked message. With `seconds` it is a passing notice, kept low in the view so it
   * does not cover the pattern. Without, it is an instruction that stays near the centre until
   * replaced (the calibration prompt).
   */
  prompt(text, seconds) {
    this.promptLabel.setText(text);
    this.promptLabel.mesh.visible = this.presenting && text !== '';
    this.promptLabel.mesh.position.y = seconds ? -0.5 : -0.1;
    this.promptUntil = seconds ? performance.now() + seconds * 1000 : 0;
  }

  setSpeedLabel(speed) {
    const text = Math.abs(speed - 1) < 1e-6 ? '' : formatSpeed(speed);
    this.speedLabel.setText(text);
    this.speedLabel.mesh.visible = this.presenting && text !== '';
  }

  /**
   * Place the control board relative to where the person is and which way they face.
   *   'side'   well to the left, out of the way of the pattern (which fills the view ahead);
   *   'front'  straight ahead, a little below eye level, for when you want to use it.
   */
  summonPanel(where) {
    const head = this.headPosition(this.tmpA);
    const yaw = this.headYaw();
    const offset = where === 'front' ? this.tmpB.set(0, -0.25, -1.15) : this.tmpB.set(-1.06, -0.15, -0.28);
    offset.applyAxisAngle(UP, yaw);
    this.panel.group.position.copy(head).add(offset);
    this.panel.group.position.y = Math.max(this.panel.group.position.y, 0.45);
    this.panel.group.lookAt(head);
    this.panel.group.visible = true;
    this.panel.group.updateMatrixWorld(true);
  }

  hidePanel() {
    this.panel.group.visible = false;
    this.controllers.forEach((c) => {
      c.line.visible = false;
      this.panel.clearPointer(c.index);
    });
  }

  /** Is the board roughly where the person is looking (within 35 degrees to either side)? */
  panelInView() {
    if (!this.panel.group.visible) return false;
    const head = this.headPosition(this.tmpA);
    const to = this.tmpB.copy(this.panel.group.position).sub(head);
    const bearing = Math.atan2(-to.x, -to.z);
    let off = bearing - this.headYaw();
    off = Math.atan2(Math.sin(off), Math.cos(off));
    return Math.abs(off) < (35 * Math.PI) / 180;
  }

  /** A or X: hide the board if you are looking at it, otherwise bring it in front of you. */
  togglePanel() {
    if (this.panelInView()) this.hidePanel();
    else this.summonPanel('front');
  }

  /**
   * World position of the head: the point midway between the eyes. (three.js parks its combined
   * XR camera a little behind the eyes so one frustum covers both, so that camera's own position
   * is not the head.)
   */
  headPosition(out) {
    const eyes = this.presenting ? this.stage.renderer.xr.getCamera().cameras : null;
    if (eyes && eyes.length === 2) {
      out.setFromMatrixPosition(eyes[0].matrixWorld);
      this.tmpEye.setFromMatrixPosition(eyes[1].matrixWorld);
      return out.add(this.tmpEye).multiplyScalar(0.5);
    }
    return this.stage.camera.getWorldPosition(out);
  }

  /** Heading of the head about the vertical axis (0 = looking down -Z, positive = turned left). */
  headYaw() {
    const dir = this.stage.camera.getWorldDirection(new THREE.Vector3());
    return Math.atan2(-dir.x, -dir.z);
  }

  /** World position of the palm point of one hand (RIGHT or LEFT), or null if not tracked. */
  palmPosition(side, out) {
    for (const c of this.controllers) {
      if (!c.source || c.side !== side) continue;
      if (c.grip.visible) return c.holder.getWorldPosition(out);
      const joint = c.hand.joints && c.hand.joints[JOINT_FOR_PALM];
      if (c.hand.visible && joint && joint.visible) return joint.getWorldPosition(out);
      if (c.ray.visible) return c.ray.getWorldPosition(out);
    }
    return null;
  }

  /** What calibration needs: where the head and the two palm points are right now. */
  sample() {
    const head = this.headPosition(new THREE.Vector3());
    return {
      head,
      headYaw: this.headYaw(),
      palms: [this.palmPosition(RIGHT, new THREE.Vector3()), this.palmPosition(LEFT, new THREE.Vector3())],
    };
  }

  /** Move the person so their head is over a floor point (used by "my spot"). */
  moveHeadTo(x, z) {
    const rig = this.stage.rig;
    const head = this.headPosition(this.tmpA);
    rig.position.x += x - head.x;
    rig.position.z += z - head.z;
    this.syncCamera();
  }

  /**
   * Bring the camera up to date with the headset for this frame. three.js would do this while
   * drawing; doing it first means everything that reads the head pose this frame is current.
   */
  syncCamera() {
    this.stage.rig.updateMatrixWorld(true);
    this.stage.renderer.xr.updateCamera(this.stage.camera);
  }

  /** Once per XR frame, before the scene is drawn. */
  update(dt) {
    if (!this.presenting) return;
    const stage = this.stage;
    const rig = stage.rig;
    this.frames++;

    // Thumbsticks and buttons.
    let moveX = 0;
    let moveY = 0;
    let turn = 0;
    let turnController = null;
    for (const c of this.controllers) {
      const gp = c.source && c.source.gamepad;
      if (!gp) continue;
      const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
      if (c.handedness === 'left') {
        moveX = ax[0];
        moveY = ax[1];
      } else {
        turn = ax[0];
        turnController = c;
      }
      const down =
        !!(gp.buttons[BUTTON_AX] && gp.buttons[BUTTON_AX].pressed) ||
        !!(gp.buttons[BUTTON_BY] && gp.buttons[BUTTON_BY].pressed);
      if (down && !c.menuDown) this.handlers.onMenu();
      c.menuDown = down;
    }

    if (Math.hypot(moveX, moveY) > STICK_DEADZONE) {
      const yaw = this.headYaw();
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      // Stick up is -1 on the y axis: walk the way the head is facing.
      const forward = -moveY;
      rig.position.x += (fx * forward + -fz * moveX) * MOVE_SPEED * dt;
      rig.position.z += (fz * forward + fx * moveX) * MOVE_SPEED * dt;
    }
    if (turnController) {
      if (Math.abs(turn) > 0.6 && turnController.snapReady) {
        turnController.snapReady = false;
        this.turnAboutHead(turn > 0 ? -SNAP_ANGLE : SNAP_ANGLE);
      } else if (Math.abs(turn) < 0.3) {
        turnController.snapReady = true;
      }
    }

    this.syncCamera();

    if (!this.placed && this.frames >= 2) {
      this.placed = true;
      this.handlers.onFirstPose(this.sample());
    }

    // Hand tracking: draw the joints as small dots.
    for (const c of this.controllers) {
      if (!c.source || !c.source.hand || !c.hand.joints) continue;
      for (const name in c.hand.joints) {
        const joint = c.hand.joints[name];
        if (!joint.userData.dot) {
          if (!this.jointGeometry) {
            this.jointGeometry = new THREE.SphereGeometry(0.007, 8, 6);
            this.jointMaterial = new THREE.MeshBasicMaterial({ color: OWN_HAND_COLOR });
          }
          joint.userData.dot = new THREE.Mesh(this.jointGeometry, this.jointMaterial);
          joint.add(joint.userData.dot);
        }
        joint.userData.dot.visible = this.showMyHands;
      }
    }

    // Pointing at the control board.
    for (const c of this.controllers) {
      let hit = null;
      if (c.source && c.ray.visible && this.panel.group.visible) {
        const origin = c.ray.getWorldPosition(this.tmpA);
        const dir = this.tmpB.set(0, 0, -1).applyQuaternion(c.ray.getWorldQuaternion(this.tmpQ));
        hit = this.panel.point(c.index, origin, dir);
      } else {
        this.panel.clearPointer(c.index);
      }
      c.line.visible = !!hit;
      if (hit) c.line.scale.set(1, 1, hit.distance);
    }

    if (this.promptUntil && performance.now() > this.promptUntil) {
      this.promptUntil = 0;
      this.prompt('', 0);
    }
  }

  turnAboutHead(angle) {
    const rig = this.stage.rig;
    const head = this.headPosition(this.tmpA).clone();
    const local = rig.worldToLocal(head.clone()); // the head in tracking space
    rig.rotation.y += angle;
    const c = Math.cos(rig.rotation.y);
    const s = Math.sin(rig.rotation.y);
    // Keep the head where it was: rig.position = head - R(yaw) * local.
    rig.position.x = head.x - (c * local.x + s * local.z);
    rig.position.z = head.z - (-s * local.x + c * local.z);
  }
}
