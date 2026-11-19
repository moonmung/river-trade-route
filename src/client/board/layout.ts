// 보드 배치: 육각 타일 위치, 타일 종류별 소품 배치, 육각 받침, 강줄기, 보드 밖 풍경.
// 모든 배치는 타일 ID를 시드로 정해지므로 모든 기기에서 같은 모습이 된다.
// 타일은 꼭짓점이 위아래(화면 앞뒤)를 향하는 pointy-top 육각형이다.
import * as THREE from 'three';
import type { TileDef, TileKind } from '../../shared/types';
import type { PropKey } from './art/builders';
import { hashString, mulberry32 } from './art/rng';

const SQRT3 = Math.sqrt(3);

/** 타일 육각형의 외접원 반지름 (가운데 → 꼭짓점) */
export const HEX_RADIUS = 1.14;
/** 타일 중심 간격을 정하는 반지름. HEX_RADIUS 보다 커서 타일 사이에 흙길이 생긴다. */
export const HEX_SPACING = 1.25;
/** 타일 가운데 → 옆 변까지 거리 */
export const HEX_APOTHEM = (HEX_RADIUS * SQRT3) / 2;
export const PLATFORM_TOP = 0.22;
export const TILE_THICKNESS = 0.09;
export const TILE_TOP = PLATFORM_TOP + TILE_THICKNESS;
/** 바깥 타일과 받침 가장자리 사이 여백 */
export const PLATFORM_MARGIN = 0.38;
export const WATER_Y = 0.035;

/** 거점(집)과 깃발이 서는 자리 (타일 중심 기준, 앞쪽 오른편) */
export const HOUSE_SLOT = { x: 0.22, z: 0.32 };
export const BANNER_SLOT = { x: -0.18, z: 0.12 };
export const LOT_SIZE = { w: 0.78, d: 0.6 };

export interface Placement {
  key: PropKey;
  variant: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  /** 가로(x) 방향으로만 더 늘이는 배율 (밀 줄 길이 맞추기) */
  stretch?: number;
  /** 세로(y) 방향으로만 더 늘이는 배율 (바위 언덕을 높게) */
  sy?: number;
  /** 접촉 그림자 반지름 (0이면 그림자 없음) */
  shadow: number;
  /** 그림자 가로세로 비율 */
  shadowAspect?: number;
}

export interface BoardMetrics {
  /** 받침(육각형, 꼭짓점이 좌우를 향함)의 외접원 반지름 */
  plinthRadius: number;
  /** 받침이 차지하는 x, z 반폭 */
  halfX: number;
  halfZ: number;
  /** 카메라를 맞출 범위: 타일 꼭짓점까지의 반폭 (받침 테두리는 화면 밖으로 조금 나가도 된다) */
  fitX: number;
  fitZ: number;
  /** 타일 배치 중심 (보드를 원점에 두기 위한 이동량) */
  cx: number;
  cz: number;
}

function rawCenter(t: Pick<TileDef, 'q' | 'r'>): { x: number; z: number } {
  return { x: SQRT3 * HEX_SPACING * (t.q + t.r / 2), z: 1.5 * HEX_SPACING * t.r };
}

/** 타일 육각형의 꼭짓점 (중심 기준). 첫 꼭짓점은 화면 뒤쪽(-z). */
export function hexCorners(radius = HEX_RADIUS): { x: number; z: number }[] {
  return Array.from({ length: 6 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 3;
    return { x: Math.cos(a) * radius, z: Math.sin(a) * radius };
  });
}

