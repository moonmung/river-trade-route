import type { Bundle, DevKind, PieceKind, Resource, TileDef, TileId, TileKind } from './types';

/** 화면에 늘어놓는 순서도 이 순서다 */
export const RESOURCES: readonly Resource[] = ['wood', 'grain', 'wool', 'brick', 'stone'];

export const RESOURCE_LABEL: Record<Resource, string> = {
  wood: '목재',
  grain: '곡물',
  wool: '양모',
  brick: '벽돌',
  stone: '석재',
};

export const TILE_KIND_LABEL: Record<TileKind, string> = {
  ...RESOURCE_LABEL,
  plaza: '광장',
};

export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

/** 보드 반지름: 가운데 칸에서 가장자리까지 2칸 → 줄마다 3-4-5-4-3칸, 모두 19칸 */
export const BOARD_RADIUS = 2;

/**
 * 고정 보드 (육각 19칸, 위쪽 줄 A 부터 아래쪽 줄 E 까지). 칸 코드(A1~E3)는 맵을 만들고 바꿀 때 쓴다.
 * 가운데 C3 은 마을 광장(빈 땅)이고 기사단 동상이 처음 서 있다. 목재·곡물·양모가 4칸씩, 벽돌·석재가 3칸씩이다.
 * 같은 종류의 생산 칸끼리는 변을 맞대지 않고, 광장 둘레 6칸에 다섯 종류가 모두 있다.
 */
export const BOARD_LAYOUT: readonly (readonly TileKind[])[] = [
  ['wool', 'grain', 'stone'],
  ['wood', 'brick', 'wood', 'wool'],
  ['grain', 'stone', 'plaza', 'grain', 'wood'],
  ['brick', 'wool', 'stone', 'brick'],
  ['wood', 'grain', 'wool'],
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

/** 숫자 토큰 18개 (카탄 기본판과 같은 구성). 게임마다 생산 칸에 무작위로 놓되 6과 8은 이웃하지 않게 한다. */
export const NUMBER_TOKENS: readonly number[] = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

/** 두 주사위 합이 나올 경우의 수 (숫자판의 점 개수) */
export function numberPips(n: number): number {
  return 6 - Math.abs(7 - n);
}

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 4;
/** 이 승점에 먼저 닿으면 이긴다 (자기 턴에 판정) */
export const WIN_POINTS = 10;
/** 7이 나오면 자원이 이 수보다 많은 사람이 절반(내림)을 버린다 */
export const DISCARD_LIMIT = 7;

export const PIECE_LABEL: Record<PieceKind, string> = { road: '길', village: '마을', city: '도시' };
/** 건설 비용 (카탄 설명서와 같은 값): 길 = 목재·벽돌, 마을 = 목재·벽돌·양모·곡물, 도시 = 곡물 2·석재 3 (마을을 올린다) */
export const PIECE_COST: Record<PieceKind, Bundle> = {
  road: { wood: 1, grain: 0, wool: 0, brick: 1, stone: 0 },
  village: { wood: 1, grain: 1, wool: 1, brick: 1, stone: 0 },
  city: { wood: 0, grain: 2, wool: 0, brick: 0, stone: 3 },
};
/** 한 사람이 가질 수 있는 개수 */
export const PIECE_LIMIT: Record<PieceKind, number> = { road: 15, village: 5, city: 4 };
/** 마을 1점, 도시 2점 (도시로 올리면 마을 1점이 도시 2점으로 바뀐다) */
export const PIECE_POINTS: Record<PieceKind, number> = { road: 0, village: 1, city: 2 };

/** 발전 카드 1장 값: 양모·곡물·석재 1개씩 */
export const DEV_COST: Bundle = { wood: 0, grain: 1, wool: 1, brick: 0, stone: 1 };
/** 발전 카드 25장: 기사 14, 승점 5, 길 건설 2, 풍년 2, 독점 2 */
export const DEV_DECK: Readonly<Record<DevKind, number>> = { knight: 14, victory: 5, road_building: 2, year_of_plenty: 2, monopoly: 2 };
export const DEV_LABEL: Record<DevKind, string> = {
  knight: '기사',
  victory: '승점',
  road_building: '길 건설',
  year_of_plenty: '풍년',
  monopoly: '독점',
};
export const DEV_HELP: Record<DevKind, string> = {
  knight: '기사단 동상을 다른 칸으로 옮기고, 그 칸에 닿은 사람 한 명에게서 자원 1장을 빼앗는다. 쓴 기사는 최강 기사단 계산에 들어간다.',
  victory: '승점 1점. 다른 사람에게는 보이지 않고, 10점에 닿을 때 함께 센다.',
  road_building: '길 2개를 비용 없이 놓는다.',
  year_of_plenty: '원하는 자원 2개를 은행에서 받는다 (같은 종류 2개도 된다).',
  monopoly: '자원 한 종류를 고르면 다른 사람 모두가 그 자원을 전부 나에게 준다.',
};

/** 최장 교역로: 이어진 길 5칸 이상, 가장 긴 한 사람에게 2점 */
export const LONGEST_ROAD_MIN = 5;
/** 최강 기사단: 쓴 기사 카드 3장 이상, 가장 많은 한 사람에게 2점 */
export const LARGEST_ARMY_MIN = 3;
export const AWARD_POINTS = 2;

/** 은행 교환 비율. 해상 교역로가 있으면 3:1 (아무 자원) 또는 2:1 (정해진 자원) */
export const BANK_RATIO = 4;
export const GENERIC_HARBOR_RATIO = 3;
export const SPECIAL_HARBOR_RATIO = 2;

/** 한 번의 플레이어 교환에서 한 종류당 제시할 수 있는 최대 수량 */
export const MAX_TRADE_AMOUNT = 9;

export const NICKNAME_MAX = 12;
export const ROOM_CODE_LENGTH = 4;
/** 헷갈리기 쉬운 0/O, 1/I/L 을 뺀 방 코드 문자 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function emptyBundle(): Bundle {
  return { wood: 0, grain: 0, wool: 0, brick: 0, stone: 0 };
}

export function bundleTotal(b: Bundle): number {
  return RESOURCES.reduce((n, r) => n + b[r], 0);
}

/** "목재 1개, 벽돌 1개" 처럼 0개가 아닌 자원만 늘어놓는다 */
export function bundleLabel(b: Bundle): string {
  return RESOURCES.filter((r) => b[r] > 0)
    .map((r) => `${RESOURCE_LABEL[r]} ${b[r]}개`)
    .join(', ');
}

export function hasBundle(have: Bundle, need: Bundle): boolean {
  return RESOURCES.every((r) => have[r] >= need[r]);
}
