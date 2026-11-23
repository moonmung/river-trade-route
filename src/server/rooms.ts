// 방과 자리 관리. 진행 상태는 메모리에 두고, 바뀔 때마다 onChange 로 알려 persist.ts 가 디스크에 저장한다.
import { randomBytes, randomInt } from 'node:crypto';
import {
  DEV_CARDS,
  DEV_CARDS_MAX,
  DEV_CARDS_MIN,
  DISCARD_LIMIT,
  HAND_LIMIT_MAX,
  HAND_LIMIT_MIN,
  MIN_PLAYERS,
  RESOURCE_CARDS,
  RESOURCE_CARDS_MAX,
  RESOURCE_CARDS_MIN,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TURN_SECONDS,
  WIN_POINTS,
  WIN_POINTS_MAX,
  WIN_POINTS_MIN,
  normalizeDevCards,
  normalizeHandLimit,
  normalizeResourceCards,
  normalizeTurnSeconds,
  normalizeWinPoints,
} from '../shared/constants';
import { SEAT_CODE_LENGTH, type AckResult, type RoomListing, type RoomPeek, type SeatHandover } from '../shared/protocol';
import { DEFAULT_MAP, mapCardDefaults, maxPlayersFor, normalizeMapArrange, normalizeMapShape } from '../shared/maps';
import { applyAction, autoPlay, clockKey, createGame, type GameState } from '../shared/rules';
import type { GameAction, MapConfig } from '../shared/types';

export interface RoomPlayer {
  id: string;
  /** 재접속용 비밀 값. 본인 브라우저에만 전달한다. */
  token: string;
  nickname: string;
  colorIndex: number;
  ready: boolean;
  connected: boolean;
  socketId: string | null;
  /** 같은 요청이 두 번 도착해도 한 번만 반영하기 위한 최근 요청 결과 */
  recent: Map<string, AckResult>;
}

export interface Room {
  code: string;
  hostId: string;
  players: RoomPlayer[];
  phase: 'lobby' | 'game';
  game: GameState | null;
  gameNumber: number;
  /** 방장이 정한 승리 점수 (10~20, 다음 게임부터 쓴다) */
  winPoints: number;
  /** 방장이 정한 자원 보유 한도 (7이 나오면 이보다 많이 든 사람이 절반을 버린다, 다음 게임부터 쓴다) */
  handLimit: number;
  /** 방장이 정한 한 차례 제한 시간 (초, 0 이면 제한 없음) */
  turnSeconds: number;
  /** 방장이 정한 맵 모양과 땅 배치 (다음 게임부터 쓴다) */
  map: MapConfig;
  /** 방장이 정한 은행 자원 카드 수, 자원마다 (다음 게임부터 쓴다) */
  resourceCards: number;
  /** 방장이 정한 발전 카드 총 장수 (다음 게임부터 쓴다) */
  devCards: number;
  /** 방장이 정한 개수 제한 없음: 길·마을·도시 개수 제한과 발전 카드 소진이 없다 (다음 게임부터 쓴다) */
  unlimited: boolean;
  createdAt: number;
  /** 마지막으로 상태가 바뀐 시각 (오래 비어 있는 방 정리용) */
  touchedAt: number;
}

export type RoomError = { error: string; code?: string };

const MAX_ROOMS = 200;
const RECENT_LIMIT = 64;
/** 방이 가득 찼을 때, 아무도 없는 게임 방을 정리하기 전까지 기다리는 시간 */
const IDLE_GAME_MS = 30 * 60 * 1000;
/** 자리 넘기기 코드가 유효한 시간 */
const HANDOVER_TTL_MS = 10 * 60 * 1000;
/** 한 방에서 자리 넘기기 코드를 이만큼 틀리면 그 방의 코드를 모두 지운다 (마구 넣어 맞히기 방지) */
const HANDOVER_MAX_FAILS = 8;

function secureRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/**
 * 새 방의 기본값. 저장해 둔 방을 되살릴 때도 이 값 위에 저장된 값을 덮어쓴다.
 * Room 에 필드를 더하면 여기에 기본값을 넣어 두어야 예전 저장 파일에서 되살린 방도 그 필드를 갖는다.
 */
export function blankRoom(code: string, now = Date.now()): Room {
  return {
    code,
    hostId: '',
    players: [],
    phase: 'lobby',
    game: null,
    gameNumber: 1,
    winPoints: WIN_POINTS,
    handLimit: DISCARD_LIMIT,
    turnSeconds: TURN_SECONDS,
    map: { ...DEFAULT_MAP },
    resourceCards: RESOURCE_CARDS,
    devCards: DEV_CARDS,
    unlimited: false,
    createdAt: now,
    touchedAt: now,
  };
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** 저장할 만한 변화(방·자리·게임 상태)가 생길 때마다 부른다. 연결 상태만 바뀐 것은 알리지 않는다. */
  onChange: (() => void) | null = null;
  /** 방 코드 → 아직 쓰지 않은 자리 넘기기 코드. 몇 분만 쓰는 값이라 저장하지 않는다. */
  private readonly handovers = new Map<string, SeatHandover[]>();
  private readonly handoverFails = new Map<string, number>();
  /** 방 코드 → 차례 시계 (지금 재는 차례의 열쇠와 마감 시각). 서버가 켜져 있는 동안만 쓰는 값이라 저장하지 않는다. */
  private readonly clocks = new Map<string, { key: string; deadline: number; timer: ReturnType<typeof setTimeout> }>();
  /** 시간이 다 되어 서버가 대신 진행했을 때 부른다 (socket.ts 가 모두에게 새 화면을 보낸다). */
  onAutoPlay: ((room: Room) => void) | null = null;

  constructor(private readonly maxRooms = MAX_ROOMS) {}

  private changed(): void {
    this.onChange?.();
  }

  private deleteRoom(code: string): void {
    this.stopClock(code);
    this.rooms.delete(code);
    this.handovers.delete(code);
    this.handoverFails.delete(code);
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('방 코드를 만들 수 없습니다.');
  }

  private newPlayer(room: Room | null, nickname: string): RoomPlayer {
    const used = new Set(room?.players.map((p) => p.colorIndex) ?? []);
    let colorIndex = 0;
    while (used.has(colorIndex)) colorIndex++;
    return {
      id: `p_${randomBytes(6).toString('hex')}`,
      token: randomBytes(24).toString('base64url'),
      nickname,
      colorIndex,
      ready: false,
      connected: false,
      socketId: null,
      recent: new Map(),
    };
  }

  create(nickname: string, winPoints: unknown = WIN_POINTS): { room: Room; player: RoomPlayer } | RoomError {
    const points = normalizeWinPoints(winPoints);
    if (points === null) return { error: `승리 점수는 ${WIN_POINTS_MIN}~${WIN_POINTS_MAX}점 사이로 정하세요.` };
    if (this.rooms.size >= this.maxRooms) this.pruneIdleRooms();
    if (this.rooms.size >= this.maxRooms) return { error: '열려 있는 방이 너무 많습니다. 쓰지 않는 방에서 나가 주세요.' };
    const player = this.newPlayer(null, nickname);
    const room: Room = { ...blankRoom(this.newCode()), hostId: player.id, players: [player], winPoints: points };
    this.rooms.set(room.code, room);
    this.changed();
    return { room, player };
  }

  peek(code: string): RoomPeek | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    return {
      code: room.code,
      phase: room.phase,
      playerCount: room.players.length,
      maxPlayers: maxPlayersFor(room.map.shape),
      joinable: room.phase === 'lobby' && room.players.length < maxPlayersFor(room.map.shape),
      hostNickname: room.players.find((p) => p.id === room.hostId)?.nickname ?? '',
    };
  }

  join(code: string, nickname: string): { room: Room; player: RoomPlayer } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return { error: '방을 찾을 수 없습니다. 방 코드를 확인하세요.', code: 'NO_ROOM' };
    if (room.phase !== 'lobby') {
      return { error: '이미 게임이 시작된 방입니다. 참가했던 기기라면 이전 자리로 돌아가기를 누르세요.', code: 'STARTED' };
    }
    const max = maxPlayersFor(room.map.shape);
    if (room.players.length >= max) return { error: `방이 가득 찼습니다 (최대 ${max}명).`, code: 'FULL' };
    const lower = nickname.toLocaleLowerCase('ko');
    if (room.players.some((p) => p.nickname.toLocaleLowerCase('ko') === lower)) {
      return { error: '이 방에서 이미 쓰고 있는 닉네임입니다.', code: 'NICK_TAKEN' };
    }
    const player = this.newPlayer(room, nickname);
    room.players.push(player);
    this.changed();
    return { room, player };
  }

  authenticate(code: string, token: string): { room: Room; player: RoomPlayer } | null {
    const room = this.rooms.get(code);
    const player = room?.players.find((p) => p.token === token);
    return room && player ? { room, player } : null;
  }

  setReady(room: Room, playerId: string, ready: boolean): RoomError | null {
    if (room.phase !== 'lobby') return { error: '대기실에서만 준비 상태를 바꿀 수 있습니다.' };
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return { error: '방에 없는 참가자입니다.' };
    p.ready = ready;
    this.changed();
    return null;
  }

  /** 방장이 대기실에서 승리 점수를 바꾼다. */
  setWinPoints(room: Room, playerId: string, winPoints: unknown): RoomError | null {
    return this.setSettings(room, playerId, { winPoints });
  }

  /** 방장이 대기실에서 규칙(승리 점수·자원 보유 한도·차례 시간·맵·카드 장수)을 바꾼다. 보낸 값만 바꾸고, 하나라도 틀리면 아무것도 바꾸지 않는다. */
  setSettings(room: Room, playerId: string, patch: unknown): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 규칙을 바꿀 수 있습니다.' };
    if (room.phase !== 'lobby') return { error: '대기실에서만 규칙을 바꿀 수 있습니다.' };
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
    const next = {
      winPoints: room.winPoints,
      handLimit: room.handLimit,
      turnSeconds: room.turnSeconds,
      map: { ...room.map },
      resourceCards: room.resourceCards,
      devCards: room.devCards,
      unlimited: room.unlimited,
    };
    if (p.winPoints !== undefined) {
      const n = normalizeWinPoints(p.winPoints);
      if (n === null) return { error: `승리 점수는 ${WIN_POINTS_MIN}~${WIN_POINTS_MAX}점 사이로 정하세요.` };
      next.winPoints = n;
    }
    if (p.handLimit !== undefined) {
      const n = normalizeHandLimit(p.handLimit);
      if (n === null) return { error: `자원 보유 한도는 ${HAND_LIMIT_MIN}~${HAND_LIMIT_MAX}장 사이로 정하세요.` };
      next.handLimit = n;
    }
    if (p.turnSeconds !== undefined) {
      const n = normalizeTurnSeconds(p.turnSeconds);
      if (n === null) return { error: '차례 시간은 고를 수 있는 값 중에서 정하세요.' };
      next.turnSeconds = n;
    }
    if (p.mapShape !== undefined) {
      const shape = normalizeMapShape(p.mapShape);
      if (!shape) return { error: '맵 모양은 고를 수 있는 것 중에서 정하세요.' };
      const max = maxPlayersFor(shape);
      if (room.players.length > max) return { error: `지금 ${room.players.length}명이라 이 맵은 고를 수 없습니다 (최대 ${max}명).` };
      // 카드 장수를 맵 기본값 그대로 두었으면 새 맵의 기본값으로 바꾼다 (대형 맵은 은행 자원·발전 카드가 더 많다).
      const was = mapCardDefaults(room.map.shape);
      const now = mapCardDefaults(shape);
      if (p.resourceCards === undefined && room.resourceCards === was.resourceCards) next.resourceCards = now.resourceCards;
      if (p.devCards === undefined && room.devCards === was.devCards) next.devCards = now.devCards;
      next.map.shape = shape;
    }
    if (p.mapArrange !== undefined) {
      const arrange = normalizeMapArrange(p.mapArrange);
      if (!arrange) return { error: '맵 배치는 황금 배치와 섞기 중에서 정하세요.' };
      next.map.arrange = arrange;
    }
    if (p.resourceCards !== undefined) {
      const n = normalizeResourceCards(p.resourceCards);
      if (n === null) return { error: `자원 카드는 종류마다 ${RESOURCE_CARDS_MIN}~${RESOURCE_CARDS_MAX}장 사이로 정하세요.` };
      next.resourceCards = n;
    }
    if (p.unlimited !== undefined) {
      if (typeof p.unlimited !== 'boolean') return { error: '개수 제한은 있음·없음 중에서 고르세요.' };
      next.unlimited = p.unlimited;
    }
    if (p.devCards !== undefined) {
      const n = normalizeDevCards(p.devCards);
      if (n === null) return { error: `발전 카드는 ${DEV_CARDS_MIN}~${DEV_CARDS_MAX}장 사이로 정하세요.` };
      next.devCards = n;
    }
    const same =
      next.winPoints === room.winPoints &&
      next.handLimit === room.handLimit &&
      next.turnSeconds === room.turnSeconds &&
      next.map.shape === room.map.shape &&
      next.map.arrange === room.map.arrange &&
      next.resourceCards === room.resourceCards &&
      next.devCards === room.devCards &&
      next.unlimited === room.unlimited;
    if (same) return null;
    Object.assign(room, next);
    // 규칙이 바뀌면 다른 사람은 다시 확인하고 준비하도록 준비를 푼다.
    for (const pl of room.players) if (pl.id !== room.hostId) pl.ready = false;
    this.changed();
    return null;
  }

  start(room: Room, playerId: string): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 게임을 시작할 수 있습니다.' };
    if (room.phase !== 'lobby') return { error: '이미 게임이 진행 중입니다.' };
    const n = room.players.length;
    const max = maxPlayersFor(room.map.shape);
    if (n < MIN_PLAYERS || n > max) return { error: `방장 포함 ${MIN_PLAYERS}~${max}명이 있어야 시작할 수 있습니다.` };
    const notReady = room.players.filter((p) => !p.ready || !p.connected);
    if (notReady.length > 0) {
      return { error: `모두 접속해서 준비해야 시작할 수 있습니다: ${notReady.map((p) => p.nickname).join(', ')}` };
    }
    // 자리 순서는 모두 주사위를 굴려 정한다 (가장 낮은 사람이 마지막).
    room.game = createGame(
      room.players.map((p) => p.id),
      secureRandom,
      {
        winPoints: room.winPoints,
        handLimit: room.handLimit,
        rollForOrder: true,
        map: { ...room.map },
        resourceCards: room.resourceCards,
        devCards: room.devCards,
        unlimited: room.unlimited,
      },
    );
    room.phase = 'game';
    for (const p of room.players) p.recent.clear();
    this.syncClock(room);
    this.changed();
    return null;
  }

  /** 대기실에서 나가기. 게임 중에는 자리를 유지한다 (나중에 같은 자리로 돌아올 수 있게). */
  leave(room: Room, playerId: string): RoomError | null {
    if (room.phase !== 'lobby') return { error: '게임 중에는 자리를 비울 수 없습니다. 창을 닫아도 같은 자리로 돌아올 수 있습니다.' };
    this.removePlayer(room, playerId);
    return null;
  }

  kick(room: Room, hostId: string, targetId: string): RoomError | null {
    if (room.hostId !== hostId) return { error: '방장만 내보낼 수 있습니다.' };
    if (room.phase !== 'lobby') return { error: '대기실에서만 내보낼 수 있습니다.' };
    if (targetId === hostId) return { error: '자기 자신은 내보낼 수 없습니다.' };
    if (!room.players.some((p) => p.id === targetId)) return { error: '방에 없는 참가자입니다.' };
    this.removePlayer(room, targetId);
    return null;
  }

  private removePlayer(room: Room, playerId: string): void {
    room.players = room.players.filter((p) => p.id !== playerId);
    this.changed();
    if (room.players.length === 0) {
      this.deleteRoom(room.code);
      return;
    }
    // 방장이 나가면 지금 접속해 있는 사람 중 가장 먼저 들어온 사람이 방장이 된다.
    // (연결이 끊긴 사람에게 넘기면 남은 사람들이 시작도 내보내기도 못 하게 된다.)
    if (room.hostId === playerId) room.hostId = (room.players.find((p) => p.connected) ?? room.players[0]).id;
  }

  /** 남은 방 목록 (최근에 바뀐 방부터). 서버를 켠 PC 의 처음 화면에서 지난 게임 방이나 빈 대기실을 지울 때 쓴다. */
  list(): RoomListing[] {
    return [...this.rooms.values()]
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .map((r) => {
        const host = r.players.find((p) => p.id === r.hostId);
        const players = host ? [host, ...r.players.filter((p) => p !== host)] : r.players;
        return {
          code: r.code,
          phase: r.phase,
          finished: r.game?.phase === 'finished',
          players: players.map((p) => p.nickname),
          connected: r.players.filter((p) => p.connected).length,
          touchedAt: r.touchedAt,
        };
      });
  }

  /** 방장이 아니어도 방을 지운다 (서버를 켠 PC 에서만 부른다). 없는 방이면 false. */
  remove(code: string): boolean {
    if (!this.rooms.has(code)) return false;
    this.deleteRoom(code);
    this.changed();
    return true;
  }

  /** 방장이 방을 닫는다 (대기실·게임 중 언제든). 방과 게임 기록이 모두 사라지고, 남은 사람은 처음 화면으로 돌아간다. */
  close(room: Room, playerId: string): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 방을 닫을 수 있습니다.' };
    this.deleteRoom(room.code);
    this.changed();
    return null;
  }

  /** 게임이 끝난 뒤 같은 멤버로 대기실에 돌아간다. */
  rematch(room: Room, playerId: string): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 새 게임을 준비할 수 있습니다.' };
    if (room.phase !== 'game' || room.game?.phase !== 'finished') return { error: '게임이 끝난 뒤에 새 게임을 준비할 수 있습니다.' };
    room.phase = 'lobby';
    room.game = null;
    room.gameNumber += 1;
    this.stopClock(room.code);
    for (const p of room.players) {
      p.ready = false;
      p.recent.clear();
    }
    this.changed();
    return null;
  }

  /**
   * 게임 행동 처리. requestId 가 같은 요청은 처음 결과를 그대로 돌려주고 다시 반영하지 않는다.
   * changed 가 true 면 상태가 바뀐 것이므로 모두에게 새 화면 정보를 보낸다.
   */
  act(room: Room, playerId: string, requestId: string, action: GameAction): { result: AckResult; changed: boolean } {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return { result: { ok: false, error: '방에 없는 참가자입니다.' }, changed: false };
    const cached = player.recent.get(requestId);
    if (cached) return { result: cached, changed: false };
    if (room.phase !== 'game' || !room.game) {
      return { result: { ok: false, error: '게임이 진행 중이 아닙니다.' }, changed: false };
    }
    const before = room.game.version;
    const r = applyAction(room.game, playerId, action);
    const result: AckResult = r.ok ? { ok: true } : { ok: false, error: r.message, code: r.code };
    player.recent.set(requestId, result);
    if (player.recent.size > RECENT_LIMIT) {
      const oldest = player.recent.keys().next().value;
      if (oldest !== undefined) player.recent.delete(oldest);
    }
    const changed = room.game.version !== before;
    if (changed) {
      this.syncClock(room);
      this.changed();
    }
    return { result, changed };
  }

  // ───────────────────────── 차례 시계 ─────────────────────────

  /** 지금 재는 차례의 마감 시각 (제한이 없거나 멈춰 있으면 null) */
  deadline(room: Room): number | null {
    return this.clocks.get(room.code)?.deadline ?? null;
  }

  private stopClock(code: string): void {
    const c = this.clocks.get(code);
    if (c) clearTimeout(c.timer);
    this.clocks.delete(code);
  }

  /**
   * 상태나 연결이 바뀔 때마다 부른다. 재는 차례(clockKey)가 바뀌었으면 시간을 처음부터 다시 잰다.
   * 아무도 접속해 있지 않으면 멈춘다 (서버를 다시 켜 되살린 방이 혼자 진행되지 않게). 누군가 돌아오면 그 차례를 처음부터 다시 잰다.
   */
  syncClock(room: Room, now = Date.now()): void {
    const g = room.game;
    const key = g && room.phase === 'game' ? clockKey(g) : null;
    if (!key || room.turnSeconds <= 0 || !room.players.some((p) => p.connected)) {
      this.stopClock(room.code);
      return;
    }
    const cur = this.clocks.get(room.code);
    if (cur && cur.key === key) return;
    this.stopClock(room.code);
    const deadline = now + room.turnSeconds * 1000;
    const timer = setTimeout(() => this.expire(room.code, key), deadline - now);
    (timer as { unref?: () => void }).unref?.();
    this.clocks.set(room.code, { key, deadline, timer });
  }

  /** 시간이 다 됐다: 같은 차례가 그대로면 서버가 대신 진행하고 모두에게 알린다. */
  private expire(code: string, key: string): void {
    const room = this.rooms.get(code);
    const clock = this.clocks.get(code);
    if (!room?.game || !clock || clock.key !== key) return;
    this.clocks.delete(code);
    if (clockKey(room.game) === key && autoPlay(room.game, secureRandom)) this.changed();
    this.syncClock(room);
    this.onAutoPlay?.(room);
  }

  /** 서버를 끌 때 시계를 모두 멈춘다. */
  stopAllClocks(): void {
    for (const code of [...this.clocks.keys()]) this.stopClock(code);
  }

  /**
   * 방이 가득 찼을 때만 부른다. 아무도 접속해 있지 않은 대기실을 먼저 닫고,
   * 그래도 가득 차 있으면 30분 넘게 아무도 접속하지 않은 게임 방을 닫는다.
   * (잠깐 모두 끊긴 진행 중인 게임은 남겨 둔다.)
   */
  pruneIdleRooms(now = Date.now()): void {
    const before = this.rooms.size;
    const idle = [...this.rooms.values()].filter((r) => r.players.every((p) => !p.connected));
    for (const r of idle) if (r.phase === 'lobby') this.deleteRoom(r.code);
    if (this.rooms.size >= this.maxRooms) {
      for (const r of idle) if (r.phase === 'game' && now - r.touchedAt > IDLE_GAME_MS) this.deleteRoom(r.code);
    }
    if (this.rooms.size !== before) this.changed();
  }

  /** 아무도 접속해 있지 않은 채 maxAgeMs 넘게 아무 일도 없던 방을 닫는다 (서버를 오래 켜 두거나 저장 파일이 쌓이지 않게). */
  pruneStale(maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const r of [...this.rooms.values()]) {
      if (now - r.touchedAt > maxAgeMs && r.players.every((p) => !p.connected)) {
        this.deleteRoom(r.code);
        n++;
      }
    }
    if (n) this.changed();
    return n;
  }

  /**
   * 연결이 끊긴 자리를 다른 기기로 넘기는 일회용 코드를 만든다.
   * 다른 브라우저로 바꿨거나, 방장 PC 주소가 바뀌어 저장된 참가 토큰을 못 쓸 때 쓴다.
   * 방장이 만들고, 방장 자신이 끊겨 있으면 접속해 있는 다른 사람이 만들 수 있다.
   */
  issueHandover(room: Room, issuerId: string, targetId: string, now = Date.now()): SeatHandover | RoomError {
    const issuer = room.players.find((p) => p.id === issuerId);
    const target = room.players.find((p) => p.id === targetId);
    if (!issuer || !target) return { error: '방에 없는 참가자입니다.' };
    if (issuer.id === target.id) return { error: '자기 자리는 넘길 수 없습니다.' };
    const host = room.players.find((p) => p.id === room.hostId);
    if (issuer.id !== room.hostId && host?.connected) return { error: '자리 넘기기는 방장만 할 수 있습니다.' };
    if (target.connected) return { error: `${target.nickname} 님은 지금 접속해 있습니다. 연결이 끊긴 자리만 넘길 수 있습니다.` };
    // 같은 자리에 예전에 만든 코드는 버린다.
    const list = (this.handovers.get(room.code) ?? []).filter((h) => h.expiresAt > now && h.playerId !== target.id);
    let code: string;
    do {
      code = '';
      for (let i = 0; i < SEAT_CODE_LENGTH; i++) code += String(randomInt(10));
    } while (list.some((h) => h.code === code));
    const handover: SeatHandover = { playerId: target.id, code, expiresAt: now + HANDOVER_TTL_MS };
    list.push(handover);
    this.handovers.set(room.code, list);
    return { ...handover };
  }

  /** 자리 넘기기 코드로 자리를 받는다. 참가 토큰을 새로 만들어 예전 기기에 남은 토큰은 더 이상 쓸 수 없게 한다. */
  claimHandover(code: string, seatCode: string, now = Date.now()): { room: Room; player: RoomPlayer } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return { error: '방을 찾을 수 없습니다. 방 코드를 확인하세요.', code: 'NO_ROOM' };
    const list = (this.handovers.get(code) ?? []).filter((h) => h.expiresAt > now);
    const found = list.find((h) => h.code === seatCode);
    if (!found) {
      const fails = (this.handoverFails.get(code) ?? 0) + 1;
      if (fails >= HANDOVER_MAX_FAILS) {
        this.handovers.delete(code);
        this.handoverFails.delete(code);
        return { error: '코드가 여러 번 틀려 이 방의 자리 넘기기 코드를 모두 지웠습니다. 방장에게 새 코드를 받으세요.', code: 'SEAT_CODE' };
      }
      this.handoverFails.set(code, fails);
      this.handovers.set(code, list);
      return { error: '자리 넘기기 코드가 맞지 않거나 10분이 지났습니다. 방장에게 새 코드를 받으세요.', code: 'SEAT_CODE' };
    }
    this.handovers.set(
      code,
      list.filter((h) => h !== found),
    );
    const player = room.players.find((p) => p.id === found.playerId);
    if (!player) return { error: '넘겨받을 자리가 방에 없습니다.', code: 'SEAT_CODE' };
    if (player.connected) return { error: `${player.nickname} 님이 방금 원래 기기로 다시 접속했습니다.`, code: 'SEAT_CODE' };
    this.handoverFails.delete(code);
    player.token = randomBytes(24).toString('base64url');
    this.changed();
    return { room, player };
  }

  /** 혼자 있던 대기실에서 새 방을 만들거나 다른 방에 들어가면 그 대기실은 닫는다. */
  closeIfLoneLobby(room: Room, playerId: string): boolean {
    if (room.phase !== 'lobby' || room.players.length !== 1 || room.players[0].id !== playerId) return false;
    this.deleteRoom(room.code);
    this.changed();
    return true;
  }
}

export function isRoomError(v: unknown): v is RoomError {
  return typeof v === 'object' && v !== null && 'error' in v;
}
