import * as THREE from './vendor/three.module.js';
import { HOME_CAMERA_POSE, isCameraKey, isTypingTarget, stepCameraControls, applyPointerLook, beginCameraDrag, stepCameraDrag, sceneClickAction } from './camera-controls.js?v=4';
import { upgradeAppearance } from './upgrade-appearance.js';
import { stablePixelRatio, renderViewport, viewportChange, viewportDiagnostics } from './render-viewport.js';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const level = (f, key) => {
  if (!f.restored) return 0;
  const v = f.upgrades?.[key];
  return Number(typeof v === 'object' ? (v?.level ?? 0) : (v ?? 0)) || 0;
};
const seed = n => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

/** A real 3D park. The management simulation remains entirely in game.js. */
export class ParkScene {
  constructor({ canvas, game, onSelect = () => {}, onLockChange = () => {}, onHover = () => {} }) {
    this.canvas = canvas;
    this.game = game;
    this.onSelect = onSelect;
    this.onLockChange = onLockChange;
    this.onHover = onHover;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#d9edf0');
    this.scene.fog = new THREE.Fog('#d9edf0', 155, 370);
    this.camera = new THREE.PerspectiveCamera(47, 1, 0.3, 650);
    this.camera.rotation.order = 'YXZ';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderPixelRatio = stablePixelRatio(window.devicePixelRatio);
    this.viewport = null;
    this.pendingViewport = null;
    this.uiInteractionActive = false;
    this.viewportDiagnostics = viewportDiagnostics();
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.materials = new Map();
    this.geometries = new Map();
    this.records = new Map();
    this.pickTargets = [];
    this.listeners = [];
    this.keys = new Set();
    this.time = 0;
    this.syncTimer = 0;
    this.yaw = 0;
    this.pitch = -0.65;
    this.hovered = null;
    this.selectedId = null;
    this.pointer = new THREE.Vector2(0, 0);
    this.pointerInside = false;
    this.raycaster = new THREE.Raycaster();
    this.temp = new THREE.Object3D();
    this.disposed = false;
    this.scene.add(new THREE.HemisphereLight('#fff8de', '#779c73', 2.55));
    const sun = new THREE.DirectionalLight('#fff2cf', 3.15);
    sun.position.set(-90, 150, 85);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 130, bottom: -130, near: 10, far: 370 });
    sun.shadow.normalBias = 0.055;
    sun.shadow.bias = -0.0002;
    this.scene.add(sun);
    this.world = new THREE.Group();
    this.world.userData.resources = [];
    this.scene.add(this.world);
    this.buildWorld();
    this.buildVisitors();
    this.selection = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(20.7, 0.2, 18.7)), new THREE.LineBasicMaterial({ color: '#f4bd56', transparent: true, opacity: 0.95 }));
    this.selection.visible = false;
    this.scene.add(this.selection);
    this.syncFacilities();
    this.bindControls();
    this.home(true);
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  geometry(key, factory) {
    if (!this.geometries.has(key)) this.geometries.set(key, factory());
    return this.geometries.get(key);
  }

  material(color, f = null, extra = {}) {
    let c = new THREE.Color(color);
    if (f && !f.restored) {
      const hsl = {}; c.getHSL(hsl);
      // Four weathered tones let inactive rides share a handful of draw calls.
      c.set(hsl.l < 0.32 ? '#6f796f' : hsl.l < 0.52 ? '#929989' : hsl.l < 0.73 ? '#abb09a' : '#c6c7b1');
    }
    const key = c.getHexString() + JSON.stringify(extra);
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({ color: c, roughness: 0.84, metalness: 0.02, flatShading: true, ...extra }));
    return this.materials.get(key);
  }

  mesh(g, geometry, color, x, y, z, sx = 1, sy = 1, sz = 1, f = null, extra = {}) {
    const m = new THREE.Mesh(geometry, this.material(color, f, extra));
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  }

  box(g, color, x, y, z, sx, sy, sz, f = null) {
    return this.mesh(g, this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), color, x, y, z, sx, sy, sz, f);
  }

  cylinder(g, color, x, y, z, r, h, f = null, top = 1, sides = 12) {
    return this.mesh(g, this.geometry(`cyl:${top}:${sides}`, () => new THREE.CylinderGeometry(top, 1, 1, sides)), color, x, y, z, r, h, r, f);
  }

  ball(g, color, x, y, z, sx, sy = sx, sz = sx, f = null) {
    return this.mesh(g, this.geometry('ico', () => new THREE.IcosahedronGeometry(1, 1)), color, x, y, z, sx, sy, sz, f);
  }

  beam(g, color, a, b, radius = 0.15, f = null) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), delta = vb.clone().sub(va);
    const m = this.cylinder(g, color, ...va.clone().add(vb).multiplyScalar(0.5).toArray(), radius, delta.length(), f, 1, 6);
    m.quaternion.setFromUnitVectors(UP, delta.normalize());
    return m;
  }

  ring(g, color, x, y, z, radius, thickness, f = null) {
    return this.mesh(g, this.geometry(`torus:${radius.toFixed(2)}:${thickness}`, () => new THREE.TorusGeometry(radius, thickness, 6, 64)), color, x, y, z, 1, 1, 1, f);
  }

  tube(g, color, curve, thickness = 0.15, f = null, segments = 72) {
    const geometry = new THREE.TubeGeometry(curve, segments, thickness, 6, false);
    this.resources(g).push(geometry);
    return this.mesh(g, geometry, color, 0, 0, 0, 1, 1, 1, f);
  }

  resources(g) {
    let current = g;
    while (current.parent && !current.userData.resources) current = current.parent;
    return current.userData.resources || (current.userData.resources = []);
  }

  sign(g, text, x, y, z, width = 8.8, sub = '', f = null) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = sub ? 144 : 112;
    const ctx = c.getContext('2d');
    ctx.fillStyle = f && !f.restored ? '#c6c8b8' : '#fff7e6';
    ctx.beginPath();
    ctx.roundRect(4, 4, c.width - 8, c.height - 8, 17);
    ctx.fill();
    ctx.strokeStyle = f && !f.restored ? '#9a9b8b' : '#dbccaa';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#304b44';
    ctx.font = `600 ${text.length > 7 ? 34 : 39}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillText(text, 256, sub ? 54 : 57, 474);
    if (sub) {
      ctx.fillStyle = f && !f.restored ? '#8d6855' : '#8a987c';
      ctx.font = '23px "PingFang SC", sans-serif';
      ctx.fillText(sub, 256, 106, 470);
    }
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(width, width * c.height / c.width);
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    g.add(m);
    this.resources(g).push(texture, material, geometry);
    return m;
  }

  // Merge static meshes by material, retaining separate animated subgroups.
  compact(group) {
    for (const child of [...group.children]) if (child.isGroup) this.compact(child);
    const buckets = new Map();
    for (const mesh of group.children) {
      if (!mesh.isMesh || !mesh.material.isMeshStandardMaterial || mesh.isInstancedMesh || mesh.userData.noBatch) continue;
      mesh.updateMatrix();
      const coloredBatch = !mesh.material.map && !mesh.material.transparent && mesh.material.emissive.getHex() === 0;
      const key = coloredBatch ? 'vertex-colors' : mesh.material.uuid;
      const bucket = buckets.get(key) || { material: coloredBatch ? this.material('#ffffff', null, { vertexColors: true }) : mesh.material, meshes: [], coloredBatch };
      bucket.meshes.push(mesh);
      buckets.set(key, bucket);
    }
    for (const { material, meshes, coloredBatch } of buckets.values()) {
      if (meshes.length < 2) continue;
      const positions = [], normals = [], colors = [];
      const v = new THREE.Vector3(), n = new THREE.Vector3();
      for (const mesh of meshes) {
        const pos = mesh.geometry.attributes.position, normal = mesh.geometry.attributes.normal;
        const color = mesh.material.vertexColors ? mesh.geometry.attributes.color : null;
        const indices = mesh.geometry.index;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrix);
        const count = indices ? indices.count : pos.count;
        for (let i = 0; i < count; i++) {
          const at = indices ? indices.getX(i) : i;
          v.fromBufferAttribute(pos, at).applyMatrix4(mesh.matrix);
          positions.push(v.x, v.y, v.z);
          if (normal) n.fromBufferAttribute(normal, at).applyMatrix3(normalMatrix).normalize(); else n.set(0, 1, 0);
          normals.push(n.x, n.y, n.z);
          if (coloredBatch) colors.push(color ? color.getX(at) : mesh.material.color.r, color ? color.getY(at) : mesh.material.color.g, color ? color.getZ(at) : mesh.material.color.b);
        }
        group.remove(mesh);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      if (coloredBatch) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();
      this.resources(group).push(geometry);
      const merged = new THREE.Mesh(geometry, material);
      merged.castShadow = true;
      merged.receiveShadow = true;
      group.add(merged);
    }
  }

  buildWorld() {
    const g = this.world;
    const ground = this.box(g, '#90bb7c', 0, -0.5, 0, 650, 0.8, 550);
    ground.castShadow = false;
    this.box(g, '#a1c78c', 0, -0.01, 5, 257, 0.16, 190);
    for (let row = 0; row < 6; row++) {
      const z = (row - 2.5) * 26 + 10;
      this.box(g, '#ded8bd', 0, 0.07, z, 248, 0.18, 5.4);
      this.box(g, '#f0e8cf', 0, 0.18, z, 248, 0.12, 4.65);
    }
    this.box(g, '#ded8bd', 0, 0.09, 9, 6.5, 0.2, 190);
    this.box(g, '#f0e8cf', 0, 0.2, 10, 5.7, 0.14, 190);
    this.cylinder(g, '#f0e8cf', 0, 0.24, 84, 10, 0.18, null, 1, 40);
    this.box(g, '#eee4ca', 0, 0.18, 98, 249, 0.25, 5);
    // Perimeter fence, lamp posts and benches.
    for (let x = -126; x <= 126; x += 6) for (const z of [-81, 103]) {
      if (z === 103 && Math.abs(x) < 12) continue;
      this.box(g, '#f5eed9', x, 1.2, z, 0.3, 2.25, 0.3);
      if (x < 126 && !(z === 103 && Math.abs(x + 3) < 12)) {
        this.box(g, '#eee4c8', x + 3, 1.1, z, 5.9, 0.16, 0.16);
        this.box(g, '#eee4c8', x + 3, 1.8, z, 5.9, 0.16, 0.16);
      }
    }
    for (const x of [-126, 126]) for (let z = -81; z < 102; z += 6) {
      this.box(g, '#f5eed9', x, 1.2, z, 0.3, 2.25, 0.3);
      this.box(g, '#eee4c8', x, 1.1, z + 3, 0.16, 0.16, 5.9);
      this.box(g, '#eee4c8', x, 1.8, z + 3, 0.16, 0.16, 5.9);
    }
    for (let row = 0; row < 6; row++) for (let col = 0; col < 10; col++) {
      const x = (col - 4.5) * 24, z = (row - 2.5) * 26;
      this.box(g, '#bfd09d', x, 0.12, z - 1, 20.8, 0.2, 18.5);
      if (col % 2 === 0) {
        this.cylinder(g, '#667b61', x + 10.3, 2.5, z + 12.3, 0.1, 4.8);
        this.ball(g, '#ffedb4', x + 10.3, 4.9, z + 12.3, 0.35);
        this.box(g, '#a87d54', x - 8, 0.9, z + 12.7, 3, 0.18, 0.7);
        this.box(g, '#a87d54', x - 8, 1.4, z + 13.1, 3, 0.65, 0.13);
        this.box(g, '#667b61', x - 9, 0.45, z + 12.7, 0.15, 0.8, 0.6);
        this.box(g, '#667b61', x - 7, 0.45, z + 12.7, 0.15, 0.8, 0.6);
      }
    }
    // Welcome arch.
    for (const x of [-9, 9]) {
      this.box(g, '#f9edcf', x, 3.5, 96, 1.5, 7, 1.8);
      this.cylinder(g, '#589a91', x, 7.3, 96, 1.2, 0.8, null, 0, 8);
      this.ball(g, '#f1c16d', x, 8, 96, 0.45);
    }
    this.box(g, '#477e72', 0, 6.1, 96, 19.5, 2.2, 1.1);
    this.sign(g, '常青游乐园', 0, 6.15, 96.61, 12.5);
    for (const x of [-16, 16]) {
      this.box(g, '#f8e7bd', x, 1.7, 94, 5, 3.4, 4);
      this.cylinder(g, '#d78a75', x, 4, 94, 3.9, 1.5, null, 0, 4).rotation.y = Math.PI / 4;
      this.box(g, '#7ca9a2', x, 2, 96.03, 2.5, 1.2, 0.08);
    }
    // Pond beyond the park and soft low-poly mountain silhouettes.
    this.cylinder(g, '#79babe', -162, -0.1, 31, 30, 0.13, null, 1, 48).scale.z *= 1.6;
    for (let i = 0; i < 13; i++) {
      const x = (i - 6) * 40;
      this.mesh(g, this.geometry('hill', () => new THREE.IcosahedronGeometry(1, 0)), i % 2 ? '#8dae91' : '#9bb99a', x, 8 + seed(i) * 5, -153 - seed(i + 3) * 28, 36 + seed(i + 9) * 24, 23 + seed(i + 14) * 22, 35);
    }
    this.compact(g);
    this.buildTrees();
  }

  buildTrees() {
    const points = [];
    for (let i = 0; i < 155; i++) {
      const side = i % 4;
      const p = seed(i + 80), q = seed(i + 140);
      if (side === 0) points.push([-132 - q * 24, -83 + p * 199, i]);
      if (side === 1) points.push([132 + q * 23, -83 + p * 199, i]);
      if (side === 2) points.push([-128 + p * 256, -90 - q * 24, i]);
      if (side === 3) points.push([-126 + p * 252, 110 + q * 20, i]);
    }
    for (let row = 0; row < 6; row++) for (let col = 0; col < 10; col++) {
      if (col === 4 || col === 5) continue;
      points.push([(col - 4.5) * 24 + 10.8, (row - 2.5) * 26 - 8.8, row * 10 + col + 200]);
    }
    const trunk = new THREE.InstancedMesh(this.geometry('treeTrunk', () => new THREE.CylinderGeometry(0.22, 0.33, 1, 6)), this.material('#89734e'), points.length);
    const crown = new THREE.InstancedMesh(this.geometry('treeCrown', () => new THREE.IcosahedronGeometry(1, 0)), this.material('#4d8b65'), points.length);
    const top = new THREE.InstancedMesh(this.geometry('treeTop', () => new THREE.IcosahedronGeometry(1, 0)), this.material('#79a765'), points.length);
    const d = this.temp;
    points.forEach(([x, z, i], at) => {
      const s = 0.75 + seed(i) * 0.6;
      d.position.set(x, 1.4 * s, z); d.scale.set(1, 2.8 * s, 1); d.rotation.set(0, 0, 0); d.updateMatrix(); trunk.setMatrixAt(at, d.matrix);
      d.position.set(x, 4 * s, z); d.scale.set(2.5 * s, 2.7 * s, 2.3 * s); d.rotation.y = seed(i + 7) * 5; d.updateMatrix(); crown.setMatrixAt(at, d.matrix);
      d.position.set(x - 0.5 * s, 5.5 * s, z); d.scale.set(1.9 * s, 1.7 * s, 1.8 * s); d.updateMatrix(); top.setMatrixAt(at, d.matrix);
      const tint = new THREE.Color().setHSL(0.29 + seed(i + 4) * 0.045, 0.26 + seed(i) * 0.17, 0.36 + seed(i + 3) * 0.1);
      crown.setColorAt(at, tint);
    });
    for (const mesh of [trunk, crown, top]) { mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); }
    this.treeMeshes = [trunk, crown, top];
  }

  buildVisitors() {
    this.visitorLimit = 2200;
    this.people = {
      bodies: new THREE.InstancedMesh(this.geometry('personBody', () => new THREE.CylinderGeometry(0.21, 0.24, 0.62, 5)), this.material('#ffffff'), this.visitorLimit),
      heads: new THREE.InstancedMesh(this.geometry('personHead', () => new THREE.IcosahedronGeometry(0.22, 1)), this.material('#edc19e'), this.visitorLimit),
      legs: new THREE.InstancedMesh(this.geometry('personLeg', () => new THREE.BoxGeometry(0.14, 0.33, 0.16)), this.material('#48636a'), this.visitorLimit * 2),
      hats: new THREE.InstancedMesh(this.geometry('personHat', () => new THREE.CylinderGeometry(0.22, 0.28, 0.14, 8)), this.material('#f0bd52'), this.visitorLimit),
    };
    for (const mesh of Object.values(this.people)) { mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(mesh); }
  }

  updateVisitors() {
    const list = (this.game.state.visitors || []).filter(v => v.phase !== 'riding' && Number.isFinite(v.x) && Number.isFinite(v.z));
    const count = Math.min(this.visitorLimit, list.length);
    const d = this.temp;
    let fast = 0;
    for (let i = 0; i < count; i++) {
      const v = list[i];
      if (!Number.isFinite(v.x) || !Number.isFinite(v.z)) continue;
      const phase = this.time * 8 + i * 2.1;
      const bob = Math.sin(phase * 2) * 0.025;
      d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1);
      d.position.set(v.x, 0.86 + bob, v.z); d.updateMatrix(); this.people.bodies.setMatrixAt(i, d.matrix);
      this.people.bodies.setColorAt(i, new THREE.Color(v.fast ? '#edb84f' : (v.color || ['#e38c86', '#6fa6be', '#efe5c4', '#a69bc4', '#72aa88'][i % 5])));
      d.position.y = 1.35 + bob; d.updateMatrix(); this.people.heads.setMatrixAt(i, d.matrix);
      for (let side = 0; side < 2; side++) {
        d.position.set(v.x + (side ? 0.12 : -0.12), 0.4, v.z + Math.sin(phase + side * Math.PI) * 0.065);
        d.updateMatrix(); this.people.legs.setMatrixAt(i * 2 + side, d.matrix);
      }
      if (v.fast) { d.position.set(v.x, 1.55 + bob, v.z); d.updateMatrix(); this.people.hats.setMatrixAt(fast++, d.matrix); }
    }
    this.people.bodies.count = this.people.heads.count = count;
    this.people.legs.count = count * 2;
    this.people.hats.count = fast;
    for (const mesh of Object.values(this.people)) mesh.instanceMatrix.needsUpdate = true;
    if (this.people.bodies.instanceColor) this.people.bodies.instanceColor.needsUpdate = true;
  }

  syncFacilities() {
    const all = this.game.state.facilities || [];
    for (const f of all) {
      const signature = `${!!f.restored}:${JSON.stringify(f.upgrades || {})}`;
      if (this.records.get(f.id)?.signature === signature) { this.records.get(f.id).f = f; continue; }
      const prior = this.records.get(f.id);
      if (prior) this.removeRecord(prior);
      const group = new THREE.Group();
      group.position.set(f.x, 0.28, f.z);
      group.userData.resources = [];
      const record = { f, group, signature, animations: [], appearance: upgradeAppearance(f) };
      this.records.set(f.id, record);
      this.scene.add(group);
      this.buildFacility(record);
      if (prior && prior.signature.startsWith('true:') && f.restored && record.appearance.totalLevel > prior.appearance.totalLevel) {
        const geometry = this.geometry('upgradeOutline', () => { const box = new THREE.BoxGeometry(20, 0.4, 18.2); const edges = new THREE.EdgesGeometry(box); box.dispose(); return edges; });
        const material = new THREE.LineBasicMaterial({ color: '#ffcd63', transparent: true, opacity: 1 });
        const pulse = new THREE.LineSegments(geometry, material);
        pulse.position.set(0, 0.5, -0.7);
        group.add(pulse);
        record.pulse = pulse; record.pulseTime = 1.4;
        group.userData.resources.push(material);
      }
      if (!f.restored) this.flatten(group);
      this.compact(group);
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      const height = clamp(bounds.max.y, 5, 40);
      const target = new THREE.Mesh(this.geometry('pickBox', () => new THREE.BoxGeometry(20, 1, 18)), this.material('#ffffff'));
      target.position.set(f.x, height / 2, f.z - 1);
      target.scale.y = height;
      target.userData.facilityId = f.id;
      target.updateMatrixWorld(true);
      record.target = target;
      this.pickTargets.push(target);
    }
    const present = new Set(all.map(f => f.id));
    for (const [id, record] of this.records) if (!present.has(id)) { this.removeRecord(record); this.records.delete(id); }
  }

  removeRecord(record) {
    this.scene.remove(record.group);
    for (const resource of record.group.userData.resources || []) resource.dispose?.();
    this.pickTargets = this.pickTargets.filter(t => t !== record.target);
  }

  flatten(group) {
    // Abandoned rides cannot move: batch their entire hierarchy into the lot.
    group.updateMatrixWorld(true);
    const meshes = [];
    group.traverse(child => { if (child.isMesh && child.parent !== group) meshes.push(child); });
    for (const mesh of meshes) group.attach(mesh);
    for (const child of [...group.children]) if (child.isGroup) group.remove(child);
  }

  buildFacility(record) {
    const { group: g, f } = record;
    const color = f.color || '#77a8a0';
    this.box(g, '#ece5ce', 0, -0.01, -0.6, 19.9, 0.2, 17.7, f);
    this.box(g, color, 0, 0.12, -0.8, 18.8, 0.15, 16.5, f);
    const model = f.model || 'building';
    if (model === 'ferris') this.buildFerris(record);
    else if (model === 'carousel' || model === 'swings' || model === 'teacups' || model === 'spin') this.buildSpinner(record, model);
    else if (model === 'coaster') this.buildCoaster(record);
    else if (model === 'tower') this.buildTower(record);
    else if (model === 'pirate' || model === 'pendulum') this.buildSwing(record, model);
    else if (['water', 'slide', 'river', 'pool', 'surf', 'waterball', 'boat', 'harbor'].includes(model)) this.buildWater(record, model);
    else if (['train', 'kart', 'rc', 'pedal', 'cable', 'zipline'].includes(model)) this.buildTrack(record, model);
    else if (['cs', 'laser', 'shooter'].includes(model)) this.buildBattle(record, model);
    else if (['haunted', 'maze', 'mine'].includes(model)) this.buildAdventure(record, model);
    else if (['ropes', 'climbing', 'playground', 'trampoline', 'golf', 'football', 'skate', 'digger', 'blocks', 'bumper'].includes(model)) this.buildActivity(record, model);
    else if (model === 'fountain') this.buildFountain(record);
    else this.buildHall(record, model);
    this.buildUpgradeModules(record);
    this.buildQueues(record);
    for (const x of [-4.2, 4.2]) this.cylinder(g, '#657f6c', x, 1.1, 7.55, 0.09, 2, f, 1, 6);
    this.sign(g, f.name || '游乐项目', 0, 2.1, 7.7, 8.8, f.restored ? '' : '待翻修 · 点击查看', f);
    if (!f.restored) {
      // Timber braces make the abandoned state legible without covering its silhouette.
      this.box(g, '#927d5e', -1.7, 0.9, 6.2, 3.6, 0.26, 0.18, f).rotation.z = 0.14;
      this.box(g, '#927d5e', 1.5, 0.9, 6.3, 3.5, 0.26, 0.18, f).rotation.z = -0.12;
      for (let i = 0; i < 5; i++) this.ball(g, '#829364', -8 + seed(i + f.x) * 16, 0.4, -6 + seed(i + f.z + 9) * 11, 0.6, 0.4, 0.5, f);
    }
  }

  buildQueues({ group: g, f, appearance }) {
    for (const q of appearance.queues) {
      const { level: lv, x: center, width, depth, color } = q;
      const fast = q.id === 'fastQueue';
      this.box(g, q.floorColor, center, 0.3, 5.85, width, 0.1, depth, f);
      for (let row = 0; row < q.rails; row++) {
        const z = 5.85 - depth / 2 + row / (q.rails - 1) * depth;
        for (const x of [center - width / 2, center + width / 2]) this.cylinder(g, color, x, 1.02, z, 0.08, 1.45, f, 1, 6);
        this.beam(g, color, [center - width / 2, 1.35, z], [center + width / 2, 1.35, z], 0.065, f);
      }
      // Every level adds a visible roof bay and a wider/longer queue footprint.
      if (lv) {
        for (const x of [center - width / 2, center + width / 2]) this.cylinder(g, '#f4e9ce', x, 2, 5.85, 0.09, 3.7, f);
        for (let i = 0; i < lv; i++) this.box(g, fast ? '#efbe54' : '#71b7a6', center - width / 2 + (i + 0.5) * width / 5, 3.9, 5.85, width / 5 + 0.03, 0.2, depth + 0.15, f);
        const h = 1.9 + lv * 0.17;
        for (const x of [center - 0.65, center + 0.65]) this.box(g, color, x, h / 2, 7.8, 0.16, h, 0.2, f);
        this.box(g, color, center, h, 7.8, 1.5, 0.25, 0.25, f);
      }
    }
  }

  buildUpgradeModules({ group: g, f, appearance }) {
    for (const m of appearance.modules) {
      const { x, z, level: lv, type } = m;
      const accent = f.color || '#e6b871';
      this.box(g, '#f3e6c7', x, 0.3, z, 1.45, 0.2, 3.1, f);
      if (type === 'support') {
        const h = 1.1 + lv * 0.65;
        this.box(g, '#6a9a96', x, h / 2 + 0.3, z, 0.4, h, 0.8, f);
        for (let i = 0; i < lv; i++) this.box(g, '#f1c976', x, 1 + i * 0.65, z, 1.35, 0.18, 1.3, f);
        this.box(g, accent, x, h + 0.4, z, 1.4, 0.3, 1.5, f);
      } else {
        for (let i = 0; i < lv; i++) {
          const zi = z - 1.25 + i * 0.61;
          if (type === 'capacity') {
            const equipment = ['cs', 'laser', 'shooter', 'vr', 'ar', 'simulator', 'science', 'career'].includes(f.model);
            for (const side of [-1, 1]) {
              this.box(g, accent, x + side * 0.34, 0.65, zi, 0.55, 0.3, 0.5, f);
              if (equipment) {
                this.box(g, '#688b96', x + side * 0.34, 1.05, zi, 0.4, 0.5, 0.33, f);
                this.ball(g, '#f4d290', x + side * 0.34, 1.5, zi, 0.24, 0.22, 0.22, f);
              } else this.box(g, '#f4d290', x + side * 0.34, 1, zi - 0.2, 0.55, 0.65, 0.13, f);
            }
          } else if (type === 'gates') {
            for (const dx of [-0.55, 0.55]) this.box(g, '#5e8d88', x + dx, 1.1, zi, 0.14, 1.6, 0.18, f);
            this.box(g, '#f0c15f', x, 1.95, zi, 1.3, 0.3, 0.28, f);
          } else if (type === 'shelter') {
            this.box(g, '#d49977', x, 0.8, zi, 1.2, 0.25, 0.48, f);
            this.box(g, '#f4d5a0', x, 1.05, zi - 0.23, 1.2, 0.6, 0.12, f);
            this.cylinder(g, '#75958b', x, 1.7, zi, 0.045, 2.6, f);
            this.box(g, i % 2 ? '#e9bf78' : '#83b9a5', x, 3.05, zi, 1.45, 0.15, 0.61, f);
          } else if (type === 'flags') {
            this.cylinder(g, '#f1dbab', x, 1.9, zi, 0.055, 3.1, f);
            this.box(g, i % 2 ? '#e4a06f' : '#d288a2', x + (x > 0 ? -0.35 : 0.35), 3.05, zi, 0.85, 0.95, 0.08, f);
          } else if (type === 'lights') {
            this.cylinder(g, '#658f89', x, 1.65, zi, 0.055, 2.7, f);
            for (const dx of [-0.42, 0.42]) this.mesh(g, this.geometry('ico', () => new THREE.IcosahedronGeometry(1, 1)), dx > 0 ? '#ffd279' : '#eaa4bf', x + dx, 3, zi, 0.3, 0.3, 0.3, f, { emissive: dx > 0 ? '#f0af42' : '#d5629c', emissiveIntensity: 0.6 });
            this.beam(g, '#f5d291', [x - 0.45, 2.9, zi], [x + 0.45, 2.9, zi], 0.06, f);
          } else if (type === 'energy') {
            this.box(g, '#7da493', x, 0.8, zi, 1.2, 0.8, 0.48, f);
            const panel = this.box(g, '#658aab', x, 1.4, zi, 1.4, 0.1, 0.57, f); panel.rotation.z = x > 0 ? 0.2 : -0.2;
            this.box(g, '#e8cf8e', x, 1.45, zi, 0.04, 0.07, 0.54, f);
          } else if (type === 'route') {
            this.box(g, '#b69d79', x, 0.55, zi, 1.3, 0.3, 0.5, f);
            for (const dx of [-0.43, 0.43]) this.box(g, '#709894', x + dx, 0.78, zi, 0.08, 0.16, 0.61, f);
          } else {
            this.box(g, '#8eb6a6', x, 0.7, zi, 1.4, 0.6, 0.5, f);
            this.box(g, '#edcd88', x, 1.1, zi, 1.4, 0.16, 0.5, f);
          }
        }
      }
    }
  }

  buildFerris(record) {
    const { group: g, f } = record;
    const radius = record.appearance.metrics.ferrisRadius;
    const center = radius + 2.5;
    for (const z of [-2.4, 0.7]) for (const x of [-4.5, 4.5]) this.beam(g, '#4b8c83', [x, 0.2, z], [0, center, -0.8], 0.35, f);
    this.beam(g, '#f6e7be', [0, center, -3.1], [0, center, 1.2], 0.35, f);
    const wheel = new THREE.Group();
    wheel.position.set(0, center, -0.8);
    g.add(wheel);
    this.ring(wheel, '#e9a357', 0, 0, 0, radius, 0.22, f);
    this.ring(wheel, '#faf1d8', 0, 0, 0.18, radius * 0.95, 0.1, f);
    const cabins = [];
    const count = record.appearance.metrics.ferrisCabins;
    for (let i = 0; i < count; i++) {
      const a = i / count * TAU;
      this.beam(wheel, '#f6e8cb', [0, 0, 0], [Math.cos(a) * radius, Math.sin(a) * radius, 0], 0.065, f);
      const cabin = new THREE.Group();
      cabin.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
      const size = 1 + level(f, 'width') * 0.08;
      this.box(cabin, i % 2 ? '#e9967d' : '#74b3b2', 0, -0.7, 0.25, 1.2 * size, 1.1, 1.1, f);
      this.box(cabin, '#f6e7bf', 0, -0.05, 0.25, 1.4 * size, 0.15, 1.25, f);
      this.box(cabin, '#bed9d8', 0, -0.45, 0.82, 0.83 * size, 0.43, 0.03, f);
      this.beam(cabin, '#e7ddc4', [0, 0, 0], [0, 0.25, 0], 0.06, f);
      wheel.add(cabin); cabins.push(cabin);
    }
    this.ball(wheel, '#f0c56d', 0, 0, 0.35, 0.65, 0.65, 0.4, f);
    record.animations.push(t => { wheel.rotation.z = t * 0.095; for (const cabin of cabins) cabin.rotation.z = -wheel.rotation.z; });
  }

  buildSpinner(record, model) {
    const { group: g, f } = record;
    const r = record.appearance.metrics.carouselRadius;
    this.cylinder(g, '#f6e6bd', 0, 0.35, -1.2, r + 0.8, 0.5, f, 1, 40);
    this.cylinder(g, f.color, 0, 0.65, -1.2, r + 0.5, 0.2, f, 1, 40);
    const spin = new THREE.Group(); spin.position.z = -1.2; g.add(spin);
    if (model === 'carousel') {
      const h = record.appearance.metrics.carouselHeight;
      this.cylinder(g, '#efcc84', 0, h / 2, -1.2, 0.55, h, f);
      this.cylinder(g, '#f5d69d', 0, h, -1.2, r + 0.9, 0.5, f, 1, 32);
      const cone = this.geometry('carouselCone', () => new THREE.ConeGeometry(1, 1, 12, 1, false));
      this.mesh(g, cone, '#db927e', 0, h + 1.2, -1.2, r + 0.9, 2, r + 0.9, f);
      this.cylinder(g, '#faf0d0', 0, h + 2.45, -1.2, 0.17, 1.2, f);
      this.ball(g, '#eeb958', 0, h + 3.05, -1.2, 0.32, 0.32, 0.32, f);
      const count = record.appearance.metrics.carouselHorses;
      const outerCount = count <= 9 ? count : Math.ceil(count * 0.67);
      const horses = [];
      for (let i = 0; i < count; i++) {
        const outer = i < outerCount;
        const a = (outer ? i / outerCount : (i - outerCount) / (count - outerCount)) * TAU;
        const orbit = outer ? r - 0.65 : r - 2.05;
        const x = Math.cos(a) * orbit, z = Math.sin(a) * orbit;
        this.cylinder(spin, '#f8e7b9', x, h / 2, z, 0.055, h - 0.5, f, 1, 6);
        const horse = new THREE.Group(); horse.position.set(x, 1.9 + level(f, 'height') * 0.24, z); horse.rotation.y = -a; horse.scale.y = 1 + level(f, 'height') * 0.12; spin.add(horse);
        const c = ['#f4e6c1', '#93b7b1', '#e9b178'][i % 3];
        this.ball(horse, c, 0, 0, 0, 0.7, 0.35, 0.31, f);
        this.beam(horse, c, [0.45, 0.1, 0], [0.56, 0.7, 0], 0.18, f);
        this.ball(horse, c, 0.62, 0.74, 0, 0.31, 0.26, 0.22, f);
        this.box(horse, '#cc7c6a', 0, 0.3, 0, 0.45, 0.14, 0.65, f);
        for (const px of [-0.4, 0.4]) for (const pz of [-0.2, 0.2]) this.beam(horse, c, [px, -0.1, pz], [px - 0.1, -0.65, pz], 0.075, f);
        horses.push(horse);
      }
      record.animations.push(t => { spin.rotation.y = t * 0.24; horses.forEach((horse, i) => { horse.position.y = 1.9 + level(f, 'height') * 0.24 + Math.sin(t * 1.7 + i) * 0.21; }); });
    } else if (model === 'swings') {
      const h = 8.5 + level(f, 'height') * 0.6;
      this.cylinder(g, '#f4dfad', 0, h / 2, -1.2, 0.7, h, f);
      spin.position.y = h;
      this.cylinder(spin, '#de907c', 0, 0, 0, 5.4, 0.8, f, 0.5, 20);
      const count = 9 + level(f, 'count');
      for (let i = 0; i < count; i++) {
        const a = i / count * TAU, x = Math.cos(a), z = Math.sin(a);
        this.beam(spin, '#eee2be', [x * 4, 0, z * 4], [x * 5.6, -4.2, z * 5.6], 0.035, f);
        this.box(spin, '#6daba4', x * 5.6, -4.3, z * 5.6, 0.65, 0.22, 0.7, f);
      }
      record.animations.push(t => { spin.rotation.y = t * 0.38; });
    } else if (model === 'teacups') {
      this.cylinder(spin, '#f3d48e', 0, 0.85, 0, r, 0.16, f, 1, 32);
      const count = 5 + level(f, 'count');
      for (let i = 0; i < count; i++) {
        const a = i / count * TAU;
        const x = Math.cos(a) * 3.2, z = Math.sin(a) * 3.2;
        this.cylinder(spin, i % 2 ? '#8db7b0' : '#eab0a3', x, 1.55, z, 1.15, 1.15, f, 1.3, 12);
        const handle = this.ring(spin, '#f6e5c4', x + 1.2, 1.65, z, 0.5, 0.1, f); handle.rotation.y = Math.PI / 2;
        this.cylinder(spin, '#eedeb7', x, 2.18, z, 1.48, 0.1, f, 1, 16);
      }
      record.animations.push(t => { spin.rotation.y = t * 0.3; });
    } else {
      const rings = new THREE.Group(); rings.position.y = 4.5; spin.add(rings);
      for (let i = 0; i < 3; i++) { const r = this.ring(rings, ['#e6b75e', '#d58d8d', '#7fb5b0'][i], 0, 0, 0, 2.7 + i * 0.65, 0.2, f); r.rotation.y = i * 0.8; r.rotation.x = i * 0.7; }
      this.box(rings, '#f4e8c7', 0, 0, 0, 1.8, 0.4, 1.8, f);
      for (const x of [-4.5, 4.5]) this.beam(g, '#618b88', [x, 0.5, -1.2], [x, 5, -1.2], 0.3, f);
      record.animations.push(t => { rings.rotation.x = t * 0.4; rings.rotation.z = t * 0.22; });
    }
  }

  buildCoaster(record) {
    const { group: g, f } = record;
    const h = 8.5 + level(f, 'height') * 0.9;
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-7, 1.5, -5), new THREE.Vector3(-4, h, -7), new THREE.Vector3(3, h + 2, -5),
      new THREE.Vector3(7.4, 3.6, -1), new THREE.Vector3(5, 1.8, 3.7), new THREE.Vector3(-1, 3, 4), new THREE.Vector3(-7.3, 2.3, 0),
    ], true, 'catmullrom', 0.35);
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 100; i++) {
        const t = i / 100, p = path.getPoint(t), dir = path.getTangent(t);
        p.add(new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(side * (0.38 + level(f, 'width') * 0.03)));
        pts.push(p);
      }
      this.tube(g, '#e5a76b', new THREE.CatmullRomCurve3(pts), 0.12, f, 120);
    }
    for (let i = 0; i < 21; i++) {
      const p = path.getPoint(i / 21);
      this.beam(g, '#639b9d', [p.x, 0.3, p.z], [p.x, p.y - 0.1, p.z], 0.14, f);
      if (i % 3 === 0) this.beam(g, '#639b9d', [p.x + 1.1, 0.2, p.z], [p.x, p.y * 0.8, p.z], 0.1, f);
      const dir = path.getTangent(i / 21), side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.6);
      this.beam(g, '#557c7b', p.clone().sub(side).toArray(), p.clone().add(side).toArray(), 0.09, f);
    }
    const cars = [];
    for (let i = 0; i < record.appearance.metrics.coasterCars; i++) {
      const car = new THREE.Group(); g.add(car);
      this.box(car, '#d77d76', 0, 0.45, 0, record.appearance.metrics.coasterCarWidth, 0.55, 1.4, f);
      this.box(car, '#f3dfb6', 0, 0.8, -0.3, record.appearance.metrics.coasterCarWidth - 0.4, 0.45, 0.35, f);
      for (const x of [-0.55, 0.55]) for (const z of [-0.45, 0.45]) this.ball(car, '#485e5a', x, 0.1, z, 0.18, 0.18, 0.18, f);
      cars.push(car);
    }
    const positionCars = t => cars.forEach((car, i) => {
      const p = ((t * 0.043 - i * 0.028) % 1 + 1) % 1;
      car.position.copy(path.getPointAt(p));
      const tangent = path.getTangentAt(p);
      car.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), tangent.clone().negate(), UP));
    });
    positionCars(0); record.animations.push(positionCars);
  }

  buildTower(record) {
    const { group: g, f } = record;
    const h = 13 + level(f, 'height') * 1.3;
    this.cylinder(g, '#ebdba8', 0, 0.6, -1.5, 4.6, 0.7, f, 1, 16);
    this.cylinder(g, '#6da2a1', 0, h / 2, -1.5, 0.72, h, f, 1, 6);
    for (const x of [-0.9, 0.9]) this.beam(g, '#ecdbb6', [x, 0.5, -1.5], [x, h, -1.5], 0.08, f);
    this.cylinder(g, '#e4a079', 0, h, -1.5, 1.7, 0.65, f, 1, 10);
    this.cylinder(g, '#f4d191', 0, h + 1.1, -1.5, 1.5, 1.6, f, 0, 8);
    const lift = new THREE.Group(); lift.position.set(0, 2, -1.5); g.add(lift);
    this.cylinder(lift, '#da8a79', 0, 0, 0, 2.7 + level(f, 'count') * 0.1, 0.45, f, 1, 16);
    for (let i = 0; i < 10 + level(f, 'count') * 2; i++) {
      const a = i / (10 + level(f, 'count') * 2) * TAU;
      const seat = this.box(lift, '#f4e1ae', Math.cos(a) * 2.1, 0.65, Math.sin(a) * 2.1, 0.6, 1, 0.45, f);
      seat.rotation.y = -a + Math.PI / 2;
    }
    record.animations.push(t => { const p = (t * 0.065) % 1; lift.position.y = 1.6 + (h - 3) * (p < 0.72 ? p / 0.72 : Math.pow(1 - (p - 0.72) / 0.28, 3)); });
  }

  buildSwing(record, model) {
    const { group: g, f } = record;
    const h = 10 + level(f, 'height') * 0.55;
    for (const z of [-3.5, 0.3]) for (const x of [-5.8, 5.8]) this.beam(g, '#75a6a2', [x, 0.3, z], [0, h, -1.6], 0.28, f);
    this.beam(g, '#f0d8a4', [0, h, -3.3], [0, h, 0.5], 0.35, f);
    const pivot = new THREE.Group(); pivot.position.set(0, h, -1.6); g.add(pivot);
    const drop = h - 3.2;
    if (model === 'pirate') {
      this.beam(pivot, '#e9d3a5', [-2.5, -drop, -0.8], [0, 0, -0.8], 0.14, f);
      this.beam(pivot, '#e9d3a5', [2.5, -drop, 0.8], [0, 0, 0.8], 0.14, f);
      const boat = new THREE.Group(); boat.position.y = -drop; pivot.add(boat);
      const shape = new THREE.Shape(); shape.moveTo(-5.2, 0.7); shape.lineTo(-3.7, -1.2); shape.lineTo(3.7, -1.2); shape.lineTo(5.2, 0.7); shape.lineTo(-5.2, 0.7);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: record.appearance.metrics.hullWidth, bevelEnabled: false });
      this.resources(g).push(geo);
      this.mesh(boat, geo, '#bd8065', 0, 0, -record.appearance.metrics.hullWidth / 2, record.appearance.metrics.hullLength, 1, 1, f);
      this.box(boat, '#eecf91', 0, 0.65, 0, 10.2, 0.22, 2.9, f);
      for (let i = -3; i <= 3; i++) this.box(boat, '#d79b7c', i, 1.05, 0, 0.25, 0.7, 2.3, f);
    } else {
      this.beam(pivot, '#edca86', [0, 0, 0], [0, -drop, 0], 0.38, f);
      this.cylinder(pivot, '#d8867e', 0, -drop, 0, 3.7 + level(f, 'width') * 0.12, 0.55, f, 1, 20);
      for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; this.box(pivot, '#f4deb1', Math.cos(a) * 3.2, -drop + 0.55, Math.sin(a) * 3.2, 0.6, 0.8, 0.6, f); }
    }
    const halfWidth = model === 'pirate' ? 5.25 * record.appearance.metrics.hullLength : 3.7 + level(f, 'width') * 0.12;
    const reach = drop + 1.3;
    const maximumAngle = Math.asin(Math.min(1, 9.8 / Math.hypot(reach, halfWidth))) - Math.atan2(halfWidth, reach);
    const amplitude = Math.min(0.65 + level(f, 'height') * 0.045, Math.max(0.2, maximumAngle));
    record.animations.push(t => { pivot.rotation.z = Math.sin(t * 0.75) * amplitude; });
  }

  buildWater(record, model) {
    const { group: g, f } = record;
    const water = f.restored ? '#83c8cb' : '#7f9185';
    this.box(g, '#f4e7bf', 0, 0.4, -1.8, 16.6, 0.45, 12.8, f);
    this.box(g, water, 0, 0.67, -1.8, 15.5 + level(f, 'width') * 0.1, 0.12, 11.7, f);
    if (['water', 'slide', 'surf'].includes(model)) {
      const h = 6.8 + level(f, 'height') * 0.75;
      for (const x of [-6, -3]) this.beam(g, '#83a895', [x, 0.6, -6], [x, h, -6], 0.2, f);
      this.box(g, '#ecdcae', -4.5, h, -6, 3.8, 0.3, 3, f);
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-4.5, h + 0.4, -6), new THREE.Vector3(-1, h * 0.85, -5), new THREE.Vector3(4, h * 0.7, -4), new THREE.Vector3(5, h * 0.35, -0.5), new THREE.Vector3(1, 1.1, 2.2)]);
      this.tube(g, model === 'surf' ? '#6ab8ba' : '#eac373', curve, 0.7 + level(f, 'width') * 0.03, f, 64);
      this.tube(g, '#b1dde0', curve, 0.51, f, 64);
      const raft = new THREE.Group(); g.add(raft); this.cylinder(raft, '#d88e78', 0, 0, 0, 0.8, 0.25, f, 1, 12);
      record.animations.push(t => { raft.position.copy(curve.getPointAt((t * 0.11) % 1)); raft.position.y += 0.6; });
      for (let i = 0; i < 8; i++) this.box(g, '#f3e5c6', -6.1, i * h / 8 + 0.4, -3 + i * -0.4, 1.4, 0.16, 0.7, f);
    } else if (model === 'pool') {
      for (let i = 0; i < 5; i++) this.box(g, '#bce3dc', -6 + i * 3, 0.78, -1.8, 0.16, 0.07, 10, f);
      for (const x of [-5, 5]) {
        this.cylinder(g, '#d7bc8e', x, 2.2, 3, 0.06, 3.3, f);
        this.cylinder(g, '#eeb987', x, 3.9, 3, 2.1, 0.7, f, 0, 12);
      }
      this.box(g, '#e0e3c2', 0, 1.2, -7, 6, 1, 1, f);
    } else if (model === 'waterball') {
      for (let i = 0; i < 4 + level(f, 'count'); i++) {
        const x = -5 + (i % 4) * 3.4, z = -4.3 + Math.floor(i / 4) * 3;
        this.ball(g, '#b7dedc', x, 1.85, z, 1.2, 1.2, 1.2, f);
        const ring = this.ring(g, '#f4d897', x, 1.85, z, 1.22, 0.055, f); ring.rotation.y = Math.PI / 4;
      }
    } else {
      const curve = new THREE.CatmullRomCurve3(Array.from({ length: 12 }, (_, i) => { const a = i / 12 * TAU; return new THREE.Vector3(Math.cos(a) * 5.6, 0.95, Math.sin(a) * 3.8 - 1.8); }), true);
      if (model === 'river') {
        this.cylinder(g, '#a9c685', 0, 0.85, -1.8, 3.2, 0.35, f, 1, 16).scale.z *= 0.7;
        this.ball(g, '#72a174', 0, 1.8, -1.8, 1.3, 1.2, 1.1, f);
      }
      const boats = [];
      for (let i = 0; i < 3 + level(f, 'count'); i++) {
        const boat = new THREE.Group(); g.add(boat);
        if (model === 'river') { const ring = this.ring(boat, ['#e9bd6d', '#d99491', '#88b4ad'][i % 3], 0, 0, 0, 0.7, 0.23, f); ring.rotation.x = Math.PI / 2; }
        else { this.cylinder(boat, i % 2 ? '#e9b575' : '#e29689', 0, 0, 0, 0.9, 0.3, f, 0.8, 8).scale.z *= 1.4; this.box(boat, '#f7e1b7', 0, 0.3, 0, 0.8, 0.3, 1, f); }
        boats.push(boat);
      }
      record.animations.push(t => boats.forEach((boat, i) => { const at = (t * 0.025 + i / boats.length) % 1; boat.position.copy(curve.getPointAt(at)); const tangent = curve.getTangentAt(at); boat.rotation.y = Math.atan2(tangent.x, tangent.z); }));
    }
  }

  buildTrack(record, model) {
    const { group: g, f } = record;
    const elevated = ['pedal', 'cable', 'zipline'].includes(model);
    const height = elevated ? 5.3 + level(f, 'height') * 0.5 : 0.6;
    const curve = new THREE.CatmullRomCurve3(Array.from({ length: 12 }, (_, i) => { const a = i / 12 * TAU; return new THREE.Vector3(Math.cos(a) * 7.1, height + (model === 'zipline' ? Math.sin(a) * 0.6 : 0), Math.sin(a) * 4.5 - 1.6); }), true);
    if (model === 'kart' || model === 'rc') {
      this.box(g, '#818c86', 0, 0.35, -1.6, 16, 0.25, 11.5, f);
      this.box(g, '#b2c690', 0, 0.52, -1.6, 8.5, 0.1, 4.5, f);
      for (let i = 0; i < 26; i++) { const a = i / 26 * TAU; this.cylinder(g, i % 2 ? '#f2e6cc' : '#d68e7c', Math.cos(a) * 7.7, 0.65, Math.sin(a) * 5.1 - 1.6, 0.3, 0.5, f, 1, 6); }
    } else {
      this.tube(g, elevated ? '#6e918d' : '#797363', curve, model === 'train' ? 0.17 : 0.1, f, 72);
      if (model === 'train') {
        const outer = new THREE.CatmullRomCurve3(Array.from({ length: 12 }, (_, i) => { const a = i / 12 * TAU; return new THREE.Vector3(Math.cos(a) * 7.7, height, Math.sin(a) * 5.1 - 1.6); }), true);
        this.tube(g, '#797363', outer, 0.1, f, 72);
      }
      for (let i = 0; i < (elevated ? 8 : 24); i++) {
        const p = curve.getPoint(i / (elevated ? 8 : 24));
        if (elevated) this.beam(g, '#c5ba91', [p.x, 0.3, p.z], [p.x, p.y + (model === 'cable' ? 1.5 : 0), p.z], 0.18, f);
        else { const sleeper = this.box(g, '#b9946f', p.x, 0.45, p.z, 1.4, 0.12, 0.23, f); sleeper.rotation.y = -i / 24 * TAU; }
      }
    }
    const cars = [];
    for (let i = 0; i < 3 + level(f, 'count'); i++) {
      const car = new THREE.Group(); g.add(car);
      const color = ['#d98d78', '#e9bf70', '#83b5ad'][i % 3];
      if (model === 'cable' || model === 'zipline') {
        this.beam(car, '#e8dfc6', [0, 0, 0], [0, -1.1, 0], 0.06, f);
        this.box(car, color, 0, -1.7, 0, 1.4, 1.2, 1.4, f);
        this.box(car, '#b8d5d2', 0, -1.3, 0.72, 1, 0.5, 0.03, f);
      } else {
        this.box(car, color, 0, 0.5, 0, model === 'rc' ? 0.8 : 1.4, 0.6, model === 'train' ? 2 : 1.5, f);
        this.box(car, '#f0e3c4', 0, 1.05, -0.3, 1, 0.5, 0.7, f);
        if (model === 'train') { this.cylinder(car, '#536d66', 0, 1.35, 0.65, 0.2, 0.7, f); this.box(car, '#e2be78', 0, 1.6, -0.3, 1.4, 0.12, 1.1, f); }
        for (const x of [-0.62, 0.62]) for (const z of [-0.55, 0.55]) this.ball(car, '#465d58', x, 0.25, z, 0.23, 0.23, 0.23, f);
      }
      cars.push(car);
    }
    const run = t => cars.forEach((car, i) => { const at = (t * (model === 'kart' ? 0.067 : 0.025) + i / cars.length) % 1; car.position.copy(curve.getPointAt(at)); const dir = curve.getTangentAt(at); car.rotation.y = Math.atan2(dir.x, dir.z); });
    run(0); record.animations.push(run);
  }

  buildBattle(record, model) {
    const { group: g, f } = record;
    this.box(g, model === 'laser' ? '#526e7a' : '#b5b787', 0, 0.35, -1.6, 16.6, 0.25, 12.4, f);
    const wallColor = model === 'laser' ? '#718f9c' : '#a99575';
    for (const z of [-7.7, 4.3]) this.box(g, wallColor, 0, 1.25, z, 16.7, 1.8, 0.3, f);
    for (const x of [-8.2, 8.2]) this.box(g, wallColor, x, 1.25, -1.6, 0.3, 1.8, 12.3, f);
    const count = 7 + level(f, 'theme');
    for (let i = 0; i < count; i++) {
      const x = -6.5 + seed(i + 5) * 13, z = -6 + seed(i + 9) * 8.5;
      this.box(g, i % 2 ? '#829274' : '#c0a17a', x, 1.2, z, 1.6, 1.8 + (i % 3) * 0.5, 1.2, f).rotation.y = i * 0.9;
      if (model === 'laser') this.box(g, i % 2 ? '#c4a2c7' : '#9bd9d1', x, 2, z + 0.65, 1.2, 0.12, 0.04, f);
    }
    for (const [x, c] of [[-6, '#d98579'], [6, '#7cabbd']]) {
      this.cylinder(g, '#f1e5c6', x, 2.5, -5.5, 0.06, 4, f);
      this.box(g, c, x + 0.6, 4.1, -5.5, 1.3, 0.8, 0.04, f);
    }
    if (model === 'shooter') {
      this.box(g, '#f3ddad', 0, 4, -6.9, 14, 0.4, 2, f);
      for (let i = 0; i < 4 + level(f, 'count'); i++) {
        const x = -6 + i * 12 / (3 + level(f, 'count'));
        const target = this.cylinder(g, '#e49e81', x, 2.2, -5.8, 0.8, 0.08, f, 1, 16); target.rotation.x = Math.PI / 2;
        const eye = this.cylinder(g, '#f5e8c8', x, 2.2, -5.72, 0.4, 0.09, f, 1, 16); eye.rotation.x = Math.PI / 2;
      }
    }
    if (model === 'laser') { for (const x of [-8.1, 8.1]) this.box(g, '#596b79', x, 3.2, -1.6, 0.3, 4, 12.2, f); this.box(g, '#677482', 0, 5.2, -1.6, 16.5, 0.35, 12.4, f); }
  }

  buildAdventure(record, model) {
    const { group: g, f } = record;
    if (model === 'maze') {
      this.box(g, '#ddd4b3', 0, 0.4, -1.8, 16, 0.3, 12, f);
      for (let i = 0; i < 8; i++) {
        const x = -7 + i * 2;
        this.box(g, '#759a77', x, 1.6, -1.8, 0.6, 2.4, i % 2 ? 8 : 10.5, f);
        if (i % 2 === 0) this.box(g, '#759a77', x + 0.8, 1.6, -5, 2, 2.4, 0.6, f);
      }
      return;
    }
    const haunted = model === 'haunted';
    this.box(g, haunted ? '#657284' : '#a78c68', 0, 3.1, -2, 11.5, 5.5, 9.5, f);
    const roof = this.cylinder(g, haunted ? '#7d6d8b' : '#83775c', 0, 6.8, -2, 8.9, 3.2, f, 0, 4); roof.rotation.y = Math.PI / 4; roof.scale.z *= 0.82;
    for (const x of [-4.8, 4.8]) {
      this.box(g, '#737486', x, 4.5, -3.7, 2.5, 8.4, 2.5, f);
      this.cylinder(g, '#8a728e', x, 9.5, -3.7, 2.1, 2.9, f, 0, 6);
      this.box(g, '#edc37c', x, 5.3, -2.42, 0.7, 1.3, 0.03, f);
    }
    this.box(g, '#374b4c', 0, 1.9, 2.8, 2.5, 3.3, 0.15, f);
    for (const x of [-3.3, 3.3]) this.box(g, '#ecc68d', x, 3.5, 2.79, 1.3, 1.6, 0.06, f);
    if (!haunted) {
      for (let i = 0; i < 9; i++) this.ball(g, '#b69b72', -7 + seed(i) * 14, 1.2 + seed(i + 6) * 3.2, -4 + seed(i + 9) * 6, 1.4, 1.6, 1.3, f);
      this.box(g, '#3c5147', 0, 1.7, 2.85, 3.8, 3, 0.1, f);
    }
  }

  buildActivity(record, model) {
    const { group: g, f } = record;
    if (model === 'climbing') {
      const h = 7 + level(f, 'height') * 0.8;
      this.box(g, '#d1b49a', 0, h / 2, -4, 13 + level(f, 'width') * 0.25, h, 1.8, f).rotation.x = -0.07;
      for (let i = 0; i < 40; i++) this.ball(g, ['#d88975', '#79a7a6', '#eac06f'][i % 3], -5.7 + seed(i + 1) * 11.4, 1 + seed(i + 6) * (h - 2), -2.95, 0.2, 0.18, 0.2, f);
    } else if (model === 'ropes' || model === 'playground') {
      for (let i = 0; i < 6; i++) {
        const x = -6 + (i % 3) * 6, z = -5.5 + Math.floor(i / 3) * 6;
        const h = 4 + level(f, 'height') * 0.4 + i % 2;
        this.cylinder(g, '#b69b72', x, h / 2, z, 0.23, h, f);
        this.box(g, '#e7c98e', x, h, z, 2.7, 0.2, 2.7, f);
        this.cylinder(g, '#d9937f', x, h + 1.5, z, 2.1, 1.5, f, 0, 4).rotation.y = Math.PI / 4;
        if (i % 3 < 2) { this.beam(g, '#d8c6a2', [x, h, z], [x + 6, h + 1, z], 0.07, f); this.beam(g, '#83947a', [x, h + 1.2, z], [x + 6, h + 2.2, z], 0.035, f); }
      }
    } else if (model === 'trampoline') {
      for (let i = 0; i < 6 + level(f, 'count'); i++) {
        const x = -6 + (i % 4) * 4, z = -5.5 + Math.floor(i / 4) * 3.8;
        this.box(g, i % 2 ? '#dfb16e' : '#d89e96', x, 0.7 + level(f, 'height') * 0.08, z, 3.7, 0.7 + level(f, 'height') * 0.16, 3.4, f);
        this.box(g, '#637b82', x, 1.1 + level(f, 'height') * 0.16, z, 3, 0.15, 2.7, f);
      }
    } else if (model === 'football' || model === 'golf') {
      this.box(g, '#76a775', 0, 0.4, -1.8, 16, 0.2, 11.5, f);
      if (model === 'football') {
        for (const z of [-7.1, 3.5]) { this.box(g, '#eee9d1', 0, 0.53, z, 15, 0.03, 0.1, f); this.beam(g, '#f3e9d0', [-2, 0.5, z], [-2, 2.5, z], 0.08, f); this.beam(g, '#f3e9d0', [2, 0.5, z], [2, 2.5, z], 0.08, f); this.beam(g, '#f3e9d0', [-2, 2.5, z], [2, 2.5, z], 0.08, f); }
        this.box(g, '#eee9d1', 0, 0.54, -1.8, 15, 0.04, 0.12, f);
        for (let i = 0; i < 4; i++) this.beam(g, '#b8c5af', [-8, 1.8, -5 + i * 2.2], [8, 1.8, -5 + i * 2.2], 0.06, f);
      } else for (let i = 0; i < 5; i++) {
        const x = -5 + (i % 3) * 5, z = -5 + Math.floor(i / 3) * 6;
        this.cylinder(g, '#c2d397', x, 0.6, z, 2.2, 0.15, f, 1, 20);
        this.cylinder(g, '#e4d9b1', x, 1.7, z, 0.05, 2.2, f);
        this.box(g, '#db8f7c', x + 0.35, 2.6, z, 0.75, 0.6, 0.03, f);
      }
    } else if (model === 'digger') {
      this.box(g, '#e4c68b', 0, 0.4, -1.7, 16, 0.25, 12, f);
      for (let i = 0; i < 4 + level(f, 'count'); i++) {
        const x = -6 + (i % 4) * 4, z = -4 + Math.floor(i / 4) * 5;
        this.box(g, '#626e63', x, 0.65, z, 1.8, 0.45, 2.1, f);
        this.box(g, '#e9b74f', x, 1.3, z, 1.3, 1, 1.5, f);
        this.beam(g, '#e9b74f', [x, 1.5, z + 0.5], [x, 3.2, z + 1.5], 0.18, f);
        this.beam(g, '#e9b74f', [x, 3.2, z + 1.5], [x, 0.8, z + 2.3], 0.15, f);
      }
    } else if (model === 'blocks') {
      for (let i = 0; i < 18 + level(f, 'theme') * 3; i++) {
        const x = -6 + (i % 6) * 2.4, z = -5 + Math.floor(i / 6) * 1.55;
        this.box(g, ['#e0a072', '#84ada5', '#d4949e', '#b2a0c7'][i % 4], x, 0.8 + (i % 3) * 0.45, z, 2, 1 + (i % 3) * 0.9, 1.3, f);
        this.cylinder(g, '#f1d79f', x, 1.4 + (i % 3) * 0.9, z, 0.35, 0.2, f);
      }
    } else if (model === 'skate') {
      this.box(g, '#bbc2b6', 0, 0.5, -1.5, 16, 0.3, 12, f);
      for (const x of [-5.8, 5.8]) { const ramp = this.box(g, '#a5b0ad', x, 1.6, -1.8, 3.5, 0.4, 10, f); ramp.rotation.z = x > 0 ? 0.55 : -0.55; }
      this.beam(g, '#627e7a', [-3, 1, -2], [3, 1, -2], 0.08, f);
    } else {
      this.box(g, '#d7d7bd', 0, 0.5, -1.7, 16.5, 0.3, 11.8, f);
      for (const x of [-8, 8]) this.box(g, '#eac47f', x, 3, -1.7, 0.2, 5.8, 11.5, f);
      for (let i = 0; i < 6 + level(f, 'count'); i++) {
        const car = new THREE.Group(); g.add(car);
        this.cylinder(car, '#586d67', 0, 0.7, 0, 0.95, 0.25, f, 1, 10);
        this.box(car, i % 2 ? '#de9182' : '#83b2ad', 0, 1, 0, 1.2, 0.5, 1.4, f);
        this.beam(car, '#ccc6ab', [0, 1.2, -0.5], [0, 4.7, -0.5], 0.03, f);
        record.animations.push(t => { car.position.set(Math.sin(t * 0.5 + i * 4) * 5.5, 0, -1.7 + Math.cos(t * 0.37 + i * 2) * 3.5); car.rotation.y = t * 0.4 + i; });
      }
      this.box(g, '#f0dfb8', 0, 5.1, -1.7, 17.2, 0.3, 12.2, f);
    }
  }

  buildFountain(record) {
    const { group: g, f } = record;
    this.cylinder(g, '#e9ddba', 0, 0.6, -1.4, 6.3, 0.7, f, 1, 40);
    this.cylinder(g, '#84bdc0', 0, 1, -1.4, 5.8, 0.12, f, 1, 40);
    const jets = new THREE.Group(); jets.position.z = -1.4; g.add(jets);
    for (let i = 0; i < 9; i++) { const a = i / 8 * TAU, r = i === 8 ? 0 : 3.5; this.cylinder(jets, '#b9e3df', Math.cos(a) * r, 2.5, Math.sin(a) * r, 0.14, 4.4 + level(f, 'height') * 0.5, f, 0.45, 6); }
    record.animations.push(t => { jets.scale.y = 0.75 + Math.sin(t * 1.4) * 0.22; });
  }

  buildHall(record, model) {
    const { group: g, f } = record;
    const c = f.color || '#9eb8b0';
    const w = 12 + level(f, 'width') * 0.5, d = 9.5 + level(f, 'length') * 0.4;
    const future = ['vr', 'science', 'simulator', 'ar', 'windtunnel'].includes(model);
    this.box(g, '#f2e5c3', 0, 2.7, -2, w, 5.1, d, f);
    this.box(g, c, 0, 4.6, -2, w + 0.4, 1.5, d + 0.3, f);
    if (future) {
      this.mesh(g, this.geometry('dome', () => new THREE.SphereGeometry(1, 16, 8, 0, TAU, 0, Math.PI / 2)), '#bed8cf', 0, 5.4, -2, w * 0.52, 3.1, d * 0.52, f);
      if (model === 'science') { const ring = this.ring(g, '#edc788', 0, 9, -2, 1.5, 0.14, f); ring.rotation.y = 0.6; this.ball(g, '#91b5b7', 0, 9, -2, 0.65, 0.65, 0.65, f); }
      if (model === 'windtunnel') {
        this.cylinder(g, '#a3cbc8', 0, 7, -2, 2.4, 7, f, 1, 16);
        this.cylinder(g, '#e4c78c', 0, 10.6, -2, 2.8, 0.3, f, 1, 16);
        for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; this.beam(g, '#f4e8c7', [Math.cos(a) * 2.4, 4, Math.sin(a) * 2.4 - 2], [Math.cos(a) * 2.4, 10.4, Math.sin(a) * 2.4 - 2], 0.08, f); }
      }
    } else if (model === 'ski') {
      const roof = this.box(g, '#e6eee4', 0, 7, -2, w + 1, 0.6, d + 1, f); roof.rotation.x = -0.4;
      for (let i = 0; i < 3; i++) this.mesh(g, this.geometry('snowPeak', () => new THREE.ConeGeometry(1, 1, 4)), '#f4f0da', -3 + i * 3, 8 + i % 2, -2, 2.7, 4, 2.7, f);
    } else {
      const roof = this.cylinder(g, c, 0, 6.3, -2, w * 0.77, 2.1, f, 0, 4); roof.rotation.y = Math.PI / 4; roof.scale.z *= d / w;
      if (['theater', 'cinema', 'music', 'dance'].includes(model)) {
        this.box(g, '#d88c7d', 0, 3, d / 2 - 1.8, 8, 3.8, 0.2, f);
        this.box(g, '#f4d791', 0, 4.7, d / 2 - 1.4, 9, 0.5, 0.8, f);
        for (let i = 0; i < 9; i++) this.ball(g, '#fff0be', -4 + i, 4.75, d / 2 - 0.97, 0.12, 0.12, 0.12, f);
      }
      if (model === 'bowling') { this.ball(g, '#6e9b9c', 0, 7.9, -2, 1.25, 1.25, 1.25, f); for (const x of [-1.8, 1.8]) { this.ball(g, '#f3e7cb', x, 7.7, -2, 0.4, 1.1, 0.4, f); this.ball(g, '#d38e7b', x, 8.3, -2, 0.27, 0.16, 0.27, f); } }
      if (model === 'dinosaur') {
        this.ball(g, '#82a878', 0, 7.4, -2, 2.2, 1.3, 1.1, f);
        this.beam(g, '#82a878', [1.1, 7.7, -2], [2, 9.5, -2], 0.5, f);
        this.ball(g, '#82a878', 2.2, 9.6, -2, 0.9, 0.6, 0.5, f);
        this.beam(g, '#82a878', [-1.6, 7.4, -2], [-4.2, 8.2, -2], 0.35, f);
      }
    }
    for (const x of [-w * 0.32, w * 0.32]) this.box(g, '#8db6b6', x, 2.8, d / 2 - 1.96, 2.1, 2, 0.08, f);
    this.box(g, '#4d726f', 0, 1.8, d / 2 - 1.93, 2.3, 3, 0.1, f);
    if (level(f, 'effect') >= 2 || level(f, 'theme') >= 2) for (const x of [-w / 2, w / 2]) { this.cylinder(g, '#efc170', x, 3.5, 2.9, 0.12, 6.3, f); this.ball(g, '#eab987', x, 6.8, 2.9, 0.55, 0.7, 0.55, f); }
  }

  bindControls() {
    const listen = (element, event, fn, options) => { element.addEventListener(event, fn, options); this.listeners.push(() => element.removeEventListener(event, fn, options)); };
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';
    listen(this.canvas, 'click', e => {
      if (performance.now() < (this.suppressClickUntil || 0)) return;
      this.canvas.focus({ preventScroll: true });
      const locked = document.pointerLockElement === this.canvas;
      if (locked) {
        if (performance.now() - (this.lockedAt || 0) < 180) return;
      }
      const hit = this.selectAt(locked, e);
      // Stay in this click's user activation: never defer the lock request.
      if (sceneClickAction({ locked, hit }) === 'lock') this.lock();
    });
    listen(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked) this.fallback = false;
      this.lockedAt = performance.now(); this.keys.clear(); this.onLockChange(locked);
    });
    listen(document, 'pointerlockerror', () => this.controlFallback());
    listen(this.canvas, 'contextmenu', e => e.preventDefault());
    listen(this.canvas, 'mousedown', e => {
      if (![0, 2].includes(e.button) || document.pointerLockElement === this.canvas) return;
      this.dragging = true;
      this.drag = beginCameraDrag(e.clientX, e.clientY, e.button);
      this.canvas.focus({ preventScroll: true });
      e.preventDefault();
    });
    listen(window, 'mouseup', () => {
      if (this.drag?.moved) this.suppressClickUntil = performance.now() + 250;
      this.dragging = false;
      this.drag = null;
    });
    listen(this.canvas, 'mouseenter', () => { this.pointerInside = true; });
    listen(this.canvas, 'mouseleave', () => { this.pointerInside = false; if (!this.dragging) this.setHovered(null); });
    listen(window, 'mousemove', e => {
      let next = null;
      if (document.pointerLockElement === this.canvas) {
        next = applyPointerLook(this.cameraPose(), e.movementX || 0, e.movementY || 0);
      } else if (this.dragging && this.drag) {
        const result = stepCameraDrag(this.cameraPose(), this.drag, e.clientX, e.clientY);
        this.drag = result.drag;
        if (this.drag.moved) next = result.pose;
      }
      if (next) {
        this.transition = null;
        this.applyCameraPose(next);
      }
      const r = this.canvas.getBoundingClientRect();
      this.pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    });
    listen(window, 'keydown', e => {
      if (this.isTyping(e.target)) { this.keys.clear(); return; }
      if (e.defaultPrevented) return;
      if (isCameraKey(e.code)) { this.keys.add(e.code); e.preventDefault(); }
    });
    listen(window, 'keyup', e => this.keys.delete(e.code));
    listen(window, 'focusin', e => { if (this.isTyping(e.target)) this.keys.clear(); });
    listen(window, 'blur', () => { this.keys.clear(); this.dragging = false; this.drag = null; });
    listen(document, 'visibilitychange', () => { if (document.hidden) { this.keys.clear(); this.dragging = false; this.drag = null; } });
    listen(this.canvas, 'wheel', e => {
      e.preventDefault(); this.transition = null;
      const delta = clamp(e.deltaY, -160, 160) * 0.11;
      this.camera.position.y = clamp(this.camera.position.y + delta, 8, 165);
      this.camera.position.x += Math.sin(this.yaw) * delta * 0.5;
      this.camera.position.z += Math.cos(this.yaw) * delta * 0.5;
    }, { passive: false });
    listen(window, 'resize', () => this.resize(true));
    listen(this.canvas, 'webglcontextlost', () => { this.viewportDiagnostics.contextLost++; });
    listen(this.canvas, 'webglcontextrestored', () => { this.viewportDiagnostics.contextRestored++; });
  }

  isTyping(target) { return isTypingTarget(target); }

  cameraPose() { return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.yaw, pitch: this.pitch }; }

  applyCameraPose(pose) {
    this.camera.position.set(pose.x, pose.y, pose.z);
    this.yaw = pose.yaw; this.pitch = pose.pitch;
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  lock() {
    if (this.disposed || document.pointerLockElement === this.canvas) return;
    this.canvas.focus({ preventScroll: true });
    if (typeof this.canvas.requestPointerLock !== 'function') { this.controlFallback(); return; }
    try { const result = this.canvas.requestPointerLock(); if (result?.catch) result.catch(() => this.controlFallback()); }
    catch { this.controlFallback(); }
  }

  controlFallback() {
    this.fallback = true;
    this.onLockChange(false);
    window.dispatchEvent(new CustomEvent('park-control-fallback', { detail: { message: '当前浏览器限制了鼠标锁定。仍可用 WASD 移动、方向键转头，或按住左键／右键拖动视角。' } }));
  }

  unlock() { if (document.pointerLockElement === this.canvas) document.exitPointerLock(); this.keys.clear(); }

  selectAt(center, event) {
    const pointer = center ? new THREE.Vector2() : this.pointerFromEvent(event);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickTargets, false)[0];
    if (hit) {
      const id = hit.object.userData.facilityId;
      this.selectedId = id; this.unlock(); this.onSelect(id);
      return true;
    }
    return false;
  }

  pointerFromEvent(e) { const r = this.canvas.getBoundingClientRect(); return new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); }

  setHovered(id) { if (this.hovered === id) return; this.hovered = id; this.onHover(id); }

  home(immediate = false) {
    const p = HOME_CAMERA_POSE;
    const position = new THREE.Vector3(p.x, p.y, p.z);
    const direction = new THREE.Vector3(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
    this.setView(position, position.clone().add(direction), immediate);
  }

  focus(id) {
    const f = this.game.state.facilities.find(facility => facility.id === id);
    if (!f) return;
    this.selectedId = id;
    this.unlock();
    // Explicit facility focus turns the player in place instead of flying away.
    this.setView(this.camera.position.clone(), new THREE.Vector3(f.x, 3, f.z - 1), false);
  }

  setView(position, target, immediate) {
    const camera = this.camera.clone(); camera.position.copy(position); camera.lookAt(target); camera.rotation.order = 'YXZ';
    if (immediate) { this.camera.position.copy(position); this.camera.quaternion.copy(camera.quaternion); this.yaw = this.camera.rotation.y; this.pitch = this.camera.rotation.x; this.transition = null; }
    else this.transition = { position, quaternion: camera.quaternion.clone() };
  }

  update(dt = 0.016) {
    if (this.disposed) return;
    dt = clamp(Number(dt) || 0.016, 0, 0.08);
    const state = this.game.state;
    if (!state.paused) this.time += dt * Math.min(Number(state.speed) || 1, 3);
    this.syncTimer += dt;
    if (this.syncTimer > 0.3) { this.syncTimer = 0; this.syncFacilities(); }
    if (this.transition) {
      const k = 1 - Math.exp(-dt * 6);
      this.camera.position.lerp(this.transition.position, k);
      this.camera.quaternion.slerp(this.transition.quaternion, k);
      this.yaw = this.camera.rotation.y; this.pitch = this.camera.rotation.x;
      if (this.camera.position.distanceTo(this.transition.position) < 0.03) this.transition = null;
    }
    if (this.isTyping(document.activeElement)) this.keys.clear();
    const pose = this.cameraPose();
    const next = stepCameraControls(pose, this.keys, dt);
    if (next.x !== pose.x || next.y !== pose.y || next.z !== pose.z || next.yaw !== pose.yaw || next.pitch !== pose.pitch) {
      this.transition = null;
      this.applyCameraPose(next);
    }
    for (const record of this.records.values()) {
      if (record.pulse) {
        record.pulseTime -= dt;
        record.pulse.material.opacity = Math.max(0, record.pulseTime / 1.4);
        record.pulse.scale.setScalar(1 + (1 - record.pulseTime / 1.4) * 0.04);
        if (record.pulseTime <= 0) { record.group.remove(record.pulse); record.pulse = null; }
      }
      if (record.f.restored && record.f.open !== false) for (const animate of record.animations) animate(this.time * record.appearance.metrics.animationFactor);
    }
    this.updateVisitors();
    if ((this.pointerInside || document.pointerLockElement === this.canvas) && !this.dragging) {
      this.camera.updateMatrixWorld();
      this.raycaster.setFromCamera(document.pointerLockElement === this.canvas ? new THREE.Vector2() : this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.pickTargets, false)[0];
      this.setHovered(hit?.object.userData.facilityId || null);
    }
    const selected = this.records.get(this.hovered || this.selectedId);
    this.selection.visible = !!selected;
    if (selected) this.selection.position.set(selected.f.x, 0.6, selected.f.z - 0.7);
    // Resize and draw in the same frame, after any expensive scene updates.
    this.applyPendingViewport();
    this.renderer.render(this.scene, this.camera);
    this.viewportDiagnostics.frames++;
  }

  setUIInteractionActive(active) { this.uiInteractionActive = !!active; }

  resize(refreshPixelRatio = false) {
    if (this.disposed) return false;
    this.viewportDiagnostics.requests++;
    // ResizeObserver notifications never change resolution on their own.
    if (refreshPixelRatio) this.renderPixelRatio = stablePixelRatio(window.devicePixelRatio);
    const desired = renderViewport(this.canvas.clientWidth, this.canvas.clientHeight, this.renderPixelRatio);
    const change = viewportChange(this.viewport, desired, this.uiInteractionActive);
    if (change === 'empty') { this.viewportDiagnostics.skipped++; return false; }
    if (change === 'unchanged') {
      this.pendingViewport = null;
      this.viewportDiagnostics.skipped++;
      return false;
    }
    if (this.pendingViewport) this.viewportDiagnostics.coalesced++;
    this.pendingViewport = desired;
    if (!this.viewport) this.applyPendingViewport();
    return true;
  }

  applyPendingViewport() {
    if (!this.pendingViewport || this.disposed) return false;
    const change = viewportChange(this.viewport, this.pendingViewport, this.uiInteractionActive);
    if (change === 'defer') { this.viewportDiagnostics.deferredFrames++; return false; }
    if (change !== 'apply') { this.pendingViewport = null; return false; }
    const next = this.pendingViewport;
    // Atomic size + DPR update avoids setPixelRatio()'s extra canvas resize.
    this.renderer.setDrawingBufferSize(next.cssWidth, next.cssHeight, next.pixelRatio);
    this.camera.aspect = next.cssWidth / next.cssHeight;
    this.camera.updateProjectionMatrix();
    this.viewport = next;
    this.pendingViewport = null;
    this.viewportDiagnostics.applied++;
    return true;
  }

  inspectState() {
    return { facilities: this.records.size, visitors: this.people.bodies.count, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, locked: document.pointerLockElement === this.canvas, fallback: !!this.fallback, position: this.camera.position.toArray(), yaw: this.yaw, pitch: this.pitch, selected: this.selectedId, keys: [...this.keys], dragging: !!this.dragging, viewport: { ...this.viewport, ...this.viewportDiagnostics, pending: this.pendingViewport ? { ...this.pendingViewport } : null, uiInteractionActive: this.uiInteractionActive } };
  }

  dispose() {
    this.disposed = true; this.unlock(); clearTimeout(this.clickTimer); this.resizeObserver?.disconnect();
    for (const remove of this.listeners) remove();
    for (const record of this.records.values()) this.removeRecord(record);
    for (const resource of this.world.userData.resources || []) resource.dispose?.();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.selection.geometry.dispose(); this.selection.material.dispose(); this.renderer.dispose();
  }
}
