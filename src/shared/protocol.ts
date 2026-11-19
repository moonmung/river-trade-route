// 브라우저 ↔ 서버 Socket.IO 메시지 형식.
import type {
  Bundle,
  ContractId,
  GameAction,
  GameEvent,
  GamePhase,
  GameResult,
  Resource,
  Settlement,
} from './types';

export interface LobbyPlayerView {
  id: string;
  nickname: string;
  colorIndex: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
}

/** 다른 사람에게도 공개되는 플레이어 정보. 종류별 자원은 포함하지 않는다. */
export interface GamePlayerView {
  id: string;
  seat: number;
  score: number;
  resourceTotal: number;
  settlementCount: number;
}

/** 교환 당사자에게만 give/get 이 채워진다. */
export interface TradeView {
  id: number;
  from: string;
  to: string;
  give?: Bundle;
  get?: Bundle;
}

export interface ContractView {
  id: ContractId;
  completedBy: string | null;
}

export interface GameView {
  phase: GamePhase;
  round: number;
  totalRounds: number;
  forecast: Resource[];
  order: string[];
  placementOrder: string[];
  placementPlayerId: string | null;
  firstPlayerId: string | null;
  currentPlayerId: string | null;
  actionsLeft: number;
  settlements: Settlement[];
  contracts: ContractView[];
  players: GamePlayerView[];
  /** 이 화면의 주인 자원만 종류별로 들어 있다. */
  myResources: Bundle;
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
