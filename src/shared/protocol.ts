// 브라우저 ↔ 서버 Socket.IO 메시지 형식.
import type { DiceMode } from './fairDice';
import type { DevMix, PieceLimits } from './constants';
import type {
  Building,
  Bundle,
  DevCard,
  GameEvent,
  GamePhase,
  GameResult,
  GameAction,
  Harbor,
  MapArrange,
  MapConfig,
  MapShape,
  Resource,
  Road,
  SeaCell,
  Ship,
  TileDef,
  TileId,
  TradeResponse,
  TurnStep,
} from './types';

export interface LobbyPlayerView {
  id: string;
  nickname: string;
  colorIndex: number;
  isHost: boolean;
  ready: boolean;
  /** 자리 비움: 컴퓨터가 대신 두는 중 */
  auto: boolean;
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
  /** 가장 길게 이어진 교역로 (길과 배) */
  roadLength: number;
  villages: number;
  cities: number;
  roads: number;
  /** 띄운 배 (섬 맵이 아니면 0) */
  ships: number;
  /** 새 섬 보너스를 받은 작은 섬 수 (섬 맵, 섬마다 2점이 score 에 들어 있다) */
  islands: number;
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
  /** 순서 정하기 주사위 기록 (사람마다 굴린 순서대로) */
  startRolls: Record<string, [number, number][]>;
  /** 순서 정하기에서 아직 굴려야 하는 사람 */
  startPending: string[];
  placementOrder: string[];
  placementPlayerId: string | null;
  /** 시작 배치에서 마을만 지어 두고 길을 기다리는 꼭짓점 */
  setupVillage: string | null;
  /** 자원 보유 한도 (7이 나오면 이보다 많이 든 사람이 절반을 버린다) */
  handLimit: number;
  /** 한 차례 제한 시간 (초, 0 이면 제한 없음) */
  turnSeconds: number;
  /** 지금 시간이 흐르는 사람들 */
  clockHolders: string[];
  /** 화면 정보를 만든 순간 남은 시간 (ms). 제한이 없거나 멈춰 있으면 null. 받은 쪽은 받은 시각에 더해 마감 시각을 잡는다. */
  timeLeftMs: number | null;
  currentPlayerId: string | null;
  step: TurnStep;
  dice: [number, number] | null;
  /** 7이 나와 아직 버려야 하는 장수 */
  discards: Record<string, number>;
  /** 기사단 동상을 옮긴 뒤 빼앗을 수 있는 상대 */
  stealFrom: string[];
  /** 이 게임의 보드 칸 (맵 모양과 땅 배치) */
  tiles: TileDef[];
  /** 배를 띄울 바다 칸 (섬 맵이 아니면 빈 목록) */
  sea: SeaCell[];
  /** 은행에 남은 자원 카드 (자원마다, 무제한이면 null) */
  bank: Bundle | null;
  /** 게임을 시작할 때 은행에 둔 자원 카드 수 (자원마다, 무제한이면 null) */
  bankSize: number | null;
  /** 기사단 동상이 선 칸 */
  robber: TileId;
  /** 칸마다 놓인 주사위 숫자 */
  numbers: Record<TileId, number>;
  harbors: Harbor[];
  buildings: Building[];
  roads: Road[];
  ships: Ship[];
  /** 이번 턴에 배를 이미 옮겼는지 */
  shipMoved: boolean;
  /** 해적선이 선 바다 칸 ID (섬 맵, 없으면 null) */
  pirate: string | null;
  /** 금광에서 원하는 자원을 골라 받을 장수 (사람마다, 다 고르면 빠진다) */
  goldPicks: Record<string, number>;
  devDeckCount: number;
  /** 개수 제한 없음: 길·마을·도시를 몇 개든 짓고 발전 카드도 떨어지지 않는다 */
  unlimited: boolean;
  /** 주사위 방식 (고르게·무작위) */
  diceMode: DiceMode;
  /** 7이 나오면 보유 한도보다 많이 든 사람이 절반을 버리는지 */
  sevenDiscard: boolean;
  /** 최장 교역로 2점이 있는지 (예전 서버는 보내지 않는다: 없으면 있음) */
  longestRoadAward?: boolean;
  /** 최강 기사단 2점이 있는지 (예전 서버는 보내지 않는다: 없으면 있음) */
  largestArmyAward?: boolean;
  /** 한 사람이 가질 수 있는 길·마을·도시 개수 (방장이 정한 값) */
  pieceLimits: PieceLimits;
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
  /** 열린 교환 제안 (차례인 사람이 낸 것, 낸 순서대로 최대 MAX_OPEN_TRADES 개) */
  trades: TradeView[];
  events: GameEvent[];
  result: GameResult | null;
  /** 이 승점에 먼저 닿으면 이긴다 */
  winPoints: number;
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
  /** 방장이 정한 승리 점수 (다음 게임에 쓴다) */
  winPoints: number;
  /** 방장이 정한 자원 보유 한도 */
  handLimit: number;
  /** 방장이 정한 한 차례 제한 시간 (초, 0 이면 제한 없음) */
  turnSeconds: number;
  /** 방장이 정한 맵 모양과 땅 배치 (다음 게임에 쓴다) */
  map: MapConfig;
  /** 방장이 정한 은행 자원 카드 수 (자원마다) */
  resourceCards: number;
  /** 방장이 정한 발전 카드 총 장수 (종류별로 정했으면 그 합) */
  devCards: number;
  /** 발전 카드 종류별 장수 (종류별로 정하지 않았으면 총 장수를 기본 비율로 나눈 값) */
  devMix: DevMix;
  /** 방장이 발전 카드를 종류마다 따로 정했는지 */
  devMixCustom: boolean;
  /** 방장이 정한 한 사람의 길·마을·도시 개수 */
  pieceLimits: PieceLimits;
  /** 방장이 정한 개수 제한 없음 (길·마을·도시·발전 카드) */
  unlimited: boolean;
  /** 방장이 정한 주사위 방식 */
  diceMode: DiceMode;
  /** 방장이 정한 7 버리기 (있음·없음) */
  sevenDiscard: boolean;
  /** 방장이 정한 최장 교역로 달성 (있음·없음, 예전 서버는 보내지 않는다: 없으면 있음) */
  longestRoadAward?: boolean;
  /** 방장이 정한 최강 기사단 달성 (있음·없음, 예전 서버는 보내지 않는다: 없으면 있음) */
  largestArmyAward?: boolean;
}

