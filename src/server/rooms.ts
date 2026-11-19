// 방과 자리 관리. 진행 상태는 메모리에만 있으므로 서버를 다시 켜면 모든 방이 사라진다.
import { randomBytes, randomInt } from 'node:crypto';
import { MAX_PLAYERS, MIN_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/constants';
import type { AckResult, RoomPeek } from '../shared/protocol';
import { applyAction, createGame, type GameState } from '../shared/rules';
import type { GameAction } from '../shared/types';

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
  createdAt: number;
  /** 마지막으로 상태가 바뀐 시각 (오래 비어 있는 방 정리용) */
  touchedAt: number;
}

export type RoomError = { error: string; code?: string };

const MAX_ROOMS = 200;
const RECENT_LIMIT = 64;
/** 방이 가득 찼을 때, 아무도 없는 게임 방을 정리하기 전까지 기다리는 시간 */
const IDLE_GAME_MS = 30 * 60 * 1000;

function secureRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly maxRooms = MAX_ROOMS) {}

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

  create(nickname: string): { room: Room; player: RoomPlayer } | RoomError {
    if (this.rooms.size >= this.maxRooms) this.pruneIdleRooms();
    if (this.rooms.size >= this.maxRooms) return { error: '열려 있는 방이 너무 많습니다. 쓰지 않는 방에서 나가 주세요.' };
    const player = this.newPlayer(null, nickname);
    const now = Date.now();
    const room: Room = {
      code: this.newCode(),
      hostId: player.id,
      players: [player],
      phase: 'lobby',
      game: null,
      gameNumber: 1,
      createdAt: now,
      touchedAt: now,
    };
    this.rooms.set(room.code, room);
    return { room, player };
  }

  peek(code: string): RoomPeek | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    return {
      code: room.code,
      phase: room.phase,
      playerCount: room.players.length,
      maxPlayers: MAX_PLAYERS,
      joinable: room.phase === 'lobby' && room.players.length < MAX_PLAYERS,
      hostNickname: room.players.find((p) => p.id === room.hostId)?.nickname ?? '',
    };
  }

  join(code: string, nickname: string): { room: Room; player: RoomPlayer } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return { error: '방을 찾을 수 없습니다. 방 코드를 확인하세요.', code: 'NO_ROOM' };
    if (room.phase !== 'lobby') {
      return { error: '이미 게임이 시작된 방입니다. 참가했던 기기라면 이전 자리로 돌아가기를 누르세요.', code: 'STARTED' };
    }
    if (room.players.length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명).`, code: 'FULL' };
    const lower = nickname.toLocaleLowerCase('ko');
    if (room.players.some((p) => p.nickname.toLocaleLowerCase('ko') === lower)) {
      return { error: '이 방에서 이미 쓰고 있는 닉네임입니다.', code: 'NICK_TAKEN' };
    }
    const player = this.newPlayer(room, nickname);
    room.players.push(player);
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
    return null;
  }

  start(room: Room, playerId: string): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 게임을 시작할 수 있습니다.' };
    if (room.phase !== 'lobby') return { error: '이미 게임이 진행 중입니다.' };
    const n = room.players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) return { error: `방장 포함 ${MIN_PLAYERS}~${MAX_PLAYERS}명이 있어야 시작할 수 있습니다.` };
    const notReady = room.players.filter((p) => !p.ready || !p.connected);
    if (notReady.length > 0) {
      return { error: `모두 접속해서 준비해야 시작할 수 있습니다: ${notReady.map((p) => p.nickname).join(', ')}` };
    }
    room.game = createGame(
      room.players.map((p) => p.id),
      secureRandom,
    );
    room.phase = 'game';
    for (const p of room.players) p.recent.clear();
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
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return;
    }
    // 방장이 나가면 지금 접속해 있는 사람 중 가장 먼저 들어온 사람이 방장이 된다.
    // (연결이 끊긴 사람에게 넘기면 남은 사람들이 시작도 내보내기도 못 하게 된다.)
    if (room.hostId === playerId) room.hostId = (room.players.find((p) => p.connected) ?? room.players[0]).id;
  }

  /** 게임이 끝난 뒤 같은 멤버로 대기실에 돌아간다. */
  rematch(room: Room, playerId: string): RoomError | null {
    if (room.hostId !== playerId) return { error: '방장만 새 게임을 준비할 수 있습니다.' };
    if (room.phase !== 'game' || room.game?.phase !== 'finished') return { error: '게임이 끝난 뒤에 새 게임을 준비할 수 있습니다.' };
    room.phase = 'lobby';
    room.game = null;
    room.gameNumber += 1;
    for (const p of room.players) {
      p.ready = false;
      p.recent.clear();
    }
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
    return { result, changed: room.game.version !== before };
  }

  /**
   * 방이 가득 찼을 때만 부른다. 아무도 접속해 있지 않은 대기실을 먼저 닫고,
   * 그래도 가득 차 있으면 30분 넘게 아무도 접속하지 않은 게임 방을 닫는다.
   * (잠깐 모두 끊긴 진행 중인 게임은 남겨 둔다.)
   */
  pruneIdleRooms(now = Date.now()): void {
    const idle = [...this.rooms.values()].filter((r) => r.players.every((p) => !p.connected));
    for (const r of idle) if (r.phase === 'lobby') this.rooms.delete(r.code);
    if (this.rooms.size < this.maxRooms) return;
    for (const r of idle) if (r.phase === 'game' && now - r.touchedAt > IDLE_GAME_MS) this.rooms.delete(r.code);
  }

  /** 혼자 있던 대기실에서 새 방을 만들거나 다른 방에 들어가면 그 대기실은 닫는다. */
  closeIfLoneLobby(room: Room, playerId: string): boolean {
    if (room.phase !== 'lobby' || room.players.length !== 1 || room.players[0].id !== playerId) return false;
    this.rooms.delete(room.code);
    return true;
  }
}

export function isRoomError(v: unknown): v is RoomError {
  return typeof v === 'object' && v !== null && 'error' in v;
}
