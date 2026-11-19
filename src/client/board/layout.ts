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

type Recipe = Omit<Placement, 'y'> & { y?: number };

// 타일 중심 기준 좌표(월드 단위). 큰 소품은 뒤쪽(-z), 앞쪽 오른편은 거점 자리로 비워 둔다.
const FOREST: Recipe[] = [
  { key: 'pine', variant: 0, x: -0.5, z: -0.52, rotY: 0.3, scale: 1.02, shadow: 0.32 },
  { key: 'pine', variant: 1, x: -0.04, z: -0.74, rotY: 1.1, scale: 0.95, shadow: 0.3 },
  { key: 'pine', variant: 2, x: 0.44, z: -0.5, rotY: 2.0, scale: 1.05, shadow: 0.33 },
  { key: 'pine', variant: 0, x: -0.74, z: -0.08, rotY: 0.7, scale: 0.84, shadow: 0.28 },
  { key: 'pine', variant: 1, x: -0.27, z: -0.2, rotY: 2.6, scale: 0.9, shadow: 0.29 },
  { key: 'pine', variant: 2, x: 0.17, z: -0.22, rotY: 0.2, scale: 0.86, shadow: 0.28 },
  { key: 'pine', variant: 0, x: 0.68, z: -0.12, rotY: 1.7, scale: 0.78, shadow: 0.26 },
  { key: 'logpile', variant: 0, x: -0.52, z: 0.38, rotY: 0.12, scale: 0.95, shadow: 0.34, shadowAspect: 1.3 },
  { key: 'stump', variant: 0, x: 0.06, z: 0.8, rotY: 0.6, scale: 1, shadow: 0.12 },
  { key: 'bush', variant: 0, x: 0.8, z: 0.0, rotY: 0, scale: 0.85, shadow: 0.14 },
];

const FIELD: Recipe[] = [
  ...[-0.84, -0.66, -0.48, -0.3, -0.12].map((z, i) => {
    const half = halfWidthAt(Math.abs(z) + 0.08) - 0.07;
    return { key: 'wheatrow' as const, variant: i % 3, x: 0, z, rotY: 0, scale: 1, stretch: (half * 2) / 1.6, shadow: 0 };
  }),
  { key: 'stook', variant: 0, x: -0.58, z: 0.28, rotY: 0.4, scale: 1, shadow: 0.13 },
  { key: 'stook', variant: 1, x: -0.4, z: 0.5, rotY: 1.4, scale: 0.95, shadow: 0.13 },
  { key: 'stook', variant: 0, x: -0.7, z: 0.5, rotY: 2.4, scale: 0.88, shadow: 0.12 },
  { key: 'sack', variant: 0, x: -0.18, z: 0.76, rotY: 0.3, scale: 1, shadow: 0.12 },
  { key: 'sack', variant: 1, x: -0.36, z: 0.72, rotY: 1.2, scale: 0.95, shadow: 0.12 },
];

const QUARRY: Recipe[] = [
  { key: 'boulder', variant: 0, x: -0.46, z: -0.5, rotY: 0.2, scale: 1.3, shadow: 0.35 },
  { key: 'boulder', variant: 1, x: 0.04, z: -0.72, rotY: 1.3, scale: 1.0, shadow: 0.3 },
  { key: 'boulder', variant: 2, x: 0.5, z: -0.44, rotY: 2.2, scale: 1.35, shadow: 0.37 },
  { key: 'boulder', variant: 3, x: -0.32, z: -0.12, rotY: 0.8, scale: 0.8, shadow: 0.24 },
  { key: 'boulder', variant: 1, x: 0.3, z: -0.14, rotY: 2.9, scale: 0.85, shadow: 0.25 },
  { key: 'boulder', variant: 3, x: 0.8, z: 0.04, rotY: 1.9, scale: 0.6, shadow: 0.18 },
  { key: 'blocks', variant: 0, x: -0.48, z: 0.36, rotY: 0.08, scale: 0.95, shadow: 0.3, shadowAspect: 1.4 },
  { key: 'boulder', variant: 2, x: -0.6, z: 0.62, rotY: 0.5, scale: 0.42, shadow: 0.11 },
  { key: 'boulder', variant: 0, x: 0.04, z: 0.8, rotY: 1.5, scale: 0.36, shadow: 0.1 },
];

