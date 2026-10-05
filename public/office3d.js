// The 3D office: one floor per project around a central stand-up hub, six desks per floor, one
// agent per desk. Free agents get up and walk around (aisles, the water cooler, a teammate's
// desk, the hub); an agent with work walks back to their desk and types. Click an agent and the
// camera flies to them; they turn to you and wave, and the app pins a status card above them.
import * as THREE from '/vendor/three.module.min.js';

const ROLE_ORDER = ['architect', 'frontend', 'backend', 'database', 'qa', 'devops'];
const SKIN = ['#f1c9a5', '#e0ac8a', '#c68863', '#8d5a3c', '#f5d6c0', '#a8714f'];
const HAIR = ['#2b2321', '#5a3b28', '#1c1c1c', '#8a6a4a', '#3a2a20', '#b88a5a'];
const ZONE_W = 10.4;
const ZONE_D = 7.8;
const FLOOR = 0.14;          // top of a zone floor
const HUB_R = 3.3;           // hub platform radius
const RING_A = 4.75;         // walkway around the desks (half width / half depth)
const RING_B = 3.0;
const RING_P = 4 * RING_A + 4 * RING_B;
const SEAT_DROP = -0.25;     // how far the body drops when sitting
const WALK = 1.5;            // units per second

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const mix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);
const rand = (a, b) => a + Math.random() * (b - a);
const angleLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- the walkway ring around each zone's desks (zone-local x/z) ---------- */

function ringParam(x, z) {
  const d = [Math.abs(z + RING_B), Math.abs(x - RING_A), Math.abs(z - RING_B), Math.abs(x + RING_A)];
  const e = d.indexOf(Math.min(...d));
  const cx = Math.max(-RING_A, Math.min(RING_A, x));
  const cz = Math.max(-RING_B, Math.min(RING_B, z));
  if (e === 0) return cx + RING_A;
  if (e === 1) return 2 * RING_A + (cz + RING_B);
  if (e === 2) return 2 * RING_A + 2 * RING_B + (RING_A - cx);
  return 4 * RING_A + 2 * RING_B + (RING_B - cz);
}
function ringPoint(t) {
  t = ((t % RING_P) + RING_P) % RING_P;
  if (t < 2 * RING_A) return [t - RING_A, -RING_B];
  t -= 2 * RING_A;
  if (t < 2 * RING_B) return [RING_A, t - RING_B];
  t -= 2 * RING_B;
  if (t < 2 * RING_A) return [RING_A - t, RING_B];
  t -= 2 * RING_A;
  return [-RING_A, RING_B - t];
}
const CORNERS = [0, 2 * RING_A, 2 * RING_A + 2 * RING_B, 4 * RING_A + 2 * RING_B];
/** Zone-local points walking the ring from t1 to t2 the short way (corners included, t2 last). */
function ringPath(t1, t2) {
  const fwd = (t2 - t1 + RING_P) % RING_P;
  const back = (t1 - t2 + RING_P) % RING_P;
  const out = [];
  if (fwd <= back) {
    CORNERS.map(c => [c, (c - t1 + RING_P) % RING_P]).filter(([, d]) => d > 0.01 && d < fwd).sort((a, b) => a[1] - b[1]).forEach(([c]) => out.push(ringPoint(c)));
  } else {
    CORNERS.map(c => [c, (t1 - c + RING_P) % RING_P]).filter(([, d]) => d > 0.01 && d < back).sort((a, b) => a[1] - b[1]).forEach(([c]) => out.push(ringPoint(c)));
  }
  out.push(ringPoint(t2));
  return out;
}

