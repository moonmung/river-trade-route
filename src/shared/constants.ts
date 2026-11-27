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
  gold: '금광',
};

/** 줄 글자. 표준 육각형은 A~E 다섯 줄이고, 대형 맵은 I 까지 아홉 줄이다. */
export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;

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

/** 2명이면 일대일 대결로 같은 규칙을 쓴다. 보통 맵은 4명까지, 대형 맵은 8명까지 (맵마다 인원은 maps.ts 의 maxPlayersFor). */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
/** 고를 수 있는 플레이어 색 개수 (client/theme.ts 의 PLAYER_COLORS 와 같다). 대기실에서 서로 다른 색을 하나씩 골라 쓴다. */
export const PLAYER_COLOR_COUNT = 12;
/** 이 승점에 먼저 닿으면 이긴다 (자기 턴에 판정). 방장이 방을 만들 때 WIN_POINTS_MIN~WIN_POINTS_MAX 사이로 바꿀 수 있다. */
export const WIN_POINTS = 10;
export const WIN_POINTS_MIN = 10;
export const WIN_POINTS_MAX = 20;

/** 승리 점수 입력값을 확인한다. 정수가 아니거나 범위를 벗어나면 null. */
export function normalizeWinPoints(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= WIN_POINTS_MIN && v <= WIN_POINTS_MAX ? v : null;
}
/**
 * 자원 보유 한도: 7이 나오면 자원이 이 수보다 많은 사람이 절반(내림)을 버린다.
 * 기본 7장이고 방장이 대기실에서 HAND_LIMIT_MIN~HAND_LIMIT_MAX 사이로 바꿀 수 있다.
 */
export const DISCARD_LIMIT = 7;
export const HAND_LIMIT_MIN = 5;
export const HAND_LIMIT_MAX = 20;

/** 보유 한도 입력값을 확인한다. 정수가 아니거나 범위를 벗어나면 null. */
export function normalizeHandLimit(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= HAND_LIMIT_MIN && v <= HAND_LIMIT_MAX ? v : null;
}

/**
 * 한 사람이 한 차례에 쓸 수 있는 시간 (초). 시간이 다 되면 서버가 대신 진행한다
 * (굴리기·동상 옮기기·버리기는 무작위로, 교환·건설 단계는 턴을 넘긴다). 0 이면 제한 없음.
 */
export const TURN_SECONDS = 60;
export const TURN_SECONDS_OPTIONS: readonly number[] = [0, 30, 45, 60, 90, 120, 180];

export function normalizeTurnSeconds(v: unknown): number | null {
  return typeof v === 'number' && TURN_SECONDS_OPTIONS.includes(v) ? v : null;
}

export const PIECE_LABEL: Record<PieceKind, string> = { road: '길', village: '마을', city: '도시', ship: '배' };
/**
 * 건설 비용 (카탄 설명서와 같은 값): 길 = 목재·벽돌, 마을 = 목재·벽돌·양모·곡물, 도시 = 곡물 2·석재 3 (마을을 올린다),
 * 배 = 목재·양모 (섬 맵에서만)
 */
export const PIECE_COST: Record<PieceKind, Bundle> = {
  road: { wood: 1, grain: 0, wool: 0, brick: 1, stone: 0 },
  village: { wood: 1, grain: 1, wool: 1, brick: 1, stone: 0 },
  city: { wood: 0, grain: 2, wool: 0, brick: 0, stone: 3 },
  ship: { wood: 1, grain: 0, wool: 1, brick: 0, stone: 0 },
};
/** 한 사람이 가질 수 있는 개수 (기본값. 방장이 대기실에서 PIECE_LIMIT_RANGE 안으로 바꿀 수 있다) */
export const PIECE_LIMIT: Record<PieceKind, number> = { road: 15, village: 5, city: 4, ship: 15 };
/** 한 사람이 가질 수 있는 길·마을·도시·배 개수 */
export type PieceLimits = Record<PieceKind, number>;
/** 방장이 정하는 한 사람의 조각 수 범위 */
export const PIECE_LIMIT_RANGE: Record<PieceKind, readonly [number, number]> = { road: [5, 40], village: [2, 15], city: [1, 12], ship: [5, 40] };