const MARKET: Recipe[] = [
  { key: 'tent', variant: 0, x: -0.4, z: -0.3, rotY: 0.08, scale: 1.0, shadow: 0.42, shadowAspect: 1.3 },
  { key: 'tent', variant: 1, x: 0.4, z: -0.32, rotY: -0.08, scale: 1.0, shadow: 0.42, shadowAspect: 1.3 },
  { key: 'barrel', variant: 0, x: 0.0, z: -0.82, rotY: 0.4, scale: 1, shadow: 0.13 },
  { key: 'crate', variant: 0, x: -0.62, z: 0.3, rotY: 0.2, scale: 1, shadow: 0.13 },
  { key: 'crate', variant: 1, x: -0.46, z: 0.46, rotY: -0.3, scale: 1, shadow: 0.13 },
  { key: 'crate', variant: 0, x: -0.6, z: 0.32, rotY: 0.5, scale: 0.9, shadow: 0, y: 0.16 },
  { key: 'barrel', variant: 0, x: 0.56, z: 0.3, rotY: 0, scale: 1, shadow: 0.13 },
  { key: 'barrel', variant: 0, x: 0.72, z: 0.12, rotY: 1, scale: 1, shadow: 0.13 },
  { key: 'barrel', variant: 0, x: 0.42, z: 0.5, rotY: 2, scale: 1, shadow: 0.13 },
  { key: 'sack', variant: 0, x: -0.12, z: 0.56, rotY: 0.4, scale: 1, shadow: 0.12 },
  { key: 'sack', variant: 1, x: 0.08, z: 0.66, rotY: 2.1, scale: 1, shadow: 0.12 },
  { key: 'jug', variant: 0, x: -0.02, z: 0.28, rotY: 0.6, scale: 1.4, shadow: 0.07 },
  { key: 'jug', variant: 0, x: 0.18, z: 0.32, rotY: 2.2, scale: 1.2, shadow: 0.06 },
];

const RECIPES: Record<TileKind, Recipe[]> = { wood: FOREST, grain: FIELD, stone: QUARRY, market: MARKET };

/** 타일 위 소품 배치. 타일마다 좌우를 뒤집거나 살짝 흔들어 같은 종류도 똑같아 보이지 않게 한다. */
export function tilePlacements(tile: TileDef, m: BoardMetrics): Placement[] {
  const center = tileCenter(tile, m);
  const rand = mulberry32(hashString(tile.id));
  const mirror = tile.kind !== 'market' && tile.kind !== 'grain' && rand() < 0.5 ? -1 : 1;
  return RECIPES[tile.kind].map((r) => {
    const jitter = r.key === 'wheatrow' ? 0 : 0.035;
    let lx = r.x * mirror + (rand() - 0.5) * jitter * 2;
    // 뒤집힌 타일에서도 앞쪽 오른편 거점 자리는 비워 둔다.
    if (mirror < 0 && lx > 0.0 && r.z > 0.1 && r.key !== 'bush') lx = -lx;
    const lz = r.z + (rand() - 0.5) * jitter * 2;
    return {
      key: r.key,
      variant: r.variant,
      x: center.x + lx,
      y: TILE_TOP + (r.y ?? 0),
      z: center.z + lz,
      rotY: r.rotY * mirror + (r.key === 'wheatrow' ? 0 : (rand() - 0.5) * 0.3),
      scale: r.scale * (r.key === 'wheatrow' ? 1 : 0.95 + rand() * 0.1),
      stretch: r.stretch,
      shadow: r.shadow,
      shadowAspect: r.shadowAspect,
    };
  });
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
