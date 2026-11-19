// 임시 3D 소품을 코드로 만든다. (Blender 최종 모델이 준비되기 전까지 쓰는 "임시 에셋")
// - scripts/generate-assets.ts 가 이 함수들로 GLB(+KTX2 텍스처)를 만든다.
// - GLB 를 불러오지 못한 기기에서는 브라우저가 같은 함수로 단색 대체 모델을 만든다.
// 단위: 타일 한 칸 = 2.0. 원점 = 바닥 중심, +Y 위쪽, +Z 가 카메라(앞) 쪽.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MaterialKey } from './materials';
import { hash3, mulberry32, smoothstep } from './rng';

export interface PropPart {
  material: MaterialKey;
  geometry: THREE.BufferGeometry;
}

export type PropKey =
  | 'house'
  | 'banner'
  | 'pine'
  | 'oak'
  | 'bush'
  | 'logpile'
  | 'stump'
  | 'wheatrow'
  | 'stook'
  | 'sack'
  | 'boulder'
  | 'blocks'
  | 'tent'
  | 'crate'
  | 'barrel'
  | 'jug'
  | 'boat'
  | 'dock'
  | 'reeds';

type Vec3 = [number, number, number];

interface AddOptions {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3 | number;
  /** 꼭짓점 색 (곱해짐). 기본 흰색 */
  color?: THREE.ColorRepresentation;
  /** UV 방식: native = 기본 UV에 배율, box = 위치 기반 평면 투영 */
  uv?: 'native' | 'box';
  uvScale?: number;
}

const UV_UNIT = 0.5; // 텍스처 한 장이 덮는 길이

/** 재질별로 도형을 모아 합치는 도우미 */
class Kit {
  private readonly groups = new Map<MaterialKey, THREE.BufferGeometry[]>();

  add(material: MaterialKey, source: THREE.BufferGeometry, opts: AddOptions = {}): this {
    let g = source.index ? source.toNonIndexed() : source.clone();
    source.dispose();
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    const s = opts.scale ?? 1;
    const scale = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(opts.rotation ?? [0, 0, 0])));
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...(opts.position ?? [0, 0, 0])), quat, scale);

    if ((opts.uv ?? 'box') === 'box') {
      g.applyMatrix4(matrix);
      boxProjectUV(g, opts.uvScale ?? 1);
    } else {
      const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
      if (uv) {
        const k = opts.uvScale ?? 1;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
      } else {
        boxProjectUV(g, 1);
      }
      g.applyMatrix4(matrix);
    }
    const color = new THREE.Color(opts.color ?? '#ffffff');
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g = ensureUV(g);
    const list = this.groups.get(material) ?? [];
    list.push(g);
    this.groups.set(material, list);
    return this;
  }

  /** 아래쪽을 어둡게 해 미리 구운 앰비언트 오클루전처럼 보이게 한 뒤 재질별로 합친다. */
  build(aoHeight = 0.25, aoMin = 0.62): PropPart[] {
    const parts: PropPart[] = [];
    for (const [material, list] of this.groups) {
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`도형 합치기 실패: ${material}`);
      list.forEach((g) => g.dispose());
      const pos = merged.attributes.position;
      const col = merged.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        const k = aoMin + (1 - aoMin) * smoothstep(0, aoHeight, pos.getY(i));
        col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
      }
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      parts.push({ material, geometry: merged });
    }
    return parts;
  }
}

function ensureUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.attributes.uv) boxProjectUV(g, 1);
  return g;
}

