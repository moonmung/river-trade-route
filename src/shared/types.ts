// 서버와 브라우저가 함께 쓰는 게임 자료형.

export type Resource = 'wood' | 'grain' | 'stone';
export type TileKind = Resource | 'market';
export type Bundle = Record<Resource, number>;
/** 'A1' ~ 'D4' 형식의 고정 타일 ID. 시작 배치와 건설 요청은 이 ID를 사용한다. */
export type TileId = string;
export type ContractId = 'raft' | 'food' | 'levee' | 'general';

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

export interface ContractDef {
  id: ContractId;
  name: string;
  cost: Bundle;
  points: number;
}

export interface Settlement {
  tileId: TileId;
  owner: string;
  /** 0이면 시작 거점. 그 외에는 지은 라운드이며, 다음 라운드부터 생산한다. */
  builtRound: number;
}

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
  | { type: 'place'; tileId: TileId }
  | { type: 'build'; tileId: TileId }
  | { type: 'market'; give: Resource; get: Resource }
  | { type: 'deliver'; contractId: ContractId }
  | { type: 'trade_propose'; to: string; give: Bundle; get: Bundle }
  | { type: 'trade_accept'; tradeId: number }
  | { type: 'trade_reject'; tradeId: number }
  | { type: 'trade_cancel'; tradeId: number }
  | { type: 'end_turn' };

export type TradeCloseReason = 'cancelled' | 'rejected' | 'turn_end' | 'unaffordable' | 'no_actions';

interface EventBase {
  seq: number;
  round: number;
}

/**
 * 게임 기록. detail 필드는 비공개 정보이며, 서버가 각 브라우저에 보낼 때
 * 볼 자격이 없는 사람에게서는 제거한다 (view.ts 의 filterEventFor).
 */
export type GameEvent = EventBase &
  (
    | { kind: 'game_start'; order: string[] }
    | { kind: 'placement'; player: string; tileId: TileId }
    | {
        kind: 'round_start';
        firstPlayer: string;
        forecast: Resource;
        /** 플레이어별 생산 총량 (공개) */
        gains: Record<string, number>;
        /** 플레이어별 종류별 생산량 (본인 것만 전송) */
        detail?: Record<string, Bundle>;
      }
    | { kind: 'build'; player: string; tileId: TileId }
    | { kind: 'market'; player: string; detail?: { give: Resource; get: Resource } }
    | { kind: 'deliver'; player: string; contractId: ContractId; points: number }
    | { kind: 'trade_proposed'; from: string; to: string; tradeId: number; detail?: { give: Bundle; get: Bundle } }
    | { kind: 'trade_accepted'; from: string; to: string; tradeId: number; detail?: { give: Bundle; get: Bundle } }
    | { kind: 'trade_closed'; from: string; to: string; tradeId: number; reason: TradeCloseReason }
    | { kind: 'turn_end'; player: string }
    | { kind: 'game_end'; winners: string[] }
  );

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewGameEvent = DistributiveOmit<GameEvent, 'seq' | 'round'>;

export interface RankEntry {
  playerId: string;
  score: number;
  resourceTotal: number;
  rank: number;
}

export interface GameResult {
  ranking: RankEntry[];
  winners: string[];
  /** score: 점수로 결정, resources: 동점을 남은 자원으로 판정, joint: 공동 승리 */
  decidedBy: 'score' | 'resources' | 'joint';
}
