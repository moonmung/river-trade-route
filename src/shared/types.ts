// 서버와 브라우저가 함께 쓰는 게임 자료형.

/** 목재(숲)·곡물(밭)·양모(목초지)·벽돌(점토 구덩이)·석재(채석장) */
export type Resource = 'wood' | 'grain' | 'wool' | 'brick' | 'stone';
/** 생산 칸 다섯 종류와 가운데 광장(아무것도 나지 않는 빈 땅, 기사단 동상이 처음 서는 곳) */
export type TileKind = Resource | 'plaza';
export type Bundle = Record<Resource, number>;
/** 'A1' ~ 'E3' 형식의 고정 타일 ID. 맵을 만들고 바꿀 때 쓰는 코드이고, 게임 화면에는 주사위 숫자를 보여 준다. */
export type TileId = string;

export interface TileDef {
  id: TileId;
  /** 줄 번호 (A=0) */
  row: number;
  /** 줄 안에서 몇 번째 칸인지 (1번 칸=0) */
  col: number;
  /** 육각 격자 축 좌표 (pointy-top). 이웃 판정과 3D 배치에 쓴다. */
  q: number;
  r: number;
  kind: TileKind;
}

/** 길·마을·도시. 마을과 도시는 꼭짓점에, 길은 변에 놓는다. */
export type PieceKind = 'road' | 'village' | 'city';

/** 꼭짓점 위의 마을 또는 도시 */
export interface Building {
  vertexId: string;
  owner: string;
  kind: 'village' | 'city';
  /** 짓거나 도시로 올린 턴 번호 (시작 배치는 0) */
  builtTurn: number;
}

/** 변 위의 길 */
export interface Road {
  edgeId: string;
  owner: string;
  builtTurn: number;
}

/** 해상 교역로: 바닷가 변 하나에 붙는다. 그 변 양 끝 꼭짓점에 마을·도시가 있으면 쓸 수 있다. */
export interface Harbor {
  edgeId: string;
  /** null 이면 아무 자원 3개 → 1개, 자원이 정해져 있으면 그 자원 2개 → 1개 */
  resource: Resource | null;
}

/** 발전 카드: 기사, 승점, 길 건설, 풍년, 독점 */
export type DevKind = 'knight' | 'victory' | 'road_building' | 'year_of_plenty' | 'monopoly';

export interface DevCard {
  kind: DevKind;
  /** 산 턴 번호. 산 턴에는 쓸 수 없다. */
  boughtTurn: number;
}

/**
 * 한 턴의 단계.
 * roll: 주사위를 굴리기 전 (기사 카드는 굴리기 전에도 쓸 수 있다)
 * discard: 7이 나와 자원 8장 이상인 사람들이 절반을 버리는 중
 * robber: 차례인 사람이 기사단 동상을 옮길 칸을 고르는 중
 * steal: 동상을 옮긴 칸에 닿은 사람 중 누구에게서 자원을 빼앗을지 고르는 중
 * main: 교환·건설·발전 카드
 * road_building: 길 건설 카드로 공짜 길을 놓는 중
 */
export type TurnStep = 'roll' | 'discard' | 'robber' | 'steal' | 'main' | 'road_building';

export interface TradeOffer {
  id: number;
  from: string;
  to: string;
  /** 제안한 사람(차례인 사람)이 내는 자원 */
  give: Bundle;
  /** 제안한 사람이 받는 자원 (상대가 내는 자원) */
  get: Bundle;
}

export type GamePhase = 'placement' | 'playing' | 'finished';

export type GameAction =
  | { type: 'place'; vertexId: string; edgeId: string }
  | { type: 'roll' }
  | { type: 'discard'; bundle: Bundle }
  | { type: 'move_robber'; tileId: TileId }
  | { type: 'steal'; from: string }
  | { type: 'build_road'; edgeId: string }
  | { type: 'build_village'; vertexId: string }
  | { type: 'build_city'; vertexId: string }
  | { type: 'buy_dev' }
  | { type: 'play_dev'; kind: 'knight' | 'road_building' }
  | { type: 'play_dev'; kind: 'year_of_plenty'; resources: [Resource, Resource] }
  | { type: 'play_dev'; kind: 'monopoly'; resource: Resource }
  | { type: 'bank_trade'; give: Resource; get: Resource }
  | { type: 'trade_propose'; to: string; give: Bundle; get: Bundle }
  | { type: 'trade_accept'; tradeId: number }
  | { type: 'trade_reject'; tradeId: number }
  | { type: 'trade_cancel'; tradeId: number }
  | { type: 'end_turn' };

export type TradeCloseReason = 'cancelled' | 'rejected' | 'turn_end' | 'unaffordable';

interface EventBase {
  seq: number;
  /** 기록이 남은 턴 번호 (시작 배치는 0) */
  turn: number;
}

/**
 * 게임 기록. detail 필드는 비공개 정보이며, 서버가 각 브라우저에 보낼 때
 * 볼 자격이 없는 사람에게서는 제거한다 (view.ts 의 filterEventFor).
 */
export type GameEvent = EventBase &
  (
    | { kind: 'game_start'; order: string[] }
    | { kind: 'placement'; player: string; vertexId: string; edgeId: string; gained?: Bundle }
    | {
        kind: 'roll';
        player: string;
        dice: [number, number];
        /** 플레이어별 생산 총량 (공개). 7이면 비어 있다. */
        gains: Record<string, number>;
        /** 생산한 칸 (기사단 동상이 막은 칸은 빠진다) */
        tiles: TileId[];
        /** 동상에 막혀 생산하지 못한 칸 */
        blocked: TileId[];
        /** 플레이어별 종류별 생산량 (본인 것만 전송) */
        detail?: Record<string, Bundle>;
      }
    | { kind: 'discard'; player: string; count: number; detail?: Bundle }
    | { kind: 'robber'; player: string; tileId: TileId }
    | { kind: 'steal'; player: string; from: string; detail?: Resource }
    | { kind: 'build'; player: string; piece: PieceKind; at: string; free?: boolean }
    | { kind: 'buy_dev'; player: string; detail?: DevKind }
    | { kind: 'play_dev'; player: string; card: Exclude<DevKind, 'victory'>; resources?: Resource[]; amount?: number }
    | { kind: 'bank_trade'; player: string; give: Resource; get: Resource; ratio: number }
    | { kind: 'trade_proposed'; from: string; to: string; tradeId: number; detail?: { give: Bundle; get: Bundle } }
    | { kind: 'trade_accepted'; from: string; to: string; tradeId: number; detail?: { give: Bundle; get: Bundle } }
    | { kind: 'trade_closed'; from: string; to: string; tradeId: number; reason: TradeCloseReason }
    | { kind: 'award'; award: 'longest_road' | 'largest_army'; player: string | null; previous: string | null; size: number }
    | { kind: 'turn_end'; player: string }
    | { kind: 'game_end'; winners: string[] }
  );

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewGameEvent = DistributiveOmit<GameEvent, 'seq' | 'turn'>;

export interface RankEntry {
  playerId: string;
  /** 승점 (게임이 끝나면 숨긴 승점 카드까지 더한 값) */
  score: number;
  resourceTotal: number;
  rank: number;
}

export interface GameResult {
  ranking: RankEntry[];
  winners: string[];
  /** score: 10점 도달 */
  decidedBy: 'score';
}
