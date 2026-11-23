// 맵 모양과 땅 배치.
// 모양마다 "황금 배치"를 하나씩 둔다: 땅 종류, 숫자 패, 교역로 자원이 모두 정해진 기준 배치다.
// 황금 배치는 같은 땅끼리 변을 맞대지 않고 6·8과 같은 숫자끼리 이웃하지 않으며 자원마다 나올 확률(숫자 패의 점)이 고르게 나뉘도록 짰다.
// 섞기는 같은 모양에서 광장 자리만 두고 땅·숫자·교역로 자원을 게임마다 새로 섞는다.
import { assignNumbers, boardFor, harborsFor, HARBOR_KINDS, INNER_HARBOR_KINDS, innerHarborsFor, tileCenterUnit, type Board } from './board';
import { BOARD_LAYOUT, DEV_CARDS, RESOURCE_CARDS, ROW_LABELS } from './constants';
import type { Harbor, MapArrange, MapConfig, MapShape, Resource, TileDef, TileId, TileKind } from './types';

export const MAP_SHAPES: readonly MapShape[] = ['hex', 'diamond', 'big', 'lakes'];
export const MAP_ARRANGES: readonly MapArrange[] = ['golden', 'shuffle'];
export const MAP_SHAPE_LABEL: Record<MapShape, string> = { hex: '육각형', diamond: '마름모', big: '대형', lakes: '호수' };
export const MAP_ARRANGE_LABEL: Record<MapArrange, string> = { golden: '황금 배치', shuffle: '섞기' };
export const DEFAULT_MAP: MapConfig = { shape: 'hex', arrange: 'golden' };

/** 줄의 칸: 땅 종류, 바다(null, 칸이 없다) */
type Cell = TileKind | null;

/** 칸에서 이웃 칸 쪽 방향 (축 좌표 차이). 교역로를 칸의 어느 변에 붙일지 정할 때 쓴다. */
const DIRS = { E: [1, 0], W: [-1, 0], NE: [1, -1], NW: [0, -1], SE: [0, 1], SW: [-1, 1] } as const;

/** 자리를 정해 둔 교역로: 칸(축 좌표 q, r)의 dir 쪽 변. 그 쪽은 바다(또는 호수)여야 한다. */
interface FixedHarbor {
  q: number;
  r: number;
  dir: keyof typeof DIRS;
  resource: Resource | null;
}