/** 면 방향에 따라 XY/YZ/XZ 평면으로 UV 를 투영한다 (모든 소품의 텍스처 밀도를 맞춘다). */
function boxProjectUV(g: THREE.BufferGeometry, scale: number): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else if (nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = (u / UV_UNIT) * scale;
    uv[i * 2 + 1] = (v / UV_UNIT) * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

const box = (w: number, h: number, d: number, ws = 1, hs = 1, ds = 1) => new THREE.BoxGeometry(w, h, d, ws, hs, ds);
const cyl = (rt: number, rb: number, h: number, seg = 8, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

/** 두 점 사이에 원기둥(통나무, 막대)을 놓는 회전값 */
function alongX(): Vec3 {
  return [0, 0, Math.PI / 2];
}

// ───────────────────────── 거점 ─────────────────────────

export function buildHouse(): PropPart[] {
  const k = new Kit();
  const W = 0.6;
  const D = 0.46;
  const wallH = 0.34;
  const base = 0.07;
  const top = base + wallH;
  // 돌 기초와 회벽
  k.add('stone', box(W + 0.06, base, D + 0.06), { position: [0, base / 2, 0] });
  k.add('plaster', box(W, wallH, D), { position: [0, base + wallH / 2, 0] });
  // 박공 벽 (양옆 삼각형)
  const gableH = 0.22;
  const tri = new THREE.Shape();
  tri.moveTo(-D / 2, 0);
  tri.lineTo(D / 2, 0);
  tri.lineTo(0, gableH);
  tri.closePath();
  const gable = new THREE.ExtrudeGeometry(tri, { depth: W - 0.02, bevelEnabled: false });
  k.add('plaster', gable, { position: [-(W - 0.02) / 2, top, 0], rotation: [0, Math.PI / 2, 0] });
  // 지붕 (플레이어 색). 용마루는 좌우 방향이라 앞쪽 경사면이 카메라를 향한다.
  const slope = Math.atan2(gableH, D / 2);
  const slopeLen = Math.hypot(gableH, D / 2) + 0.1;
  const roofLen = W + 0.16;
  for (const side of [1, -1]) {
    k.add('roof', box(roofLen, 0.04, slopeLen, 1, 1, 1), {
      position: [0, top + gableH / 2 + 0.03, (side * (D / 2 + 0.05)) / 2],
      rotation: [side * slope, 0, 0],
    });
  }
  k.add('roof', box(roofLen + 0.02, 0.05, 0.06), { position: [0, top + gableH + 0.035, 0], color: '#d8d8d8' });
  // 목조 골조: 모서리 기둥, 가로보, 앞면 가새
  const post = 0.035;
  for (const x of [-W / 2, W / 2]) {
    for (const z of [-D / 2, D / 2]) {
      k.add('wood', box(post, wallH, post), { position: [x, base + wallH / 2, z], color: '#7a5532' });
    }
  }
  for (const z of [D / 2 + 0.004, -D / 2 - 0.004]) {
    k.add('wood', box(W + post, post, post * 0.6), { position: [0, top - post / 2, z], color: '#7a5532' });
    k.add('wood', box(W + post, post * 0.8, post * 0.6), { position: [0, base + wallH * 0.48, z], color: '#7a5532' });
  }
  for (const x of [-W / 2 - 0.004, W / 2 + 0.004]) {
    k.add('wood', box(post * 0.6, post, D), { position: [x, top - post / 2, 0], color: '#7a5532' });
    k.add('wood', box(post * 0.6, post * 0.8, D), { position: [x, base + wallH * 0.48, 0], color: '#7a5532' });
  }
  // 앞면 가새 두 개
  const braceLen = Math.hypot(W * 0.22, wallH * 0.46);
  const braceAngle = Math.atan2(wallH * 0.46, W * 0.22);
  k.add('wood', box(braceLen, post * 0.7, post * 0.5), {
    position: [W * 0.36, base + wallH * 0.73, D / 2 + 0.006],
    rotation: [0, 0, braceAngle],
    color: '#7a5532',
  });
  k.add('wood', box(braceLen, post * 0.7, post * 0.5), {
    position: [-W * 0.36, base + wallH * 0.73, D / 2 + 0.006],
    rotation: [0, 0, -braceAngle],
    color: '#7a5532',
  });
  // 문과 창
  k.add('wood', box(0.11, 0.19, 0.02), { position: [-0.1, base + 0.095, D / 2 + 0.008], color: '#5a3b20' });
  k.add('dark', box(0.085, 0.075, 0.012), { position: [0.13, base + 0.21, D / 2 + 0.007] });
  k.add('wood', box(0.03, 0.08, 0.016), { position: [0.075, base + 0.21, D / 2 + 0.009], color: '#6b4a2a' });
  k.add('wood', box(0.03, 0.08, 0.016), { position: [0.185, base + 0.21, D / 2 + 0.009], color: '#6b4a2a' });
  // 굴뚝
  k.add('stone', box(0.08, 0.2, 0.08), { position: [0.16, top + 0.12, -0.08] });
  return k.build(0.18, 0.7);
}

export function buildBanner(): PropPart[] {
  const k = new Kit();
  const h = 0.92;
  k.add('wood', cyl(0.014, 0.018, h, 6), { position: [0, h / 2, 0], uv: 'native', color: '#8a6238' });
  k.add('metal', new THREE.SphereGeometry(0.026, 8, 6), { position: [0, h + 0.015, 0], color: '#d6b25a' });
  // 바람에 휘날리는 깃발 (얇은 판을 물결 모양으로 휜다)
  const flag = box(0.32, 0.2, 0.012, 10, 2, 1);
  const pos = flag.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + 0.16;
    pos.setZ(i, pos.getZ(i) + Math.sin(x * 14) * 0.022 * (x / 0.32));
    pos.setY(i, pos.getY(i) - x * 0.06);
  }
  flag.computeVertexNormals();
  k.add('banner', flag, { position: [0.17, h - 0.13, 0], uv: 'native' });
  // 기를 매단 가로대
  k.add('wood', cyl(0.008, 0.008, 0.34, 5), { position: [0.17, h - 0.025, 0], rotation: alongX(), color: '#6b4a2a' });
  return k.build(0.3, 0.75);
}

// ───────────────────────── 목재 ─────────────────────────

export function buildPine(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  k.add('bark', cyl(0.03, 0.048, 0.3, 7), { position: [0, 0.15, 0], uv: 'native', uvScale: 0.6 });
  const tiers = [
    { r: 0.3, h: 0.42, y: 0.42 },
    { r: 0.235, h: 0.37, y: 0.62 },
    { r: 0.16, h: 0.32, y: 0.8 },
  ];
  for (const t of tiers) {
    const tint = new THREE.Color('#ffffff').multiplyScalar(0.88 + rand() * 0.2);
    k.add('foliage', new THREE.ConeGeometry(t.r * (0.94 + rand() * 0.12), t.h, 8, 1), {
      position: [(rand() - 0.5) * 0.02, t.y, (rand() - 0.5) * 0.02],
      rotation: [0, rand() * Math.PI, 0],
      color: tint,
      uv: 'native',
    });
  }
  return k.build(0.55, 0.55);
}

export function buildOak(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  k.add('bark', cyl(0.04, 0.06, 0.42, 7), { position: [0, 0.21, 0], uv: 'native', uvScale: 0.6 });
  const blobs = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rand();
    const r = 0.22 + rand() * 0.1;
    k.add('leaf', lumpy(new THREE.IcosahedronGeometry(r, 1), seed * 13 + i, 0.18), {
      position: [Math.cos(a) * 0.13, 0.55 + rand() * 0.12, Math.sin(a) * 0.13],
      color: new THREE.Color('#ffffff').multiplyScalar(0.85 + rand() * 0.25),
    });
  }
  return k.build(0.6, 0.55);
}

