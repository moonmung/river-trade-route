// 맵 모양과 땅 배치.
// 모양마다 "황금 배치"를 하나씩 둔다: 땅 종류, 숫자 패, 교역로 자원이 모두 정해진 기준 배치다.
// 황금 배치는 같은 땅끼리 변을 맞대지 않고 6·8과 같은 숫자끼리 이웃하지 않으며 자원마다 나올 확률(숫자 패의 점)이 고르게 나뉘도록 짰다.
// 섞기는 같은 모양에서 광장 자리만 두고 땅·숫자·교역로 자원을 게임마다 새로 섞는다.
import { assignNumbers, boardFor, harborsFor, HARBOR_KINDS } from './board';
import { BOARD_LAYOUT, ROW_LABELS } from './constants';
import type { Harbor, MapArrange, MapConfig, MapShape, Resource, TileDef, TileId, TileKind } from './types';

export const MAP_SHAPES: readonly MapShape[] = ['hex', 'diamond'];
export const MAP_ARRANGES: readonly MapArrange[] = ['golden', 'shuffle'];
export const MAP_SHAPE_LABEL: Record<MapShape, string> = { hex: '육각형', diamond: '마름모' };
export const MAP_ARRANGE_LABEL: Record<MapArrange, string> = { golden: '황금 배치', shuffle: '섞기' };
export const DEFAULT_MAP: MapConfig = { shape: 'hex', arrange: 'golden' };

interface MapPreset {
  /** 줄마다 땅 종류 (황금 배치). 줄 수와 줄마다 칸 수가 모양을 정한다. */
  kinds: readonly (readonly TileKind[])[];
  /** 줄마다 숫자 패 (황금 배치, 광장은 null). 섞기도 이 숫자 패 묶음을 쓴다. */
  numbers: readonly (readonly (number | null)[])[];
  /** 줄 번호 → 축 좌표 r */
  rowR: (row: number) => number;
  /** 줄 번호 → 그 줄 첫 칸의 축 좌표 q */
  qStart: (row: number) => number;
}

const PRESETS: Record<MapShape, MapPreset> = {
  // 3-4-5-4-3 줄의 육각형 19칸. 목재·곡물·양모 4칸, 벽돌·석재 3칸, 가운데 광장.
  hex: {
    kinds: BOARD_LAYOUT,
    numbers: [
      [3, 9, 6],
      [5, 8, 11, 10],
      [10, 3, null, 8, 4],
      [5, 4, 11, 12],
      [9, 2, 6],
    ],
    rowR: (i) => i - 2,
    qStart: (i) => Math.max(-2, -(i - 2) - 2),
  },
  // 4칸씩 4줄인 마름모 16칸. 아래 줄로 갈수록 반 칸씩 오른쪽으로 밀려 윗부분이 왼쪽으로 기운다.
  // 다섯 자원이 3칸씩이고 광장(C2)은 가운데 두 칸 중 하나다. 칸이 적어 숫자 패는 2·12 와 3 하나를 뺀 15개를 쓴다.
  diamond: {
    kinds: [
      ['brick', 'grain', 'wool', 'stone'],
      ['wool', 'brick', 'grain', 'wood'],
      ['stone', 'plaza', 'wool', 'brick'],
      ['grain', 'wood', 'stone', 'wood'],
    ],
    numbers: [
      [9, 10, 4, 10],
      [5, 11, 8, 11],
      [6, null, 9, 6],
      [4, 8, 3, 5],
    ],
    rowR: (i) => i - 2,
    qStart: () => -1,
  },
};

export function normalizeMapShape(v: unknown): MapShape | null {
  return typeof v === 'string' && (MAP_SHAPES as readonly string[]).includes(v) ? (v as MapShape) : null;
}

export function normalizeMapArrange(v: unknown): MapArrange | null {
  return typeof v === 'string' && (MAP_ARRANGES as readonly string[]).includes(v) ? (v as MapArrange) : null;
}

/** 모양의 칸 자리에 땅 종류를 채운 타일 묶음 (kinds 를 주지 않으면 황금 배치의 땅) */
export function mapTiles(shape: MapShape, kinds?: readonly (readonly TileKind[])[]): TileDef[] {
  const p = PRESETS[shape];
  const rows = kinds ?? p.kinds;
  return p.kinds.flatMap((row, i) =>
    row.map((_, c) => ({ id: `${ROW_LABELS[i]}${c + 1}`, row: i, col: c, q: p.qStart(i) + c, r: p.rowR(i), kind: rows[i][c] })),
  );
}