/* ---------- geometry helpers ---------- */

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function slab(w, d, h, r, mat) {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, d, r), { depth: h, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function codeTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1424';
  g.fillRect(0, 0, 128, 256);
  const cols = ['#7dd3fc', '#a5b4fc', '#86efac', '#fcd34d', '#f9a8d4', '#cbd5e1'];
  for (let y = 6; y < 256; y += 10) {
    let x = 8 + Math.floor(Math.random() * 4) * 8;
    const n = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n && x < 118; i++) {
      const w = 8 + Math.random() * 34;
      g.fillStyle = cols[Math.floor(Math.random() * cols.length)];
      g.fillRect(x, y, Math.min(w, 120 - x), 4);
      x += w + 5;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createOffice(host, { onAgent, onZone, onHub }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'office-canvas';
  host.appendChild(renderer.domElement);

  const labels = document.createElement('div');
  labels.className = 'office-labels';
  host.appendChild(labels);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
  const OFFSET = new THREE.Vector3(1, 0.95, 1).normalize().multiplyScalar(120);
  const target = new THREE.Vector3();
  let halfH = 20;
  let zoomGoal = null;

  scene.add(new THREE.HemisphereLight('#ffffff', '#8b93a6', 1.6));
  const sun = new THREE.DirectionalLight('#fff6e8', 2.2);
  sun.position.set(-30, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: '#e9ecf1', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  const code = codeTexture();
  const M = {
    desk: new THREE.MeshStandardMaterial({ color: '#d9c7a8', roughness: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ color: '#4b5563', roughness: 0.5, metalness: 0.3 }),
    monitor: new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.4, metalness: 0.2 }),
    chair: new THREE.MeshStandardMaterial({ color: '#374151', roughness: 0.8 }),
    keyboard: new THREE.MeshStandardMaterial({ color: '#e5e7eb', roughness: 0.6 }),
    divider: new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.9 }),
    pot: new THREE.MeshStandardMaterial({ color: '#f3f4f6', roughness: 0.8 }),
    leaf: new THREE.MeshStandardMaterial({ color: '#4d9a5b', roughness: 0.9, flatShading: true }),
    water: new THREE.MeshStandardMaterial({ color: '#93c5fd', roughness: 0.1, transparent: true, opacity: 0.75 }),
    trousers: new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.8 }),
    shoe: new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.6 }),
    screenOff: new THREE.MeshStandardMaterial({ color: '#111827', emissive: '#1e293b', emissiveIntensity: 0.4, roughness: 0.3 }),
    screenOn: new THREE.MeshBasicMaterial({ map: code }),
  };

  /* ---------------- furniture ---------------- */

  function makeDesk() {
    const g = new THREE.Group();
    g.add(box(2.2, 0.08, 1.05, M.desk, 0, 0.78, 0));
    g.add(box(0.06, 0.74, 0.9, M.metal, -1.0, 0.37, 0));
    g.add(box(0.06, 0.74, 0.9, M.metal, 1.0, 0.37, 0));
    g.add(box(0.62, 0.03, 0.2, M.keyboard, 0, 0.835, -0.18));
    g.add(box(0.08, 0.3, 0.08, M.monitor, 0, 0.97, 0.3));
    g.add(box(1.05, 0.64, 0.06, M.monitor, 0, 1.36, 0.3));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.54), M.screenOff);
    screen.position.set(0, 1.36, 0.265);
    screen.rotation.y = Math.PI;
    g.add(screen);
    return { group: g, screen };
  }
  function makeChair() {
    const g = new THREE.Group();
    g.add(box(0.72, 0.08, 0.72, M.chair, 0, 0.5, 0));
    g.add(box(0.72, 0.75, 0.08, M.chair, 0, 0.92, -0.38));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.46, 8), M.metal);
    pole.position.y = 0.25;
    g.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.04, 16), M.metal);
    base.position.y = 0.03;
    g.add(base);
    return g;
  }
  function makePlant() {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.45, 12), M.pot);
    pot.position.y = 0.22;
    pot.castShadow = true;
    g.add(pot);
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32 - i * 0.05, 0), M.leaf);
      leaf.position.set((i - 1) * 0.12, 0.65 + i * 0.22, (i % 2) * 0.08);
      leaf.castShadow = true;
      g.add(leaf);
    }
    return g;
  }
  function makeCooler() {
    const g = new THREE.Group();
    g.add(box(0.5, 0.95, 0.45, M.pot, 0, 0.475, 0));
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 16), M.water);
    bottle.position.y = 1.2;
    g.add(bottle);
    return g;
  }

  /* ---------------- people ---------------- */

  function makeFigure(color, i) {
    const root = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[i % SKIN.length], roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: HAIR[(i * 7) % HAIR.length], roughness: 0.9 });

    const legs = [];
    for (const sx of [-0.13, 0.13]) {
      const hip = new THREE.Group();
      hip.position.set(sx, 0.85, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.5, 4, 8), M.trousers);
      leg.position.y = -0.36;
      leg.castShadow = true;
      hip.add(leg);
      const shoe = box(0.16, 0.08, 0.26, M.shoe, 0, -0.8, 0.05);
      hip.add(shoe);
      root.add(hip);
      legs.push(hip);
    }
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.42, 6, 14), bodyMat);
    body.position.y = 1.27;
    body.castShadow = true;
    root.add(body);
    const head = new THREE.Group();
    head.position.y = 1.98;
    root.add(head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.23, 20, 16), skin);
    skull.castShadow = true;
    head.add(skull);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.245, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    hair.rotation.x = -0.35;
    head.add(hair);
    const arms = [];
    for (const sx of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(sx * 0.31, 1.6, 0.02);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.4, 4, 8), bodyMat);
      arm.position.y = -0.26;
      arm.castShadow = true;
      sh.add(arm);
      root.add(sh);
      arms.push(sh);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.035, 8, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.5;
    ring.visible = false;
    root.add(ring);
    const flag = new THREE.Mesh(new THREE.OctahedronGeometry(0.17), new THREE.MeshStandardMaterial({ color: '#f59e0b', emissive: '#f59e0b', emissiveIntensity: 0.6 }));
    flag.position.y = 2.6;
    flag.visible = false;
    root.add(flag);
    return { root, legs, body, head, arms, ring, flag, bodyMat };
  }

  /* ---------------- the hub ---------------- */

  const hub = new THREE.Group();
  scene.add(hub);
  const hubMat = new THREE.MeshStandardMaterial({ color: '#dfe3ea', roughness: 0.9 });
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(HUB_R, HUB_R + 0.1, 0.16, 48), hubMat);
  plat.position.y = 0.08;
  plat.receiveShadow = true;
  hub.add(plat);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.08, 40), M.desk);
  table.position.y = 0.98;
  table.castShadow = true;
  hub.add(table);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.82, 12), M.metal);
  stem.position.y = 0.57;
  hub.add(stem);
  const coreMat = new THREE.MeshStandardMaterial({ color: '#6366f1', emissive: '#6366f1', emissiveIntensity: 0.35, roughness: 0.3, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), coreMat);
  core.position.y = 2.0;
  core.castShadow = true;
  hub.add(core);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), new THREE.MeshBasicMaterial({ color: '#818cf8', wireframe: true, transparent: true, opacity: 0.35 }));
  shell.position.y = 2.0;
  hub.add(shell);
  hub.traverse(o => { o.userData.pick = { kind: 'hub' }; });

  /* ---------------- zones and agents ---------------- */

  let zones = [];
  let zoneKey = '';
  const agents = new Map(); // `${pid}:${role}` -> agent
  const pickables = [];
  const agentLabels = new Map();
  const zoneLabels = new Map();
  const hubLabel = document.createElement('div');
  hubLabel.className = 'ol-hub';
  hubLabel.addEventListener('click', () => onHub && onHub());
  labels.appendChild(hubLabel);

  function layout(n) {
    if (n === 1) return [[0, -9]];
    const R = Math.max(12.8, 6.8 / Math.sin(Math.PI / n));
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 - Math.PI / 4 + (i * 2 * Math.PI) / n;
      return [Math.cos(a) * R, Math.sin(a) * R];
    });
  }

  const collect = root => { const out = []; root.traverse(o => { if (o.isMesh) out.push(o); }); return out; };

  function buildZones(projects, roles) {
    for (const z of zones) scene.remove(z.group);
    for (const a of agents.values()) scene.remove(a.fig.root);
    zones = [];
    agents.clear();
    pickables.length = 0;
    pickables.push(...collect(hub));
    for (const d of [...agentLabels.values(), ...zoneLabels.values()]) d.remove();
    agentLabels.clear();
    zoneLabels.clear();

    const pos = layout(projects.length);
    projects.forEach((p, pi) => {
      const zpos = new THREE.Vector3(pos[pi][0], 0, pos[pi][1]);
      const group = new THREE.Group();
      group.position.copy(zpos);
      scene.add(group);
      const rimMat = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.6 });
      const floorMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.95 });
      const rim = slab(ZONE_W + 0.3, ZONE_D + 0.3, 0.1, 0.9, rimMat);
      const floor = slab(ZONE_W, ZONE_D, FLOOR, 0.75, floorMat);
      const divider = box(ZONE_W - 3.6, 0.5, 0.06, M.divider, 0, FLOOR + 0.25, 0);
      group.add(rim, floor, divider);
      const zonePick = { kind: 'zone', projectId: p.id };
      for (const m of [rim, floor, divider]) { m.userData.pick = zonePick; pickables.push(m); }

      const plantA = makePlant();
      plantA.position.set(-ZONE_W / 2 + 0.55, FLOOR, -ZONE_D / 2 + 0.55);
      const plantB = makePlant();
      plantB.position.set(ZONE_W / 2 - 0.55, FLOOR, ZONE_D / 2 - 0.55);
      const cooler = makeCooler();
      cooler.position.set(ZONE_W / 2 - 0.5, FLOOR, -ZONE_D / 2 + 0.5);
      group.add(plantA, plantB, cooler);

      const zone = { id: p.id, pos: zpos, group, rimMat, floorMat, cooler: new THREE.Vector3(RING_A - 0.15, 0, -RING_B - 0.45) };
      // where the zone's walkway is closest to the hub: the way out
      zone.exitT = ringParam(-zpos.x, -zpos.z);
      zones.push(zone);

      ROLE_ORDER.forEach((roleId, i) => {
        const role = roles.find(r => r.id === roleId) || { color: '#888', short: roleId, name: roleId };
        const x = ((i % 3) - 1) * 3.1;
        const side = i < 3 ? -1 : 1;
        const desk = makeDesk();
        desk.group.position.set(x, FLOOR, side * 0.72);
        desk.group.rotation.y = side === -1 ? Math.PI : 0;
        group.add(desk.group);
        const facing = side === -1 ? 0 : Math.PI;
        const chair = makeChair();
        chair.position.set(x, FLOOR, side * 1.95);
        chair.rotation.y = facing;
        group.add(chair);

        const fig = makeFigure(role.color, pi * 6 + i);
        scene.add(fig.root);
        const a = {
          key: `${p.id}:${roleId}`, pid: p.id, role: roleId, zone, fig, screen: desk.screen,
          seat: { x, z: side * 1.95, facing, aisleT: ringParam(x, side * RING_B) },
          pos: new THREE.Vector3(zpos.x + x, 0, zpos.z + side * 1.95),
          heading: facing, sit: 1, sitGoal: 1, loc: 'seat', ringT: ringParam(x, side * RING_B),
          path: [], after: null, timer: rand(1, 14), phase: Math.random() * 10, walkPhase: 0,
          state: 'idle', focused: false, wave: 0,
        };
        const pick = { kind: 'agent', projectId: p.id, role: roleId };
        for (const g of [fig.root, desk.group, chair]) g.traverse(o => { o.userData.pick = pick; });
        pickables.push(...collect(fig.root), ...collect(desk.group), ...collect(chair));
        agents.set(a.key, a);

        const lab = document.createElement('div');
        lab.className = 'ol-agent';
        lab.style.setProperty('--rc', role.color);
        lab.addEventListener('click', () => onAgent && onAgent(p.id, roleId));
        labels.appendChild(lab);
        agentLabels.set(a.key, lab);
      });

      const zl = document.createElement('div');
      zl.className = 'ol-zone';
      zl.addEventListener('click', () => onZone && onZone(p.id));
      labels.appendChild(zl);
      zoneLabels.set(p.id, zl);
    });
    fit();
  }

  /* ---------------- walking about ---------------- */

  const W = (zone, lx, lz) => new THREE.Vector3(zone.pos.x + lx, 0, zone.pos.z + lz);

  /** Path from wherever the agent is to the zone walkway; returns the ring param it joins at. */
  function toRing(a, path) {
    const z = a.zone;
    if (a.loc === 'seat') {
      const [x, zz] = ringPoint(a.seat.aisleT);
      path.push(W(z, x, zz));
      return a.seat.aisleT;
    }
    if (a.loc === 'hub') {
      const [x, zz] = ringPoint(z.exitT);
      path.push(W(z, x, zz));
      return z.exitT;
    }
    const t = ringParam(a.pos.x - z.pos.x, a.pos.z - z.pos.z);
    const [x, zz] = ringPoint(t);
    path.push(W(z, x, zz));
    return t;
  }

  function plan(a, dest) {
    const z = a.zone;
    const path = [];
    const t0 = toRing(a, path);
    if (dest.kind === 'seat') {
      for (const [x, zz] of ringPath(t0, a.seat.aisleT)) path.push(W(z, x, zz));
      path.push(W(z, a.seat.x, a.seat.z));
    } else if (dest.kind === 'ring') {
      for (const [x, zz] of ringPath(t0, dest.t)) path.push(W(z, x, zz));
    } else if (dest.kind === 'cooler') {
      const t = ringParam(z.cooler.x, z.cooler.z);
      for (const [x, zz] of ringPath(t0, t)) path.push(W(z, x, zz));
      path.push(W(z, z.cooler.x - 0.55, z.cooler.z + 0.2));
    } else if (dest.kind === 'hub') {
      for (const [x, zz] of ringPath(t0, z.exitT)) path.push(W(z, x, zz));
      const ang = Math.atan2(z.pos.z, z.pos.x) + rand(-0.5, 0.5);
      path.push(new THREE.Vector3(Math.cos(ang) * 2.15, 0, Math.sin(ang) * 2.15));
    }
    a.path = path;
    a.dest = dest;
    a.sitGoal = 0;
  }

  function pickOuting(a) {
    const r = Math.random();
    if (r < 0.2) return { kind: 'hub' };
    if (r < 0.4) return { kind: 'cooler' };
    if (r < 0.65) {
      const mates = [...agents.values()].filter(m => m.zone === a.zone && m !== a);
      const mate = mates[Math.floor(Math.random() * mates.length)];
      return { kind: 'ring', t: mate.seat.aisleT + rand(-0.4, 0.4), visit: mate };
    }
    return { kind: 'ring', t: rand(0, RING_P) };
  }

  function floorY(p) {
    if (Math.hypot(p.x, p.z) < HUB_R) return 0.16;
    for (const z of zones) if (Math.abs(p.x - z.pos.x) < ZONE_W / 2 && Math.abs(p.z - z.pos.z) < ZONE_D / 2) return FLOOR;
    return 0;
  }

  function think(a, dt) {
    const wantDesk = a.state === 'working';
    if (a.focused) return;
    const walking = a.path.length > 0;
    if (wantDesk && a.loc !== 'seat' && (!walking || a.dest.kind !== 'seat')) { plan(a, { kind: 'seat' }); return; }
    if (walking) return;
    a.timer -= dt;
    if (a.timer > 0) return;
    if (a.loc === 'seat') {
      if (wantDesk || a.state === 'queued') { a.timer = rand(5, 10); return; }
      plan(a, pickOuting(a));
    } else {
      if (wantDesk || Math.random() < 0.45) plan(a, { kind: 'seat' });
      else plan(a, pickOuting(a));
    }
  }

  const tmp = new THREE.Vector3();
  function move(a, dt, t) {
    const f = a.fig;
    // stand up before walking off; sit down once at the seat
    a.sit += (a.sitGoal - a.sit) * Math.min(1, dt * 5);
    const standing = a.sit < 0.06;
    let speed = 0;
    if (a.path.length && standing && !a.focused) {
      const next = a.path[0];
      tmp.subVectors(next, a.pos).setY(0);
      const d = tmp.length();
      const step = WALK * dt;
      if (d <= step) {
        a.pos.copy(next);
        a.path.shift();
        if (!a.path.length) arrive(a);
      } else {
        a.pos.addScaledVector(tmp.normalize(), step);
        a.heading = angleLerp(a.heading, Math.atan2(tmp.x, tmp.z), Math.min(1, dt * 10));
        speed = 1;
      }
    }
    if (a.focused) {
      a.heading = angleLerp(a.heading, Math.PI / 4, Math.min(1, dt * 6)); // turn to the camera
    } else if (!speed && a.lookAt) {
      tmp.subVectors(a.lookAt, a.pos);
      a.heading = angleLerp(a.heading, Math.atan2(tmp.x, tmp.z), Math.min(1, dt * 4));
    } else if (!speed && a.loc === 'seat') {
      a.heading = angleLerp(a.heading, a.seat.facing, Math.min(1, dt * 6));
    }

    a.walkPhase += dt * 9 * speed;
    const swing = Math.sin(a.walkPhase) * 0.55 * speed;
    const s = a.sit;
    f.root.position.set(a.pos.x, floorY(a.pos) + SEAT_DROP * s + Math.abs(Math.sin(a.walkPhase)) * 0.04 * speed, a.pos.z);
    f.root.rotation.y = a.heading;
    f.legs[0].rotation.x = -Math.PI / 2 * s + swing * (1 - s);
    f.legs[1].rotation.x = -Math.PI / 2 * s - swing * (1 - s);

    const typing = a.state === 'working' && s > 0.9 && !a.focused;
    let armL = -0.08 - swing * 0.8;
    let armR = -0.08 + swing * 0.8;
    if (s > 0.5) { armL = -0.95; armR = -0.95; }
    if (typing) {
      armL = -1.05 + Math.sin(t * 16 + a.phase) * 0.12;
      armR = -1.05 + Math.sin(t * 16 + a.phase + 1.7) * 0.12;
    }
    f.arms[0].rotation.x = armL;
    f.arms[1].rotation.x = armR;
    a.wave += ((a.focused ? 1 : 0) - a.wave) * Math.min(1, dt * 6);
    f.arms[1].rotation.z = a.wave * (2.5 + Math.sin(t * 9) * 0.35);
    f.arms[0].rotation.z = 0;

    f.head.rotation.x = typing ? 0.12 + Math.sin(t * 2 + a.phase) * 0.04 : -0.05;
    f.head.rotation.y = a.focused || speed ? 0 : Math.sin(t * 0.5 + a.phase) * 0.3;
    if (f.ring.visible) {
      const k = 1 + Math.sin(t * 3 + a.phase) * 0.12;
      f.ring.scale.set(k, k, k);
      f.ring.rotation.z = t;
      f.ring.position.y = 2.5 + SEAT_DROP * 0;
    }
    if (f.flag.visible) {
      f.flag.position.y = 2.6 + Math.sin(t * 3 + a.phase) * 0.08;
      f.flag.rotation.y = t * 2;
    }
  }

  function arrive(a) {
    const d = a.dest || {};
    a.lookAt = null;
    if (d.kind === 'seat') {
      a.loc = 'seat';
      a.sitGoal = 1;
      a.timer = rand(10, 30);
    } else if (d.kind === 'hub') {
      a.loc = 'hub';
      a.lookAt = new THREE.Vector3(0, 0, 0);
      a.timer = rand(5, 10);
    } else if (d.kind === 'cooler') {
      a.loc = 'spot';
      a.lookAt = W(a.zone, a.zone.cooler.x, a.zone.cooler.z);
      a.timer = rand(4, 8);
    } else {
      a.loc = 'ring';
      if (d.visit) a.lookAt = d.visit.pos.clone();
      a.timer = rand(3, 7);
    }
  }

  /* ---------------- state from the app ---------------- */

  let hubBusy = false;
  function update(S, activity) {
    const bg = cssVar('--bg') || '#f6f7f9';
    const dark = new THREE.Color(bg).getHSL({}).l < 0.3;
    scene.background = new THREE.Color(bg);
    ground.material.color = mix(bg, dark ? '#000000' : '#d5dae3', dark ? 0.25 : 0.35);
    hubMat.color = mix(bg, dark ? '#ffffff' : '#c8ced9', dark ? 0.1 : 0.5);
    M.divider.color = mix(bg, dark ? '#ffffff' : '#94a3b8', dark ? 0.15 : 0.4);

    const key = S.projects.map(p => p.id).join('|');
    if (key !== zoneKey) { zoneKey = key; buildZones(S.projects, S.roles); }

    for (const z of zones) {
      const p = S.projects.find(x => x.id === z.id);
      const tasks = S.tasks.filter(t => t.projectId === z.id);
      const rep = S.reports.find(r => r.projectId === z.id && r.status === 'done');
      const hc = rep && { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[rep.health];
      z.rimMat.color = hc ? new THREE.Color(hc) : mix(bg, dark ? '#ffffff' : '#94a3b8', dark ? 0.18 : 0.45);
      z.floorMat.color = mix(bg, '#ffffff', dark ? 0.06 : 0.8);
      const live = tasks.filter(t => t.status === 'running' || t.status === 'queued').length;
      const zl = zoneLabels.get(z.id);
      const zHtml = `<span class="dot ${rep ? rep.health : ''}"></span><b>${esc(p.name)}</b>${live ? `<span class="count live">${live}</span>` : ''}`;
      if (zl.innerHTML !== zHtml) zl.innerHTML = zHtml;

      for (const roleId of ROLE_ORDER) {
        const a = agents.get(`${z.id}:${roleId}`);
        const mine = tasks.filter(t => t.role === roleId);
        const run = mine.find(t => t.status === 'running');
        const queued = mine.filter(t => t.status === 'queued').length;
        const review = mine.filter(t => t.mode === 'change' && t.status === 'done' && !t.cleaned && t.git && t.git.commits.length).length;
        const last = mine.find(t => t.status !== 'queued' && t.status !== 'running');
        const failed = last && last.status === 'failed';
        a.state = run ? 'working' : failed ? 'failed' : review ? 'review' : queued ? 'queued' : 'idle';
        a.screen.material = run && a.loc === 'seat' ? M.screenOn : M.screenOff;
        a.fig.ring.visible = !!run;
        a.fig.flag.visible = a.state === 'review' || a.state === 'failed';
        const fc = a.state === 'failed' ? '#ef4444' : '#f59e0b';
        a.fig.flag.material.color.set(fc);
        a.fig.flag.material.emissive.set(fc);

        const role = S.roles.find(r => r.id === roleId);
        const lab = agentLabels.get(a.key);
        let text;
        if (run) text = `<b>${esc(role.short)}</b> ${esc(activity[run.id] || run.title)}`;
        else if (a.state === 'failed') text = `<b>${esc(role.short)}</b> failed: ${esc(last.title)}`;
        else if (review) text = `<b>${esc(role.short)}</b> ${review} to review`;
        else if (queued) text = `<b>${esc(role.short)}</b> ${queued} queued`;
        else text = `<b>${esc(role.short)}</b> ${esc(role.name)}`;
        if (lab.innerHTML !== text) lab.innerHTML = text;
        lab.dataset.state = a.state;
        lab.title = run ? `${role.name}: ${run.title}` : `${role.name} — click to talk`;
      }
    }
    hubBusy = S.reports.some(r => r.status === 'running' || r.status === 'queued');
    const dr = S.settings.dailyReport;
    const next = S.nextDaily ? new Date(S.nextDaily).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'off';
    const hHtml = hubBusy ? '<b>Stand-up hub</b> writing stand-ups…' : `<b>Stand-up hub</b> next: ${dr.enabled ? next : 'off'}`;
    if (hubLabel.innerHTML !== hHtml) hubLabel.innerHTML = hHtml;
  }

  /* ---------------- camera ---------------- */

  function applyCamera() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const aspect = w / h;
    Object.assign(camera, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
    camera.position.copy(target).add(OFFSET);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function fit() {
    follow = null;
    zoomGoal = null;
    target.set(0, 0, 0);
    camera.zoom = 1;
    halfH = 20;
    applyCamera();
    const pts = [];
    for (const z of zones) for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 2.8]) {
      pts.push(new THREE.Vector3(z.pos.x + sx * ZONE_W / 2, y, z.pos.z + sz * ZONE_D / 2));
    }
    if (!pts.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const v = p.applyMatrix4(camera.matrixWorldInverse);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const aspect = (host.clientWidth || 1) / (host.clientHeight || 1);
    halfH = Math.max((maxY - minY) / 2, (maxX - minX) / 2 / aspect) * 1.12;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, (minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2);
    applyCamera();
  }

  function pan(dx, dy) {
    follow = null;
    zoomGoal = null;
    const per = (2 * halfH) / camera.zoom / (host.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, -dx * per).addScaledVector(up, dy * per);
    applyCamera();
  }

  function zoomBy(f) {
    zoomGoal = null;
    camera.zoom = Math.min(5, Math.max(0.5, camera.zoom * f));
    camera.updateProjectionMatrix();
  }

  /* ---------------- focus + pinned card ---------------- */

  let follow = null;     // agent the camera tracks
  let focused = null;    // agent turned towards you
  let card = null;       // { el, agent }

  function focus(pid, role, { zoom = 2.6 } = {}) {
    const a = agents.get(`${pid}:${role}`);
    if (!a) return false;
    if (focused && focused !== a) focused.focused = false;
    focused = a;
    a.focused = true;
    follow = a;
    zoomGoal = Math.max(camera.zoom, zoom);
    return true;
  }
  function release() {
    if (focused) { focused.focused = false; focused.timer = rand(2, 6); }
    focused = null;
    follow = null;
  }
  function attachCard(el, pid, role) {
    detachCard();
    const a = agents.get(`${pid}:${role}`);
    if (!a) return;
    el.classList.add('ol-card');
    labels.appendChild(el);
    card = { el, agent: a };
  }
  function detachCard() {
    if (card) card.el.remove();
    card = null;
  }

  /* ---------------- pointer ---------------- */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointers = new Map();
  let down = null;
  let hovered = null;
  let pinch = 0;

  function pickAt(x, y) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.pick : null;
  }
  function setHover(pick) {
    const key = pick ? `${pick.kind}:${pick.projectId || ''}:${pick.role || ''}` : '';
    if (key === (hovered && hovered.key)) return;
    if (hovered && hovered.agent) hovered.agent.fig.bodyMat.emissive.set('#000000');
    hovered = null;
    for (const d of agentLabels.values()) d.classList.remove('hover');
    for (const d of zoneLabels.values()) d.classList.remove('hover');
    renderer.domElement.style.cursor = pick ? 'pointer' : 'grab';
    if (!pick) return;
    hovered = { key };
    if (pick.kind === 'agent') {
      const a = agents.get(`${pick.projectId}:${pick.role}`);
      if (a) { a.fig.bodyMat.emissive.set('#333333'); hovered.agent = a; }
      const l = agentLabels.get(`${pick.projectId}:${pick.role}`);
      if (l) l.classList.add('hover');
    } else if (pick.kind === 'zone') {
      const l = zoneLabels.get(pick.projectId);
      if (l) l.classList.add('hover');
    }
  }

  const el = renderer.domElement;
  el.style.cursor = 'grab';
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY, moved: false };
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinch = Math.hypot(p.x - q.x, p.y - q.y);
    }
  });
  el.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) { setHover(pickAt(e.clientX, e.clientY)); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (pinch) zoomBy(d / pinch);
      pinch = d;
      if (down) down.moved = true;
      return;
    }
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
    if (down && down.moved) { el.style.cursor = 'grabbing'; pan(e.clientX - prev.x, e.clientY - prev.y); }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (down && !down.moved && e.type === 'pointerup') {
      const pick = pickAt(e.clientX, e.clientY);
      if (pick && pick.kind === 'agent') onAgent && onAgent(pick.projectId, pick.role);
      else if (pick && pick.kind === 'zone') onZone && onZone(pick.projectId);
      else if (pick && pick.kind === 'hub') onHub && onHub();
    }
    if (!pointers.size) { down = null; el.style.cursor = hovered ? 'pointer' : 'grab'; }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { if (!pointers.size) setHover(null); });
  el.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.pow(1.0015, -e.deltaY)); }, { passive: false });
  el.addEventListener('dblclick', () => fit());

  /* ---------------- frame loop ---------------- */

  const clock = new THREE.Clock();
  const v = new THREE.Vector3();
  let raf = 0;
  let running = false;

  function place(div, world, lift = 0) {
    v.copy(world).project(camera);
    const x = (v.x * 0.5 + 0.5) * host.clientWidth;
    const y = (-v.y * 0.5 + 0.5) * host.clientHeight - lift;
    div.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, clock.getDelta());
    const t = clock.elapsedTime;
    const still = reducedMotion();
    code.offset.y = (t * 0.12) % 1;
    core.rotation.y = t * (hubBusy ? 1.6 : 0.35);
    core.rotation.x = t * 0.2;
    shell.rotation.y = -t * 0.15;
    coreMat.emissiveIntensity = hubBusy ? 0.6 + Math.sin(t * 5) * 0.3 : 0.3;

    for (const a of agents.values()) {
      if (!still) think(a, dt);
      else if (a.state === 'working' && a.loc !== 'seat' && !a.path.length) plan(a, { kind: 'seat' });
      move(a, still ? 1 : dt, t);
      a.screen.material = a.state === 'working' && a.loc === 'seat' && !a.path.length ? M.screenOn : M.screenOff;
    }

    if (follow) {
      // keep the agent in the lower part of the view so the card above them fits
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      v.copy(follow.pos).setY(1.2).addScaledVector(up, (halfH / camera.zoom) * 0.4);
      target.lerp(v, Math.min(1, dt * 4));
      applyCamera();
    }
    if (zoomGoal) {
      camera.zoom += (zoomGoal - camera.zoom) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
      if (Math.abs(zoomGoal - camera.zoom) < 0.01) zoomGoal = null;
    }

    const showAll = camera.zoom > 1.35;
    for (const a of agents.values()) {
      const lab = agentLabels.get(a.key);
      const pinned = card && card.agent === a;
      const show = !pinned && (a.state !== 'idle' || showAll || lab.classList.contains('hover'));
      lab.style.display = show ? '' : 'none';
      if (show) place(lab, v.copy(a.fig.root.position).setY(a.fig.root.position.y + 2.85));
    }
    if (card) {
      v.copy(card.agent.fig.root.position).setY(card.agent.fig.root.position.y + 2.7).project(camera);
      const W0 = host.clientWidth, H0 = host.clientHeight, cw = card.el.offsetWidth, ch = card.el.offsetHeight;
      const x = Math.min(W0 - cw / 2 - 8, Math.max(cw / 2 + 8, (v.x * 0.5 + 0.5) * W0));
      const y = Math.min(H0 - 8, Math.max(ch + 8, (-v.y * 0.5 + 0.5) * H0 - 6));
      card.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const z of zones) place(zoneLabels.get(z.id), v.set(z.pos.x, 0.3, z.pos.z + ZONE_D / 2 + 0.9));
    place(hubLabel, v.set(0, 3.1, 0));
    renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(() => {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    applyCamera();
  });
  ro.observe(host);

  return {
    update, fit, zoomBy, focus, release, attachCard, detachCard,
    start() {
      if (running) return;
      running = true;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      applyCamera();
      clock.getDelta();
      frame();
    },
    stop() { running = false; cancelAnimationFrame(raf); },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
