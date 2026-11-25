// 임시 3D 소품을 코드로 만든다. (Blender 최종 모델이 준비되기 전까지 쓰는 "임시 에셋")
// - scripts/generate-assets.ts 가 이 함수들로 GLB(+KTX2 텍스처)를 만든다.
// - GLB 를 불러오지 못한 기기에서는 브라우저가 같은 함수로 단색 대체 모델을 만든다.
// 단위: 타일 한 칸 = 2.0. 원점 = 바닥 중심, +Y 위쪽, +Z 가 카메라(앞) 쪽.
// 디테일은 텍스처를 늘리지 않고 실루엣(가지 끝, 지붕널 단, 판자 틈)과 꼭짓점 색(햇빛 받는 윗면은 밝게,
// 아랫면과 틈은 어둡게)으로 낸다.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
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
  | 'tuft'
  | 'logpile'
  | 'stump'
  | 'wheatrow'
  | 'stook'
  | 'sack'
  | 'boulder'
  | 'pebbles'
  | 'blocks'
  | 'tent'
  | 'crate'
  | 'barrel'
  | 'jug'
  | 'well'
  | 'boat'
  | 'dock'
  | 'reeds'
  | 'sheep'
  | 'fence'
  | 'trough'
  | 'kiln'
  | 'bricks'
  | 'claymound'
  | 'road'
  | 'city'
  | 'statue'
  | 'dais'
  | 'chain'
  | 'padlock'
  | 'pier'
  | 'brickrows'
  | 'roadjoint'
  | 'goods'
  | 'trader'
  | 'ship'
  | 'soldier'
  | 'soldierarm'
  | 'shore';

type Vec3 = [number, number, number];
/** 밝기 배율. 숫자 하나는 밝기만 바꾸고, 세 값은 색조까지 바꾼다 (이끼 낀 돌처럼). */
type Shade = number | Vec3;

interface AddOptions {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3 | number;
  /** 꼭짓점 색 (곱해짐). 기본 흰색 */
  color?: THREE.ColorRepresentation;
  /** UV 방식: native = 기본 UV에 배율, box = 위치 기반 평면 투영 */
  uv?: 'native' | 'box';
  uvScale?: number;
  /** 면마다 평평한 음영 (각진 돌, 낟알) */
  flat?: boolean;
  /** 꼭짓점마다 곱할 밝기. 소품 좌표의 위치와 법선을 받는다 (위는 밝고 아래는 어두운 그러데이션 등). */
  shade?: (p: THREE.Vector3, n: THREE.Vector3) => Shade;
  /** 삼각형마다 곱할 밝기. 무게중심과 면 법선을 받는다 (통 널빤지, 돌 줄눈처럼 면 단위 무늬). */
  faceShade?: (c: THREE.Vector3, n: THREE.Vector3) => Shade;
}

const UV_UNIT = 0.5; // 텍스처 한 장이 덮는 길이

const tmpP = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

function multiplyColor(colors: Float32Array, i: number, s: Shade): void {
  if (typeof s === 'number') {
    colors[i * 3] *= s;
    colors[i * 3 + 1] *= s;
    colors[i * 3 + 2] *= s;
  } else {
    colors[i * 3] *= s[0];
    colors[i * 3 + 1] *= s[1];
    colors[i * 3 + 2] *= s[2];
  }
}

function applyShading(g: THREE.BufferGeometry, colors: Float32Array, opts: AddOptions): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  if (opts.shade) {
    for (let i = 0; i < pos.count; i++) {
      multiplyColor(colors, i, opts.shade(tmpP.fromBufferAttribute(pos, i), tmpN.fromBufferAttribute(nor, i)));
    }
  }
  if (opts.faceShade) {
    // 도형은 이미 꼭짓점을 나눠 둔 상태(삼각형마다 꼭짓점 3개)다.
    for (let i = 0; i + 2 < pos.count; i += 3) {
      tmpA.fromBufferAttribute(pos, i);
      tmpB.fromBufferAttribute(pos, i + 1);
      tmpC.fromBufferAttribute(pos, i + 2);
      tmpP.copy(tmpA).add(tmpB).add(tmpC).divideScalar(3);
      tmpN.crossVectors(tmpB.sub(tmpA), tmpC.sub(tmpA)).normalize();
      const s = opts.faceShade(tmpP, tmpN);
      multiplyColor(colors, i, s);
      multiplyColor(colors, i + 1, s);
      multiplyColor(colors, i + 2, s);
    }
  }
}

/** 재질별로 도형을 모아 합치는 도우미 */
class Kit {
  private readonly groups = new Map<MaterialKey, THREE.BufferGeometry[]>();

  add(material: MaterialKey, source: THREE.BufferGeometry, opts: AddOptions = {}): this {
    let g = source.index ? source.toNonIndexed() : source.clone();
    source.dispose();
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    }
    // 꼭짓점을 나눈 뒤라 법선을 다시 계산하면 면마다 평평한 음영이 된다.
    if (opts.flat || !g.attributes.normal) g.computeVertexNormals();
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
    applyShading(g, colors, opts);
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

/** 도형을 받아 쌓는 쪽: 소품 전체(Kit)나 그 안의 한 자리(Frame) */
interface Adder {
  add(material: MaterialKey, source: THREE.BufferGeometry, opts?: AddOptions): unknown;
}

/**
 * 소품 안의 한 자리에 y축으로 돌려 세운 좌표계. 도시 안의 집 여러 채처럼 같은 짜임을 자리·방향만 달리해 놓을 때 쓴다.
 * 넘긴 위치·회전·크기는 이 자리 기준이고, 도형을 소품 좌표로 옮긴 뒤 Kit 에 넘기므로 음영 함수는 소품 좌표를 받는다.
 */
class Frame implements Adder {
  private readonly matrix: THREE.Matrix4;

  constructor(
    private readonly kit: Kit,
    at: Vec3,
    yaw = 0,
  ) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.matrix = new THREE.Matrix4().compose(new THREE.Vector3(...at), q, new THREE.Vector3(1, 1, 1));
  }

  add(material: MaterialKey, source: THREE.BufferGeometry, opts: AddOptions = {}): this {
    const s = opts.scale ?? 1;
    const scale = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(opts.rotation ?? [0, 0, 0])));
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...(opts.position ?? [0, 0, 0])), quat, scale);
    source.applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.matrix, local));
    this.kit.add(material, source, { ...opts, position: undefined, rotation: undefined, scale: undefined });
    return this;
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

/** 원기둥(통나무, 막대)을 가로로 눕히는 회전값 */
function alongX(): Vec3 {
  return [0, 0, Math.PI / 2];
}

/** +Y 방향을 주어진 방향으로 돌리는 회전값 (기울어진 줄기·가지·자루) */
function aim(x: number, y: number, z: number): Vec3 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, y, z).normalize());
  const e = new THREE.Euler().setFromQuaternion(q);
  return [e.x, e.y, e.z];
}

/** 위치로 정해지는 부드러운 잡음 (0~1). 같은 위치는 같은 값을 받아 도형에 틈이 생기지 않는다. */
function wobble(x: number, y: number, z: number, seed: number): number {
  const s =
    Math.sin(x * 5.3 + seed * 1.7) +
    Math.sin(y * 6.1 - seed * 2.3) +
    Math.sin(z * 4.7 + seed * 0.9) +
    Math.sin((x + z) * 3.1 + y * 2.2 + seed);
  return s / 8 + 0.5;
}

/** 꼭짓점을 함수로 옮긴 뒤 법선을 다시 계산한다. */
function warp<T extends THREE.BufferGeometry>(g: T, fn: (v: THREE.Vector3) => void): T {
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** 위를 향한 면은 밝게, 아래를 향한 면은 어둡게 (하늘빛을 받는 느낌) */
function skyShade(n: THREE.Vector3, lo = 0.62, hi = 1.08): number {
  return lo + (hi - lo) * smoothstep(-0.6, 0.85, n.y);
}

/** 매끈하게 칠하는 울퉁불퉁한 덩어리 (나뭇잎 뭉치, 양배추). 겹친 꼭짓점을 합쳐 부풀려도 틈이 없다. */
function blob(r: number, detail: number, seed: number, amount: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(r, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  ico.dispose();
  return warp(g, (v) => {
    const n = 0.55 * wobble(v.x / r, v.y / r, v.z / r, seed) + 0.45 * hash3(v.x * 9.1 + seed, v.y * 7.3, v.z * 8.7);
    v.multiplyScalar(1 - amount / 2 + n * amount);
  });
}

/** 각진 돌: 정이십면체를 큰 굴곡과 잔 요철 두 겹으로 울퉁불퉁하게 만든다 (면마다 평평하게 칠할 것). */
function rock(r: number, detail: number, seed: number, amount: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 0.55 * wobble((x / r) * 1.4, (y / r) * 1.4, (z / r) * 1.4, seed) + 0.45 * hash3(x * 9.1 + seed, y * 7.3, z * 8.7);
    const s = 1 - amount / 2 + n * amount;
    pos.setXYZ(i, x * s, y * s, z * s);
  }
  g.computeVertexNormals();
  return g;
}

/** 통나무 단면: 가운데는 밝은 심재, 바깥은 껍질 쪽으로 갈수록 어두운 나이테 */
function addLogEnd(k: Kit, r: number, at: Vec3, rotation: Vec3, brightness = 1): void {
  const center = new THREE.Vector3(...at);
  k.add('endgrain', new THREE.RingGeometry(0, r, 10, 2), {
    position: at,
    rotation,
    shade: (p) => {
      const d = p.distanceTo(center) / r;
      return brightness * (d < 0.25 ? 1.12 : d < 0.75 ? 0.96 : 0.7);
    },
  });
}

// ───────────────────────── 마을(집) ─────────────────────────

const TIMBER = '#7a5532';

/** 지붕널을 단마다 겹쳐 덮은 경사면 한 쪽. 단 아래 끝이 살짝 들려 계단처럼 보인다. */
function addShingles(
  k: Adder,
  material: MaterialKey,
  apex: Vec3,
  side: 1 | -1,
  slope: number,
  slopeLen: number,
  length: number,
  courses: number,
  seed: number,
  baseColor = '#ffffff',
): void {
  const rand = mulberry32(seed);
  const dir = new THREE.Vector3(0, -Math.sin(slope), side * Math.cos(slope));
  const out = new THREE.Vector3(0, Math.cos(slope), side * Math.sin(slope));
  const cd = slopeLen / courses;
  for (let i = 0; i < courses; i++) {
    const c = new THREE.Vector3(...apex).addScaledVector(dir, (i + 0.5) * cd).addScaledVector(out, 0.006);
    k.add(material, box(length, 0.026, cd + 0.03), {
      position: [c.x, c.y, c.z],
      // 경사보다 조금 완만하게 눕혀 아래 끝이 위 단 밖으로 나오게 한다.
      // 단마다 밝기를 번갈아 달리해 그림에서 지붕널 줄이 먹선으로 드러나게 한다.
      rotation: [side * (slope - 0.15), 0, 0],
      color: new THREE.Color(baseColor).multiplyScalar((i % 2 ? 0.8 : 0.98) + rand() * 0.06),
    });
  }
}

/** 나무통. 널빤지마다 밝기가 달라 세로 줄이 보이고, 쇠테 네 개를 두른다. */
function addBarrel(k: Kit, at: Vec3, scale = 1, seed = 1): void {
  const h = 0.22 * scale;
  const r = 0.075 * scale;
  const bulge = 0.018 * scale;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2(r + Math.sin(t * Math.PI) * bulge, t * h));
  }
  const staves = 14;
  k.add('wood', new THREE.LatheGeometry(pts, staves), {
    position: at,
    uv: 'native',
    color: '#b9895a',
    faceShade: (c) => {
      const a = (Math.atan2(c.x - at[0], c.z - at[2]) + Math.PI * 2) % (Math.PI * 2);
      const i = Math.floor(a / ((Math.PI * 2) / staves));
      return (i % 2 ? 0.9 : 1.03) * (0.94 + 0.1 * hash3(i, seed, 3));
    },
  });
  addLogEnd(k, r, [at[0], at[1] + h, at[2]], [-Math.PI / 2, 0, 0], 0.95);
  k.add('dark', cyl(0.011 * scale, 0.011 * scale, 0.006, 8), { position: [at[0] + 0.03 * scale, at[1] + h + 0.002, at[2]] });
  for (const [t, extra] of [
    [0.13, 0.45],
    [0.38, 0.95],
    [0.62, 0.95],
    [0.87, 0.45],
  ] as const) {
    const rr = r + bulge * extra + 0.004 * scale;
    k.add('metal', cyl(rr, rr, 0.014 * scale, staves, true), { position: [at[0], at[1] + t * h, at[2]] });
  }
}