export function buildBush(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  for (let i = 0; i < 3; i++) {
    k.add('leaf', lumpy(new THREE.IcosahedronGeometry(0.09 + rand() * 0.05, 1), seed * 7 + i, 0.2), {
      position: [(rand() - 0.5) * 0.16, 0.07, (rand() - 0.5) * 0.12],
      color: new THREE.Color('#ffffff').multiplyScalar(0.8 + rand() * 0.25),
    });
  }
  return k.build(0.15, 0.6);
}

export function buildLogPile(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const r = 0.052;
  const rows = [4, 3, 2];
  rows.forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      const z = (i - (count - 1) / 2) * r * 2.05;
      const y = r + row * r * 1.75;
      const len = 0.5 + (rand() - 0.5) * 0.08;
      const shift = (rand() - 0.5) * 0.05;
      k.add('bark', cyl(r, r, len, 9, true), {
        position: [shift, y, z],
        rotation: [rand() * 3, 0, Math.PI / 2],
        uv: 'native',
        uvScale: 0.7,
        color: new THREE.Color('#ffffff').multiplyScalar(0.9 + rand() * 0.15),
      });
      for (const side of [1, -1]) {
        k.add('endgrain', new THREE.CircleGeometry(r * 0.98, 9), {
          position: [shift + (side * len) / 2, y, z],
          rotation: [0, (side * Math.PI) / 2, 0],
          color: new THREE.Color('#ffffff').multiplyScalar(0.92 + rand() * 0.1),
        });
      }
    }
  });
  // 쌓은 통나무를 받치는 말뚝
  for (const z of [-0.24, 0.24]) {
    k.add('wood', box(0.025, 0.3, 0.025), { position: [0.18, 0.15, z], color: '#6b4a2a' });
    k.add('wood', box(0.025, 0.3, 0.025), { position: [-0.18, 0.15, z], color: '#6b4a2a' });
  }
  return k.build(0.16, 0.6);
}