export function boardMetrics(tiles: readonly TileDef[]): BoardMetrics {
  const centers = tiles.map(rawCenter);
  const xs = centers.map((c) => c.x);
  const zs = centers.map((c) => c.z);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  // 모든 타일 꼭짓점을 감싸는 가장 작은 육각 받침 (변이 위아래로 평평한 방향)
  const cos30 = SQRT3 / 2;
  let need = 0;
  let fitX = 0;
  let fitZ = 0;
  for (const c of centers) {
    for (const v of hexCorners()) {
      const x = Math.abs(c.x - cx + v.x);
      const z = Math.abs(c.z - cz + v.z);
      need = Math.max(need, z / cos30, (x * cos30 + z * 0.5) / cos30);
      fitX = Math.max(fitX, x);
      fitZ = Math.max(fitZ, z);
    }
  }
  const plinthRadius = need + PLATFORM_MARGIN / cos30;
  return { plinthRadius, halfX: plinthRadius, halfZ: plinthRadius * cos30, fitX, fitZ, cx, cz };
}

export function tileCenter(tile: Pick<TileDef, 'q' | 'r'>, m: BoardMetrics): THREE.Vector3 {
  const c = rawCenter(tile);
  return new THREE.Vector3(c.x - m.cx, TILE_TOP, c.z - m.cz);
}

/** 받침 육각형 안쪽인지 (pad 만큼 넓혀서 판정) */
export function insidePlinth(x: number, z: number, m: BoardMetrics, pad = 0): boolean {
  const cos30 = SQRT3 / 2;
  const R = m.plinthRadius + pad;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  return az <= R * cos30 && ax * cos30 + az * 0.5 <= R * cos30;
}

/** 타일 안에서 z 위치의 가로 반폭 (육각형이 위아래로 좁아지는 것 반영) */
function halfWidthAt(z: number): number {
  return Math.min(HEX_APOTHEM, (HEX_RADIUS - Math.abs(z)) * SQRT3);
}

type Local = Omit<Placement, 'x' | 'y' | 'z'> & { x: number; z: number; y?: number };

/** 거점(집·깃발)이 들어설 앞쪽 오른편 빈터. 모든 생산 칸에서 비워 둔다. */
const CLEARING = { x0: -0.32, x1: 0.64, z0: -0.04, z1: 0.66 };

function inClearing(x: number, z: number, pad: number): boolean {
  return x > CLEARING.x0 - pad && x < CLEARING.x1 + pad && z > CLEARING.z0 - pad && z < CLEARING.z1 + pad;
}

/** 타일 육각형 안쪽인지 (margin 만큼 안으로 들여서 판정) */
function insideHex(x: number, z: number, margin: number): boolean {
  const R = HEX_RADIUS - margin;
  return Math.abs(x) <= (R * SQRT3) / 2 && Math.abs(z) <= R - Math.abs(x) / SQRT3;
}

/** 숲: 뒤쪽 절반을 소나무와 참나무가 빽빽하게 채운다. 앞 왼쪽은 통나무 더미, 앞 오른쪽은 거점 빈터. */
function forest(rand: () => number): Local[] {
  const out: Local[] = [
    { key: 'logpile', variant: 0, x: -0.5, z: 0.42, rotY: 0.12, scale: 0.9, shadow: 0.36, shadowAspect: 1.3 },
    { key: 'stump', variant: 0, x: 0.02, z: 0.84, rotY: 0.6, scale: 1, shadow: 0.12 },
  ];
  const step = 0.31;
  for (let j = -4; j <= 2; j++) {
    for (let i = -4; i <= 4; i++) {
      const x = (i + (j & 1 ? 0.5 : 0)) * step + (rand() - 0.5) * 0.09;
      const z = j * step * 0.86 + (rand() - 0.5) * 0.09;
      const oak = rand() < 0.3;
      const s = (oak ? 0.6 : 0.7) + rand() * 0.24;
      const reach = (oak ? 0.34 : 0.29) * s;
      if (!insideHex(x, z, reach * 0.85)) continue;
      if (z > 0.6 || inClearing(x, z, reach * 0.8)) continue;
      if (x < -0.12 && z > 0.14) continue; // 통나무 더미 자리
      out.push({ key: oak ? 'oak' : 'pine', variant: Math.floor(rand() * 3), x, z, rotY: rand() * 6.28, scale: s, shadow: oak ? 0.38 : 0.31 });
    }
  }
  return out;
}