export function buildHouse(): PropPart[] {
  const k = new Kit();
  const rand = mulberry32(31);
  const W = 0.6;
  const D = 0.46;
  const wallH = 0.34;
  const base = 0.07;
  const top = base + wallH;
  const front = D / 2;
  const fz = front + 0.006;

  // 돌 기초: 어두운 줄눈 위에 크기가 조금씩 다른 돌을 앞면에 두 줄 쌓는다.
  const footW = W + 0.06;
  k.add('stone', box(footW, base, D + 0.06), { position: [0, base / 2, 0], color: '#77736c' });
  for (let row = 0; row < 2; row++) {
    let x = -footW / 2;
    if (row === 1) {
      const w = 0.04;
      k.add('stone', box(w - 0.007, base / 2 - 0.007, 0.022), {
        position: [x + w / 2, base * 0.75, (D + 0.06) / 2],
        color: new THREE.Color('#ffffff').multiplyScalar(0.8 + rand() * 0.25),
      });
      x += w;
    }
    while (x < footW / 2 - 0.02) {
      const w = Math.min(0.07 + rand() * 0.05, footW / 2 - x);
      k.add('stone', box(w - 0.007, base / 2 - 0.007, 0.022), {
        position: [x + w / 2, base * (row ? 0.75 : 0.25), (D + 0.06) / 2],
        color: new THREE.Color('#ffffff').multiplyScalar(0.8 + rand() * 0.25),
      });
      x += w;
    }
  }

  // 회벽: 아래쪽은 흙이 튀어 어둡고 군데군데 얼룩진다.
  k.add('plaster', box(W, wallH, D, 6, 4, 4), {
    position: [0, base + wallH / 2, 0],
    shade: (p) => (0.84 + 0.16 * smoothstep(base, base + 0.12, p.y)) * (0.92 + 0.14 * wobble(p.x * 4, p.y * 4, p.z * 4, 3)),
  });
  // 박공 벽 (양옆 삼각형)
  const gableH = 0.22;
  const tri = new THREE.Shape();
  tri.moveTo(-D / 2, 0);
  tri.lineTo(D / 2, 0);
  tri.lineTo(0, gableH);
  tri.closePath();
  const gable = new THREE.ExtrudeGeometry(tri, { depth: W - 0.02, bevelEnabled: false });
  k.add('plaster', gable, { position: [-(W - 0.02) / 2, top, 0], rotation: [0, Math.PI / 2, 0] });

  // 지붕 (플레이어 색). 용마루는 좌우 방향이라 앞쪽 경사면이 카메라를 향한다. 단마다 지붕널을 겹쳐 덮는다.
  // 처마를 짧게 내밀어 비스듬히 내려다보는 카메라에서도 문과 창이 가려지지 않게 한다.
  const slope = Math.atan2(gableH, D / 2);
  const slopeLen = Math.hypot(gableH, D / 2) + 0.05;
  const roofLen = W + 0.16;
  const apex: Vec3 = [0, top + gableH + 0.035, 0];
  for (const side of [1, -1] as const) {
    addShingles(k, 'roof', apex, side, slope, slopeLen, roofLen, 4, side === 1 ? 11 : 12);
    // 박공 끝을 마감한 판재
    const dir = new THREE.Vector3(0, -Math.sin(slope), side * Math.cos(slope));
    const mid = new THREE.Vector3(...apex).addScaledVector(dir, slopeLen / 2);
    for (const x of [-roofLen / 2 - 0.006, roofLen / 2 + 0.006]) {
      k.add('wood', box(0.018, 0.034, slopeLen), { position: [x, mid.y, mid.z], rotation: [side * slope, 0, 0], color: TIMBER });
    }
  }
  k.add('roof', box(roofLen + 0.02, 0.045, 0.07), { position: [apex[0], apex[1] + 0.012, apex[2]], color: '#d8d8d8' });

  // 목조 골조: 모서리 기둥, 가로보, 앞면 가새
  const post = 0.035;
  for (const x of [-W / 2, W / 2]) {
    for (const z of [-D / 2, D / 2]) {
      k.add('wood', box(post, wallH, post), { position: [x, base + wallH / 2, z], color: TIMBER });
    }
  }
  const midRail = base + wallH * 0.48;
  for (const z of [D / 2 + 0.004, -D / 2 - 0.004]) {
    k.add('wood', box(W + post, post, post * 0.6), { position: [0, top - post / 2, z], color: TIMBER });
  }
  // 앞면 가운데 보는 문 자리를 비우고 둘로 나눈다. 뒤쪽은 한 줄.
  k.add('wood', box(0.13, post * 0.8, post * 0.6), { position: [-0.235, midRail, D / 2 + 0.004], color: TIMBER });
  k.add('wood', box(0.33, post * 0.8, post * 0.6), { position: [0.135, midRail, D / 2 + 0.004], color: TIMBER });
  k.add('wood', box(W + post, post * 0.8, post * 0.6), { position: [0, midRail, -D / 2 - 0.004], color: TIMBER });
  for (const x of [-W / 2 - 0.004, W / 2 + 0.004]) {
    k.add('wood', box(post * 0.6, post, D), { position: [x, top - post / 2, 0], color: TIMBER });
    k.add('wood', box(post * 0.6, post * 0.8, D), { position: [x, midRail, 0], color: TIMBER });
  }
  // 가새: 가운데 보에서 위 보까지, 모서리 기둥 쪽으로 비스듬히
  const y0 = midRail + 0.014;
  const y1 = top - post;
  for (const s of [-1, 1]) {
    const dx = 0.05;
    const len = Math.hypot(dx, y1 - y0);
    k.add('wood', box(len, post * 0.7, post * 0.5), {
      position: [s * 0.26, (y0 + y1) / 2, D / 2 + 0.007],
      rotation: [0, 0, Math.atan2(y1 - y0, -s * dx)],
      color: TIMBER,
    });
  }

  // 문: 세로 판자 세 장, 띠장 두 줄, 쇠 손잡이, 문틀, 문 앞 디딤돌
  const doorX = -0.1;
  const doorW = 0.11;
  const doorH = 0.19;
  for (let i = 0; i < 3; i++) {
    const pw = doorW / 3;
    k.add('wood', box(pw - 0.004, doorH, 0.014), {
      position: [doorX - doorW / 2 + pw * (i + 0.5), base + doorH / 2, fz],
      color: new THREE.Color('#5a3b20').multiplyScalar([0.95, 1.08, 0.9][i]),
    });
  }
  for (const y of [0.045, 0.145]) {
    k.add('wood', box(doorW - 0.01, 0.018, 0.008), { position: [doorX, base + y, fz + 0.009], color: '#4a3019' });
  }
  k.add('metal', new THREE.SphereGeometry(0.009, 6, 4), { position: [doorX + 0.034, base + 0.1, fz + 0.013] });
  k.add('wood', box(doorW + 0.034, 0.022, 0.018), { position: [doorX, base + doorH + 0.011, fz + 0.001], color: TIMBER });
  for (const s of [-1, 1]) {
    k.add('wood', box(0.017, doorH, 0.018), { position: [doorX + s * (doorW / 2 + 0.0085), base + doorH / 2, fz + 0.001], color: TIMBER });
  }
  k.add('stone', box(0.16, 0.04, 0.06), { position: [doorX, 0.02, (D + 0.06) / 2 + 0.03], color: '#cdc8be' });

  // 창: 불 켜진 창 안쪽, 창틀과 십자 살, 창턱, 열어 둔 덧문
  const winX = 0.13;
  const winY = base + 0.215;
  const winW = 0.09;
  const winH = 0.08;
  k.add('dark', box(winW, winH, 0.012), { position: [winX, winY, fz] });
  k.add('paint', box(winW - 0.016, winH - 0.016, 0.004), { position: [winX, winY, fz + 0.007], color: '#e0a052' });
  k.add('wood', box(0.008, winH, 0.01), { position: [winX, winY, fz + 0.011], color: '#5a3b20' });
  k.add('wood', box(winW, 0.008, 0.01), { position: [winX, winY, fz + 0.011], color: '#5a3b20' });
  k.add('wood', box(winW + 0.024, 0.014, 0.014), { position: [winX, winY + winH / 2 + 0.007, fz + 0.003], color: TIMBER });
  k.add('wood', box(0.014, winH, 0.014), { position: [winX - winW / 2 - 0.007, winY, fz + 0.003], color: TIMBER });
  k.add('wood', box(0.014, winH, 0.014), { position: [winX + winW / 2 + 0.007, winY, fz + 0.003], color: TIMBER });
  k.add('wood', box(winW + 0.04, 0.016, 0.03), { position: [winX, winY - winH / 2 - 0.008, fz + 0.01], color: '#6b4a2a' });
  for (const s of [-1, 1]) {
    for (let j = 0; j < 2; j++) {
      k.add('wood', box(0.016, winH, 0.01), {
        position: [winX + s * (winW / 2 + 0.024 + 0.017 * j), winY, fz + 0.002],
        color: new THREE.Color('#6b4a2a').multiplyScalar(j ? 0.92 : 1.05),
      });
    }
  }

  // 굴뚝: 돌을 줄마다 다른 밝기로 쌓고 덮개돌을 얹는다.
  const chimH = 0.24;
  const chimY0 = top + 0.02;
  k.add('stone', box(0.085, chimH, 0.085, 1, 4, 1), {
    position: [0.16, chimY0 + chimH / 2, -0.08],
    faceShade: (c, n) => 0.84 + 0.22 * hash3(Math.floor((c.y - chimY0) / (chimH / 4)), Math.round(n.x) * 3 + Math.round(n.z) * 7, 5),
  });
  k.add('stone', box(0.11, 0.02, 0.11), { position: [0.16, chimY0 + chimH + 0.01, -0.08], color: '#d8d4cc' });
  k.add('dark', box(0.05, 0.004, 0.05), { position: [0.16, chimY0 + chimH + 0.021, -0.08] });

  // 집 옆 살림살이: 오른쪽 물통, 왼쪽 장작 패는 받침
  addBarrel(k, [0.36, 0, 0.15], 0.7, 4);
  k.add('bark', cyl(0.042, 0.047, 0.06, 9, true), { position: [-0.37, 0.03, 0.19], uv: 'native', uvScale: 0.6 });
  addLogEnd(k, 0.042, [-0.37, 0.0605, 0.19], [-Math.PI / 2, 0, 0]);
  k.add('endgrain', box(0.022, 0.07, 0.03), { position: [-0.33, 0.035, 0.245], rotation: [0.3, 0.5, 0.25], color: '#e8cfa5' });
  return k.build(0.18, 0.7);
}

export function buildBanner(): PropPart[] {
  const k = new Kit();
  const rand = mulberry32(5);
  const h = 0.92;
  // 깃대 밑을 받친 돌
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + rand();
    k.add('stone', rock(0.028 + rand() * 0.012, 0, 40 + i, 0.4), {
      position: [Math.cos(a) * 0.04, 0.012, Math.sin(a) * 0.04],
      scale: [1, 0.65, 1],
      flat: true,
      color: new THREE.Color('#ffffff').multiplyScalar(0.8 + rand() * 0.2),
    });
  }
  k.add('wood', cyl(0.014, 0.019, h, 8), { position: [0, h / 2, 0], uv: 'native', color: '#8a6238' });
  k.add('metal', new THREE.SphereGeometry(0.02, 8, 6), { position: [0, h + 0.005, 0], color: '#d6b25a' });
  k.add('metal', new THREE.ConeGeometry(0.016, 0.05, 8), { position: [0, h + 0.045, 0], color: '#d6b25a' });
  // 바람에 휘날리는 제비꼬리 깃발 (끝 가운데를 파낸 판을 물결 모양으로 휜다)
  const FW = 0.34;
  const FH = 0.2;
  const flag = warp(new THREE.PlaneGeometry(FW, FH, 12, 4), (v) => {
    let x = v.x + FW / 2;
    if (x > FW - 0.001) x -= 0.075 * (1 - Math.abs(v.y) / (FH / 2));
    v.set(x, v.y - x * 0.06, Math.sin(x * 14) * 0.022 * (x / FW));
  });
  k.add('banner', flag, {
    position: [0.004, h - 0.13, 0],
    uv: 'native',
    shade: (p) => 0.84 + 0.18 * (0.5 + 0.5 * Math.cos(p.x * 14)),
  });
  // 기를 매단 가로대
  k.add('wood', cyl(0.008, 0.008, 0.36, 6), { position: [0.17, h - 0.025, 0], rotation: alongX(), color: '#6b4a2a' });
  return k.build(0.3, 0.75);
}

// ───────────────────────── 목재 ─────────────────────────

/** 침엽수 한 층: 아래 테두리가 가지 끝처럼 톱니 모양으로 처진 원뿔 */
function boughCone(r: number, h: number, lobes: number, seed: number): THREE.BufferGeometry {
  return warp(new THREE.ConeGeometry(r, h, lobes * 2, 2, true), (v) => {
    const t = (v.y + h / 2) / h; // 0 = 아래 테두리, 1 = 꼭대기
    if (t > 0.99) return;
    const a = Math.atan2(v.z, v.x);
    const tip = 0.5 + 0.5 * Math.cos(a * lobes + seed);
    const jitter = 0.93 + 0.14 * hash3(Math.round(a * 1000), seed, 3);
    if (t < 0.01) {
      const k = (0.76 + 0.34 * tip) * jitter;
      v.x *= k;
      v.z *= k;
      v.y -= h * 0.17 * tip;
    } else {
      const k = 1.06 * (0.96 + 0.07 * tip);
      v.x *= k;
      v.z *= k;
    }
  });
}

export function buildPine(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  k.add('bark', cyl(0.024, 0.05, 0.36, 7), { position: [0, 0.18, 0], uv: 'native', uvScale: 0.6 });
  // 나무마다 잎 색이 조금씩 다르다 (푸른빛 ~ 누른빛)
  const hue = rand();
  const tint: Vec3 = [0.92 + hue * 0.12, 1, 1.02 - hue * 0.1];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const r = (0.33 - i * 0.056) * (0.94 + rand() * 0.12);
    const h = 0.3 - i * 0.012;
    const y0 = 0.2 + i * 0.14; // 층 아래 테두리 높이
    const lobes = 7 - (i >> 1);
    k.add('foliage', boughCone(r, h, lobes, seed * 3 + i), {
      position: [(rand() - 0.5) * 0.025, y0 + h / 2, (rand() - 0.5) * 0.025],
      rotation: [0, rand() * Math.PI * 2, 0],
      uv: 'native',
      shade: (p, n) => {
        // 층마다 안쪽 아래는 그늘지고 가지 끝과 윗면은 밝다.
        const s = (0.58 + 0.5 * smoothstep(y0 - 0.05, y0 + h * 0.8, p.y)) * (0.86 + 0.2 * smoothstep(-0.2, 0.8, n.y));
        return [s * tint[0], s * tint[1], s * tint[2]];
      },
    });
  }
  return k.build(0.55, 0.55);
}

export function buildOak(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  k.add('bark', cyl(0.034, 0.062, 0.46, 8), { position: [0, 0.23, 0], uv: 'native', uvScale: 0.6 });
  // 땅 위로 드러난 뿌리
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + rand() * 0.6;
    k.add('bark', new THREE.ConeGeometry(0.028, 0.12, 5), {
      position: [Math.cos(a) * 0.075, 0.018, Math.sin(a) * 0.075],
      rotation: aim(Math.cos(a), -0.3, Math.sin(a)),
      uv: 'native',
      uvScale: 0.4,
    });
  }
  // 줄기 위에서 갈라지는 굵은 가지
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + rand();
    const dir = new THREE.Vector3(Math.cos(a) * 0.8, 1, Math.sin(a) * 0.8).normalize();
    const c = new THREE.Vector3(0, 0.42, 0).addScaledVector(dir, 0.1);
    k.add('bark', cyl(0.01, 0.026, 0.22, 5), { position: [c.x, c.y, c.z], rotation: aim(dir.x, dir.y, dir.z), uv: 'native', uvScale: 0.5 });
  }
  // 잎 뭉치: 가운데 큰 덩어리를 작은 덩어리들이 둘러싼다.
  const crown: Vec3[] = [[0, 0.64, 0]];
  const radii = [0.25];
  const count = 5 + Math.floor(rand() * 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.5;
    const d = 0.15 + rand() * 0.05;
    crown.push([Math.cos(a) * d, 0.54 + rand() * 0.16, Math.sin(a) * d]);
    radii.push(0.13 + rand() * 0.05);
  }
  const hue = rand();
  crown.forEach((at, i) => {
    const b = 0.84 + rand() * 0.14;
    k.add('leaf', blob(radii[i], i === 0 ? 2 : 1, seed * 13 + i, 0.3), {
      position: at,
      // 잎 텍스처를 잘게 입혀 둥근 덩어리에서 무늬가 대리석처럼 늘어나 보이지 않게 한다.
      uvScale: 2,
      shade: (p, n) => {
        const s = b * skyShade(n, 0.5, 0.98) * (0.9 + 0.12 * smoothstep(0.45, 0.85, p.y));
        return [s * (0.95 + hue * 0.08), s, s * (0.94 - hue * 0.06)];
      },
    });
  });
  return k.build(0.6, 0.55);
}

export function buildBush(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 37 + 3);
  const k = new Kit();
  const n = 4 + variant;
  const centers: { at: Vec3; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand();
    const r = 0.07 + rand() * 0.05;
    const d = i === 0 ? 0 : 0.07 + rand() * 0.04;
    const at: Vec3 = [Math.cos(a) * d, r * 0.75, Math.sin(a) * d * 0.8];
    centers.push({ at, r });
    const b = 0.84 + rand() * 0.16;
    k.add('leaf', blob(r, 1, variant * 7 + i, 0.32), { position: at, uvScale: 2, shade: (_p, nn) => b * skyShade(nn, 0.5, 1.0) });
  }
  // 두 번째 덤불에는 붉은 열매가 달린다.
  if (variant === 1) {
    for (let i = 0; i < 9; i++) {
      const c = centers[i % centers.length];
      const dir = new THREE.Vector3(rand() - 0.5, 0.35 + rand() * 0.6, rand() - 0.5).normalize();
      k.add('paint', new THREE.SphereGeometry(0.012, 6, 4), {
        position: [c.at[0] + dir.x * c.r * 0.95, c.at[1] + dir.y * c.r * 0.95, c.at[2] + dir.z * c.r * 0.95],
        color: rand() > 0.3 ? '#b8322a' : '#7e1f2a',
      });
    }
  }
  return k.build(0.15, 0.6);
}