/** 방장이 대기실에서 바꾸는 규칙 (보낸 것만 바뀐다) */
export interface RoomSettingsPatch {
  winPoints?: number;
  handLimit?: number;
  turnSeconds?: number;
  mapShape?: MapShape;
  mapArrange?: MapArrange;
  resourceCards?: number;
  /** 총 장수만 정한다 (종류는 기본 비율로 나눈다) */
  devCards?: number;
  /** 종류마다 장수를 정한다 */
  devMix?: DevMix;
  pieceLimits?: PieceLimits;
  unlimited?: boolean;
  diceMode?: DiceMode;
  sevenDiscard?: boolean;
  longestRoadAward?: boolean;
  largestArmyAward?: boolean;
}

export interface RoomPeek {
  code: string;
  phase: 'lobby' | 'game';
  playerCount: number;
  maxPlayers: number;
  joinable: boolean;
  hostNickname: string;
}

/** 서버를 켠 PC 의 처음 화면에 보이는 남은 방 한 줄 */
export interface RoomListing {
  code: string;
  phase: 'lobby' | 'game';
  /** 게임이 끝나 결과만 남은 방 */
  finished: boolean;
  /** 자리에 앉은 사람 닉네임 (방장이 맨 앞) */
  players: string[];
  /** 지금 접속해 있는 사람 수 */
  connected: number;
  /** 마지막으로 상태가 바뀐 시각 (ms) */
  touchedAt: number;
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

/** 같은 방 사람끼리 주고받는 짧은 글. 보낸 사람이 방을 나가도 이름이 남도록 이름·색을 함께 적는다. */
export interface ChatMessage {
  id: number;
  from: string;
  nickname: string;
  colorIndex: number;
  text: string;
  /** 서버가 받은 시각 (ms) */
  at: number;
}

/** 이름 옆에 잠깐 떠오르는 이모티콘 (보관하지 않는다) */
export interface ChatEmote {
  from: string;
  emote: string;
  at: number;
}

/** 보드 한 자리(칸·꼭짓점·변)를 가리키는 핑. 같은 방 모두의 보드에 그 사람 색 물결로 잠깐 뜬다. */
export interface ChatPing {
  /** 방마다 늘어나는 번호 */
  id: number;
  from: string;
  kind: 'tile' | 'vertex' | 'edge';
  target: string;
  at: number;
}

/** 자랑할 수 있는 것: 지금 가진 최장 교역로·최강 기사단(게임 중), 이긴 사람의 승리(게임이 끝난 뒤) */
export type BragKind = 'longest_road' | 'largest_army' | 'victory';

/**
 * 자랑하기: 최장 교역로·최강 기사단을 가진 사람은 모두의 화면에 달성 연출을 다시 띄워 뽐내고, 이긴 사람은 승리를 뽐낸다.
 * 누를 때마다 그 사람이 고른 한마디(line)가 함께 뜬다. 보관하지 않는다.
 */
export interface ChatBrag {
  from: string;
  award: BragKind;
  /** 뽐낼 때의 길 칸 수, 쓴 기사 장수, 또는 승리 점수 */
  size: number;
  /** 한마디 번호 (0 ~ BRAG_LINE_COUNT-1, 글은 화면이 갖고 있다) */
  line: number;
  at: number;
}

export type AckFail = { ok: false; error: string; code?: string };
export type AckResult<T extends object = object> = ({ ok: true } & T) | AckFail;
export type Ack<T extends object = object> = (result: AckResult<T>) => void;

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  'session:invalid': (info: { reason: string }) => void;
  'session:replaced': () => void;
  kicked: () => void;
  /** 방이 닫혔다. 방장이 닫았으면 남은 사람에게, 서버를 켠 PC 에서 지웠으면 접속해 있던 모두에게 보낸다. */
  'room:closed': (info?: { by: 'host' | 'server' }) => void;
  /** 방에 붙을 때(참가·재접속) 그 방의 최근 채팅 */
  'chat:history': (p: { code: string; messages: ChatMessage[] }) => void;
  'chat:message': (p: { code: string; message: ChatMessage }) => void;
  'chat:emote': (p: { code: string; emote: ChatEmote }) => void;
  'chat:ping': (p: { code: string; ping: ChatPing }) => void;
  'chat:brag': (p: { code: string; brag: ChatBrag }) => void;
}