/** 밭: 육각형을 가득 채우는 밀 고랑. 거점 빈터와 앞 꼭짓점만 비우고 짚단·포대를 둔다. */
function field(rand: () => number): Local[] {
  const out: Local[] = [];
  for (let z = -0.93; z <= 0.62; z += 0.155) {
    const half = halfWidthAt(Math.abs(z) + 0.09) - 0.06;
    if (half < 0.14) continue;
    const x0 = -half;
    let x1 = half;
    if (z > CLEARING.z0 - 0.08 && z < CLEARING.z1 + 0.08) x1 = Math.min(x1, CLEARING.x0 - 0.05);
    const len = x1 - x0;
    if (len < 0.2) continue;
    out.push({ key: 'wheatrow', variant: Math.floor(rand() * 3), x: (x0 + x1) / 2, z, rotY: 0, scale: 1, stretch: len / 1.6, shadow: 0 });
  }
  out.push({ key: 'stook', variant: 0, x: -0.14, z: 0.8, rotY: rand() * 3, scale: 0.92, shadow: 0.13 });
  out.push({ key: 'sack', variant: 0, x: 0.12, z: 0.8, rotY: rand() * 3, scale: 0.95, shadow: 0.12 });
  out.push({ key: 'sack', variant: 1, x: 0.27, z: 0.74, rotY: rand() * 3, scale: 0.9, shadow: 0.11 });
  return out;
}

/** 채석장: 뒤쪽에 높이 솟은 바위 언덕, 앞쪽에 잘라 낸 돌덩이와 자갈 */
function quarry(rand: () => number): Local[] {
  const r = () => rand() * 6.28;
  return [
    { key: 'boulder', variant: 0, x: -0.42, z: -0.5, rotY: r(), scale: 1.65, sy: 1.5, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.08, z: -0.66, rotY: r(), scale: 1.85, sy: 1.75, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: 0.5, z: -0.38, rotY: r(), scale: 1.5, sy: 1.4, shadow: 0.24 },
    { key: 'boulder', variant: 3, x: -0.7, z: -0.08, rotY: r(), scale: 1.1, sy: 1.2, shadow: 0.24 },
    { key: 'boulder', variant: 0, x: -0.2, z: -0.18, rotY: r(), scale: 1.0, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.3, z: -0.1, rotY: r(), scale: 0.8, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: 0.78, z: 0.0, rotY: r(), scale: 0.6, shadow: 0.24 },
    { key: 'blocks', variant: 0, x: -0.5, z: 0.38, rotY: 0.08, scale: 0.95, shadow: 0.3, shadowAspect: 1.4 },
    { key: 'boulder', variant: 3, x: -0.62, z: 0.66, rotY: r(), scale: 0.4, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: -0.22, z: 0.78, rotY: r(), scale: 0.32, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.06, z: 0.86, rotY: r(), scale: 0.36, shadow: 0.24 },
  ];
}