/** 풀 포기. 두 번째 변형에는 들꽃이 섞인다. */
export function buildTuft(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 53 + 11);
  const k = new Kit();
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rand() * 0.6;
    const h = 0.08 + rand() * 0.08;
    const lean = 0.25 + rand() * 0.45;
    const g = new THREE.ConeGeometry(0.011, h, 3, 1, true);
    g.translate(0, h / 2, 0); // 밑동을 원점에 둔다
    k.add('leaf', g, {
      position: [Math.cos(a) * 0.015, 0, Math.sin(a) * 0.015],
      rotation: aim(Math.cos(a) * Math.sin(lean), Math.cos(lean), Math.sin(a) * Math.sin(lean)),
      uv: 'native',
      color: new THREE.Color().setRGB(0.85 + rand() * 0.25, 1, 0.75 + rand() * 0.2),
      shade: (p) => 0.55 + 0.6 * smoothstep(0, 0.12, p.y),
    });
  }
  if (variant === 1) {
    const colors = ['#f4efe0', '#f0c53c', '#9a7fd0', '#d4483b'];
    for (let i = 0; i < 4; i++) {
      const a = rand() * Math.PI * 2;
      const d = 0.02 + rand() * 0.035;
      const h = 0.09 + rand() * 0.06;
      k.add('leaf', cyl(0.003, 0.003, h, 3), { position: [Math.cos(a) * d, h / 2, Math.sin(a) * d], color: '#9fb86a' });
      k.add('paint', new THREE.IcosahedronGeometry(0.014, 0), {
        position: [Math.cos(a) * d, h + 0.006, Math.sin(a) * d],
        scale: [1, 0.6, 1],
        color: colors[i],
        flat: true,
      });
    }
  }
  return k.build(0.1, 0.7);
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
      const rr = r * (0.9 + rand() * 0.15);
      k.add('bark', cyl(rr, rr, len, 9, true), {
        position: [shift, y, z],
        rotation: [rand() * 3, 0, Math.PI / 2],
        uv: 'native',
        uvScale: 0.7,
        color: new THREE.Color('#ffffff').multiplyScalar(0.88 + rand() * 0.18),
      });
      const b = 0.9 + rand() * 0.15;
      for (const side of [1, -1]) {
        addLogEnd(k, rr * 0.98, [shift + (side * len) / 2, y, z], [0, (side * Math.PI) / 2, 0], b);
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
  const rand = mulberry32(17);
  k.add('bark', cyl(0.068, 0.085, 0.09, 10, true), { position: [0, 0.045, 0], uv: 'native', uvScale: 0.6 });
  addLogEnd(k, 0.068, [0, 0.0905, 0], [-Math.PI / 2, 0, 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.4 + rand() * 0.5;
    k.add('bark', new THREE.ConeGeometry(0.026, 0.1, 5), {
      position: [Math.cos(a) * 0.09, 0.014, Math.sin(a) * 0.09],
      rotation: aim(Math.cos(a), -0.25, Math.sin(a)),
      uv: 'native',
      uvScale: 0.4,
    });
  }
  // 그루터기에 꽂힌 도끼와 흩어진 나무 조각
  k.add('wood', box(0.018, 0.018, 0.2), { position: [0.02, 0.15, 0.06], rotation: [0.9, 0, 0], color: '#8a6238' });
  k.add('metal', box(0.012, 0.06, 0.05), { position: [0.02, 0.1, -0.005], rotation: [0.9, 0, 0] });
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2;
    const d = 0.11 + rand() * 0.06;
    k.add('endgrain', box(0.024, 0.008, 0.012), {
      position: [Math.cos(a) * d, 0.004, Math.sin(a) * d],
      rotation: [0, rand() * 3, 0],
      color: new THREE.Color('#ffffff').multiplyScalar(0.9 + rand() * 0.2),
    });
  }
  return k.build(0.08, 0.7);
}

// ───────────────────────── 곡물 ─────────────────────────

export function buildWheatRow(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const len = 1.6;
  const ridgeH = 0.17;
  const tri = new THREE.Shape();
  tri.moveTo(-0.07, 0);
  tri.lineTo(0.07, 0);
  tri.lineTo(0.0, ridgeH);
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
  // 줄기 덩어리는 아래가 그늘지고, 그 위로 이삭이 밝게 솟는다.
  k.add('wheat', ridge, {
    position: [-len / 2, 0, 0],
    rotation: [0, Math.PI / 2, 0],
    color: new THREE.Color('#ffffff').multiplyScalar(0.92 + rand() * 0.06),
    shade: (p) => 0.6 + 0.42 * smoothstep(0.0, ridgeH, p.y),
  });
  // 이삭: 고랑 꼭대기를 따라 가늘고 긴 낟알 뭉치를 촘촘히 세우고, 바람 방향(+x)으로 조금씩 눕힌다.
  const ears = 46;
  const stepX = (len - 0.06) / ears;
  for (let i = 0; i < ears; i++) {
    const x = -len / 2 + 0.03 + (i + rand() * 0.8) * stepX;
    const top = 0.13 + rand() * 0.05;
    k.add('wheat', new THREE.OctahedronGeometry(0.016, 0), {
      position: [x, top, (rand() - 0.5) * 0.07],
      rotation: [(rand() - 0.5) * 0.5, rand() * Math.PI, -0.18 + (rand() - 0.5) * 0.4],
      scale: [0.75, 2.8, 0.75],
      color: new THREE.Color('#ffffff').multiplyScalar(1.02 + rand() * 0.16),
      flat: true,
      shade: (p) => 0.78 + 0.32 * smoothstep(top - 0.03, top + 0.04, p.y),
    });
  }
  return k.build(0.17, 0.55);
}

/** 볏단 더미: 단 일곱 개를 가운데로 기대 세우고 허리를 끈으로 묶었다. */
export function buildStook(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3;
    const lean = 0.2 + rand() * 0.08;
    const rot = aim(-Math.cos(a) * Math.sin(lean), Math.cos(lean), -Math.sin(a) * Math.sin(lean));
    const at: Vec3 = [Math.cos(a) * 0.075, 0, Math.sin(a) * 0.075];
    const h = 0.28 + rand() * 0.04;
    const b = 0.9 + rand() * 0.15;
    const sheaf = cyl(0.024, 0.036, h, 7);
    sheaf.translate(0, h / 2, 0);
    k.add('wheat', sheaf, { position: at, rotation: rot, uv: 'native', shade: (p) => b * (0.66 + 0.4 * smoothstep(0.02, 0.3, p.y)) });
    const head = new THREE.ConeGeometry(0.042, 0.09, 7);
    head.rotateX(Math.PI); // 위로 벌어진 이삭 다발
    head.translate(0, h + 0.03, 0);
    k.add('wheat', head, { position: at, rotation: rot, flat: true, color: new THREE.Color('#ffffff').multiplyScalar(b * 1.08) });
  }
  k.add('cloth', new THREE.TorusGeometry(0.058, 0.009, 5, 14), { position: [0, 0.19, 0], rotation: [Math.PI / 2, 0, 0], color: '#a8875a' });
  return k.build(0.2, 0.6);
}

/** 곡식 포대. 두 번째 변형은 비스듬히 주저앉아 낟알이 조금 쏟아져 있다. */
export function buildSack(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 101 + 7);
  const k = new Kit();
  const tilt: Vec3 = variant === 1 ? [0.12, rand() * 3, 0.22] : [0, rand() * 3, 0];
  const body = warp(new THREE.SphereGeometry(0.1, 12, 9), (v) => {
    if (v.y < -0.03) v.y = -0.03 - (-0.03 - v.y) * 0.35; // 바닥을 눌러 평평하게
    const w = 0.94 + 0.12 * wobble(v.x * 30, v.y * 30, v.z * 30, variant + 2); // 천 주름
    v.x *= w;
    v.z *= w;
  });
  k.add('cloth', body, {
    position: [0, 0.07, 0],
    scale: [1, 1.25, 0.9],
    rotation: tilt,
    uv: 'native',
    uvScale: 2,
    shade: (_p, n) => skyShade(n, 0.72, 1.06),
  });
  // 묶은 목, 끈, 위로 벌어진 자루 끝
  const neck = new THREE.Vector3(0, 0.12, 0).applyEuler(new THREE.Euler(...tilt)).add(new THREE.Vector3(0, 0.07, 0));
  k.add('cloth', new THREE.ConeGeometry(0.045, 0.07, 8), { position: [neck.x, neck.y + 0.03, neck.z], rotation: [Math.PI + tilt[0], tilt[1], tilt[2]], uv: 'native' });
  k.add('cloth', new THREE.TorusGeometry(0.026, 0.007, 5, 10), {
    position: [neck.x, neck.y + 0.005, neck.z],
    rotation: [Math.PI / 2 + tilt[0], tilt[1], tilt[2]],
    color: '#8a6a43',
  });
  if (variant === 1) {
    for (let i = 0; i < 7; i++) {
      k.add('wheat', new THREE.SphereGeometry(0.012, 5, 4), {
        position: [0.06 + rand() * 0.08, 0.006, 0.04 + (rand() - 0.5) * 0.1],
        scale: [1.4, 0.6, 1],
        color: new THREE.Color('#ffffff').multiplyScalar(0.95 + rand() * 0.15),
      });
    }
  }
  return k.build(0.18, 0.65);
}

// ───────────────────────── 석재 ─────────────────────────

export function buildBoulder(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const g = rock(0.2, 2, seed, 0.46);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, y < 0 ? y * 0.35 : y * 0.85);
  }
  const moss = 0.84 + rand() * 0.08;
  k.add('stone', g, {
    position: [0, 0.05, 0],
    rotation: [0, rand() * Math.PI * 2, 0],
    scale: [1 + rand() * 0.3, 0.9 + rand() * 0.3, 1],
    color: new THREE.Color('#ffffff').multiplyScalar(0.85 + rand() * 0.2),
    // 돌 텍스처를 크게 입혀 면마다 금이 촘촘히 보이지 않게 한다.
    uvScale: 0.45,
    flat: true,
    faceShade: (c, n) => {
      // 윗면은 밝고 아랫면은 그늘지며, 가로 결이 희미하게 보인다. 볕 드는 윗면 몇 군데에만 이끼가 낀다.
      const s = (0.7 + 0.4 * smoothstep(-0.3, 0.9, n.y)) * (0.94 + 0.06 * Math.sin(c.y * 60 + seed));
      if (n.y > 0.7 && hash3(c.x * 13, c.z * 13, seed) > moss) return [s * 0.86, s * 0.97, s * 0.76];
      return s;
    },
  });
  return k.build(0.2, 0.6);
}

/** 자갈 무더기 */
export function buildPebbles(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 29 + 5);
  const k = new Kit();
  const n = 7 + variant * 3;
  for (let i = 0; i < n; i++) {
    const r = 0.018 + rand() * 0.026;
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * 0.13;
    k.add('stone', rock(r, 0, 70 + i + variant * 10, 0.5), {
      position: [Math.cos(a) * d, r * 0.35, Math.sin(a) * d],
      rotation: [(rand() - 0.5) * 0.4, rand() * 3, (rand() - 0.5) * 0.4],
      scale: [1, 0.6, 1],
      flat: true,
      color: new THREE.Color('#ffffff').multiplyScalar(0.75 + rand() * 0.35),
      faceShade: (_c, nn) => 0.75 + 0.35 * smoothstep(-0.3, 0.9, nn.y),
    });
  }
  return k.build(0.05, 0.7);
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
      // 정으로 쪼아 낸 돌이라 모서리가 조금씩 고르지 않다.
      const g = warp(box(bw, bh, bd, 2, 1, 2), (v) => {
        const j = (hash3(v.x * 31 + i, v.y * 17 + layer, v.z * 23) - 0.5) * 0.014;
        v.set(v.x + j, v.y + j * 0.5, v.z + j * 0.7);
      });
      k.add('stone', g, {
        position: [(i - (count - 1) / 2) * (bw + 0.012), bh / 2 + layer * (bh + 0.004), (rand() - 0.5) * 0.02],
        rotation: [0, (rand() - 0.5) * 0.12, 0],
        color: new THREE.Color('#f2efe8').multiplyScalar(0.88 + rand() * 0.12),
        flat: true,
        faceShade: (_c, n) => (n.y > 0.5 ? 1.06 : n.y < -0.5 ? 0.7 : 0.93),
      });
    }
  }
  // 정과 망치 받침용 나무 판
  k.add('wood', box(0.5, 0.025, 0.2), { position: [0, 0.0125, 0.18], rotation: [0, 0.08, 0], color: '#8a6238' });
  // 돌더미 오른쪽에 기대 세운 곡괭이 (자루를 기준으로 머리까지 함께 기울인다)
  const pickRot = aim(-0.35, 1, 0.12);
  const handle = cyl(0.008, 0.009, 0.26, 6);
  handle.translate(0, 0.13, 0);
  k.add('wood', handle, { position: [0.33, 0, 0.03], rotation: pickRot, uv: 'native', color: '#9a6e40' });
  for (const s of [-1, 1]) {
    const head = box(0.075, 0.015, 0.015);
    head.rotateZ(s * 0.18);
    head.translate(s * 0.034, 0.252, 0);
    k.add('metal', head, { position: [0.33, 0, 0.03], rotation: pickRot });
  }
  // 판 위에 놓인 나무망치
  k.add('wood', cyl(0.022, 0.022, 0.075, 8), { position: [-0.12, 0.047, 0.17], rotation: alongX(), uv: 'native', color: '#a07a4c' });
  k.add('wood', cyl(0.006, 0.006, 0.13, 5), { position: [-0.12, 0.04, 0.24], rotation: [Math.PI / 2, 0, 0], color: '#8a6238' });
  // 쪼아 낸 돌 부스러기
  for (let i = 0; i < 6; i++) {
    k.add('stone', rock(0.012 + rand() * 0.01, 0, 90 + i, 0.5), {
      position: [-0.3 + rand() * 0.6, 0.006, 0.09 + rand() * 0.04],
      scale: [1, 0.6, 1],
      flat: true,
      color: new THREE.Color('#f2efe8').multiplyScalar(0.8 + rand() * 0.2),
    });
  }
  return k.build(0.22, 0.65);
}

// ───────────────────────── 시장 ─────────────────────────

/** 회전체 단면 (반지름, 높이). 바깥 벽을 올라갔다가 안쪽 벽으로 내려와 위에서 봐도 속이 차 보이는 그릇이 된다. */
function vessel(profile: [number, number][]): THREE.Vector2[] {
  return profile.map(([r, y]) => new THREE.Vector2(r, y));
}

const TENT_PALETTES: [string, string][] = [
  ['#b7412e', '#f1e6cc'],
  ['#2f6a8a', '#efe3c4'],
];

