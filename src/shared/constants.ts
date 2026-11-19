import type { Bundle, ContractDef, ContractId, Resource, TileDef, TileId, TileKind } from './types';

export const RESOURCES: readonly Resource[] = ['wood', 'grain', 'stone'];

export const RESOURCE_LABEL: Record<Resource, string> = {
  wood: '목재',
  grain: '곡물',
  stone: '석재',
};

export const TILE_KIND_LABEL: Record<TileKind, string> = {
  ...RESOURCE_LABEL,
  market: '시장',
};

export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

/** 보드 반지름: 가운데 칸에서 가장자리까지 2칸 → 줄마다 3-4-5-4-3칸, 모두 19칸 */
export const BOARD_RADIUS = 2;

/**
 * 첫 테스트용 고정 보드 (육각 19칸, 위쪽 줄 A 부터 아래쪽 줄 E 까지).
 * 가운데 C3 이 공동 시장이고, 목재·곡물·석재가 6칸씩이다.
 * 같은 종류의 생산 칸끼리는 변을 맞대지 않게 배치했다.
 */
export const BOARD_LAYOUT: readonly (readonly TileKind[])[] = [
  ['grain', 'stone', 'wood'],
  ['stone', 'wood', 'grain', 'stone'],
  ['wood', 'grain', 'market', 'wood', 'grain'],
  ['stone', 'wood', 'grain', 'stone'],
  ['grain', 'stone', 'wood'],
];

export const TILES: readonly TileDef[] = BOARD_LAYOUT.flatMap((row, i) => {
  const r = i - BOARD_RADIUS;
  const qStart = Math.max(-BOARD_RADIUS, -r - BOARD_RADIUS);
  return row.map((kind, c) => ({ id: `${ROW_LABELS[i]}${c + 1}`, row: i, col: c, q: qStart + c, r, kind }));
});

export const TILE_MAP: Readonly<Record<TileId, TileDef>> = Object.fromEntries(TILES.map((t) => [t.id, t]));

/** 육각 격자 거리 (축 좌표) */
export function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** 변을 맞댄 칸(최대 6칸)만 인접한 것으로 본다. */
export const NEIGHBORS: Readonly<Record<TileId, readonly TileId[]>> = Object.fromEntries(
  TILES.map((t) => [t.id, TILES.filter((o) => hexDistance(o, t) === 1).map((o) => o.id)]),
);

export const TOTAL_ROUNDS = 6;
/** 라운드별 예보: 목재 → 곡물 → 석재 → 목재 → 곡물 → 석재 */
export const FORECAST: readonly Resource[] = ['wood', 'grain', 'stone', 'wood', 'grain', 'stone'];
export const ACTIONS_PER_TURN = 2;
export const MAX_SETTLEMENTS = 3;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 4;
export const START_RESOURCES: Bundle = { wood: 1, grain: 1, stone: 1 };
export const BUILD_COST: Bundle = { wood: 1, grain: 0, stone: 1 };
export const MARKET_GIVE = 2;
export const MARKET_GET = 1;
/** 한 번의 플레이어 교환에서 한 종류당 제시할 수 있는 최대 수량 */
export const MAX_TRADE_AMOUNT = 9;

export const CONTRACTS: readonly ContractDef[] = [
  { id: 'raft', name: '뗏목 자재', cost: { wood: 2, grain: 0, stone: 1 }, points: 2 },
  { id: 'food', name: '식량 꾸러미', cost: { wood: 1, grain: 2, stone: 0 }, points: 2 },
  { id: 'levee', name: '제방 보수', cost: { wood: 0, grain: 1, stone: 2 }, points: 2 },
  { id: 'general', name: '종합 납품', cost: { wood: 1, grain: 1, stone: 1 }, points: 2 },
];

export const CONTRACT_MAP: Readonly<Record<ContractId, ContractDef>> = Object.fromEntries(
  CONTRACTS.map((c) => [c.id, c]),
) as Record<ContractId, ContractDef>;

export const NICKNAME_MAX = 12;
export const ROOM_CODE_LENGTH = 4;
/** 헷갈리기 쉬운 0/O, 1/I/L 을 뺀 방 코드 문자 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function emptyBundle(): Bundle {
  return { wood: 0, grain: 0, stone: 0 };
}

export function bundleTotal(b: Bundle): number {
  return b.wood + b.grain + b.stone;
}

export function hasBundle(have: Bundle, need: Bundle): boolean {
  return RESOURCES.every((r) => have[r] >= need[r]);
}
