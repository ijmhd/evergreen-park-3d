// Camera controls are independent of WebGL, the DOM and pointer-lock support.
export const HOME_CAMERA_POSE = Object.freeze({ x: 0, y: 26, z: 0, yaw: 0, pitch: -0.65 });
export const CAMERA_LIMITS = Object.freeze({ minX: -180, maxX: 180, minY: 7, maxY: 180, minZ: -130, maxZ: 200, minPitch: -1.45, maxPitch: 0.3 });
const CAMERA_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function isCameraKey(code) { return CAMERA_KEYS.has(code); }

export function sceneClickAction({ locked = false, hit = false, dragged = false } = {}) {
  if (dragged) return 'ignore';
  if (hit) return 'select';
  return locked ? 'keep-locked' : 'lock';
}

export function isTypingTarget(target) {
  if (!target) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target.tagName || '').toUpperCase()) || !!target.isContentEditable;
}

/** WASD changes horizontal position; arrow keys change only viewing angles. */
export function stepCameraControls(pose, pressed, deltaSeconds) {
  const dt = clamp(Number(deltaSeconds) || 0, 0, 0.1);
  const has = key => pressed.has(key);
  const forward = Number(has('KeyW')) - Number(has('KeyS'));
  const right = Number(has('KeyD')) - Number(has('KeyA'));
  const vertical = Number(has('KeyE')) - Number(has('KeyQ'));
  const turn = Number(has('ArrowLeft')) - Number(has('ArrowRight'));
  const tilt = Number(has('ArrowUp')) - Number(has('ArrowDown'));
  const yaw = pose.yaw + turn * dt * 1.15;
  const pitch = clamp(pose.pitch + tilt * dt * 0.9, CAMERA_LIMITS.minPitch, CAMERA_LIMITS.maxPitch);
  const speed = dt * (18 + pose.y * 0.32) * (has('ShiftLeft') || has('ShiftRight') ? 1.9 : 1);
  const norm = forward && right ? Math.SQRT1_2 : 1;
  return {
    x: clamp(pose.x + (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * speed * norm, CAMERA_LIMITS.minX, CAMERA_LIMITS.maxX),
    y: clamp(pose.y + vertical * speed * 0.8, CAMERA_LIMITS.minY, CAMERA_LIMITS.maxY),
    z: clamp(pose.z + (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * speed * norm, CAMERA_LIMITS.minZ, CAMERA_LIMITS.maxZ),
    yaw,
    pitch,
  };
}

export function applyPointerLook(pose, dx, dy) {
  return { ...pose, yaw: pose.yaw - (Number(dx) || 0) * 0.0026, pitch: clamp(pose.pitch - (Number(dy) || 0) * 0.0022, CAMERA_LIMITS.minPitch, CAMERA_LIMITS.maxPitch) };
}

export function beginCameraDrag(x, y, button = 0) {
  return { startX: x, startY: y, lastX: x, lastY: y, moved: false, button };
}

/** A four-pixel threshold preserves stationary clicks for facility selection. */
export function stepCameraDrag(pose, drag, x, y) {
  const moved = drag.moved || Math.hypot(x - drag.startX, y - drag.startY) >= 4;
  const dx = x - (drag.moved ? drag.lastX : drag.startX);
  const dy = y - (drag.moved ? drag.lastY : drag.startY);
  return {
    pose: moved ? applyPointerLook(pose, dx, dy) : pose,
    drag: { ...drag, lastX: x, lastY: y, moved },
  };
}