/** 시장 천막. 첫 번째는 사과·빵·양배추를 파는 먹거리 가게, 두 번째는 옷감과 그릇을 파는 가게다. */
export function buildTent(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 101 + 7);
  const k = new Kit();
  const W = 0.66;
  const D = 0.5;
  const H = 0.42;
  const [c1, c2] = TENT_PALETTES[variant % TENT_PALETTES.length];
  // 기둥 (뒤가 높다). 앞 기둥 끝에는 둥근 장식
  for (const x of [-W / 2, W / 2]) {
    for (const z of [-D / 2, D / 2]) {
      const h = H + (z < 0 ? 0.08 : 0) + 0.02;
      k.add('wood', cyl(0.015, 0.019, h, 6), { position: [x, h / 2, z], uv: 'native', color: TIMBER });
      if (z > 0) k.add('wood', new THREE.SphereGeometry(0.022, 8, 6), { position: [x, h + 0.012, z], color: '#8f6238' });
    }
  }
  // 줄무늬 차양 (앞으로 기울어진 지붕). 가운데가 조금 처지고, 앞 끝에 삼각 장식천이 늘어진다.
  const stripes = 7;
  const span = W + 0.1;
  const sw = span / stripes;
  const pitch = 0.32;
  const depth = D + 0.16;
  const cy = H + 0.06;
  const cz = 0.02;
  const frontY = cy - (Math.sin(pitch) * depth) / 2;
  const frontZ = cz + (Math.cos(pitch) * depth) / 2;
  for (let i = 0; i < stripes; i++) {
    const x = -span / 2 + sw * (i + 0.5);
    const col = i % 2 === 0 ? c1 : c2;
    const canopy = warp(box(sw, 0.016, depth, 1, 1, 6), (v) => {
      v.y -= Math.sin(Math.PI * (v.z / depth + 0.5)) * 0.022;
    });
    k.add('stripe', canopy, { position: [x, cy, cz], rotation: [pitch, 0, 0], color: col });
    const pennant = new THREE.Shape();
    pennant.moveTo(-sw / 2, 0);
    pennant.lineTo(sw / 2, 0);
    pennant.lineTo(0, -0.07);
    pennant.closePath();
    k.add('stripe', new THREE.ShapeGeometry(pennant), { position: [x, frontY + 0.003, frontZ + 0.004], color: col });
  }
  // 뒤 천막: 세로 주름이 진 천
  k.add('cloth', warp(box(W, H, 0.015, 10, 1, 1), (v) => {
    v.z += Math.sin(v.x * 40) * 0.008;
  }), {
    position: [0, H / 2, -D / 2],
    color: '#e9dcbc',
    shade: (p) => 0.86 + 0.14 * (0.5 + 0.5 * Math.cos(p.x * 40)),
  });
  // 판매대: 위판, 가로 판자 세 장으로 된 앞판, 다리
  const counterZ = D / 2 - 0.08;
  const topY = 0.225;
  k.add('wood', box(W * 0.9, 0.04, 0.17), { position: [0, topY - 0.02, counterZ], color: '#8a6238' });
  for (let j = 0; j < 3; j++) {
    k.add('wood', box(W * 0.9, 0.052, 0.018), {
      position: [0, 0.03 + j * 0.058, D / 2 - 0.005],
      color: new THREE.Color('#6b4a2a').multiplyScalar([0.95, 1.06, 0.9][j]),
    });
  }
  if (variant === 0) {
    // 바구니에 쌓은 사과
    k.add('wood', new THREE.LatheGeometry(vessel([[0, 0], [0.05, 0.004], [0.062, 0.03], [0.064, 0.04], [0.056, 0.04], [0.05, 0.012], [0, 0.01]]), 12), {
      position: [-0.2, topY, counterZ],
      color: '#b08550',
    });
    for (let i = 0; i < 8; i++) {
      const a = (i / 7) * Math.PI * 2;
      const d = i === 7 ? 0 : 0.034;
      k.add('paint', new THREE.SphereGeometry(0.018, 7, 5), {
        position: [-0.2 + Math.cos(a) * d, topY + 0.045 + (i === 7 ? 0.02 : 0), counterZ + Math.sin(a) * d],
        color: i % 4 === 3 ? '#8fae3c' : rand() > 0.5 ? '#b8322a' : '#cc4a2e',
        shade: (_p, n) => skyShade(n, 0.6, 1.1),
      });
    }
    // 빵 세 덩이
    for (let i = 0; i < 3; i++) {
      k.add('wheat', new THREE.SphereGeometry(0.03, 9, 6), {
        position: [-0.06 + (i - 1) * 0.03, topY + 0.016, counterZ + (i - 1) * 0.045],
        rotation: [0, 0.4 + i * 0.3, 0],
        scale: [1.4, 0.62, 0.9],
        color: '#a8693a',
        shade: (_p, n) => skyShade(n, 0.65, 1.12),
      });
    }
    addJug(k, [0.07, topY, counterZ], 0.75);
    // 양배추
    for (let i = 0; i < 3; i++) {
      k.add('paint', blob(0.027, 1, 60 + i, 0.25), {
        position: [0.19 + (i % 2) * 0.035, topY + 0.024 + (i === 2 ? 0.03 : 0), counterZ + (i === 1 ? 0.04 : -0.015)],
        color: '#7fa64a',
        shade: (_p, n) => skyShade(n, 0.6, 1.12),
      });
    }
  } else {
    // 둘둘 만 옷감 세 필
    const bolts = ['#7b3a62', '#3e6f9e', '#c99a3a'];
    bolts.forEach((col, i) => {
      const x = -0.2 + (i === 2 ? 0.023 : i * 0.046);
      const y = topY + 0.022 + (i === 2 ? 0.038 : 0);
      k.add('paint', cyl(0.022, 0.022, 0.14, 10), { position: [x, y, counterZ], rotation: [Math.PI / 2, 0, 0], color: col, shade: (_p, n) => skyShade(n, 0.65, 1.1) });
    });
    addJug(k, [0.0, topY, counterZ], 0.75);
    addJug(k, [0.08, topY, counterZ + 0.03], 0.6);
    // 포개 놓은 사발
    for (let i = 0; i < 3; i++) {
      k.add('clay', new THREE.LatheGeometry(vessel([[0, 0], [0.032, 0.003], [0.046, 0.024], [0.042, 0.026], [0.03, 0.01], [0, 0.008]]), 12), {
        position: [0.2, topY + i * 0.012, counterZ - 0.01],
        color: '#d9b48a',
      });
    }
  }
  return k.build(0.3, 0.7);
}

/** 나무 상자. 면마다 판자 세 장이 보이도록 밝기를 달리하고, 모서리에 덧댄 판을 붙인다. 두 번째 변형에는 사과가 담겨 있다. */
export function buildCrate(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 41 + 9);
  const k = new Kit();
  const s = 0.16;
  const plank = s / 3;
  k.add('wood', box(s, s, s, 3, 3, 3), {
    position: [0, s / 2, 0],
    color: '#c7a070',
    faceShade: (c, n) => {
      // 옆면 판자는 가로로, 윗면 판자는 앞뒤로 놓인다.
      const u = Math.abs(n.y) > 0.5 ? c.x + s / 2 : c.y;
      const i = Math.min(2, Math.max(0, Math.floor(u / plank)));
      const face = Math.round(n.x) * 3 + Math.round(n.y) * 5 + Math.round(n.z) * 7;
      return [0.9, 1.05, 0.96][i] * (0.94 + 0.1 * hash3(i, face, variant));
    },
  });
  const t = 0.022;
  for (const y of [t / 2, s - t / 2]) {
    for (const z of [-s / 2, s / 2]) k.add('wood', box(s + 0.008, t, t), { position: [0, y, z], color: '#7d5733' });
    for (const x of [-s / 2, s / 2]) k.add('wood', box(t, t, s + 0.008), { position: [x, y, 0], color: '#7d5733' });
  }
  if (variant === 1) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 6) * Math.PI * 2 + rand();
      const d = i === 6 ? 0 : 0.04;
      k.add('paint', new THREE.SphereGeometry(0.02, 7, 5), {
        position: [Math.cos(a) * d, s + 0.008 + (i === 6 ? 0.018 : 0), Math.sin(a) * d],
        color: rand() > 0.4 ? '#b8322a' : '#8fae3c',
        shade: (_p, n) => skyShade(n, 0.6, 1.1),
      });
    }
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
  const k = new Kit();
  addBarrel(k, [0, 0, 0], 1, seed);
  return k.build(0.15, 0.7);
}

/** 시장 광장 가운데 우물: 돌을 쌓은 테두리, 나무 기둥과 널 지붕, 굴대에 감은 밧줄과 두레박 */
export function buildWell(): PropPart[] {
  const k = new Kit();
  // 돌 테두리: 둥근 벽을 칸으로 나눠 돌마다 밝기를 달리한다 (돌 하나가 두 칸, 줄마다 한 칸씩 어긋나게).
  const segs = 16;
  const rows = 3;
  const wallH = 0.17;
  k.add('stone', new THREE.CylinderGeometry(0.16, 0.175, wallH, segs, rows), {
    position: [0, wallH / 2, 0],
    uv: 'native',
    uvScale: 1.5,
    faceShade: (c, n) => {
      if (Math.abs(n.y) > 0.7) return 1;
      const row = Math.min(rows - 1, Math.max(0, Math.floor((c.y / wallH) * rows)));
      const a = (Math.atan2(c.x, c.z) + Math.PI * 2) % (Math.PI * 2);
      const seg = Math.floor(a / ((Math.PI * 2) / segs));
      return 0.78 + 0.32 * hash3(Math.floor((seg + (row % 2)) / 2), row, 9);
    },
  });
  k.add('stone', new THREE.TorusGeometry(0.158, 0.026, 6, 16), { position: [0, 0.17, 0], rotation: [Math.PI / 2, 0, 0], color: '#e4e0d8' });
  k.add('dark', new THREE.CircleGeometry(0.13, 14), { position: [0, 0.172, 0], rotation: [-Math.PI / 2, 0, 0], color: '#2c4a5a' });
  for (const x of [-0.16, 0.16]) k.add('wood', box(0.032, 0.42, 0.032), { position: [x, 0.38, 0], color: TIMBER });
  // 널 지붕: 단마다 판을 겹친다.
  const slope = 0.62;
  for (const side of [1, -1] as const) addShingles(k, 'wood', [0, 0.665, 0], side, slope, 0.21, 0.46, 3, side === 1 ? 21 : 22, '#8f6238');
  k.add('wood', box(0.48, 0.03, 0.04), { position: [0, 0.675, 0], color: '#6b4a2a' });
  // 굴대, 감아 둔 밧줄, 손잡이
  k.add('wood', cyl(0.014, 0.014, 0.4, 6), { position: [0.02, 0.48, 0], rotation: alongX(), color: '#6b4a2a' });
  k.add('cloth', cyl(0.024, 0.024, 0.06, 10), { position: [0.06, 0.48, 0], rotation: alongX(), color: '#a8875a' });
  k.add('wood', box(0.012, 0.07, 0.012), { position: [0.215, 0.455, 0], color: '#6b4a2a' });
  k.add('wood', cyl(0.007, 0.007, 0.05, 5), { position: [0.235, 0.425, 0], rotation: alongX(), color: '#8a6238' });
  // 늘어뜨린 밧줄과 두레박
  k.add('cloth', cyl(0.004, 0.004, 0.13, 4), { position: [0.06, 0.4, 0.02], color: '#a8875a' });
  k.add('wood', cyl(0.042, 0.036, 0.07, 10), { position: [0.06, 0.3, 0.02], color: '#8a5f36' });
  k.add('metal', cyl(0.044, 0.044, 0.012, 10, true), { position: [0.06, 0.32, 0.02] });
  k.add('metal', new THREE.TorusGeometry(0.038, 0.004, 4, 10, Math.PI), { position: [0.06, 0.335, 0.02] });
  return k.build(0.25, 0.7);
}

// ───────────────────────── 강가 (지금은 보드에 놓지 않는다) ─────────────────────────

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

// ───────────────────────── 양모 (목초지) ─────────────────────────

/** 양: 0 = 고개 숙여 풀 뜯는 양, 1 = 고개 든 양, 2 = 엎드린 양. 머리는 +x 쪽을 본다. */
export function buildSheep(variant = 0): PropPart[] {
  const k = new Kit();
  const lying = variant === 2;
  const grazing = variant === 0;
  const bodyY = lying ? 0.07 : 0.118;
  const fluffy = (_p: THREE.Vector3, n: THREE.Vector3) => skyShade(n, 0.74, 1.06);
  // 털: 울퉁불퉁한 덩어리를 앞뒤로 길게 늘인 몸통과 엉덩이 쪽 털뭉치
  k.add('fleece', blob(0.085, 2, 30 + variant, 0.3), { position: [0, bodyY, 0], scale: [1.38, lying ? 0.78 : 0.95, 0.98], shade: fluffy });
  k.add('fleece', blob(0.05, 1, 40 + variant, 0.3), { position: [-0.1, bodyY + 0.025, 0], shade: fluffy });
  // 짙은 얼굴, 귀, 이마 털
  const head: Vec3 = grazing ? [0.142, 0.058, 0] : lying ? [0.13, 0.112, 0.012] : [0.15, 0.168, 0];
  const tilt = grazing ? -0.75 : 0.28;
  k.add('dark', new THREE.SphereGeometry(0.036, 10, 8), { position: head, scale: [1.4, 0.92, 0.84], rotation: [0, 0, tilt], shade: (_p, n) => skyShade(n, 0.7, 1.15) });
  for (const side of [1, -1]) {
    k.add('dark', new THREE.SphereGeometry(0.016, 6, 5), { position: [head[0] - 0.022, head[1] + 0.018, side * 0.036], scale: [1.6, 0.55, 0.9], rotation: [side * 0.5, 0, 0] });
  }
  k.add('fleece', blob(0.026, 1, 50 + variant, 0.3), { position: [head[0] - 0.03, head[1] + 0.03, 0], shade: fluffy });
  if (!lying) {
    for (const [x, z] of [
      [0.07, 0.042],
      [0.07, -0.042],
      [-0.075, 0.042],
      [-0.075, -0.042],
    ]) {
      k.add('dark', cyl(0.011, 0.009, 0.085, 6), { position: [x, 0.042, z] });
    }
  }
  return k.build(0.1, 0.72);
}

/** 나무 울타리 한 칸 (길이 0.6): 기둥 셋, 가로대 둘 */
export function buildFence(seed = 1): PropPart[] {
  const rand = mulberry32(seed);
  const k = new Kit();
  const L = 0.6;
  for (let i = 0; i < 3; i++) {
    const h = 0.17 + rand() * 0.035;
    k.add('wood', cyl(0.014, 0.017, h, 6), {
      position: [-L / 2 + (i * L) / 2, h / 2, 0],
      rotation: [(rand() - 0.5) * 0.14, 0, (rand() - 0.5) * 0.14],
      color: '#8a6238',
      uv: 'native',
    });
  }
  for (const y of [0.075, 0.135]) {
    k.add('wood', box(L + 0.05, 0.022, 0.016), {
      position: [0, y + (rand() - 0.5) * 0.012, 0.014],
      rotation: [0, 0, (rand() - 0.5) * 0.06],
      color: new THREE.Color('#9a6e40').multiplyScalar(0.9 + rand() * 0.15),
    });
  }
  return k.build(0.1, 0.7);
}

/** 물 여물통 */
export function buildTrough(): PropPart[] {
  const k = new Kit();
  k.add('wood', box(0.28, 0.07, 0.11), { position: [0, 0.055, 0], color: '#8a6238' });
  k.add('paint', box(0.24, 0.004, 0.075), { position: [0, 0.092, 0], color: '#6f9fb3' });
  for (const x of [-0.11, 0.11]) k.add('wood', box(0.025, 0.03, 0.13), { position: [x, 0.015, 0], color: '#6b4a2a' });
  return k.build(0.08, 0.7);
}

// ───────────────────────── 벽돌 (점토 구덩이) ─────────────────────────

/** 벽돌 줄눈: 높이로 켜를 나누고 켜마다 반 장씩 어긋나게 밝기를 바꾼다 */
function brickCourses(c: THREE.Vector3, n: THREE.Vector3, courseH = 0.028): number {
  const course = Math.floor(c.y / courseH);
  const a = Math.atan2(c.z, c.x) * 6 + (course % 2) * 0.5;
  const s = (Math.floor(a) + course) % 2 ? 0.9 : 1.0;
  return s * skyShade(n, 0.72, 1.08);
}

/** 벽돌 굽는 둥근 가마: 원통 벽 위에 돔, 앞쪽 아궁이에 불빛, 꼭대기 연기 구멍, 옆에 장작 */
export function buildKiln(): PropPart[] {
  const k = new Kit();
  const R = 0.24;
  k.add('brick', cyl(R, R * 1.05, 0.17, 18), { position: [0, 0.085, 0], flat: true, faceShade: (c, n) => brickCourses(c, n) });
  k.add('brick', new THREE.SphereGeometry(R, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), {
    position: [0, 0.17, 0],
    flat: true,
    faceShade: (c, n) => brickCourses(c, n),
  });
  // 아궁이: 어두운 아치 안에 주황 불빛
  k.add('dark', new THREE.CircleGeometry(0.075, 14, 0, Math.PI), { position: [0, 0.085, R + 0.012] });
  k.add('dark', box(0.15, 0.085, 0.01), { position: [0, 0.043, R + 0.006] });
  k.add('paint', new THREE.CircleGeometry(0.045, 12, 0, Math.PI), { position: [0, 0.03, R + 0.016], color: '#f08a3c' });
  k.add('brick', new THREE.TorusGeometry(0.083, 0.016, 5, 12, Math.PI), { position: [0, 0.085, R + 0.012], color: '#d88a62' });
  // 연기 구멍
  k.add('brick', cyl(0.05, 0.065, 0.07, 12), { position: [0, 0.17 + R - 0.01, 0], color: '#c9744e', faceShade: (_c, n) => skyShade(n, 0.7, 1.05) });
  k.add('dark', new THREE.CircleGeometry(0.036, 12), { position: [0, 0.17 + R + 0.026, 0], rotation: [-Math.PI / 2, 0, 0] });
  // 옆에 쌓은 장작
  for (let i = 0; i < 5; i++) {
    const row = i < 3 ? 0 : 1;
    const x = 0.3 + (row ? (i - 3.5) : i - 1) * 0.038;
    k.add('wood', cyl(0.018, 0.018, 0.2, 7), { position: [x, 0.02 + row * 0.033, 0.12], rotation: [Math.PI / 2, 0, 0], color: '#8f6238', uv: 'native' });
  }
  return k.build(0.18, 0.62);
}