/** 시장: 포석 광장 가운데 우물, 뒤쪽에 줄무늬 천막, 앞쪽에 상자·통·포대 */
function market(): Local[] {
  return [
    { key: 'tent', variant: 0, x: -0.42, z: -0.36, rotY: 0.1, scale: 1.0, shadow: 0.42, shadowAspect: 1.3 },
    { key: 'tent', variant: 1, x: 0.42, z: -0.4, rotY: -0.1, scale: 1.0, shadow: 0.42, shadowAspect: 1.3 },
    { key: 'well', variant: 0, x: 0.0, z: 0.12, rotY: 0.3, scale: 1.1, shadow: 0.22 },
    { key: 'barrel', variant: 0, x: 0.0, z: -0.84, rotY: 0.4, scale: 1, shadow: 0.13 },
    { key: 'crate', variant: 0, x: -0.62, z: 0.32, rotY: 0.2, scale: 1, shadow: 0.13 },
    { key: 'crate', variant: 1, x: -0.46, z: 0.48, rotY: -0.3, scale: 1, shadow: 0.13 },
    { key: 'crate', variant: 0, x: -0.6, z: 0.34, rotY: 0.5, scale: 0.9, shadow: 0, y: 0.16 },
    { key: 'barrel', variant: 0, x: 0.58, z: 0.3, rotY: 0, scale: 1, shadow: 0.13 },
    { key: 'barrel', variant: 0, x: 0.74, z: 0.1, rotY: 1, scale: 1, shadow: 0.13 },
    { key: 'barrel', variant: 0, x: 0.44, z: 0.5, rotY: 2, scale: 1, shadow: 0.13 },
    { key: 'sack', variant: 0, x: -0.16, z: 0.62, rotY: 0.4, scale: 1, shadow: 0.12 },
    { key: 'sack', variant: 1, x: 0.1, z: 0.7, rotY: 2.1, scale: 1, shadow: 0.12 },
    { key: 'jug', variant: 0, x: 0.26, z: 0.38, rotY: 0.6, scale: 1.4, shadow: 0.07 },
    { key: 'jug', variant: 0, x: -0.28, z: 0.36, rotY: 2.2, scale: 1.2, shadow: 0.06 },
  ];
}

/** 타일 위 소품 배치. 타일 ID 를 시드로 써서 같은 종류도 칸마다 조금씩 다르게 보인다. */
export function tilePlacements(tile: TileDef, m: BoardMetrics): Placement[] {
  const center = tileCenter(tile, m);
  const rand = mulberry32(hashString(tile.id));
  const local =
    tile.kind === 'wood' ? forest(rand) : tile.kind === 'grain' ? field(rand) : tile.kind === 'stone' ? quarry(rand) : market();
  return local.map((p) => ({
    ...p,
    x: center.x + p.x,
    y: TILE_TOP + (p.y ?? 0),
    z: center.z + p.z,
  }));
}

export function houseTransform(tile: TileDef, m: BoardMetrics): { house: THREE.Vector3; banner: THREE.Vector3 } {
  const c = tileCenter(tile, m);
  return {
    house: new THREE.Vector3(c.x + HOUSE_SLOT.x, TILE_TOP, c.z + HOUSE_SLOT.z),
    banner: new THREE.Vector3(c.x + BANNER_SLOT.x, TILE_TOP, c.z + BANNER_SLOT.z),
  };
}

// ───────────────────────── 강과 풍경 ─────────────────────────

/** 보드 오른쪽을 따라 내려와 앞쪽을 지나가는 강줄기 */
export function riverCurve(m: BoardMetrics): THREE.CatmullRomCurve3 {
  const hx = m.halfX;
  const hz = m.halfZ;
  const pts = [
    [hx * 0.55 + 2.4, -hz - 14],
    [hx * 0.55 + 2.2, -hz - 3],
    [hx * 0.8 + 1.6, -hz + 0.6],
    [hx + 1.7, -0.6],
    [hx * 0.75 + 1.6, hz - 0.7],
    [hx * 0.3 + 0.8, hz + 1.75],
    [-hx * 0.4, hz + 2.05],
    [-hx - 3.5, hz + 2.4],
    [-hx - 16, hz + 2.9],
  ];
  return new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5,
  );
}

export const RIVER_WIDTH = 2.0;
export const BANK_WIDTH = 0.42;

function distanceToCurve(p: THREE.Vector3, samples: THREE.Vector3[]): number {
  let best = Infinity;
  for (const s of samples) best = Math.min(best, (s.x - p.x) ** 2 + (s.z - p.z) ** 2);
  return Math.sqrt(best);
}