export function buildStump(): PropPart[] {
  const k = new Kit();
  k.add('bark', cyl(0.07, 0.085, 0.09, 9, true), { position: [0, 0.045, 0], uv: 'native', uvScale: 0.6 });
  k.add('endgrain', new THREE.CircleGeometry(0.07, 9), { position: [0, 0.09, 0], rotation: [-Math.PI / 2, 0, 0] });
  // 그루터기에 꽂힌 도끼
  k.add('wood', box(0.018, 0.018, 0.2), { position: [0.02, 0.15, 0.06], rotation: [0.9, 0, 0], color: '#8a6238' });
  k.add('metal', box(0.012, 0.06, 0.05), { position: [0.02, 0.1, -0.005], rotation: [0.9, 0, 0] });
  return k.build(0.08, 0.7);
}

// ───────────────────────── 곡물 ─────────────────────────

export function buildWheatRow(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const len = 1.6;
  const tri = new THREE.Shape();
  tri.moveTo(-0.07, 0);
  tri.lineTo(0.07, 0);
  tri.lineTo(0.0, 0.17);
  tri.closePath();
  const ridge = new THREE.ExtrudeGeometry(tri, { depth: len, steps: 16, bevelEnabled: false });
  const pos = ridge.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.05) {
      const n = hash3(pos.getX(i) * 3, pos.getZ(i) * 7, seed);
      pos.setY(i, y * (0.8 + n * 0.35));
      pos.setX(i, pos.getX(i) + (hash3(pos.getZ(i) * 5, seed, 1) - 0.5) * 0.03);
    }
  }
  ridge.computeVertexNormals();
  k.add('wheat', ridge, {
    position: [-len / 2, 0, 0],
    rotation: [0, Math.PI / 2, 0],
    color: new THREE.Color('#ffffff').multiplyScalar(0.9 + rand() * 0.15),
  });
  return k.build(0.17, 0.55);
}

export function buildStook(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  k.add('wheat', new THREE.ConeGeometry(0.1, 0.28, 8, 1, true), { position: [0, 0.14, 0], rotation: [Math.PI, rand(), 0], uv: 'native' });
  k.add('wheat', new THREE.ConeGeometry(0.07, 0.12, 8), { position: [0, 0.33, 0], rotation: [0, rand(), 0], uv: 'native', color: '#fff2c8' });
  k.add('cloth', new THREE.TorusGeometry(0.045, 0.012, 5, 10), { position: [0, 0.24, 0], rotation: [Math.PI / 2, 0, 0], color: '#a8875a' });
  return k.build(0.2, 0.6);
}

export function buildSack(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const body = new THREE.SphereGeometry(0.1, 10, 8);
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i);
    if (y < -0.03) y = -0.03 - (-0.03 - y) * 0.35; // 바닥을 눌러 평평하게
    pos.setY(i, y);
  }
  body.computeVertexNormals();
  k.add('cloth', body, { position: [0, 0.07, 0], scale: [1, 1.25, 0.9], rotation: [0, rand() * 3, 0], uv: 'native', uvScale: 2 });
  k.add('cloth', new THREE.ConeGeometry(0.045, 0.07, 8), { position: [0, 0.22, 0], rotation: [Math.PI, 0, 0], uv: 'native' });
  k.add('dark', cyl(0.03, 0.03, 0.015, 8), { position: [0, 0.19, 0], color: '#6b5333' });
  return k.build(0.18, 0.65);
}