/** 깔판 위에 엇갈려 쌓은 벽돌 더미. 변형 1은 한 켜 낮고 위쪽이 덜 찼다. 변형 2는 여덟 켜로 높이 쌓았다. */
export function buildBrickStack(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 31 + 3);
  const k = new Kit();
  k.add('wood', box(0.36, 0.028, 0.26), { position: [0, 0.014, 0], color: '#8a6238' });
  const layers = variant === 0 ? 4 : variant === 1 ? 3 : 8;
  const bh = 0.034;
  for (let l = 0; l < layers; l++) {
    const y = 0.028 + bh / 2 + l * bh;
    const top = l === layers - 1;
    const alongX = l % 2 === 0;
    const cols = alongX ? 4 : 8;
    const rows = alongX ? 5 : 2;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (top && variant === 1 && rand() < 0.45) continue;
        const x = alongX ? -0.128 + i * 0.085 : -0.147 + i * 0.042;
        const z = alongX ? -0.09 + j * 0.045 : -0.045 + j * 0.09;
        const tone = 0.84 + rand() * 0.22;
        k.add('brick', alongX ? box(0.08, bh - 0.004, 0.04) : box(0.038, bh - 0.004, 0.085), {
          position: [x, y, z],
          rotation: [0, (rand() - 0.5) * 0.06, 0],
          color: new THREE.Color(rand() < 0.15 ? '#d48a62' : '#ffffff').multiplyScalar(tone),
          flat: true,
          faceShade: (_c, n) => skyShade(n, 0.7, 1.06),
        });
      }
    }
  }
  return k.build(0.12, 0.66);
}

/** 캐낸 진흙 무더기. 변형 0에는 삽이 꽂혀 있다. */
export function buildClayMound(variant = 0): PropPart[] {
  const k = new Kit();
  const g = blob(0.16, 2, 60 + variant, 0.35);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setY(i, y < 0 ? y * 0.15 : y * 0.62);
  }
  k.add('clay', g, { position: [0, 0.02, 0], scale: [1.25, 1, 1], color: '#bb8466', shade: (_p, n) => skyShade(n, 0.66, 1.06) });
  if (variant === 0) {
    k.add('wood', cyl(0.009, 0.009, 0.3, 6), { position: [0.05, 0.2, 0.02], rotation: [0.3, 0, -0.25], color: '#9a6e40' });
    k.add('metal', box(0.07, 0.085, 0.008), { position: [0.012, 0.075, -0.02], rotation: [0.3, 0, -0.25] });
  }
  return k.build(0.1, 0.66);
}

// ───────────────────────── 기사단 동상, 잠금 사슬, 교역로 부두 ─────────────────────────

const STATUE_STONE = (c: THREE.Vector3, n: THREE.Vector3): Shade => (Math.floor(c.y / 0.045) % 2 ? 0.92 : 1.03) * skyShade(n, 0.64, 1.08);

/**
 * 기사단 동상: 팔각 돌 받침 위에서 칼끝을 땅에 짚고 두 손을 칼자루에 얹은 기사.
 * 붉은 망토와 푸른 겉옷, 금빛 장식이라 숲·밭·채석장 어느 땅 위에서도 눈에 띈다. 얼굴은 +z(카메라) 쪽을 본다.
 */
export function buildStatue(): PropPart[] {
  const k = new Kit();
  // 받침: 넓은 아랫단, 좁은 윗단, 처마돌, 앞면 놋쇠 명판
  k.add('stone', cyl(0.25, 0.27, 0.07, 8), { position: [0, 0.035, 0], rotation: [0, Math.PI / 8, 0], flat: true, faceShade: STATUE_STONE, color: '#a39d90' });
  k.add('stone', cyl(0.185, 0.205, 0.13, 8), { position: [0, 0.135, 0], rotation: [0, Math.PI / 8, 0], flat: true, faceShade: STATUE_STONE, color: '#bdb7a8' });
  k.add('stone', cyl(0.215, 0.195, 0.03, 8), { position: [0, 0.215, 0], rotation: [0, Math.PI / 8, 0], flat: true, faceShade: (_c, n) => skyShade(n, 0.7, 1.1), color: '#d2ccbc' });
  k.add('paint', box(0.13, 0.055, 0.008), { position: [0, 0.135, 0.19], color: '#c9a43a' });
  k.add('dark', box(0.09, 0.008, 0.004), { position: [0, 0.142, 0.195] });
  k.add('dark', box(0.07, 0.008, 0.004), { position: [0, 0.126, 0.195] });
  const base = 0.23;
  const steel = '#a3aab3';
  const steelDark = '#6e757f';
  const gold = '#d0a83c';
  // 다리와 쇠장화
  for (const x of [-0.05, 0.05]) {
    k.add('paint', cyl(0.034, 0.038, 0.19, 8), { position: [x, base + 0.095, 0], color: steelDark, shade: (_p, n) => skyShade(n, 0.7, 1.08) });
    k.add('paint', box(0.06, 0.035, 0.09), { position: [x, base + 0.018, 0.015], color: '#4f5560' });
  }
  // 망토: 어깨에서 등 뒤로 넓게 퍼지며 바닥 가까이 내려온다.
  const cape = box(0.25, 0.36, 0.02, 4, 6, 1);
  warp(cape, (v) => {
    const t = (0.18 - v.y) / 0.36; // 위 0 → 아래 1
    v.x *= 0.78 + 0.32 * t;
    v.z -= 0.06 * t * t + 0.018 * Math.cos(v.x * 30) * t;
  });
  k.add('paint', cape, { position: [0, base + 0.24, -0.075], color: '#a3302a', shade: (p, n) => skyShade(n, 0.62, 1.05) * (0.86 + 0.18 * smoothstep(base + 0.05, base + 0.42, p.y)) });
  // 몸통 갑옷과 푸른 겉옷 (앞자락에 금빛 띠)
  k.add('paint', cyl(0.085, 0.1, 0.21, 10), { position: [0, base + 0.29, 0], color: steel, shade: (_p, n) => skyShade(n, 0.66, 1.1) });
  k.add('paint', box(0.16, 0.2, 0.03), { position: [0, base + 0.275, 0.085], color: '#2f4f86', faceShade: (_c, n) => skyShade(n, 0.7, 1.06) });
  k.add('paint', box(0.03, 0.2, 0.034), { position: [0, base + 0.275, 0.087], color: gold });
  k.add('paint', box(0.17, 0.025, 0.12), { position: [0, base + 0.2, 0.02], color: '#5a3b20' });
  // 어깨 갑옷
  for (const x of [-0.105, 0.105]) {
    k.add('paint', new THREE.SphereGeometry(0.048, 10, 8), { position: [x, base + 0.385, 0], scale: [1, 0.8, 1], color: steel, shade: (_p, n) => skyShade(n, 0.62, 1.12) });
  }
  // 팔: 어깨에서 앞쪽 칼자루로 모인다.
  const hands = new THREE.Vector3(0, base + 0.27, 0.13);
  for (const x of [-0.1, 0.1]) {
    const sh = new THREE.Vector3(x, base + 0.37, 0.01);
    const dir = hands.clone().sub(sh);
    const mid = sh.clone().addScaledVector(dir, 0.5);
    k.add('paint', cyl(0.024, 0.03, dir.length(), 7), { position: [mid.x, mid.y, mid.z], rotation: aim(dir.x, dir.y, dir.z), color: steel, shade: (_p, n) => skyShade(n, 0.66, 1.1) });
  }
  k.add('paint', new THREE.SphereGeometry(0.034, 8, 6), { position: [0, hands.y, hands.z], scale: [1.5, 1, 1], color: steelDark });
  // 칼: 칼끝은 받침에 닿고 칼자루는 두 손 사이
  k.add('paint', box(0.026, 0.2, 0.008), { position: [0, base + 0.1, 0.14], color: '#e4e8ee', faceShade: (_c, n) => skyShade(n, 0.8, 1.1) });
  k.add('paint', new THREE.ConeGeometry(0.018, 0.03, 4), { position: [0, base - 0.004, 0.14], rotation: [Math.PI, Math.PI / 4, 0], scale: [1, 1, 0.3], color: '#e4e8ee' });
  k.add('paint', box(0.13, 0.018, 0.022), { position: [0, base + 0.205, 0.14], color: gold });
  k.add('paint', new THREE.SphereGeometry(0.019, 8, 6), { position: [0, base + 0.315, 0.135], color: gold });
  // 방패: 왼쪽 옆구리에 비스듬히 기대 세운 연 모양 방패
  const kite = new THREE.Shape();
  kite.moveTo(-0.07, 0.07);
  kite.lineTo(0.07, 0.07);
  kite.quadraticCurveTo(0.075, -0.03, 0, -0.12);
  kite.quadraticCurveTo(-0.075, -0.03, -0.07, 0.07);
  const shield = new THREE.ExtrudeGeometry(kite, { depth: 0.014, bevelEnabled: false });
  shield.translate(0, 0, -0.007);
  k.add('paint', shield, { position: [-0.15, base + 0.16, 0.05], rotation: [0.05, -0.9, 0.12], color: '#2f4f86', flat: true, faceShade: (_c, n) => skyShade(n, 0.68, 1.08) });
  const band = box(0.026, 0.17, 0.018);
  k.add('paint', band, { position: [-0.149, base + 0.155, 0.051], rotation: [0.05, -0.9, 0.12], color: gold });
  // 머리: 투구, 눈구멍, 붉은 깃털 장식
  k.add('paint', cyl(0.05, 0.03, 0.03, 8), { position: [0, base + 0.405, 0], color: steelDark });
  k.add('paint', cyl(0.058, 0.062, 0.09, 12), { position: [0, base + 0.46, 0], color: steel, shade: (_p, n) => skyShade(n, 0.66, 1.12) });
  k.add('paint', new THREE.SphereGeometry(0.058, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { position: [0, base + 0.505, 0], color: steel, shade: (_p, n) => skyShade(n, 0.7, 1.15) });
  k.add('dark', box(0.075, 0.011, 0.01), { position: [0, base + 0.47, 0.058] });
  k.add('dark', box(0.011, 0.04, 0.01), { position: [0, base + 0.45, 0.06] });
  k.add('paint', new THREE.SphereGeometry(0.03, 8, 6), { position: [0, base + 0.585, -0.012], scale: [0.55, 1.5, 1.4], color: '#c23a2e', shade: (_p, n) => skyShade(n, 0.7, 1.1) });
  return k.build(0.22, 0.72);
}

/** 사열하는 병사의 오른쪽 어깨 자리: 칼 든 팔(buildSoldierArm)을 여기에 붙여 x 축으로 돌린다. */
export const SOLDIER_SHOULDER: Vec3 = [0.08, 0.328, 0];
/** 칼 든 팔에서 어깨부터 칼끝까지 거리 */
export const SOLDIER_REACH = 0.43;

/** 두 점을 잇는 원기둥 (팔다리 마디) */
function limb(k: Kit, from: Vec3, to: Vec3, r0: number, r1: number, color: string): void {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const mid = a.clone().addScaledVector(dir, 0.5);
  k.add('paint', cyl(r1, r0, dir.length(), 7), {
    position: [mid.x, mid.y, mid.z],
    rotation: aim(dir.x, dir.y, dir.z),
    color,
    shade: (_p, n) => skyShade(n, 0.66, 1.1),
  });
}

/**
 * 사열하는 병사: 최강 기사단 연출에서 빈 광장에 줄지어 서는 기사단 병사. 차렷 자세로 서서 왼팔에 연 모양 방패를 들었다.
 * 겉옷·망토·방패·투구 깃털은 지붕 재질이라 플레이어 색이 곱해진다. 칼 든 오른팔은 따로 만들어(buildSoldierArm) 어깨에서 돌린다.
 * 원점 = 두 발 사이 바닥, 얼굴은 +z. 깃털 끝까지 키 약 0.54.
 */
export function buildSoldier(): PropPart[] {
  const k = new Kit();
  const steel = '#a3aab3';
  const steelDark = '#6e757f';
  const gold = '#d0a83c';
  const round = (_p: THREE.Vector3, n: THREE.Vector3) => skyShade(n, 0.66, 1.1);
  const hip = 0.17;
  // 다리와 쇠장화
  for (const x of [-0.036, 0.036]) {
    limb(k, [x, 0.025, 0], [x, hip, 0], 0.026, 0.03, steelDark);
    k.add('paint', box(0.045, 0.035, 0.075), { position: [x, 0.017, 0.012], color: '#4f5560' });
  }
  // 몸통 갑옷과 허리띠
  k.add('paint', cyl(0.062, 0.07, 0.17, 10), { position: [0, hip + 0.085, 0], color: steel, shade: round });
  k.add('paint', cyl(0.076, 0.076, 0.024, 10), { position: [0, hip + 0.012, 0], color: '#5a3b20' });
  // 겉옷 (플레이어 색): 허벅지까지 내려오는 앞판과 뒤판, 앞판 가운데 금빛 십자
  k.add('roof', box(0.112, 0.21, 0.02), { position: [0, hip + 0.05, 0.064], shade: round });
  k.add('roof', box(0.112, 0.19, 0.02), { position: [0, hip + 0.06, -0.064], shade: round });
  k.add('paint', box(0.022, 0.12, 0.024), { position: [0, hip + 0.1, 0.068], color: gold });
  k.add('paint', box(0.075, 0.02, 0.024), { position: [0, hip + 0.125, 0.068], color: gold });
  // 망토 (플레이어 색): 어깨에서 등 뒤로 퍼지며 종아리까지 내려온다.
  const capeH = 0.27;
  const cape = box(0.17, capeH, 0.016, 4, 6, 1);
  warp(cape, (v) => {
    const t = (capeH / 2 - v.y) / capeH; // 위 0 → 아래 1
    v.x *= 0.8 + 0.35 * t;
    v.z -= 0.05 * t * t;
  });
  k.add('roof', cape, { position: [0, 0.34 - capeH / 2, -0.084], shade: (p, n) => skyShade(n, 0.62, 1.05) * (0.84 + 0.2 * smoothstep(0.08, 0.34, p.y)) });
  // 어깨 갑옷
  for (const x of [-SOLDIER_SHOULDER[0], SOLDIER_SHOULDER[0]]) {
    k.add('paint', new THREE.SphereGeometry(0.042, 10, 8), { position: [x, SOLDIER_SHOULDER[1], 0], scale: [1, 0.8, 1], color: steel, shade: round });
  }
  // 왼팔: 팔꿈치를 굽혀 방패를 앞으로 든다.
  const elbow: Vec3 = [-0.1, 0.245, 0.01];
  const hand: Vec3 = [-0.1, 0.225, 0.075];
  limb(k, [-SOLDIER_SHOULDER[0], SOLDIER_SHOULDER[1] - 0.005, 0], elbow, 0.026, 0.023, steel);
  limb(k, elbow, hand, 0.023, 0.021, steel);
  // 연 모양 방패 (플레이어 색), 가운데 금빛 띠와 둥근 징
  const kite = new THREE.Shape();
  kite.moveTo(-0.06, 0.065);
  kite.lineTo(0.06, 0.065);
  kite.quadraticCurveTo(0.065, -0.03, 0, -0.11);
  kite.quadraticCurveTo(-0.065, -0.03, -0.06, 0.065);
  const shield = new THREE.ExtrudeGeometry(kite, { depth: 0.014, bevelEnabled: false });
  shield.translate(0, 0, -0.007);
  const sAt: Vec3 = [-0.118, 0.215, 0.09];
  const sRot: Vec3 = [0.06, -0.55, 0.05];
  k.add('roof', shield, { position: sAt, rotation: sRot, flat: true, faceShade: (_c, n) => skyShade(n, 0.7, 1.1) });
  k.add('paint', box(0.022, 0.15, 0.018), { position: [sAt[0] - 0.003, sAt[1] - 0.012, sAt[2] + 0.006], rotation: sRot, color: gold });
  k.add('paint', new THREE.SphereGeometry(0.016, 8, 6), { position: [sAt[0] - 0.006, sAt[1], sAt[2] + 0.014], color: gold });
  // 머리: 투구, 눈 틈, 플레이어 색 깃털
  k.add('paint', cyl(0.035, 0.04, 0.03, 8), { position: [0, 0.355, 0], color: steelDark });
  k.add('paint', cyl(0.05, 0.054, 0.075, 12), { position: [0, 0.4, 0], color: steel, shade: round });
  k.add('paint', new THREE.SphereGeometry(0.05, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { position: [0, 0.437, 0], color: steel, shade: round });
  k.add('dark', box(0.066, 0.01, 0.01), { position: [0, 0.41, 0.051] });
  k.add('dark', box(0.01, 0.034, 0.01), { position: [0, 0.392, 0.053] });
  k.add('roof', new THREE.SphereGeometry(0.028, 8, 6), { position: [0, 0.495, -0.014], scale: [0.55, 1.5, 1.45], shade: round });
  return k.build(0.12, 0.72);
}

/**
 * 사열하는 병사의 칼 든 오른팔: 어깨가 원점이고 팔과 칼날이 +z 로 곧게 뻗는다.
 * 어깨에서 x 축으로 돌려, 칼끝을 앞쪽 아래로 내린 차렷 자세에서 하늘로 치켜드는 경례까지 한다. 칼끝까지 SOLDIER_REACH.
 */
export function buildSoldierArm(): PropPart[] {
  const k = new Kit();
  const round = (_p: THREE.Vector3, n: THREE.Vector3) => skyShade(n, 0.66, 1.1);
  const gold = '#d0a83c';
  k.add('paint', cyl(0.022, 0.026, 0.12, 7), { position: [0, 0, 0.06], rotation: [Math.PI / 2, 0, 0], color: '#a3aab3', shade: round });
  k.add('paint', new THREE.SphereGeometry(0.026, 8, 6), { position: [0, 0, 0.125], color: '#6e757f', shade: round });
  k.add('paint', new THREE.SphereGeometry(0.013, 6, 4), { position: [0, 0, 0.094], color: gold });
  k.add('paint', box(0.078, 0.014, 0.016), { position: [0, 0, 0.158], color: gold });
  k.add('paint', box(0.022, 0.007, 0.235), { position: [0, 0, 0.166 + 0.1175], color: '#e4e8ee', faceShade: (_c, n) => skyShade(n, 0.82, 1.14) });
  k.add('paint', new THREE.ConeGeometry(0.011, 0.03, 4), {
    position: [0, 0, 0.401 + 0.015],
    rotation: [Math.PI / 2, 0, 0],
    scale: [1, 1, 0.32],
    color: '#e4e8ee',
  });
  // 팔이 바닥 가까이 내려와도 어둡게 칠하지 않는다 (어깨가 원점이라 미리 구운 그늘을 쓰지 않는다).
  return k.build(0.01, 1);
}

/**
 * 바닷가 모래 위에 드문드문 놓는 가벼운 소품. 0 볕에 바랜 유목 한 토막, 1 조개껍데기 두 개와 작은 소라, 2 갯그령 한 포기.
 * 흙 땅 테두리가 모래 해변으로 이어져 보이게 하는 장식이라 모두 작고 낮다. 원점 = 모래 바닥.
 */
export function buildShore(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 29 + 5);
  const k = new Kit();
  const round = (_p: THREE.Vector3, n: THREE.Vector3) => skyShade(n, 0.72, 1.08);
  if (variant === 0) {
    // 유목: 껍질이 벗겨지고 볕에 바래 희끗한 통나무. 결을 따라 밝기가 조금씩 다르고 한쪽 끝은 모래에 살짝 묻혔다.
    const len = 0.42;
    k.add('paint', cyl(0.034, 0.046, len, 9), {
      position: [0, 0.028, 0],
      rotation: [0.05, 0, Math.PI / 2 + 0.06],
      color: '#cdc3b2',
      shade: (p, n) => skyShade(n, 0.7, 1.1) * (0.9 + 0.12 * Math.sin(Math.atan2(p.z, p.y - 0.028) * 7)),
    });
    k.add('paint', cyl(0.043, 0.043, 0.006, 9), { position: [len / 2 - 0.012, 0.038, 0], rotation: [0, 0, Math.PI / 2 + 0.06], color: '#e9dfcb' });
    // 부러진 가지 그루터기 둘
    k.add('paint', cyl(0.011, 0.017, 0.12, 6), { position: [0.05, 0.068, 0.03], rotation: aim(0.55, 1, 0.45), color: '#c4b9a6', shade: round });
    k.add('paint', cyl(0.009, 0.013, 0.08, 6), { position: [-0.13, 0.05, -0.028], rotation: aim(-0.6, 0.7, -0.5), color: '#c4b9a6', shade: round });
    return k.build(0.02, 0.86);
  }
  if (variant === 1) {
    // 가리비 두 개(하나는 엎어지고 하나는 기울었다)와 작은 소라 하나
    const scallop = (at: Vec3, yaw: number, tilt: number, r: number, color: string) => {
      const fan = warp(new THREE.CircleGeometry(r, 10, -Math.PI * 0.08, Math.PI * 1.16), (v) => {
        const d = Math.hypot(v.x, v.y) / r;
        v.z = 0.32 * r * (1 - d * d);
      });
      k.add('paint', fan, {
        position: at,
        rotation: [-Math.PI / 2 + tilt, 0, yaw],
        color,
        flat: true,
        // 부챗살 골: 각도마다 밝기를 번갈아
        faceShade: (c, n) => (Math.floor((Math.atan2(c.z - at[2], c.x - at[0]) + Math.PI) * 5) % 2 ? 0.9 : 1.04) * skyShade(n, 0.75, 1.08),
      });
    };
    scallop([-0.04, 0.008, 0.01], 0.4, 0, 0.038, '#f1d5c4');
    scallop([0.045, 0.014, -0.02], -1.1, 0.35, 0.032, '#f3e6d2');
    k.add('paint', new THREE.ConeGeometry(0.016, 0.052, 7), {
      position: [0.0, 0.012, 0.05],
      rotation: [Math.PI / 2, 0, 0.9],
      color: '#e6cfa8',
      shade: (p, n) => skyShade(n, 0.72, 1.08) * (0.88 + 0.14 * Math.sin(p.z * 160)),
    });
    return k.build(0.01, 0.9);
  }
  // 갯그령: 가늘고 긴 잎이 한쪽(바닷바람 쪽)으로 기운 모래 언덕 풀 한 포기. 잎 재질이라 바람에 조금 흔들린다.
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rand() * 0.5;
    const h = 0.11 + rand() * 0.07;
    const lean = 0.35 + rand() * 0.35;
    const blade = new THREE.ConeGeometry(0.008, h, 3);
    blade.translate(0, h / 2, 0);
    k.add('leaf', blade, {
      position: [Math.cos(a) * 0.015, 0, Math.sin(a) * 0.015],
      rotation: aim(Math.cos(a) * 0.25 + lean, 1, Math.sin(a) * 0.25),
      scale: [1, 1, 0.5],
      color: new THREE.Color('#f2e3a2').multiplyScalar(0.9 + rand() * 0.2),
      flat: true,
    });
  }
  return k.build(0.05, 0.8);
}