interface MapPreset {
  /** 줄마다 땅 종류 (황금 배치, null 은 칸이 없는 바다). 줄 수와 줄마다 칸 수가 모양을 정한다. */
  kinds: readonly (readonly Cell[])[];
  /** 줄마다 숫자 패 (황금 배치, 광장과 바다는 null). 섞기도 이 숫자 패 묶음을 쓴다. */
  numbers: readonly (readonly (number | null)[])[];
  /** 줄 번호 → 축 좌표 r */
  rowR: (row: number) => number;
  /** 줄 번호 → 그 줄 첫 칸의 축 좌표 q */
  qStart: (row: number) => number;
  /** 이 맵에서 함께 할 수 있는 최대 인원 */
  maxPlayers: number;
  /** 교역로: 바깥 둘레에 고르게(outer), 가운데 바다 둘레에(inner), 정해 둔 자리(목록) */
  harbors: 'outer' | 'inner' | readonly FixedHarbor[];
  /** 방장이 따로 바꾸지 않았을 때 은행 자원 카드(자원마다)와 발전 카드 장수 */
  resourceCards: number;
  devCards: number;
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
    maxPlayers: 4,
    harbors: 'outer',
    resourceCards: RESOURCE_CARDS,
    devCards: DEV_CARDS,
  },
  // 4칸씩 4줄인 마름모 16칸. 아래 줄로 갈수록 반 칸씩 오른쪽으로 밀려 윗부분이 왼쪽으로 기운다.
  // 다섯 자원이 3칸씩이고 광장(C2)은 가운데 두 칸 중 하나다. 숫자 패는 2~12 를 모두 하나 이상 쓰고(7 제외) 4·5·6·8·9 를 하나씩 더한 15개다.
  diamond: {
    kinds: [
      ['brick', 'grain', 'wool', 'stone'],
      ['wool', 'brick', 'grain', 'wood'],
      ['stone', 'plaza', 'wool', 'brick'],
      ['grain', 'wood', 'stone', 'wood'],
    ],
    numbers: [
      [6, 3, 4, 6],
      [5, 11, 10, 2],
      [9, null, 4, 5],
      [8, 9, 12, 8],
    ],
    rowR: (i) => i - 2,
    qStart: () => -1,
    maxPlayers: 4,
    harbors: 'outer',
    resourceCards: RESOURCE_CARDS,
    devCards: DEV_CARDS,
  },
  // 가운데가 바다인 대형 정육각형 (8인까지). 반지름 4칸 육각형에서 가운데 19칸(반지름 2)을 바다로 비운 두 겹 고리 42칸.
  // 목재·곡물 9칸, 양모 8칸, 벽돌·석재 7칸에 광장이 왼쪽·오른쪽 끝에 하나씩. 숫자 패 40개는 기본판 두 벌에 5·6·8·9 를 하나씩 더했다.
  // 교역로 10곳은 모두 가운데 바다 둘레에 있다. 여섯 방향(60도씩) 어느 쪽에나 다섯 자원이 다 있고 나올 확률도 고르다.
  big: {
    kinds: [
      ['wool', 'stone', 'grain', 'stone', 'grain'],
      ['wood', 'grain', 'wood', 'brick', 'wool', 'wood'],
      ['brick', 'wool', null, null, null, 'stone', 'wool'],
      ['stone', 'wood', null, null, null, null, 'grain', 'brick'],
      ['grain', 'plaza', null, null, null, null, null, 'plaza', 'grain'],
      ['wood', 'grain', null, null, null, null, 'wool', 'wood'],
      ['brick', 'stone', null, null, null, 'stone', 'brick'],
      ['wool', 'brick', 'wood', 'stone', 'wood', 'wool'],
      ['wood', 'wool', 'grain', 'brick', 'grain'],
    ],
    numbers: [
      [5, 11, 12, 8, 10],
      [4, 9, 4, 5, 3, 4],
      [10, 3, null, null, null, 6, 3],
      [11, 8, null, null, null, null, 5, 6],
      [8, null, null, null, null, null, null, null, 9],
      [10, 6, null, null, null, null, 11, 6],
      [2, 9, null, null, null, 5, 4],
      [6, 3, 5, 12, 11, 10],
      [9, 8, 2, 8, 9],
    ],
    rowR: (i) => i - 4,
    qStart: (i) => Math.max(-4, -(i - 4) - 4),
    maxPlayers: 8,
    harbors: 'inner',
    resourceCards: 30,
    devCards: 40,
  },
  // 호수 맵 (방장이 직접 짠 대형 맵을 그대로 옮겼다). 반지름 4칸 육각형 61칸에서 18칸을 물로 비운 43칸으로,
  // 가운데 사막(광장) 둘레 네 곳에 두 칸짜리 호수가 있고 바깥 둘레는 군데군데 바다가 파고든다.
  // 목재·양모·석재 9칸, 벽돌 8칸, 곡물 7칸. 교역로 14곳 중 넷은 호수 안에 있다 (3:1 네 곳, 자원마다 2:1 두 곳씩).
  // 그림 그대로라 같은 땅·같은 숫자가 맞닿은 곳이 있다. 섞기를 고르면 맞닿지 않게 다시 섞는다.
  lakes: {
    kinds: [
      ['brick', null, 'brick', null, 'stone'],
      ['grain', 'brick', 'wool', 'wool', 'wool', 'wood'],
      [null, 'grain', null, 'brick', null, 'wood', null],
      ['grain', 'brick', null, 'brick', 'stone', null, 'wool', 'grain'],
      [null, 'stone', 'stone', 'wool', 'plaza', 'wood', 'wood', 'wood', null],
      ['stone', 'grain', null, 'brick', 'grain', null, 'stone', 'wood'],
      [null, 'wool', null, 'stone', null, 'wool', null],
      ['wood', 'wood', 'brick', 'wool', 'wood', 'stone'],
      ['wool', null, 'stone', null, 'grain'],
    ],
    numbers: [
      [5, null, 4, null, 11],
      [11, 3, 9, 6, 3, 9],
      [null, 9, null, 10, null, 10, null],
      [5, 8, null, 5, 6, null, 2, 6],
      [null, 10, 3, 4, null, 4, 9, 4, null],
      [11, 2, null, 10, 6, null, 10, 9],
      [null, 5, null, 11, null, 8, null],
      [11, 3, 4, 5, 12, 3],
      [12, null, 8, null, 8],
    ],
    rowR: (i) => i - 4,
    qStart: (i) => Math.max(-4, -(i - 4) - 4),
    maxPlayers: 8,
    harbors: [
      { q: 0, r: -4, dir: 'W', resource: 'wood' },
      { q: 4, r: -4, dir: 'E', resource: null },
      { q: -3, r: -1, dir: 'NW', resource: 'grain' },
      { q: 4, r: -1, dir: 'NE', resource: 'wool' },
      { q: -3, r: 0, dir: 'W', resource: 'wood' },
      { q: 3, r: 0, dir: 'E', resource: 'brick' },
      { q: -4, r: 1, dir: 'SW', resource: 'brick' },
      { q: 3, r: 1, dir: 'SE', resource: null },
      { q: -4, r: 4, dir: 'W', resource: null },
      { q: 0, r: 4, dir: 'E', resource: null },
      // 호수 네 곳
      { q: 0, r: -1, dir: 'W', resource: 'stone' },
      { q: 1, r: -1, dir: 'E', resource: 'stone' },
      { q: -1, r: 1, dir: 'W', resource: 'wool' },
      { q: 0, r: 1, dir: 'E', resource: 'grain' },
    ],
    resourceCards: 30,
    devCards: 40,
  },
};

