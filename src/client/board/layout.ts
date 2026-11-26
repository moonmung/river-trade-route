// 보드 배치: 육각 타일 위치, 타일 종류별 소품 배치, 육각 받침. 보드 밖은 물이라 따로 배치할 것이 없다.
// 모든 배치는 타일 ID를 시드로 정해지므로 모든 기기에서 같은 모습이 된다.
// 타일은 꼭짓점이 위아래(화면 앞뒤)를 향하는 pointy-top 육각형이다.
import * as THREE from 'three';
import type { TileDef, TileKind } from '../../shared/types';
import type { PropKey } from './art/builders';
import { hashString, mulberry32 } from './art/rng';

const SQRT3 = Math.sqrt(3);

/** 타일 육각형의 외접원 반지름 (가운데 → 꼭짓점) */
export const HEX_RADIUS = 1.14;
/** 타일 중심 간격을 정하는 반지름. HEX_RADIUS 보다 커서 타일 사이에 수레가 다닐 만한 흙길(폭 약 0.31)이 생긴다. */
export const HEX_SPACING = 1.32;
/** 타일 가운데 → 옆 변까지 거리 */
export const HEX_APOTHEM = (HEX_RADIUS * SQRT3) / 2;
export const PLATFORM_TOP = 0.22;
export const TILE_THICKNESS = 0.09;
export const TILE_TOP = PLATFORM_TOP + TILE_THICKNESS;
/** 바깥 타일과 받침 가장자리 사이 여백 */
export const PLATFORM_MARGIN = 0.38;

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
  /** 길이(x) 방향 기울기 (라디안, 음수면 +x 쪽 끝이 내려간다). 잔교가 땅에서 부두로 내려가게 한다. */
  tilt?: number;
  /** 접촉 그림자 반지름 (0이면 그림자 없음) */
  shadow: number;
  /** 그림자 가로세로 비율 */
  shadowAspect?: number;
  /** 이 소품이 놓인 타일 (눌렀을 때 톡 튀기기에 쓴다) */
  tile?: string;
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


type Local = Omit<Placement, 'x' | 'y' | 'z'> & { x: number; z: number; y?: number };

/** 숫자 패가 놓이는 자리 (타일 중심 기준). 생산 칸마다 이 둘레를 비워 둔다. */
export const TOKEN_SPOT = { x: 0, z: 0.12 };
/**
 * 숫자 패를 화면에 띄우는 자리: 칸 한가운데. 위에서 비스듬히 내려다보므로 TOKEN_SPOT 에 띄우면 칸 가운데보다 조금 아래로 보인다.
 * 소품을 비우는 빈터는 TOKEN_SPOT 기준 그대로 둔다 (가운데도 빈터 안이다).
 */
export const TOKEN_FACE = { x: 0, z: 0 };
/** 기사단 동상이 서는 자리 (숫자 패 바로 뒤라 둘이 겹치지 않는다) */
export const STATUE_SPOT = { x: 0, z: -0.3 };
/** 광장에서는 가운데 돌 단 위에 선다. */
export const PLAZA_STATUE_SPOT = { x: 0, z: -0.04 };
export const DAIS_HEIGHT = 0.08;
/** 숫자 패와 동상 자리를 잇는 빈터의 반지름 */
const CLEARING_RADIUS = 0.23;

/** 숫자 패·동상 자리(두 점을 잇는 둥근 띠) 안인지 */
function inClearing(x: number, z: number, pad: number): boolean {
  const z0 = STATUE_SPOT.z;
  const z1 = TOKEN_SPOT.z;
  const t = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  return Math.hypot(x, z - (z0 + t * (z1 - z0))) < CLEARING_RADIUS + pad;
}

/** 타일 육각형 안쪽인지 (margin 만큼 안으로 들여서 판정) */
function insideHex(x: number, z: number, margin: number): boolean {
  const R = HEX_RADIUS - margin;
  return Math.abs(x) <= (R * SQRT3) / 2 && Math.abs(z) <= R - Math.abs(x) / SQRT3;
}