/** 광장 가운데 둥근 두 단 돌 단: 기사단 동상이 처음 서 있는 자리. 동상이 떠나면 빈 단만 남는다. */
export function buildDais(): PropPart[] {
  const k = new Kit();
  k.add('stone', cyl(0.4, 0.42, 0.04, 20, false), { position: [0, 0.02, 0], flat: true, faceShade: (c, n) => (Math.floor((Math.atan2(c.z, c.x) + Math.PI) * 3) % 2 ? 0.92 : 1.02) * skyShade(n, 0.7, 1.06), color: '#cfc6b2' });
  k.add('stone', cyl(0.3, 0.32, 0.04, 18, false), { position: [0, 0.06, 0], flat: true, faceShade: (c, n) => (Math.floor((Math.atan2(c.z, c.x) + Math.PI) * 2.5) % 2 ? 0.92 : 1.03) * skyShade(n, 0.72, 1.08), color: '#ddd5c2' });
  // 단 둘레의 작은 꽃 화분
  const rand = mulberry32(17);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const at: Vec3 = [Math.cos(a) * 0.36, 0.06, Math.sin(a) * 0.36];
    k.add('clay', cyl(0.035, 0.028, 0.04, 8), { position: at, color: '#c27a52' });
    k.add('leaf', blob(0.035, 1, 40 + i, 0.4), { position: [at[0], 0.095, at[2]] });
    k.add('paint', new THREE.SphereGeometry(0.012, 5, 4), { position: [at[0] + 0.01, 0.12, at[2]], color: rand() < 0.5 ? '#e8c34a' : '#d9645a' });
  }
  return k.build(0.08, 0.75);
}

/**
 * 잠금 사슬: 반지름 1인 타일 육각형(꼭짓점이 앞뒤를 향함)의 여섯 꼭짓점에 쇠말뚝을 박고 그 사이를 사슬로 늘어지게 둘렀다.
 * 화면에서 HEX 반지름에 맞게 키워 쓴다. 기사단 동상이 선 칸에 나타난다.
 */
export function buildChain(): PropPart[] {
  const k = new Kit();
  const corners = Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  });
  const postH = 0.15;
  for (const c of corners) {
    k.add('paint', cyl(0.022, 0.03, postH, 6), { position: [c.x, postH / 2, c.z], color: '#4e535b', flat: true, faceShade: (_c, n) => skyShade(n, 0.7, 1.08) });
    k.add('paint', new THREE.SphereGeometry(0.03, 8, 6), { position: [c.x, postH + 0.01, c.z], color: '#6f757e' });
  }
  const pitch = 0.034;
  for (let s = 0; s < 6; s++) {
    const a = corners[s];
    const b = corners[(s + 1) % 6];
    const len = a.distanceTo(b);
    const n = Math.round(len / pitch);
    const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = a.clone().lerp(b, t);
      const y = postH - 0.012 - 0.06 * 4 * t * (1 - t);
      const link = new THREE.TorusGeometry(0.016, 0.0052, 4, 8);
      link.scale(1.45, 1, 1);
      if (i % 2) link.rotateX(Math.PI / 2);
      // 늘어진 사슬 기울기를 따라 고리를 살짝 기울인다.
      const slope = Math.atan(0.06 * 4 * (1 - 2 * t) / len);
      link.rotateZ(slope);
      k.add('paint', link, { position: [p.x, y, p.z], rotation: [0, yaw, 0], color: i % 2 ? '#8c929b' : '#727881', shade: (_p, nn) => skyShade(nn, 0.66, 1.15) });
    }
  }
  return k.build(0.04, 0.85);
}

/** 큼직한 놋쇠 자물쇠. 바닥에 세워 두고 고리가 사슬에 걸린다. 앞면(+z)에 열쇠 구멍. */
export function buildPadlock(): PropPart[] {
  const k = new Kit();
  const body = box(0.16, 0.13, 0.06, 2, 2, 1);
  warp(body, (v) => {
    // 아래쪽 모서리를 둥글린다.
    if (v.y < 0) v.x *= 0.88;
  });
  k.add('paint', body, { position: [0, 0.065, 0], color: '#d1a73a', flat: true, faceShade: (_c, n) => skyShade(n, 0.72, 1.14) });
  k.add('paint', box(0.17, 0.016, 0.068), { position: [0, 0.128, 0], color: '#a8822a' });
  k.add('paint', new THREE.TorusGeometry(0.05, 0.014, 6, 14, Math.PI), { position: [0, 0.136, 0], color: '#9aa1aa', shade: (_p, n) => skyShade(n, 0.66, 1.15) });
  k.add('dark', new THREE.CircleGeometry(0.017, 10), { position: [0, 0.075, 0.031] });
  k.add('dark', box(0.012, 0.03, 0.004), { position: [0, 0.055, 0.031] });
  k.add('paint', new THREE.RingGeometry(0.019, 0.026, 12), { position: [0, 0.075, 0.032], color: '#f0d27a' });
  return k.build(0.05, 0.85);
}

/**
 * 바다로 뻗은 좁은 잔교: x 방향 길이 1. 밝은 가로 판자 양옆에 짙은 테두리를 대어 물 위에서도 길처럼 또렷하다.
 * 교역로 하나를 땅의 두 꼭짓점과 한 갈래씩 잇는다.
 */
export function buildPier(): PropPart[] {
  const rand = mulberry32(91);
  const k = new Kit();
  const n = 10;
  for (let i = 0; i < n; i++) {
    k.add('paint', box(1 / n - 0.014, 0.026, 0.16), {
      position: [-0.5 + (i + 0.5) / n, 0.06, (rand() - 0.5) * 0.01],
      rotation: [0, (rand() - 0.5) * 0.06, 0],
      color: new THREE.Color('#e2bf8a').multiplyScalar(0.88 + rand() * 0.14),
      flat: true,
      faceShade: (_c, nn) => skyShade(nn, 0.7, 1.06),
    });
  }
  for (const z of [-0.088, 0.088]) k.add('wood', box(1, 0.04, 0.022), { position: [0, 0.058, z], color: '#5e3f22' });
  for (const x of [-0.45, 0, 0.45]) {
    for (const z of [-0.09, 0.09]) {
      k.add('wood', cyl(0.02, 0.024, 0.3, 6), { position: [x, -0.08, z], color: '#5e3f22', uv: 'native' });
      k.add('wood', cyl(0.022, 0.022, 0.03, 6), { position: [x, 0.09, z], color: '#4e341c' });
    }
  }
  return k.build(0.06, 0.85);
}

/** 볕에 말리는 날벽돌: 굽기 전 옅은 흙빛 벽돌을 땅에 줄지어 눕혀 두고, 한쪽에 나무 벽돌 틀. */
export function buildBrickRows(): PropPart[] {
  const rand = mulberry32(29);
  const k = new Kit();
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 6; i++) {
      if (r === 3 && i > 3) continue;
      const tone = 0.86 + rand() * 0.18;
      k.add('clay', box(0.068, 0.028, 0.034), {
        position: [-0.2 + i * 0.08 + (rand() - 0.5) * 0.01, 0.014, -0.09 + r * 0.06 + (rand() - 0.5) * 0.008],
        rotation: [0, (rand() - 0.5) * 0.12, 0],
        color: new THREE.Color('#e8b48e').multiplyScalar(tone),
        flat: true,
        faceShade: (_c, n) => skyShade(n, 0.7, 1.08),
      });
    }
  }
  // 벽돌 틀: 칸이 둘 난 나무틀
  k.add('wood', box(0.17, 0.03, 0.012), { position: [0.18, 0.015, 0.1], color: '#8a6238' });
  k.add('wood', box(0.17, 0.03, 0.012), { position: [0.18, 0.015, 0.152], color: '#8a6238' });
  for (const x of [0.1, 0.18, 0.26]) k.add('wood', box(0.012, 0.03, 0.052), { position: [x, 0.015, 0.126], color: '#7a5532' });
  k.add('clay', box(0.068, 0.02, 0.038), { position: [0.14, 0.012, 0.126], color: '#c48c66' });
  return k.build(0.04, 0.75);
}

// ───────────────────────── 길과 도시 (플레이어 조각) ─────────────────────────

/** 길 판자 윗면 높이 (BoardRenderer 의 교역인 발 높이·길 표식 높이가 이 값을 따른다) */
export const ROAD_DECK_TOP = 0.1;

/**
 * 길: x 방향 길이 1, 폭 0.22 의 굵은 판자길. 실제 보드게임의 나무 길 조각처럼 도톰하게 솟아 멀리서도 누구 길인지 보인다.
 * 판자는 지붕 재질이라 플레이어 색이 곱해지고, 판자 사이 틈으로 짙은 받침목이 비쳐 판자 줄이 또렷하다.
 */
export function buildRoad(): PropPart[] {
  const rand = mulberry32(77);
  const k = new Kit();
  // 짙은 받침목: 판자 틈과 아래 가장자리에 먹선처럼 비친다.
  k.add('dark', box(1, 0.05, 0.19), { position: [0, 0.03, 0] });
  const n = 6;
  const step = 1 / n;
  const plankH = 0.05;
  for (let i = 0; i < n; i++) {
    k.add('roof', box(step - 0.018, plankH, 0.22), {
      position: [-0.5 + step * (i + 0.5), ROAD_DECK_TOP - plankH / 2, (rand() - 0.5) * 0.008],
      rotation: [0, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.02],
      color: new THREE.Color('#ffffff').multiplyScalar((i % 2 ? 0.9 : 1.0) + rand() * 0.08),
      flat: true,
      faceShade: (_c, nn) => skyShade(nn, 0.7, 1.06),
    });
  }
  return k.build(0.05, 0.78);
}

/**
 * 길 이음목: 같은 사람의 길이 꼭짓점에서 만나면 그 자리에 육각 판자 받침을 깔아 길이 끊기지 않고 이어져 보이게 한다.
 * 판자는 길과 같은 지붕 재질이라 플레이어 색이 곱해지고, 둘레에 짙은 나무 테를 둘렀다. 굵어진 길 끝(폭 0.22)을 다 덮고
 * 윗면은 길 판자보다 아주 조금 높다.
 */
