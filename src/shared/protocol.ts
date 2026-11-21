// 브라우저 ↔ 서버 Socket.IO 메시지 형식.
import type { Building, Bundle, DevCard, GameEvent, GamePhase, GameResult, GameAction, Harbor, Resource, Road, TileId, TradeResponse, TurnStep } from './types';

export interface LobbyPlayerView {
  id: string;
  nickname: string;
  colorIndex: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
}

/** 다른 사람에게도 공개되는 플레이어 정보. 종류별 자원과 발전 카드 종류는 포함하지 않는다. */
export interface GamePlayerView {
  id: string;
  seat: number;
  /** 공개 승점: 마을·도시 + 최장 교역로·최강 기사단 (숨긴 승점 카드는 빠진다) */
  score: number;
  resourceTotal: number;
  /** 손에 든 발전 카드 장수 */
  devCardCount: number;
  /** 쓴 기사 카드 수 */
  knightsPlayed: number;
  /** 가장 길게 이어진 길 */
  roadLength: number;
  villages: number;
  cities: number;
  roads: number;
}

/** 열린 교환 제안. 모두에게 제안하므로 내용과 응답은 모두에게 보인다 (종류별 보유량은 들어 있지 않다). */
export interface TradeView {
  id: number;
  from: string;
  /** 제안을 받은 사람들 */
  to: string[];
  /** 제안한 사람이 내는 자원 */
  give: Bundle;
  /** 제안한 사람이 받는 자원 */
  get: Bundle;
  responses: Record<string, TradeResponse>;
}

export interface GameView {
  phase: GamePhase;
  /** 진행 턴 번호 (시작 배치 중에는 0) */
  turn: number;
  order: string[];
  placementOrder: string[];
  placementPlayerId: string | null;
  currentPlayerId: string | null;
  step: TurnStep;
  dice: [number, number] | null;
  /** 7이 나와 아직 버려야 하는 장수 */
  discards: Record<string, number>;
  /** 기사단 동상을 옮긴 뒤 빼앗을 수 있는 상대 */
  stealFrom: string[];
  /** 기사단 동상이 선 칸 */
  robber: TileId;
  /** 칸마다 놓인 주사위 숫자 */
  numbers: Record<TileId, number>;
  harbors: Harbor[];
  buildings: Building[];
  roads: Road[];
  devDeckCount: number;
  devPlayedThisTurn: boolean;
  freeRoads: number;
  longestRoad: { holder: string | null; length: number };
  largestArmy: { holder: string | null; size: number };
  players: GamePlayerView[];
  /** 이 화면의 주인 자원만 종류별로 들어 있다. */
  myResources: Bundle;
  /** 이 화면의 주인이 든 발전 카드 */
  myDevCards: DevCard[];
  /** 이 화면의 주인이 쓸 수 있는 은행 교환 비율 */
  myTradeRatios: Record<Resource, number>;
  /** 이 화면의 주인 승점 (숨긴 승점 카드 포함) */
  myPoints: number;
  trade: TradeView | null;
  events: GameEvent[];
  result: GameResult | null;
  version: number;
}

export interface RoomView {
  code: string;
  phase: 'lobby' | 'game';
  hostId: string;
  /** 이 화면의 주인 플레이어 ID */
  you: string;
  players: LobbyPlayerView[];
  game: GameView | null;
  gameNumber: number;
  minPlayers: number;
  maxPlayers: number;
}

export interface RoomPeek {
  code: string;
  phase: 'lobby' | 'game';
  playerCount: number;
  maxPlayers: number;
  joinable: boolean;
  hostNickname: string;
}

export interface SessionInfo {
  roomCode: string;
  playerId: string;
  token: string;
  nickname: string;
}

/** 연결이 끊긴 자리를 다른 기기로 넘기는 일회용 코드 (방장이 만들고, 새 기기에서 참가 화면에 넣는다) */
export interface SeatHandover {
  playerId: string;
  /** 숫자 SEAT_CODE_LENGTH 자리 */
  code: string;
  expiresAt: number;
}

export const SEAT_CODE_LENGTH = 6;

/** 자리 넘기기 코드 입력값을 숫자만 남겨 확인한다. 형식이 맞지 않으면 null. */
export function normalizeSeatCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${SEAT_CODE_LENGTH}}$`).test(digits) ? digits : null;
}

export interface LanAddress {
  address: string;
  name: string;
  preferred: boolean;
}

export interface ServerInfo {
  port: number;
  lanAddresses: LanAddress[];
}

export type AckFail = { ok: false; error: string; code?: string };
export type AckResult<T extends object = object> = ({ ok: true } & T) | AckFail;
export type Ack<T extends object = object> = (result: AckResult<T>) => void;

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  'session:invalid': (info: { reason: string }) => void;
  'session:replaced': () => void;
  kicked: () => void;
}

export interface ClientToServerEvents {
  'room:create': (p: { nickname: string }, ack: Ack<SessionInfo>) => void;
  'room:join': (p: { code: string; nickname: string }, ack: Ack<SessionInfo>) => void;
  'room:peek': (p: { code: string }, ack: Ack<RoomPeek>) => void;
  /** 방장: 연결이 끊긴 자리를 넘길 코드를 만든다 */
  'seat:handover': (p: { playerId: string }, ack: Ack<SeatHandover>) => void;
  /** 새 기기: 받은 코드로 그 자리를 넘겨받는다 */
  'seat:claim': (p: { code: string; seatCode: string }, ack: Ack<SessionInfo>) => void;
  'room:ready': (p: { ready: boolean }, ack: Ack) => void;
  'room:start': (p: Record<string, never>, ack: Ack) => void;
  'room:leave': (p: Record<string, never>, ack: Ack) => void;
  'room:kick': (p: { playerId: string }, ack: Ack) => void;
  'room:rematch': (p: Record<string, never>, ack: Ack) => void;
  'game:action': (p: { requestId: string; action: GameAction }, ack: Ack) => void;
}

/** Socket.IO 연결 때 보내는 인증 정보 (재접속 시 같은 자리 복구용) */
export interface HandshakeAuth {
  roomCode?: string;
  token?: string;
}