/** 바닥 소품끼리 겹치지 않게 보는 대략의 반지름 (배율 1 기준) */
const FOOTPRINT: Partial<Record<PropKey, number>> = {
  pine: 0.22,
  oak: 0.26,
  bush: 0.13,
  tuft: 0.06,
  logpile: 0.32,
  stump: 0.12,
  stook: 0.12,
  sack: 0.09,
  boulder: 0.2,
  pebbles: 0.1,
  blocks: 0.32,
  sheep: 0.13,
  fence: 0.3,
  trough: 0.16,
  kiln: 0.32,
  bricks: 0.22,
  claymound: 0.2,
  brickrows: 0.26,
  dais: 0.42,
};

interface ScatterItem {
  key: PropKey;
  variants: number;
  count: number;
  scale: [number, number];
  shadow: number;
}

/** 빈 땅에 작은 소품(덤불, 풀 포기, 자갈)을 흩뿌린다. 이미 놓인 소품을 피해서 자리를 고른다. */
function scatter(out: Local[], rand: () => number, items: ScatterItem[], allow: (x: number, z: number) => boolean): void {
  for (const item of items) {
    let placed = 0;
    for (let tries = 0; tries < 80 && placed < item.count; tries++) {
      const x = (rand() * 2 - 1) * HEX_APOTHEM;
      const z = (rand() * 2 - 1) * HEX_RADIUS;
      const scale = item.scale[0] + rand() * (item.scale[1] - item.scale[0]);
      const reach = (FOOTPRINT[item.key] ?? 0.1) * scale;
      if (!insideHex(x, z, reach + 0.04) || inClearing(x, z, reach * 0.6) || !allow(x, z)) continue;
      if (out.some((p) => p.key !== 'wheatrow' && Math.hypot(p.x - x, p.z - z) < reach + (FOOTPRINT[p.key] ?? 0.1) * p.scale * 0.8)) continue;
      out.push({ key: item.key, variant: Math.floor(rand() * item.variants), x, z, rotY: rand() * 6.28, scale, shadow: item.shadow });
      placed++;
    }
  }
}

/**
 * 숲: 소나무와 참나무가 숫자 패·동상 빈터를 둘러싼다. 나무는 낮게 눌러 심고 타일 가장자리에서 들여 심어서
 * 타일 뒤쪽 변에 놓인 길이 나무에 가리지 않게 한다. 앞 왼쪽은 통나무 더미.
 */
function forest(rand: () => number): Local[] {
  const out: Local[] = [
    { key: 'logpile', variant: 0, x: -0.46, z: 0.56, rotY: 0.55, scale: 0.78, shadow: 0.3, shadowAspect: 1.3 },
    { key: 'stump', variant: 0, x: 0.36, z: 0.64, rotY: 0.6, scale: 1, shadow: 0.12 },
  ];
  const step = 0.3;
  for (let j = -4; j <= 4; j++) {
    for (let i = -4; i <= 4; i++) {
      const x = (i + (j & 1 ? 0.5 : 0)) * step + (rand() - 0.5) * 0.08;
      const z = j * step * 0.86 + (rand() - 0.5) * 0.08;
      const oak = rand() < 0.3;
      const s = (oak ? 0.56 : 0.62) + rand() * 0.18;
      const reach = (oak ? 0.34 : 0.29) * s;
      if (!insideHex(x, z, reach + 0.12)) continue;
      if (inClearing(x, z, reach * 0.7)) continue;
      if (Math.hypot(x + 0.46, z - 0.56) < 0.32 || Math.hypot(x - 0.36, z - 0.64) < 0.18) continue;
      out.push({
        key: oak ? 'oak' : 'pine',
        variant: Math.floor(rand() * 3),
        x,
        z,
        rotY: rand() * 6.28,
        scale: s,
        sy: oak ? 0.8 : 0.72,
        shadow: oak ? 0.36 : 0.3,
      });
    }
  }
  scatter(
    out,
    rand,
    [
      { key: 'bush', variants: 2, count: 2, scale: [0.7, 1.0], shadow: 0.16 },
      { key: 'tuft', variants: 2, count: 6, scale: [0.8, 1.2], shadow: 0 },
    ],
    () => true,
  );
  return out;
}