// ───────────────────────── 석재 ─────────────────────────

/** 정이십면체를 울퉁불퉁하게 만들고 면마다 각지게(평면 음영) 둔다. */
function lumpy(g: THREE.BufferGeometry, seed: number, amount: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = ng.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = hash3(x * 9.1 + seed, y * 7.3, z * 8.7);
    const s = 1 - amount / 2 + n * amount;
    pos.setXYZ(i, x * s, y * s, z * s);
  }
  ng.computeVertexNormals();
  return ng;
}

export function buildBoulder(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const rock = lumpy(new THREE.IcosahedronGeometry(0.2, 1), seed, 0.42);
  const pos = rock.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, y < 0 ? y * 0.35 : y * 0.85);
  }
  rock.computeVertexNormals();
  k.add('stone', rock, {
    position: [0, 0.05, 0],
    rotation: [0, rand() * Math.PI * 2, 0],
    scale: [1 + rand() * 0.3, 0.9 + rand() * 0.3, 1],
    color: new THREE.Color('#ffffff').multiplyScalar(0.85 + rand() * 0.2),
  });
  return k.build(0.2, 0.6);
}

export function buildBlocks(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const bw = 0.19;
  const bh = 0.11;
  const bd = 0.14;
  const layers: [number, number][] = [
    [3, 0],
    [2, 1],
  ];
  for (const [count, layer] of layers) {
    for (let i = 0; i < count; i++) {
      k.add('stone', box(bw, bh, bd), {
        position: [(i - (count - 1) / 2) * (bw + 0.012), bh / 2 + layer * (bh + 0.004), (rand() - 0.5) * 0.02],
        rotation: [0, (rand() - 0.5) * 0.12, 0],
        color: new THREE.Color('#f2efe8').multiplyScalar(0.88 + rand() * 0.12),
      });
    }
  }
  // 정과 망치 받침용 나무 판
  k.add('wood', box(0.5, 0.025, 0.2), { position: [0, 0.0125, 0.18], rotation: [0, 0.08, 0], color: '#8a6238' });
  return k.build(0.22, 0.65);
}

// ───────────────────────── 시장 ─────────────────────────

export function buildTent(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const W = 0.66;
  const D = 0.5;
  const H = 0.42;
  const palettes = [
    ['#b7412e', '#f1e6cc'],
    ['#2f6a8a', '#efe3c4'],
    ['#4f7f3a', '#f1e6cc'],
  ];
  const [c1, c2] = palettes[Math.floor(rand() * palettes.length)];
  for (const x of [-W / 2, W / 2]) {
    for (const z of [-D / 2, D / 2]) {
      k.add('wood', box(0.03, H + (z < 0 ? 0.08 : 0), 0.03), { position: [x, (H + (z < 0 ? 0.08 : 0)) / 2, z], color: '#7a5532' });
    }
  }
  // 줄무늬 차양 (앞으로 기울어진 지붕)
  const stripes = 7;
  const sw = (W + 0.1) / stripes;
  const pitch = 0.32;
  const canopyDepth = D + 0.16;
  for (let i = 0; i < stripes; i++) {
    k.add('stripe', box(sw, 0.018, canopyDepth), {
      position: [-(W + 0.1) / 2 + sw * (i + 0.5), H + 0.06, 0.02],
      rotation: [pitch, 0, 0],
      color: i % 2 === 0 ? c1 : c2,
      uv: 'box',
    });
    // 차양 끝의 늘어진 천
    k.add('stripe', box(sw, 0.07, 0.01), {
      position: [-(W + 0.1) / 2 + sw * (i + 0.5), H - 0.03, canopyDepth / 2 - 0.02],
      color: i % 2 === 0 ? c1 : c2,
    });
  }
  // 뒤 천막
  k.add('cloth', box(W, H, 0.015), { position: [0, H / 2, -D / 2], color: '#e9dcbc' });
  // 판매대와 상품
  k.add('wood', box(W * 0.9, 0.05, 0.16), { position: [0, 0.2, D / 2 - 0.08], color: '#8a6238' });
  k.add('wood', box(W * 0.9, 0.18, 0.02), { position: [0, 0.09, D / 2 - 0.01], color: '#6b4a2a' });
  for (let i = 0; i < 3; i++) {
    const x = -0.2 + i * 0.2;
    if (i === 1) {
      addJug(k, [x, 0.225, D / 2 - 0.08], 0.75);
    } else {
      k.add('wheat', new THREE.SphereGeometry(0.035, 8, 6), { position: [x, 0.25, D / 2 - 0.08], scale: [1.3, 0.6, 1] });
      k.add('cloth', cyl(0.06, 0.05, 0.03, 10), { position: [x, 0.24, D / 2 - 0.08], color: '#b89a68' });
    }
  }
  return k.build(0.3, 0.7);
}