export function buildRoadJoint(): PropPart[] {
  const k = new Kit();
  const sector = (c: THREE.Vector3) => Math.floor((Math.atan2(c.z, c.x) + Math.PI) / (Math.PI / 3));
  k.add('roof', cyl(0.13, 0.13, 0.05, 6), {
    position: [0, ROAD_DECK_TOP + 0.005 - 0.025, 0],
    rotation: [0, Math.PI / 6, 0],
    flat: true,
    faceShade: (c, n) => (sector(c) % 2 ? 0.9 : 1.0) * skyShade(n, 0.7, 1.06),
  });
  k.add('dark', cyl(0.145, 0.145, 0.05, 6), { position: [0, 0.035, 0], rotation: [0, Math.PI / 6, 0] });
  return k.build(0.05, 0.78);
}

// ───────────────────────── 도시 ─────────────────────────
// 집 한 채인 마을과 한눈에 갈리도록, 낮은 성벽이 둘러싼 안에 집 여러 채와 높은 탑을 몰아 세운다.
// 앞(카메라 쪽)은 낮게, 뒤로 갈수록 높게 놓아 비스듬히 내려다봐도 지붕이 겹겹이 보인다.
// 플레이어 색은 집 지붕, 성문 탑 고깔, 큰 탑 고깔과 깃발, 종탑 첨탑에 곱해진다.

/** 성벽 둘레(타원 반지름), 높이, 두께. 마을 집보다 한 둘레 넓고 꼭짓점 자리를 크게 벗어나지 않는다. */
const CITY_RX = 0.38;
const CITY_RZ = 0.32;
const CITY_WALL_H = 0.12;
const CITY_WALL_T = 0.05;
const CITY_TRIM = '#d8d0c2';
const LIT_WINDOW = '#e0a052';

/** 켜켜이 쌓은 돌: 높이 course 마다 밝기를 번갈아 바꾼다. 도형의 높이 칸을 course 에 맞춰 나눠 둬야 줄이 곧다. */
function stoneCourses(course: number, y0 = 0): (c: THREE.Vector3, n: THREE.Vector3) => number {
  return (c, n) => (Math.floor((c.y - y0) / course + 1e-4) % 2 ? 0.88 : 1.02) * skyShade(n, 0.68, 1.06);
}

interface TownHouse {
  at: Vec3;
  yaw: number;
  /** 용마루 방향 길이 */
  w: number;
  /** 앞뒤 깊이 */
  d: number;
  /** 처마까지 벽 높이 */
  wall: number;
  /** 처마에서 용마루까지 */
  rise: number;
  /** 돌로 쌓은 아래층 높이 (0 이면 회벽만) */
  stone: number;
  /** 앞면에 창을 내는 층 수 */
  floors: number;
  /** 박공(옆면)에도 창을 낸다: 박공이 카메라 쪽을 보는 집 */
  gableWindows?: boolean;
  /** 회벽 색 (흰 바탕에 곱한다) */
  tone?: string;
  seed: number;
}

/** 성안의 좁고 높은 집: 돌 아래층, 나무 골조 회벽, 불 켜진 창, 지붕널을 덮은 맞배지붕 */
function addTownHouse(k: Kit, h: TownHouse): void {
  const f = new Frame(k, h.at, h.yaw);
  const { w, d, wall, rise, stone } = h;
  const fz = d / 2 + 0.004;
  if (stone > 0) {
    f.add('stone', box(w + 0.012, stone, d + 0.012, 1, 2, 1), { position: [0, stone / 2, 0], flat: true, faceShade: stoneCourses(stone / 2) });
  }
  f.add('plaster', box(w, wall - stone, d, 2, 2, 2), {
    position: [0, stone + (wall - stone) / 2, 0],
    color: h.tone,
    shade: (p, n) => skyShade(n, 0.76, 1.04) * (0.93 + 0.12 * wobble(p.x * 6, p.y * 6, p.z * 6, h.seed)),
  });
  const tri = new THREE.Shape();
  tri.moveTo(-d / 2, 0);
  tri.lineTo(d / 2, 0);
  tri.lineTo(0, rise);
  tri.closePath();
  f.add('plaster', new THREE.ExtrudeGeometry(tri, { depth: w - 0.01, bevelEnabled: false }), {
    position: [-(w - 0.01) / 2, wall, 0],
    rotation: [0, Math.PI / 2, 0],
    color: h.tone,
  });

  // 나무 골조: 앞면 모서리 기둥, 처마 보, 층 사이 보
  const post = 0.016;
  for (const x of [-w / 2, w / 2]) {
    f.add('wood', box(post, wall - stone, post), { position: [x, stone + (wall - stone) / 2, d / 2], color: TIMBER });
  }
  f.add('wood', box(w + post, post, post * 0.7), { position: [0, wall - post / 2, fz], color: TIMBER });
  const floorH = (wall - stone) / h.floors;
  for (let i = 1; i < h.floors; i++) {
    f.add('wood', box(w + post, post * 0.8, post * 0.7), { position: [0, stone + floorH * i, fz], color: TIMBER });
  }

  // 창: 층마다 앞면에 불 켜진 창을 나란히. 맨 아래층(돌이 없을 때)은 문 하나를 낸다.
  const cols = Math.max(1, Math.round(w / 0.075));
  for (let i = 0; i < h.floors; i++) {
    const y = stone + floorH * (i + 0.55);
    for (let j = 0; j < cols; j++) {
      const x = -w / 2 + (w / cols) * (j + 0.5);
      if (i === 0 && stone === 0 && j === 0) {
        f.add('wood', box(0.034, Math.min(0.07, floorH * 0.8), 0.008), { position: [x, Math.min(0.07, floorH * 0.8) / 2, fz], color: '#5a3b20' });
        continue;
      }
      f.add('wood', box(0.034, 0.04, 0.006), { position: [x, y, fz], color: TIMBER });
      f.add('paint', box(0.024, 0.03, 0.006), { position: [x, y, fz + 0.003], color: LIT_WINDOW });
    }
  }
  if (stone > 0) f.add('wood', box(0.036, Math.min(stone * 0.85, 0.075), 0.008), { position: [w * 0.22, Math.min(stone * 0.85, 0.075) / 2, d / 2 + 0.01], color: '#5a3b20' });
  if (h.gableWindows) {
    // 박공 끝(-x 쪽 면)의 창과 박공 삼각 안의 작은 창
    const gx = -w / 2 - 0.004;
    for (let i = 0; i < h.floors; i++) {
      const y = stone + floorH * (i + 0.55);
      f.add('wood', box(0.006, 0.04, 0.034), { position: [gx, y, 0], color: TIMBER });
      f.add('paint', box(0.006, 0.03, 0.024), { position: [gx - 0.003, y, 0], color: LIT_WINDOW });
    }
    f.add('paint', box(0.006, 0.022, 0.02), { position: [gx, wall + rise * 0.35, 0], color: LIT_WINDOW });
  }

  // 지붕 (플레이어 색): 용마루는 집의 길이 방향, 처마를 조금 내민다.
  const slope = Math.atan2(rise, d / 2);
  const slopeLen = Math.hypot(rise, d / 2) + 0.035;
  const roofLen = w + 0.05;
  const apex: Vec3 = [0, wall + rise + 0.022, 0];
  for (const side of [1, -1] as const) addShingles(f, 'roof', apex, side, slope, slopeLen, roofLen, 3, h.seed * 2 + (side === 1 ? 0 : 1));
  f.add('roof', box(roofLen + 0.012, 0.028, 0.036), { position: [0, apex[1] + 0.006, 0], color: '#d8d8d8' });
}

/** 성벽 둘레의 꼭짓점 (앞쪽 가운데가 평평한 변이 되게 돌린 팔각형). 0번과 마지막이 성문 양옆이다. */
function cityWallCorners(n = 8): Vec3[] {
  const corners: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + Math.PI / n + (i * 2 * Math.PI) / n;
    corners.push([Math.cos(a) * CITY_RX, 0, Math.sin(a) * CITY_RZ]);
  }
  return corners;
}

/** 성벽: 꼭짓점마다 작은 망루, 변마다 총안(톱니 모양 여장), 앞쪽 가운데는 성문과 고깔 지붕을 얹은 문탑 둘 */
function addCityWall(k: Kit): void {
  const H = CITY_WALL_H;
  const T = CITY_WALL_T;
  const corners = cityWallCorners();
  const n = corners.length;
  // 앞쪽 변(마지막 → 0번)은 성문이 차지한다.
  for (let i = 0; i < n - 1; i++) {
    const a = corners[i];
    const b = corners[i + 1];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    const f = new Frame(k, [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2], Math.atan2(-dz, dx));
    f.add('stone', box(len, H, T, 1, 3, 1), { position: [0, H / 2, 0], flat: true, faceShade: stoneCourses(H / 3) });
    const m = Math.max(2, Math.round(len / 0.062));
    for (let j = 0; j < m; j++) {
      f.add('stone', box(0.026, 0.026, T), {
        position: [-len / 2 + (len / m) * (j + 0.5), H + 0.013, 0],
        faceShade: (_c, nn) => skyShade(nn, 0.7, 1.08),
      });
    }
  }
  // 모서리 망루 (성문 양옆은 문탑이 선다)
  for (let i = 1; i < n - 1; i++) {
    const [x, , z] = corners[i];
    k.add('stone', new THREE.CylinderGeometry(0.05, 0.054, 0.16, 10, 4), { position: [x, 0.08, z], flat: true, faceShade: stoneCourses(0.04) });
    k.add('stone', cyl(0.06, 0.054, 0.022, 10), { position: [x, 0.171, z], color: CITY_TRIM });
    for (let j = 0; j < 4; j++) {
      const a = (j / 4) * Math.PI * 2 + i;
      k.add('stone', box(0.024, 0.026, 0.024), {
        position: [x + Math.cos(a) * 0.044, 0.195, z + Math.sin(a) * 0.044],
        rotation: [0, -a, 0],
        faceShade: (_c, nn) => skyShade(nn, 0.7, 1.08),
      });
    }
  }

  // 성문: 앞쪽 변을 막는 문루, 아치 모양으로 뚫린 문, 활짝 연 나무 문짝
  const left = corners[0];
  const right = corners[n - 1];
  const gz = left[2];
  const gw = right[0] - left[0];
  const gh = 0.15;
  const gd = T + 0.03;
  k.add('stone', box(gw, gh, gd, 1, 4, 1), { position: [0, gh / 2, gz], flat: true, faceShade: stoneCourses(gh / 4) });
  for (let j = 0; j < 4; j++) {
    k.add('stone', box(0.03, 0.03, gd), { position: [-gw / 2 + (gw / 4) * (j + 0.5), gh + 0.015, gz], faceShade: (_c, nn) => skyShade(nn, 0.7, 1.08) });
  }
  const fz = gz + gd / 2 + 0.003;
  const archW = 0.074;
  const archH = 0.07;
  k.add('stone', box(archW + 0.024, archH, 0.006), { position: [0, archH / 2, fz - 0.001], color: CITY_TRIM });
  k.add('stone', new THREE.CylinderGeometry(archW / 2 + 0.012, archW / 2 + 0.012, 0.006, 12, 1, false, Math.PI / 2, Math.PI), {
    position: [0, archH, fz - 0.001],
    rotation: [Math.PI / 2, 0, 0],
    color: CITY_TRIM,
  });
  k.add('dark', box(archW, archH, 0.006), { position: [0, archH / 2, fz + 0.001] });
  k.add('dark', new THREE.CylinderGeometry(archW / 2, archW / 2, 0.006, 12, 1, false, Math.PI / 2, Math.PI), {
    position: [0, archH, fz + 0.001],
    rotation: [Math.PI / 2, 0, 0],
  });
  for (const s of [-1, 1]) {
    k.add('wood', box(archW / 2, archH * 1.05, 0.008), {
      position: [s * (archW / 2 + 0.012), archH * 0.525, fz + 0.016],
      rotation: [0, s * 0.9, 0],
      color: '#6b4a2a',
    });
  }
  // 문탑: 둥근 돌탑에 플레이어 색 고깔 지붕, 활 쏘는 창
  for (const [x, , z] of [left, right]) {
    k.add('stone', new THREE.CylinderGeometry(0.056, 0.06, 0.22, 10, 5), { position: [x, 0.11, z], flat: true, faceShade: stoneCourses(0.044) });
    k.add('stone', cyl(0.068, 0.061, 0.024, 10), { position: [x, 0.232, z], color: CITY_TRIM });
    k.add('roof', new THREE.ConeGeometry(0.078, 0.13, 10), { position: [x, 0.244 + 0.065, z], flat: true, faceShade: (_c, nn) => skyShade(nn, 0.66, 1.08) });
    k.add('dark', box(0.012, 0.044, 0.006), { position: [x, 0.14, z + 0.06] });
  }
}

/** 성의 큰 탑: 높은 둥근 돌탑에 내민 돌띠, 플레이어 색 고깔 지붕과 깃발 */
function addKeep(k: Kit, at: Vec3): void {
  const f = new Frame(k, at);
  const r = 0.09;
  const h = 0.56;
  f.add('stone', new THREE.CylinderGeometry(r * 0.94, r, h, 12, 8), { position: [0, h / 2, 0], flat: true, faceShade: stoneCourses(h / 8) });
  f.add('stone', cyl(r + 0.016, r * 0.95, 0.036, 12), { position: [0, h + 0.018, 0], color: CITY_TRIM, faceShade: (_c, n) => skyShade(n, 0.7, 1.08) });
  for (const [y, s] of [
    [0.22, 1],
    [0.4, 1.1],
  ] as const) {
    f.add('dark', box(0.024 * s, 0.05 * s, 0.01), { position: [0, y, r * 0.97] });
    f.add('paint', box(0.016 * s, 0.04 * s, 0.006), { position: [0, y, r * 0.97 + 0.004], color: LIT_WINDOW });
  }
  const coneH = 0.27;
  const roofY = h + 0.036;
  f.add('roof', new THREE.ConeGeometry(r + 0.03, coneH, 12), { position: [0, roofY + coneH / 2, 0], flat: true, faceShade: (_c, n) => skyShade(n, 0.66, 1.08) });
  // 깃대와 깃발: 높이 달려 바람에 흔드는 재질이면 깃대에서 떨어져 나가므로, 물결 모양으로 굳힌 지붕 재질(플레이어 색)로 만든다.
  const poleY = roofY + coneH - 0.02;
  const poleH = 0.17;
  f.add('wood', cyl(0.006, 0.007, poleH, 5), { position: [0, poleY + poleH / 2, 0], color: '#5a3b20' });
  const FW = 0.12;
  const FH = 0.065;
  const flag = warp(box(FW, FH, 0.006, 8, 1, 1), (v) => {
    const x = v.x + FW / 2;
    v.z += Math.sin(x * 34) * 0.012 * (x / FW);
    v.y -= x * 0.1;
  });
  f.add('roof', flag, { position: [FW / 2 + 0.004, poleY + poleH - FH / 2 - 0.006, 0], shade: (p) => 0.86 + 0.16 * (0.5 + 0.5 * Math.cos((p.x - at[0]) * 34)) });
  f.add('paint', new THREE.SphereGeometry(0.011, 6, 4), { position: [0, poleY + poleH + 0.006, 0], color: '#d6b25a' });
}

/** 종탑: 네모난 돌탑, 꼭대기에 사방으로 트인 종 칸, 플레이어 색 뾰족 첨탑과 금빛 꼭지 */
function addBellTower(k: Kit, at: Vec3, yaw: number): void {
  const f = new Frame(k, at, yaw);
  const s = 0.11;
  const h = 0.42;
  f.add('stone', box(s, h, s, 1, 8, 1), { position: [0, h / 2, 0], flat: true, faceShade: stoneCourses(h / 8) });
  f.add('stone', box(s + 0.02, 0.02, s + 0.02), { position: [0, h + 0.01, 0], color: CITY_TRIM, faceShade: (_c, n) => skyShade(n, 0.7, 1.08) });
  f.add('stone', box(s + 0.016, 0.016, s + 0.016), { position: [0, h - 0.11, 0], color: CITY_TRIM });
  // 종 칸: 네 면의 어두운 아치 창, 앞면 아래쪽에는 둥근 시계판
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const o = s / 2 + 0.003;
    f.add('dark', box(0.036, 0.06, 0.006), { position: [Math.sin(a) * o, h - 0.05, Math.cos(a) * o], rotation: [0, a, 0] });
  }
  f.add('stone', cyl(0.028, 0.028, 0.008, 12), { position: [0, h - 0.16, s / 2 + 0.003], rotation: [Math.PI / 2, 0, 0], color: '#f4efe4' });
  f.add('dark', box(0.004, 0.022, 0.004), { position: [0, h - 0.152, s / 2 + 0.009] });
  f.add('dark', box(0.016, 0.004, 0.004), { position: [0.006, h - 0.16, s / 2 + 0.009] });
  f.add('wood', box(0.036, 0.07, 0.008), { position: [0, 0.035, s / 2 + 0.003], color: '#5a3b20' });
  // 첨탑: 꼭짓점 넷짜리 원뿔을 45° 돌려 네모 탑에 맞춘다.
  const spireH = 0.28;
  f.add('roof', new THREE.ConeGeometry(s * 0.8, spireH, 4), {
    position: [0, h + 0.02 + spireH / 2, 0],
    rotation: [0, Math.PI / 4, 0],
    flat: true,
    faceShade: (_c, n) => skyShade(n, 0.64, 1.08),
  });
  f.add('paint', new THREE.SphereGeometry(0.013, 6, 4), { position: [0, h + 0.02 + spireH + 0.004, 0], color: '#d6b25a' });
}