/** 배 개수가 생기기 전에 저장한 값처럼 배가 빠져 있으면 배는 기본값으로 채운다. 나머지가 범위를 벗어나면 null. */
export function normalizePieceLimits(v: unknown): PieceLimits | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const out = { ...PIECE_LIMIT };
  for (const k of Object.keys(PIECE_LIMIT) as PieceKind[]) {
    const n = o[k];
    if (n === undefined && k === 'ship') continue;
    const [lo, hi] = PIECE_LIMIT_RANGE[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return null;
    out[k] = n;
  }
  return out;
}
/** 마을 1점, 도시 2점 (도시로 업그레이드하면 마을 1점이 도시 2점으로 바뀐다) */
export const PIECE_POINTS: Record<PieceKind, number> = { road: 0, village: 1, city: 2, ship: 0 };

/** 발전 카드 1장 값: 양모·곡물·석재 1개씩 */
export const DEV_COST: Bundle = { wood: 0, grain: 1, wool: 1, brick: 0, stone: 1 };
/** 발전 카드 25장: 기사 14, 승점 5, 길 건설 2, 풍년 2, 독점 2 */
export const DEV_DECK: Readonly<Record<DevKind, number>> = { knight: 14, victory: 5, road_building: 2, year_of_plenty: 2, monopoly: 2 };
/** 발전 카드 더미의 기본 장수와 방장이 고를 수 있는 범위. 종류 비율은 DEV_DECK 을 따른다. */
export const DEV_CARDS = 25;
export const DEV_CARDS_MIN = 10;
export const DEV_CARDS_MAX = 50;

export function normalizeDevCards(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= DEV_CARDS_MIN && v <= DEV_CARDS_MAX ? v : null;
}

/** 발전 카드 종류별 장수 */
export type DevMix = Record<DevKind, number>;
/** 방장이 발전 카드를 종류마다 정할 때 한 종류의 최대 장수 (0장도 된다. 모두 합쳐 1~DEV_CARDS_MAX 장) */
export const DEV_KIND_MAX = 30;

export function devMixTotal(m: DevMix): number {
  return (Object.keys(DEV_DECK) as DevKind[]).reduce((n, k) => n + m[k], 0);
}

export function normalizeDevMix(v: unknown): DevMix | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const out = { ...DEV_DECK } as DevMix;
  for (const k of Object.keys(DEV_DECK) as DevKind[]) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > DEV_KIND_MAX) return null;
    out[k] = n;
  }
  const total = devMixTotal(out);
  return total >= 1 && total <= DEV_CARDS_MAX ? out : null;
}

/**
 * 총 장수가 total 인 발전 카드 더미의 종류별 장수. DEV_DECK(25장)의 비율로 나누고, 내림하고 남은 장수는 소수점이 큰 종류부터 한 장씩 더한다.
 * 다섯 종류가 모두 한 장 이상 들어가게 한다 (25장이면 DEV_DECK 그대로).
 */
export function devDeckFor(total: number): Record<DevKind, number> {
  const kinds = Object.keys(DEV_DECK) as DevKind[];
  const base = kinds.reduce((n, k) => n + DEV_DECK[k], 0);
  const exact = kinds.map((k) => ({ k, v: (DEV_DECK[k] * total) / base }));
  const out = Object.fromEntries(exact.map(({ k, v }) => [k, Math.max(1, Math.floor(v))])) as Record<DevKind, number>;
  let left = total - kinds.reduce((n, k) => n + out[k], 0);
  const order = [...exact].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)) || DEV_DECK[b.k] - DEV_DECK[a.k]);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i].k] += 1;
  // 한 장씩 채우느라 넘쳤으면 가장 많은 종류(기사)에서 뺀다.
  while (left < 0) {
    const most = kinds.reduce((a, b) => (out[b] > out[a] ? b : a));
    out[most] -= 1;
    left += 1;
  }
  return out;
}

/** 은행에 두는 자원 카드 수 (자원마다). 생산·풍년·은행 교환은 여기서 꺼내고 건설·버리기·은행 교환으로 돌아온다. */
export const RESOURCE_CARDS = 19;
export const RESOURCE_CARDS_MIN = 10;
export const RESOURCE_CARDS_MAX = 40;

export function normalizeResourceCards(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= RESOURCE_CARDS_MIN && v <= RESOURCE_CARDS_MAX ? v : null;
}

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
  road_building: '길 2개를 비용 없이 놓는다. 섬 맵에서는 길 대신 배를 띄워도 된다.',
  year_of_plenty: '원하는 자원 2개를 은행에서 받는다 (같은 종류 2개도 된다).',
  monopoly: '자원 한 종류를 고르면 다른 사람 모두가 그 자원을 전부 나에게 준다.',
};