/** 보드 밖 풍경: 나무, 덤불, 바위, 갈대, 부두와 배 */
export function sceneryPlacements(m: BoardMetrics, seed = 42): Placement[] {
  const rand = mulberry32(seed);
  const curve = riverCurve(m);
  const samples = curve.getSpacedPoints(160);
  const out: Placement[] = [];
  const reach = 9;
  const tries = 1000;
  for (let i = 0; i < tries; i++) {
    const x = (rand() * 2 - 1) * (m.halfX + reach);
    const z = (rand() * 2 - 1) * (m.halfZ + reach);
    if (insidePlinth(x, z, m, 0.55)) continue;
    const p = new THREE.Vector3(x, 0, z);
    const d = distanceToCurve(p, samples);
    if (d < RIVER_WIDTH / 2 + BANK_WIDTH + 0.15) {
      // 강가 가장자리에 갈대
      if (d > RIVER_WIDTH / 2 - 0.05 && rand() < 0.35) {
        out.push({ key: 'reeds', variant: Math.floor(rand() * 2), x, y: 0, z, rotY: rand() * 6, scale: 1 + rand() * 0.6, shadow: 0 });
      }
      continue;
    }
    // 보드 가까이는 듬성듬성, 멀어질수록 숲이 빽빽해진다.
    const edge = Math.max(0, Math.hypot(x, z) - m.plinthRadius);
    const density = Math.min(1, 0.16 + edge * 0.12);
    if (rand() > density) continue;
    const r = rand();
    if (r < 0.45) out.push({ key: 'pine', variant: Math.floor(rand() * 3), x, y: 0, z, rotY: rand() * 6, scale: 0.9 + rand() * 0.5, shadow: 0.34 });
    else if (r < 0.8) out.push({ key: 'oak', variant: Math.floor(rand() * 3), x, y: 0, z, rotY: rand() * 6, scale: 0.9 + rand() * 0.45, shadow: 0.4 });
    else if (r < 0.93) out.push({ key: 'bush', variant: Math.floor(rand() * 2), x, y: 0, z, rotY: rand() * 6, scale: 0.9 + rand() * 0.6, shadow: 0.16 });
    else out.push({ key: 'boulder', variant: Math.floor(rand() * 4), x, y: 0, z, rotY: rand() * 6, scale: 0.6 + rand() * 0.6, shadow: 0.2 });
  }

  // 부두와 배: 보드 오른쪽(가운데 시장 줄 높이) 강가
  const dockZ = 0;
  const bankPoint = samples.reduce((best, s) => (Math.abs(s.z - dockZ) < Math.abs(best.z - dockZ) && s.x > 0 ? s : best), samples[0]);
  const dockX = bankPoint.x - RIVER_WIDTH / 2 - 0.05;
  out.push({ key: 'dock', variant: 0, x: dockX, y: 0, z: dockZ, rotY: Math.PI / 2, scale: 1.1, shadow: 0 });
  out.push({ key: 'barrel', variant: 0, x: dockX - 0.75, y: 0, z: dockZ - 0.45, rotY: 0.3, scale: 1, shadow: 0.13 });
  out.push({ key: 'crate', variant: 0, x: dockX - 0.7, y: 0, z: dockZ + 0.4, rotY: 0.7, scale: 1, shadow: 0.13 });
  out.push({ key: 'sack', variant: 1, x: dockX - 0.92, y: 0, z: dockZ + 0.1, rotY: 1.7, scale: 1, shadow: 0.12 });
  out.push({ key: 'boat', variant: 0, x: bankPoint.x + 0.15, y: WATER_Y - 0.03, z: dockZ - 1.05, rotY: Math.PI / 2 + 0.12, scale: 1.1, shadow: 0 });
  const far = curve.getPointAt(0.8);
  out.push({ key: 'boat', variant: 0, x: far.x, y: WATER_Y - 0.03, z: far.z + 0.2, rotY: 0.08, scale: 1.0, shadow: 0 });
  return out;
}