/** 정해 둔 자리의 교역로: 칸에서 dir 쪽 이웃 칸과 맞닿는 바닷가 변을 찾는다. */
function fixedHarbors(board: Board, list: readonly FixedHarbor[], kinds: readonly (Resource | null)[]): Harbor[] {
  return list.map((h, i) => {
    const tile = board.tiles.find((t) => t.q === h.q && t.r === h.r);
    if (!tile) throw new Error(`교역로 칸이 없습니다: ${h.q},${h.r}`);
    const [dq, dr] = DIRS[h.dir];
    const a = tileCenterUnit(tile);
    const b = tileCenterUnit({ q: h.q + dq, r: h.r + dr });
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const edge = board.edges.find((e) => {
      if (e.tiles.length !== 1 || e.tiles[0] !== tile.id) return false;
      const va = board.vertexMap[e.a];
      const vb = board.vertexMap[e.b];
      return Math.hypot((va.x + vb.x) / 2 - mx, (va.y + vb.y) / 2 - my) < 0.05;
    });
    if (!edge) throw new Error(`교역로 자리가 바닷가가 아닙니다: ${tile.id} ${h.dir}`);
    return { edgeId: edge.id, resource: kinds[i] };
  });
}

/** 이 맵에서 함께 할 수 있는 최대 인원 (보통 4명, 대형 맵 8명) */
export function maxPlayersFor(shape: MapShape): number {
  return PRESETS[shape].maxPlayers;
}

/** 방장이 따로 바꾸지 않았을 때 쓰는 카드 장수. 대형 맵은 사람이 많아 은행 자원과 발전 카드를 늘린다. */
export function mapCardDefaults(shape: MapShape): { resourceCards: number; devCards: number } {
  return { resourceCards: PRESETS[shape].resourceCards, devCards: PRESETS[shape].devCards };
}

export function normalizeMapShape(v: unknown): MapShape | null {
  return typeof v === 'string' && (MAP_SHAPES as readonly string[]).includes(v) ? (v as MapShape) : null;
}

export function normalizeMapArrange(v: unknown): MapArrange | null {
  return typeof v === 'string' && (MAP_ARRANGES as readonly string[]).includes(v) ? (v as MapArrange) : null;
}

/**
 * 모양의 칸 자리에 황금 배치의 땅 종류를 채운 타일 묶음. 바다 자리(null)는 칸이 없다.
 * 칸 코드는 줄 글자와 그 줄에서 몇 번째 자리인지로 정해, 가운데 바다를 사이에 둔 칸은 번호가 건너뛴다 (대형 맵 E 줄은 E1·E2·E8·E9).
 */
export function mapTiles(shape: MapShape): TileDef[] {
  const p = PRESETS[shape];
  return p.kinds.flatMap((row, i) =>
    row.flatMap((kind, c) =>
      kind === null ? [] : [{ id: `${ROW_LABELS[i]}${c + 1}`, row: i, col: c, q: p.qStart(i) + c, r: p.rowR(i), kind }],
    ),
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

/** 교역로 자리: 모양이 정한 바닷가(바깥 둘레·가운데 바다)에 고르게. random 을 주면 자리는 두고 자원만 섞는다. */
function placeHarbors(shape: MapShape, tiles: readonly TileDef[], random?: () => number): Harbor[] {
  const board = boardFor(tiles);
  const spec = PRESETS[shape].harbors;
  if (typeof spec !== 'string') {
    const kinds = spec.map((h) => h.resource);
    return fixedHarbors(board, spec, random ? shuffled(kinds, random) : kinds);
  }
  if (spec === 'inner') return innerHarborsFor(board, random ? shuffled(INNER_HARBOR_KINDS, random) : INNER_HARBOR_KINDS);
  return harborsFor(board, random ? shuffled(HARBOR_KINDS, random) : HARBOR_KINDS);
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
  return { tiles, numbers, harbors: placeHarbors(shape, tiles), robber: tiles.find((t) => t.kind === 'plaza')!.id };
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
  const harbors = placeHarbors(shape, best, random);
  return { tiles: best, numbers, harbors, robber: best.find((t) => t.kind === 'plaza')!.id };
}

export function buildMap(config: MapConfig, random: () => number): BuiltMap {
  return config.arrange === 'shuffle' ? shuffledMap(config.shape, random) : goldenMap(config.shape);
}

/** 대기실 안내용: 모양의 칸 수 (바다 자리는 빼고) */
export function mapTileCount(shape: MapShape): number {
  return PRESETS[shape].kinds.reduce((n, row) => n + row.filter((k) => k !== null).length, 0);
}