export function buildCrate(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const s = 0.16;
  k.add('wood', box(s, s, s), { position: [0, s / 2, 0], color: '#c7a070', rotation: [0, (rand() - 0.5) * 0.3, 0] });
  // 모서리 덧댄 판자
  const t = 0.022;
  for (const y of [t / 2, s - t / 2]) {
    for (const z of [-s / 2, s / 2]) k.add('wood', box(s + 0.008, t, t), { position: [0, y, z], color: '#7d5733' });
    for (const x of [-s / 2, s / 2]) k.add('wood', box(t, t, s + 0.008), { position: [x, y, 0], color: '#7d5733' });
  }
  return k.build(0.12, 0.7);
}

function addJug(k: Kit, at: Vec3, scale = 1): void {
  // The Met 소장 14세기 독일 석기의 형태: 넓은 몸통, 좁은 목, 벌어진 입구, 띠 손잡이, 단단한 굽.
  const pts = [
    [0.0, 0.0],
    [0.034, 0.0],
    [0.038, 0.008],
    [0.05, 0.03],
    [0.058, 0.06],
    [0.052, 0.09],
    [0.032, 0.115],
    [0.02, 0.13],
    [0.022, 0.15],
    [0.03, 0.165],
  ].map(([x, y]) => new THREE.Vector2(x * scale, y * scale));
  k.add('clay', new THREE.LatheGeometry(pts, 12), { position: at, uv: 'native', color: '#efe4d2' });
  k.add('clay', new THREE.TorusGeometry(0.035 * scale, 0.008 * scale, 5, 10, Math.PI * 1.1), {
    position: [at[0] + 0.035 * scale, at[1] + 0.1 * scale, at[2]],
    rotation: [0, 0, -Math.PI / 2],
    color: '#d8c9b0',
  });
}

export function buildJug(): PropPart[] {
  const k = new Kit();
  addJug(k, [0, 0, 0], 1);
  return k.build(0.08, 0.75);
}

export function buildBarrel(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const h = 0.22;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2(0.075 + Math.sin(t * Math.PI) * 0.018, t * h));
  }
  k.add('wood', new THREE.LatheGeometry(pts, 14), { uv: 'native', uvScale: 1, rotation: [0, rand() * 3, 0], color: '#b9895a' });
  k.add('endgrain', new THREE.CircleGeometry(0.075, 14), { position: [0, h, 0], rotation: [-Math.PI / 2, 0, 0], color: '#c9a273' });
  for (const y of [0.035, h - 0.035]) {
    k.add('metal', cyl(0.083, 0.083, 0.014, 14, true), { position: [0, y, 0] });
  }
  k.add('metal', cyl(0.094, 0.094, 0.014, 14, true), { position: [0, h / 2, 0] });
  return k.build(0.15, 0.7);
}

// ───────────────────────── 강가 ─────────────────────────