/** 모양의 숫자 패 묶음 (황금 배치에 놓인 숫자 그대로) */
export function mapNumberTokens(shape: MapShape): number[] {
  return PRESETS[shape].numbers.flat().filter((n): n is number => n !== null);
}

export interface BuiltMap {
  tiles: TileDef[];
  numbers: Record<TileId, number>;
  harbors: Harbor[];
  /** 기사단 동상이 처음 서는 칸 (광장) */
  robber: TileId;
}

const near = (a: TileDef, b: TileDef) => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
};

/** 같은 땅끼리 변을 맞댄 쌍의 수 (광장 제외) */
export function sameKindPairs(tiles: readonly TileDef[]): number {
  let n = 0;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i];
      const b = tiles[j];
      if (a.kind !== 'plaza' && a.kind === b.kind && near(a, b)) n += 1;
    }
  }
  return n;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 황금 배치: 정해진 땅·숫자·교역로 */
export function goldenMap(shape: MapShape): BuiltMap {
  const p = PRESETS[shape];
  const tiles = mapTiles(shape);
  const numbers: Record<TileId, number> = {};
  for (const t of tiles) {
    const n = p.numbers[t.row][t.col];
    if (n !== null) numbers[t.id] = n;
  }
  return { tiles, numbers, harbors: harborsFor(boardFor(tiles)), robber: tiles.find((t) => t.kind === 'plaza')!.id };
}

/**
 * 광장 자리는 두고 나머지 땅을 섞는다. 섞은 뒤 같은 땅끼리 맞닿은 곳이 있으면 두 칸의 땅을 맞바꿔 맞닿음을 줄여 간다
 * (늘지 않는 맞바꿈만 받아들인다). 그래도 남으면 처음부터 다시 섞고 끝내 못 없애면 맞닿음이 가장 적은 판을 쓴다.
 */
function shuffleKinds(golden: readonly TileDef[], random: () => number): TileDef[] {
  const pool = golden.filter((t) => t.kind !== 'plaza').map((t) => t.kind as Resource);
  const slots = golden.map((t, i) => (t.kind === 'plaza' ? -1 : i)).filter((i) => i >= 0);
  let best: TileDef[] = golden.map((t) => ({ ...t }));
  let bestPairs = Infinity;
  for (let restart = 0; restart < 30 && bestPairs > 0; restart++) {
    const kinds = shuffled(pool, random);
    let k = 0;
    const tiles = golden.map((t) => (t.kind === 'plaza' ? { ...t } : { ...t, kind: kinds[k++] }));
    let pairs = sameKindPairs(tiles);
    for (let step = 0; step < 600 && pairs > 0; step++) {
      const a = tiles[slots[Math.floor(random() * slots.length)]];
      const b = tiles[slots[Math.floor(random() * slots.length)]];
      if (a.kind === b.kind) continue;
      [a.kind, b.kind] = [b.kind, a.kind];
      const next = sameKindPairs(tiles);
      if (next <= pairs) pairs = next;
      else [a.kind, b.kind] = [b.kind, a.kind];
    }
    if (pairs < bestPairs) {
      best = tiles;
      bestPairs = pairs;
    }
  }
  return best;
}

/** 섞기: 땅은 같은 땅끼리 맞닿지 않게, 숫자 패는 6·8 이 이웃하지 않게 섞는다. 교역로는 자리는 두고 자원만 섞는다. */
export function shuffledMap(shape: MapShape, random: () => number): BuiltMap {
  const best = shuffleKinds(mapTiles(shape), random);
  const numbers = assignNumbers(random, best, mapNumberTokens(shape));
  const harbors = harborsFor(boardFor(best), shuffled(HARBOR_KINDS, random));
  return { tiles: best, numbers, harbors, robber: best.find((t) => t.kind === 'plaza')!.id };
}

export function buildMap(config: MapConfig, random: () => number): BuiltMap {
  return config.arrange === 'shuffle' ? shuffledMap(config.shape, random) : goldenMap(config.shape);
}

/** 대기실 안내용: 모양의 칸 수 */
export function mapTileCount(shape: MapShape): number {
  return PRESETS[shape].kinds.reduce((n, row) => n + row.length, 0);
}