/** 볼록 다각형 안쪽인지 (변마다 margin 만큼 들여서 판정) */
function insidePoly(x: number, z: number, poly: { x: number; z: number }[], margin: number): boolean {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const d = (((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / len) * sign;
    if (d < margin) return false;
  }
  return true;
}

/** 한 뙈기에 dir 방향 밀 고랑을 나란히 깐다. 빈터와 뙈기 사이 둑길은 비운다. */
function plotRows(out: Local[], rand: () => number, poly: { x: number; z: number }[], dir: { x: number; z: number }): void {
  const nx = -dir.z;
  const nz = dir.x;
  const spacing = 0.145;
  for (let o = -1.3; o <= 1.3; o += spacing) {
    let t0 = NaN;
    let t1 = NaN;
    const flush = () => {
      const len = t1 - t0;
      if (len >= 0.14) {
        const tm = (t0 + t1) / 2;
        out.push({
          key: 'wheatrow',
          variant: Math.floor(rand() * 3),
          x: nx * o + dir.x * tm,
          z: nz * o + dir.z * tm,
          rotY: Math.atan2(-dir.z, dir.x),
          scale: 1,
          stretch: len / 1.6,
          shadow: 0,
        });
      }
      t0 = NaN;
      t1 = NaN;
    };
    for (let t = -1.3; t <= 1.3; t += 0.02) {
      const x = nx * o + dir.x * t;
      const z = nz * o + dir.z * t;
      if (insidePoly(x, z, poly, 0.08) && insideHex(x, z, 0.07) && !inClearing(x, z, 0.04)) {
        if (Number.isNaN(t0)) t0 = t;
        t1 = t;
      } else if (!Number.isNaN(t0)) flush();
    }
    if (!Number.isNaN(t0)) flush();
  }
}

/**
 * 밭: 육각형을 가운데에서 마름모 세 뙈기로 나누고 뙈기마다 고랑 방향을 달리한다. 작물은 모두 익은 밀이고,
 * 뙈기 사이 좁은 둑길과 고랑 방향으로 실제 논밭처럼 나뉘어 보인다.
 */
function field(rand: () => number): Local[] {
  const out: Local[] = [];
  const c = hexCorners();
  const o = { x: 0, z: 0 };
  const plots = [
    { poly: [o, c[0], c[1], c[2]], dir: { x: 0, z: 1 } },
    { poly: [o, c[2], c[3], c[4]], dir: { x: SQRT3 / 2, z: 0.5 } },
    { poly: [o, c[4], c[5], c[0]], dir: { x: -SQRT3 / 2, z: 0.5 } },
  ];
  for (const p of plots) plotRows(out, rand, p.poly, p.dir);
  return out;
}

/** 채석장: 뒤쪽에 바위 언덕, 앞쪽에 잘라 낸 돌덩이와 자갈. 가운데 빈터에는 숫자 패와 동상 자리. */
function quarry(rand: () => number): Local[] {
  const r = () => rand() * 6.28;
  const out: Local[] = [
    { key: 'boulder', variant: 0, x: -0.5, z: -0.5, rotY: r(), scale: 1.45, sy: 1.25, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.08, z: -0.76, rotY: r(), scale: 1.4, sy: 1.3, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: 0.52, z: -0.42, rotY: r(), scale: 1.35, sy: 1.2, shadow: 0.24 },
    { key: 'boulder', variant: 3, x: -0.74, z: -0.06, rotY: r(), scale: 0.95, sy: 1.1, shadow: 0.24 },
    { key: 'boulder', variant: 0, x: 0.66, z: 0.04, rotY: r(), scale: 0.8, shadow: 0.24 },
    { key: 'blocks', variant: 0, x: -0.5, z: 0.42, rotY: 0.08, scale: 0.9, shadow: 0.3, shadowAspect: 1.4 },
    { key: 'boulder', variant: 3, x: -0.6, z: 0.7, rotY: r(), scale: 0.38, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: 0.3, z: 0.74, rotY: r(), scale: 0.34, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.5, z: 0.48, rotY: r(), scale: 0.4, shadow: 0.24 },
  ];
  scatter(
    out,
    rand,
    [
      { key: 'pebbles', variants: 2, count: 3, scale: [0.8, 1.2], shadow: 0.1 },
      { key: 'tuft', variants: 1, count: 2, scale: [0.7, 1.0], shadow: 0 },
    ],
    (_x, z) => z > -0.2,
  );
  return out;
}

/** 금광 (섬 맵): 뒤쪽에 금빛 바위 더미, 앞쪽에 광부 천막과 금을 담은 상자·통 (땅은 금빛으로 칠한 채석장 바닥) */
function goldMine(rand: () => number): Local[] {
  const r = () => rand() * 6.28;
  const out: Local[] = [
    { key: 'boulder', variant: 0, x: -0.46, z: -0.56, rotY: r(), scale: 1.25, sy: 1.2, shadow: 0.24 },
    { key: 'boulder', variant: 2, x: 0.12, z: -0.78, rotY: r(), scale: 1.2, sy: 1.25, shadow: 0.24 },
    { key: 'boulder', variant: 1, x: 0.56, z: -0.44, rotY: r(), scale: 1.1, sy: 1.15, shadow: 0.24 },
    { key: 'tent', variant: 0, x: -0.62, z: 0.3, rotY: 0.5, scale: 0.85, shadow: 0.2 },
    { key: 'crate', variant: 0, x: 0.58, z: 0.22, rotY: 0.3, scale: 0.85, shadow: 0.1 },
    { key: 'crate', variant: 1, x: 0.44, z: 0.5, rotY: -0.4, scale: 0.8, shadow: 0.1 },
    { key: 'barrel', variant: 0, x: -0.2, z: 0.78, rotY: 0.7, scale: 0.8, shadow: 0.1 },
  ];
  scatter(out, rand, [{ key: 'pebbles', variants: 2, count: 4, scale: [0.8, 1.2], shadow: 0.1 }], (_x, z) => z > -0.2);
  return out;
}

/** 목초지: 뒤쪽에 나무 울타리, 앞 왼쪽에 여물통과 건초 더미, 풀밭 곳곳에 양 */
function pasture(rand: () => number): Local[] {
  const out: Local[] = [
    { key: 'fence', variant: 0, x: -0.4, z: -0.64, rotY: 0.04, scale: 0.95, shadow: 0 },
    { key: 'fence', variant: 1, x: 0.28, z: -0.66, rotY: -0.05, scale: 0.95, shadow: 0 },
    { key: 'fence', variant: 1, x: -0.72, z: -0.24, rotY: 1.1, scale: 0.8, shadow: 0 },
    { key: 'trough', variant: 0, x: -0.5, z: 0.5, rotY: 0.3, scale: 1, shadow: 0.17, shadowAspect: 1.6 },
    { key: 'stook', variant: 1, x: -0.2, z: 0.78, rotY: rand() * 3, scale: 0.85, shadow: 0.13 },
  ];
  scatter(
    out,
    rand,
    [
      { key: 'sheep', variants: 3, count: 6, scale: [0.95, 1.15], shadow: 0.14 },
      { key: 'bush', variants: 2, count: 1, scale: [0.8, 1.0], shadow: 0.16 },
      { key: 'tuft', variants: 2, count: 7, scale: [0.8, 1.3], shadow: 0 },
    ],
    () => true,
  );
  return out;
}

/**
 * 벽돌 공방(점토 구덩이): 뒤 왼쪽에 연기 나는 가마, 뒤 오른쪽에 높이 쌓은 벽돌 탑, 오른쪽에 낮은 벽돌 더미,
 * 앞 오른쪽에 볕에 말리는 날벽돌 줄, 왼쪽에 캐낸 진흙 무더기.
 */
function clayPit(rand: () => number): Local[] {
  const out: Local[] = [
    { key: 'kiln', variant: 0, x: -0.56, z: -0.36, rotY: 0.35, scale: 0.95, shadow: 0.34 },
    { key: 'bricks', variant: 2, x: 0.44, z: -0.5, rotY: -0.25, scale: 1, shadow: 0.24, shadowAspect: 1.3 },
    { key: 'bricks', variant: 0, x: 0.72, z: -0.04, rotY: 1.2, scale: 0.9, shadow: 0.22, shadowAspect: 1.3 },
    { key: 'bricks', variant: 1, x: 0.04, z: -0.78, rotY: 0.1, scale: 0.8, shadow: 0.2, shadowAspect: 1.3 },
    { key: 'brickrows', variant: 0, x: 0.34, z: 0.52, rotY: -0.45, scale: 1.1, shadow: 0 },
    { key: 'claymound', variant: 0, x: -0.7, z: 0.16, rotY: rand() * 6.28, scale: 0.9, shadow: 0.2 },
    { key: 'claymound', variant: 1, x: -0.38, z: 0.62, rotY: rand() * 6.28, scale: 0.75, shadow: 0.18 },
    { key: 'barrel', variant: 0, x: -0.04, z: 0.84, rotY: 0.4, scale: 0.85, shadow: 0.11 },
  ];
  scatter(
    out,
    rand,
    [
      { key: 'pebbles', variants: 2, count: 2, scale: [0.7, 1.0], shadow: 0.1 },
      { key: 'tuft', variants: 1, count: 3, scale: [0.7, 1.0], shadow: 0 },
    ],
    () => true,
  );
  return out;
}

/**
 * 마을 광장: 자원이 나지 않는 빈 땅. 가운데 둥근 돌 단 위에 기사단 동상이 처음 서 있고,
 * 둘레에는 우물·통·상자가 가장자리로 물러나 있다. 뒤쪽 두 모서리는 낮은 덤불로 채워 뒤 변의 길을 가리지 않는다.
 */
function plaza(): Local[] {
  return [
    { key: 'dais', variant: 0, x: PLAZA_STATUE_SPOT.x, z: PLAZA_STATUE_SPOT.z, rotY: 0, scale: 1, shadow: 0 },
    { key: 'bush', variant: 1, x: -0.5, z: -0.56, rotY: 0.6, scale: 1.05, shadow: 0.16 },
    { key: 'bush', variant: 0, x: -0.32, z: -0.72, rotY: 2.2, scale: 0.75, shadow: 0.14 },
    { key: 'bush', variant: 0, x: 0.5, z: -0.58, rotY: -0.4, scale: 0.95, shadow: 0.16 },
    { key: 'sack', variant: 1, x: 0.3, z: -0.7, rotY: 1.3, scale: 0.8, shadow: 0.1 },
    { key: 'well', variant: 0, x: 0.66, z: 0.32, rotY: 0.3, scale: 0.7, shadow: 0.16 },
    { key: 'barrel', variant: 0, x: 0.0, z: -0.9, rotY: 0.4, scale: 0.8, shadow: 0.1 },
    { key: 'crate', variant: 0, x: -0.72, z: 0.18, rotY: 0.2, scale: 0.8, shadow: 0.1 },
    { key: 'crate', variant: 1, x: -0.6, z: 0.36, rotY: -0.3, scale: 0.8, shadow: 0.1 },
    { key: 'barrel', variant: 0, x: 0.8, z: -0.06, rotY: 1, scale: 0.8, shadow: 0.1 },
    { key: 'sack', variant: 0, x: -0.32, z: 0.7, rotY: 0.4, scale: 0.85, shadow: 0.1 },
    { key: 'sack', variant: 1, x: -0.14, z: 0.82, rotY: 2.1, scale: 0.85, shadow: 0.1 },
    { key: 'jug', variant: 0, x: 0.3, z: 0.64, rotY: 0.6, scale: 1.1, shadow: 0.06 },
  ];
}

/** 타일 위 소품 배치. 타일 ID 를 시드로 써서 같은 종류도 칸마다 조금씩 다르게 보인다. */
export function tilePlacements(tile: TileDef, m: BoardMetrics): Placement[] {
  const center = tileCenter(tile, m);
  const rand = mulberry32(hashString(tile.id));
  const local =
    tile.kind === 'wood'
      ? forest(rand)
      : tile.kind === 'grain'
        ? field(rand)
        : tile.kind === 'wool'
          ? pasture(rand)
          : tile.kind === 'brick'
            ? clayPit(rand)
            : tile.kind === 'stone'
              ? quarry(rand)
              : tile.kind === 'gold'
                ? goldMine(rand)
                : plaza();
  return local.map((p) => ({
    ...p,
    x: center.x + p.x,
    y: TILE_TOP + (p.y ?? 0),
    z: center.z + p.z,
  }));
}