export function buildBoat(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const hull = box(1.0, 0.13, 0.32, 12, 1, 2);
  const pos = hull.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = Math.abs(x) / 0.5;
    pos.setZ(i, pos.getZ(i) * (1 - t * t * 0.85));
    if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) + t * t * 0.06);
    else pos.setZ(i, pos.getZ(i) * 0.7);
  }
  hull.computeVertexNormals();
  k.add('wood', hull, { position: [0, 0.06, 0], color: '#8f6236' });
  k.add('wood', box(0.7, 0.012, 0.22), { position: [0, 0.12, 0], color: '#b58a5a' });
  // 짐: 통과 상자
  k.add('wood', box(0.14, 0.12, 0.14), { position: [-0.18, 0.19, 0], rotation: [0, 0.3, 0], color: '#c7a070' });
  k.add('cloth', new THREE.SphereGeometry(0.075, 8, 6), { position: [0.05, 0.17, 0.02], scale: [1, 0.8, 0.9] });
  k.add('wood', cyl(0.012, 0.012, 0.55 + rand() * 0.1, 5), { position: [0.22, 0.4, 0], color: '#7a5532' });
  return k.build(0.12, 0.7);
}

export function buildDock(): PropPart[] {
  const k = new Kit();
  const planks = 7;
  for (let i = 0; i < planks; i++) {
    k.add('wood', box(0.13, 0.03, 0.9), {
      position: [(i - (planks - 1) / 2) * 0.14, 0.12, 0],
      color: new THREE.Color('#c9a074').multiplyScalar(0.85 + ((i * 37) % 10) / 50),
    });
  }
  for (const x of [-0.44, 0.44]) {
    for (const z of [-0.38, 0.0, 0.38]) {
      k.add('wood', cyl(0.035, 0.04, 0.42, 7), { position: [x, -0.08, z], uv: 'native', color: '#6b4a2a' });
    }
  }
  return k.build(0.12, 0.8);
}

export function buildReeds(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  for (let i = 0; i < 9; i++) {
    const h = 0.16 + rand() * 0.14;
    k.add('foliage', new THREE.ConeGeometry(0.012, h, 4), {
      position: [(rand() - 0.5) * 0.22, h / 2, (rand() - 0.5) * 0.18],
      rotation: [(rand() - 0.5) * 0.4, 0, (rand() - 0.5) * 0.4],
      color: rand() > 0.5 ? '#c9d48a' : '#9fb86a',
      uv: 'native',
    });
  }
  return k.build(0.2, 0.6);
}

/** 소품 종류별로 만들 수 있는 변형 개수 (시드) */
export const PROP_VARIANTS: Record<PropKey, number> = {
  house: 1,
  banner: 1,
  pine: 3,
  oak: 3,
  bush: 2,
  logpile: 2,
  stump: 1,
  wheatrow: 3,
  stook: 2,
  sack: 2,
  boulder: 4,
  blocks: 1,
  tent: 2,
  crate: 2,
  barrel: 1,
  jug: 1,
  boat: 1,
  dock: 1,
  reeds: 2,
};

export function buildProp(key: PropKey, variant = 0): PropPart[] {
  const seed = variant * 101 + 7;
  switch (key) {
    case 'house':
      return buildHouse();
    case 'banner':
      return buildBanner();
    case 'pine':
      return buildPine(seed);
    case 'oak':
      return buildOak(seed);
    case 'bush':
      return buildBush(seed);
    case 'logpile':
      return buildLogPile(seed);
    case 'stump':
      return buildStump();
    case 'wheatrow':
      return buildWheatRow(seed);
    case 'stook':
      return buildStook(seed);
    case 'sack':
      return buildSack(seed);
    case 'boulder':
      return buildBoulder(seed);
    case 'blocks':
      return buildBlocks(seed);
    case 'tent':
      return buildTent(seed);
    case 'crate':
      return buildCrate(seed);
    case 'barrel':
      return buildBarrel(seed);
    case 'jug':
      return buildJug();
    case 'boat':
      return buildBoat(seed);
    case 'dock':
      return buildDock();
    case 'reeds':
      return buildReeds(seed);
  }
}

/** GLB 파일 이름: house.glb, pine_1.glb … */
export function propAssetName(key: PropKey, variant: number): string {
  return PROP_VARIANTS[key] > 1 ? `${key}_${variant}` : key;
}

export const PROP_KEYS = Object.keys(PROP_VARIANTS) as PropKey[];