/** 새 섬 보너스 (섬 맵): 작은 섬에 처음 마을을 지은 사람마다, 섬마다 2점 */
export const ISLAND_BONUS_POINTS = 2;
/** 섬 맵의 기본 승리 점수 (항해사 「새로운 해안으로」처럼 14점. 방장이 바꿀 수 있다) */
export const ISLANDS_WIN_POINTS = 14;
/** 금광 (섬 맵): 숫자가 나오면 닿은 마을은 원하는 자원 2장, 도시는 3장을 골라 받는다 (두 번째 시작 마을도 2장) */
export const GOLD_YIELD = { village: 2, city: 3 } as const;

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
/** 차례인 사람이 동시에 열어 둘 수 있는 교환 제안 수 */
export const MAX_OPEN_TRADES = 3;

/** 채팅: 한 줄 최대 글자 수, 방마다 보관하는 최근 메시지 수 */
export const CHAT_MAX_LENGTH = 120;
export const CHAT_HISTORY = 50;
/** 빠르게 띄우는 이모티콘 (이 목록 밖의 것은 서버가 받지 않는다) */
export const CHAT_EMOTES = ['👍', '😂', '😮', '😡', '🎉', '🤝'] as const;

/**
 * 핑(보드 한 자리를 가리키기) 제한: 처음에는 burst 번을 연달아 찍을 수 있고, 다 쓰면 refillMs 마다 한 번씩 다시 생긴다
 * (쉬면 최대 burst 번까지 모인다). 난사하지 못하게 서버와 화면이 같은 셈(takePingToken)을 한다.
 */
export const PING_LIMIT = { burst: 3, refillMs: 1000 } as const;
export const PING_SLOW_TEXT = `핑은 연달아 ${PING_LIMIT.burst}번까지, 그 뒤로는 ${PING_LIMIT.refillMs / 1000}초에 한 번씩 찍을 수 있습니다.`;

/** 남은 핑 횟수(소수 포함)와 마지막으로 센 시각 */
export interface PingBucket {
  tokens: number;
  at: number;
}

/**
 * now 까지 다시 생긴 만큼 채운 뒤 한 번 찍을 수 있으면 하나를 쓰고 ok. bucket 이 없으면 가득 찬 것으로 본다.
 * slackMs: 서버가 네트워크 지연 차이만큼 조금 너그럽게 판정할 때 쓴다. 판정에만 쓰고 남은 횟수에는 더하지 않으며,
 * 여유 덕에 통과하면 남은 횟수가 잠깐 0 아래로 내려가 다음 핑이 그만큼 늦게 생긴다 (거절된 핑을 연타해도 횟수가 늘지 않는다).
 */
export function takePingToken(bucket: PingBucket | undefined, now: number, slackMs = 0): { ok: boolean; bucket: PingBucket } {
  const base = bucket ?? { tokens: PING_LIMIT.burst, at: now };
  const elapsed = Math.max(0, now - base.at);
  const tokens = Math.min(PING_LIMIT.burst, base.tokens + elapsed / PING_LIMIT.refillMs);
  const lenient = Math.min(PING_LIMIT.burst, base.tokens + (elapsed + slackMs) / PING_LIMIT.refillMs);
  if (lenient < 1) return { ok: false, bucket: { tokens, at: now } };
  return { ok: true, bucket: { tokens: tokens - 1, at: now } };
}
/** 핑 물결이 보드 위에 떠 있는 시간 (CSS 의 ping-mark 와 같다) */
export const PING_MS = 2600;

/** 최장 교역로·최강 기사단을 가진 사람이 모두에게 뽐내는 자랑하기의 최소 간격 (달성 공지가 다 사라질 만큼) */
export const BRAG_GAP_MS = 5000;
/** 이긴 사람이 승리를 뽐내는 간격 (게임이 끝난 뒤라 한마디만 바뀌어 뜨므로 짧다) */
export const VICTORY_BRAG_GAP_MS = 2000;
/** 자랑할 때 뜨는 한마디의 가짓수 (자랑 종류마다) */
export const BRAG_LINE_COUNT = 10;

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