export interface ClientToServerEvents {
  'room:create': (p: { nickname: string; winPoints?: number }, ack: Ack<SessionInfo>) => void;
  /** 방장: 대기실에서 승리 점수·자원 보유 한도·차례 시간을 바꾼다 */
  'room:settings': (p: RoomSettingsPatch, ack: Ack) => void;
  'room:join': (p: { code: string; nickname: string }, ack: Ack<SessionInfo>) => void;
  'room:peek': (p: { code: string }, ack: Ack<RoomPeek>) => void;
  /** 방장: 연결이 끊긴 자리를 넘길 코드를 만든다 */
  'seat:handover': (p: { playerId: string }, ack: Ack<SeatHandover>) => void;
  /** 새 기기: 받은 코드로 그 자리를 넘겨받는다 */
  'seat:claim': (p: { code: string; seatCode: string }, ack: Ack<SessionInfo>) => void;
  'room:ready': (p: { ready: boolean }, ack: Ack) => void;
  /** 대기실에서 내 색 바꾸기 (0 ~ PLAYER_COLOR_COUNT-1, 남이 쓰는 색은 안 된다) */
  'room:color': (p: { colorIndex: number }, ack: Ack) => void;
  /** 대기실에서 내 이름 바꾸기 (1~12자, 같은 방에서 겹치지 않게). 정리한 이름을 돌려준다. */
  'room:nickname': (p: { nickname: string }, ack: Ack<{ nickname: string }>) => void;
  /** 게임 중 자리 비움(자동): 켜 두면 서버가 내 차례와 할 일을 대신 둔다. 직접 두면 저절로 꺼진다. */
  'room:auto': (p: { on: boolean }, ack: Ack) => void;
  'room:start': (p: Record<string, never>, ack: Ack) => void;
  'room:leave': (p: Record<string, never>, ack: Ack) => void;
  'room:kick': (p: { playerId: string }, ack: Ack) => void;
  'room:rematch': (p: Record<string, never>, ack: Ack) => void;
  'room:close': (p: Record<string, never>, ack: Ack) => void;
  /** 서버를 켠 PC 에서만: 남은 방 목록 */
  'rooms:list': (p: Record<string, never>, ack: Ack<{ rooms: RoomListing[] }>) => void;
  /** 서버를 켠 PC 에서만: 고른 방들을 지운다 (방장이 아니어도) */
  'rooms:remove': (p: { codes: string[] }, ack: Ack<{ removed: string[] }>) => void;
  'game:action': (p: { requestId: string; action: GameAction }, ack: Ack) => void;
  'chat:send': (p: { text: string }, ack: Ack) => void;
  'chat:emote': (p: { emote: string }, ack: Ack) => void;
  /** 보드 한 자리를 가리킨다 (연달아 3번, 그 뒤 1초에 한 번) */
  'chat:ping': (p: { kind: 'tile' | 'vertex' | 'edge'; target: string }, ack: Ack) => void;
  /** 내가 가진 달성(최장 교역로·최강 기사단, 5초에 한 번)이나 승리(2초에 한 번)를 한마디와 함께 모두에게 뽐낸다 */
  'chat:brag': (p: { award: BragKind; line?: number }, ack: Ack) => void;
}

/** Socket.IO 연결 때 보내는 인증 정보 (재접속 시 같은 자리 복구용) */
export interface HandshakeAuth {
  roomCode?: string;
  token?: string;
}