/**
 * 도시: 낮은 성벽과 성문 안에 집 세 채, 둥근 큰 탑, 종탑을 몰아 세운 성읍.
 * 마을(집 한 채)보다 둘레가 넓고 탑이 높아 멀리서도 도시인 줄 안다. 지붕·고깔·첨탑·깃발에 플레이어 색이 곱해진다.
 */
export function buildCity(): PropPart[] {
  const k = new Kit();
  // 성안 바닥: 돌을 깐 마당
  k.add('stone', new THREE.CylinderGeometry(1, 1, 0.02, 16), {
    position: [0, 0.01, 0],
    scale: [CITY_RX - 0.02, 1, CITY_RZ - 0.02],
    color: '#c9bea8',
  });
  addCityWall(k);
  // 앞줄은 낮은 집 둘(오른쪽 집은 박공이 앞을 본다), 뒷줄은 높은 집과 탑 둘
  addTownHouse(k, { at: [-0.155, 0, 0.09], yaw: 0.08, w: 0.2, d: 0.15, wall: 0.17, rise: 0.09, stone: 0.06, floors: 1, seed: 3 });
  addTownHouse(k, {
    at: [0.165, 0, 0.075],
    yaw: Math.PI / 2 - 0.06,
    w: 0.18,
    d: 0.15,
    wall: 0.22,
    rise: 0.1,
    stone: 0,
    floors: 2,
    gableWindows: true,
    tone: '#f3dcc0',
    seed: 5,
  });
  addTownHouse(k, { at: [0, 0, -0.07], yaw: -0.04, w: 0.28, d: 0.17, wall: 0.3, rise: 0.12, stone: 0.1, floors: 2, seed: 7 });
  addKeep(k, [-0.18, 0, -0.13]);
  addBellTower(k, [0.2, 0, -0.13], 0.12);
  return k.build(0.1, 0.72);
}

// ───────────────────────── 날아가는 생산물, 길 위 교역인 ─────────────────────────

/** 도형을 바운딩 박스 가운데가 원점에 오게 옮긴다 (날아가며 제자리에서 구르는 소품) */
function centerParts(parts: PropPart[]): PropPart[] {
  const bounds = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    bounds.union(p.geometry.boundingBox!);
  }
  const c = bounds.getCenter(new THREE.Vector3());
  for (const p of parts) {
    p.geometry.translate(-c.x, -c.y, -c.z);
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
  }
  return parts;
}

/** 생산물 소품 번호: 칸에서 마을·도시로 날아가는 자원 모양 (자원 이름은 shared 의 Resource 와 같다) */
export const GOODS_VARIANT = { wood: 0, grain: 1, wool: 2, brick: 3, stone: 4 } as const;

/**
 * 칸에서 마을·도시로 날아가는 생산물. 0 통나무, 1 끈으로 묶은 볏단, 2 작은 양, 3 벽돌 세 장, 4 돌덩이.
 * 가운데가 원점이라 날아가며 제자리에서 구른다. 가장 긴 쪽이 0.25 안팎이다.
 */
export function buildGoods(variant = 0): PropPart[] {
  const rand = mulberry32(variant * 53 + 11);
  const k = new Kit();
  switch (variant) {
    case 0: {
      // 껍질 붙은 통나무 한 토막과 잘린 잔가지. 날아가며 앞뒤로 뒤집혀 밝은 나이테 단면이 번갈아 보인다.
      // 작게 그려도 검은 덩어리로 뭉개지지 않게 껍질을 밝게 칠하고 세로 결마다 밝기를 달리한다.
      const r = 0.064;
      const len = 0.22;
      k.add('bark', cyl(r, r * 0.94, len, 10, true), {
        position: [0, r, 0],
        rotation: alongX(),
        uv: 'native',
        uvScale: 0.6,
        color: new THREE.Color(1.35, 1.22, 1.1),
        faceShade: (c, n) => (Math.floor((Math.atan2(c.z, c.y - r) + Math.PI) * 1.6) % 2 ? 0.86 : 1.04) * skyShade(n, 0.72, 1.1),
      });
      addLogEnd(k, r * 0.98, [len / 2, r, 0], [0, Math.PI / 2, 0], 1.08);
      addLogEnd(k, r * 0.93, [-len / 2, r, 0], [0, -Math.PI / 2, 0], 1.02);
      k.add('bark', cyl(0.013, 0.017, 0.05, 6), { position: [0.03, r * 2 + 0.012, 0.012], rotation: aim(0.35, 1, 0.2), uv: 'native', color: new THREE.Color(1.3, 1.2, 1.1) });
      return centerParts(k.build(0.03, 0.85));
    }
    case 1: {
      // 허리를 끈으로 묶은 볏단: 아래는 줄기, 위로 이삭이 부채처럼 벌어진다.
      const h = 0.16;
      const stalks = warp(new THREE.CylinderGeometry(0.036, 0.042, h, 10, 6), (v) => {
        const t = (v.y + h / 2) / h;
        const waist = 1 - 0.28 * Math.exp(-((t - 0.55) * (t - 0.55)) / 0.02);
        v.x *= waist;
        v.z *= waist;
      });
      stalks.translate(0, h / 2, 0);
      k.add('wheat', stalks, { uv: 'native', shade: (p) => 0.7 + 0.36 * smoothstep(0, h, p.y) });
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + rand() * 0.4;
        const out = 0.4 + rand() * 0.3;
        k.add('wheat', new THREE.OctahedronGeometry(0.016, 0), {
          position: [Math.cos(a) * 0.03, h + 0.025 + rand() * 0.015, Math.sin(a) * 0.03],
          rotation: aim(Math.cos(a) * out, 1, Math.sin(a) * out),
          scale: [0.8, 2.7, 0.8],
          flat: true,
          color: new THREE.Color('#ffffff').multiplyScalar(1.02 + rand() * 0.14),
        });
      }
      k.add('cloth', new THREE.TorusGeometry(0.033, 0.008, 5, 12), { position: [0, h * 0.55, 0], rotation: [Math.PI / 2, 0, 0], color: '#a8875a' });
      return centerParts(k.build(0.04, 0.8));
    }
    case 2:
      // 양모는 고개 든 작은 양이 통째로 날아간다.
      return centerParts(buildSheep(1));
    case 3: {
      // 구운 벽돌 세 장: 아래 두 장을 나란히, 위에 한 장을 엇갈려 얹었다.
      const bw = 0.13;
      const bh = 0.045;
      const bd = 0.06;
      const bricks: [number, number, number, number][] = [
        [0, bh / 2, -0.033, 0.03],
        [0.006, bh / 2, 0.033, -0.04],
        [0, bh * 1.5 + 0.003, 0, Math.PI / 2 + 0.12],
      ];
      for (const [x, y, z, ry] of bricks) {
        k.add('brick', box(bw, bh, bd), {
          position: [x, y, z],
          rotation: [0, ry, 0],
          color: new THREE.Color('#ffffff').multiplyScalar(0.88 + rand() * 0.18),
          flat: true,
          faceShade: (_c, n) => skyShade(n, 0.68, 1.08),
        });
      }
      return centerParts(k.build(0.03, 0.85));
    }
    default: {
      // 쪼아 낸 돌덩이: 큰 덩이에 작은 조각이 붙어 있다.
      k.add('stone', rock(0.085, 1, 31, 0.42), {
        position: [0, 0.07, 0],
        scale: [1.25, 0.85, 1],
        flat: true,
        color: '#ece7dd',
        faceShade: (_c, n) => 0.72 + 0.4 * smoothstep(-0.3, 0.9, n.y),
      });
      k.add('stone', rock(0.045, 0, 47, 0.4), {
        position: [0.09, 0.04, 0.03],
        flat: true,
        color: '#ddd7cc',
        faceShade: (_c, n) => 0.72 + 0.4 * smoothstep(-0.3, 0.9, n.y),
      });
      return centerParts(k.build(0.04, 0.8));
    }
  }
}

/**
 * 길 위를 오가는 교역인: 플레이어 색 옷(지붕 재질이라 플레이어 색이 곱해진다)을 입은 작은 사람.
 * 굵은 길과 큰 집 사이에서 장식으로만 보이도록 다리, 통옷, 얼굴, 색 모자만 둔 단순한 모양이다.
 * 원점 = 발 사이 바닥, 몸 앞쪽은 +x (길 방향 회전을 그대로 쓴다). 키는 약 0.21.
 */
export function buildTrader(): PropPart[] {
  const k = new Kit();
  const round = (_p: THREE.Vector3, n: THREE.Vector3) => skyShade(n, 0.7, 1.08);
  for (const z of [-0.013, 0.013]) k.add('dark', cyl(0.011, 0.012, 0.05, 6), { position: [0, 0.025, z] });
  // 통옷: 아래로 퍼지는 원뿔대 하나
  k.add('roof', cyl(0.026, 0.042, 0.09, 10), { position: [0, 0.093, 0], shade: round });
  k.add('paint', new THREE.SphereGeometry(0.027, 10, 8), { position: [0, 0.163, 0], color: '#e9c29a', shade: round });
  // 색 모자: 위에서 내려다봐도 플레이어 색이 보인다.
  k.add('roof', new THREE.ConeGeometry(0.027, 0.036, 10), { position: [-0.004, 0.206, 0], shade: round });
  return k.build(0.05, 0.8);
}

/**
 * 해상 교역 배: 교역로 부두에 짐을 싣고 들어오는 작은 돛배. 돛은 깃발 재질이라 플레이어 색이 곱해진다.
 * 원점 = 물높이의 배 가운데, 뱃머리는 +x. 길이 약 1.
 */
export function buildShip(): PropPart[] {
  const k = new Kit();
  const hull = box(1.0, 0.16, 0.36, 12, 1, 2);
  const pos = hull.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // 뱃머리(+x)는 뾰족하고 고물(-x)은 조금 뭉툭하다. 위로 갈수록 양 끝이 솟는다.
    const t = Math.abs(x) / 0.5;
    const taper = x > 0 ? 1 - t * t * 0.92 : 1 - t * t * 0.55;
    pos.setZ(i, pos.getZ(i) * taper);
    if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) + t * t * 0.07);
    else pos.setZ(i, pos.getZ(i) * 0.65);
  }
  hull.computeVertexNormals();
  k.add('wood', hull, { position: [0, 0.05, 0], color: '#8f6236', shade: (p, n) => (p.y > 0.09 ? 1.06 : 0.86) * skyShade(n, 0.7, 1.06) });
  k.add('wood', box(0.74, 0.012, 0.26), { position: [0, 0.12, 0], color: '#c49a68' });
  // 뱃전 띠
  k.add('dark', box(0.92, 0.02, 0.012), { position: [-0.02, 0.135, 0.15] });
  k.add('dark', box(0.92, 0.02, 0.012), { position: [-0.02, 0.135, -0.15] });
  // 짐: 통과 상자
  k.add('wood', box(0.14, 0.12, 0.14), { position: [-0.27, 0.19, 0.02], rotation: [0, 0.3, 0], color: '#c7a070' });
  addBarrel(k, [0.2, 0.125, -0.02], 0.65, 3);
  // 돛대, 활대, 네모 돛 (플레이어 색), 꼭대기 작은 깃발
  k.add('wood', cyl(0.014, 0.017, 0.78, 6), { position: [-0.04, 0.5, 0], color: '#6b4a2a' });
  k.add('wood', cyl(0.009, 0.009, 0.5, 5), { position: [-0.02, 0.8, 0], rotation: [Math.PI / 2, 0, 0], color: '#6b4a2a' });
  const sail = warp(new THREE.PlaneGeometry(0.46, 0.4, 6, 4), (v) => {
    // 바람을 받아 앞으로 불룩하다.
    const u = v.x / 0.23;
    const w = (v.y + 0.2) / 0.4;
    v.z = 0.07 * (1 - u * u) * Math.sin(w * Math.PI * 0.9 + 0.2);
  });
  k.add('banner', sail, { position: [-0.0, 0.58, 0], rotation: [0, Math.PI / 2, 0], shade: (_p, n) => 0.85 + 0.2 * Math.abs(n.x) });
  k.add('banner', box(0.1, 0.05, 0.004), { position: [0.01, 0.92, 0] });
  return k.build(0.12, 0.72);
}

/** 소품 종류별로 만들 수 있는 변형 개수 (시드) */
export const PROP_VARIANTS: Record<PropKey, number> = {
  house: 1,
  banner: 1,
  pine: 3,
  oak: 3,
  bush: 2,
  tuft: 2,
  logpile: 2,
  stump: 1,
  wheatrow: 3,
  stook: 2,
  sack: 2,
  boulder: 4,
  pebbles: 2,
  blocks: 1,
  tent: 2,
  crate: 2,
  barrel: 1,
  jug: 1,
  well: 1,
  boat: 1,
  dock: 1,
  reeds: 2,
  sheep: 3,
  fence: 2,
  trough: 1,
  kiln: 1,
  bricks: 3,
  claymound: 2,
  road: 1,
  city: 1,
  statue: 1,
  dais: 1,
  chain: 1,
  padlock: 1,
  pier: 1,
  brickrows: 1,
  roadjoint: 1,
  goods: 5,
  trader: 1,
  ship: 1,
  soldier: 1,
  soldierarm: 1,
  shore: 3,
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
      return buildBush(variant);
    case 'tuft':
      return buildTuft(variant);
    case 'logpile':
      return buildLogPile(seed);
    case 'stump':
      return buildStump();
    case 'wheatrow':
      return buildWheatRow(seed);
    case 'stook':
      return buildStook(seed);
    case 'sack':
      return buildSack(variant);
    case 'boulder':
      return buildBoulder(seed);
    case 'pebbles':
      return buildPebbles(variant);
    case 'blocks':
      return buildBlocks(seed);
    case 'tent':
      return buildTent(variant);
    case 'crate':
      return buildCrate(variant);
    case 'barrel':
      return buildBarrel(seed);
    case 'jug':
      return buildJug();
    case 'well':
      return buildWell();
    case 'boat':
      return buildBoat(seed);
    case 'dock':
      return buildDock();
    case 'reeds':
      return buildReeds(seed);
    case 'sheep':
      return buildSheep(variant);
    case 'fence':
      return buildFence(seed);
    case 'trough':
      return buildTrough();
    case 'kiln':
      return buildKiln();
    case 'bricks':
      return buildBrickStack(variant);
    case 'claymound':
      return buildClayMound(variant);
    case 'road':
      return buildRoad();
    case 'city':
      return buildCity();
    case 'statue':
      return buildStatue();
    case 'dais':
      return buildDais();
    case 'chain':
      return buildChain();
    case 'padlock':
      return buildPadlock();
    case 'pier':
      return buildPier();
    case 'brickrows':
      return buildBrickRows();
    case 'roadjoint':
      return buildRoadJoint();
    case 'goods':
      return buildGoods(variant);
    case 'trader':
      return buildTrader();
    case 'ship':
      return buildShip();
    case 'soldier':
      return buildSoldier();
    case 'soldierarm':
      return buildSoldierArm();
    case 'shore':
      return buildShore(variant);
  }
}

/** GLB 파일 이름: house.glb, pine_1.glb … */
export function propAssetName(key: PropKey, variant: number): string {
  return PROP_VARIANTS[key] > 1 ? `${key}_${variant}` : key;
}

export const PROP_KEYS = Object.keys(PROP_VARIANTS) as PropKey[];
