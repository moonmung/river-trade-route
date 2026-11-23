// 방과 게임 상태를 디스크의 JSON 파일 하나에 저장해 두었다가, 서버가 다시 켜지면 되살린다.
//  - 바뀔 때마다 짧게 몰아서(디바운스) 쓴다. 계속 바뀌어도 maxWaitMs 안에는 한 번 쓴다.
//  - 임시 파일에 다 쓰고 디스크에 내린(fsync) 뒤 이름을 바꿔 원래 파일과 바꿔치기한다. 쓰다가 꺼져도 직전 파일이 그대로 남는다.
//  - 게임 상태(GameState)는 통째로 저장한다. 규칙 쪽에서 필드를 더해도 따로 손댈 것이 없다.
//    필드 이름이 바뀌어 예전 파일과 맞지 않으면 그 방만 되살리지 않는다.
//  - 되살린 자리는 모두 '연결 끊김'으로 시작한다. 브라우저가 저장된 참가 토큰으로 다시 붙는 대로 이어진다.
//  - 끝난 게임과 maxAgeMs(기본 하루) 넘게 아무 일도 없던 방은 저장하지도 되살리지도 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { DISCARD_LIMIT, TILES, WIN_POINTS, normalizeDevCards, normalizeResourceCards } from '../shared/constants';
import { normalizeMapArrange, normalizeMapShape } from '../shared/maps';
import type { AckResult } from '../shared/protocol';
import { createGame } from '../shared/rules';
import { normalizeRoomCode } from '../shared/validate';
import { blankRoom, type Room, type RoomManager, type RoomPlayer } from './rooms';

const FORMAT = 1;
export const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const RETRY_MS = 3000;

export interface PersistOptions {
  /** 마지막 변화 뒤 이만큼 조용하면 쓴다 */
  debounceMs?: number;
  /** 변화가 계속돼도 첫 변화 뒤 이 시간 안에는 쓴다 */
  maxWaitMs?: number;
  /** 아무 일도 없던 방을 이 시간이 지나면 정리한다 */
  maxAgeMs?: number;
  log?: (msg: string) => void;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 저장하지 않을 방: 빈 방, 끝난 게임, 오래 쓰지 않은 방 */
export function isExpired(room: Pick<Room, 'players' | 'phase' | 'game' | 'touchedAt'>, now: number, maxAgeMs = DAY_MS): boolean {
  if (room.players.length === 0) return true;
  if (room.phase === 'game' && room.game?.phase === 'finished') return true;
  return now - room.touchedAt > maxAgeMs;
}

/**
 * JSON 으로 옮길 수 있는 값(일반 객체·배열·문자·숫자)만 남긴다.
 * Map·타이머처럼 다시 살릴 수 없는 값은 빠지고, 되살릴 때 blankRoom 기본값이 채운다.
 */
function plainOnly(_key: string, value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
  }
  return value;
}

/** 지금 방 목록을 저장 파일 내용으로 만든다. 접속 상태(소켓)는 빼고, 중복 요청 기록은 목록으로 바꿔 넣는다. */
export function snapshotRooms(rooms: Iterable<Room>, now = Date.now(), maxAgeMs = DAY_MS): string {
  const out: unknown[] = [];
  for (const room of rooms) {
    if (isExpired(room, now, maxAgeMs)) continue;
    out.push({
      ...room,
      players: room.players.map(({ connected: _c, socketId: _s, recent, ...rest }) => ({ ...rest, recent: [...recent] })),
    });
  }
  return JSON.stringify({ format: FORMAT, savedAt: now, rooms: out }, plainOnly);
}

let gameKeys: string[] | null | undefined;
/** 지금 규칙 엔진이 만드는 게임 상태의 필드 목록. 예전 파일과 모양이 맞는지 볼 때 쓴다. */
function requiredGameKeys(): string[] | null {
  if (gameKeys === undefined) {
    try {
      gameKeys = Object.keys(createGame(['a', 'b', 'c']));
    } catch {
      gameKeys = null;
    }
  }
  return gameKeys;
}

function isRecentEntry(v: unknown): v is [string, AckResult] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && isObj(v[1]) && typeof v[1].ok === 'boolean';
}

function revivePlayer(raw: unknown): RoomPlayer | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.token !== 'string' || typeof raw.nickname !== 'string') return null;
  if (typeof raw.colorIndex !== 'number') return null;
  const recent = new Map(Array.isArray(raw.recent) ? raw.recent.filter(isRecentEntry) : []);
  return { ...raw, ready: raw.ready === true, connected: false, socketId: null, recent } as RoomPlayer;
}

function reviveRoom(raw: unknown): Room | null {
  if (!isObj(raw)) return null;
  const code = normalizeRoomCode(raw.code);
  if (!code || !Array.isArray(raw.players) || raw.players.length === 0) return null;
  const players: RoomPlayer[] = [];
  for (const p of raw.players) {
    const player = revivePlayer(p);
    if (!player) return null;
    players.push(player);
  }
  if (typeof raw.hostId !== 'string' || !players.some((p) => p.id === raw.hostId)) return null;
  if (raw.phase !== 'lobby' && raw.phase !== 'game') return null;
  const game = raw.game ?? null;
  if (raw.phase === 'game') {
    if (!isObj(game) || !Array.isArray(game.order) || !isObj(game.players)) return null;
    // 승리 점수를 고를 수 있기 전에 저장한 게임은 기본 10점으로 이어 간다.
    if (!('winPoints' in game)) game.winPoints = WIN_POINTS;
    // 자원 보유 한도·순서 정하기·나눠 놓는 시작 배치가 생기기 전에 저장한 게임은 그때 규칙 그대로 이어 간다.
    if (!('handLimit' in game)) game.handLimit = DISCARD_LIMIT;
    if (!('setupVillage' in game)) game.setupVillage = null;
    if (!('startPending' in game)) game.startPending = [];
    if (!('startRolls' in game)) game.startRolls = Object.fromEntries(game.order.map((id) => [id, []]));
    // 맵을 고를 수 있기 전에 저장한 게임은 표준 육각 보드였다.
    if (!('tiles' in game)) game.tiles = TILES.map((t) => ({ ...t }));
    // 자원 카드 장수를 정하기 전에 저장한 게임은 은행이 무제한이었다.
    if (!('bank' in game)) game.bank = null;
    if (!('bankSize' in game)) game.bankSize = null;
    // 개수 제한 없음 규칙이 생기기 전에 저장한 게임은 제한이 있었다.
    if (!('unlimited' in game)) game.unlimited = false;
    const keys = requiredGameKeys();
    if (keys && keys.some((k) => !(k in game))) return null;
    const ids = new Set(players.map((p) => p.id));
    const seats = game.players;
    if (game.order.length !== players.length || !game.order.every((id) => typeof id === 'string' && ids.has(id) && isObj(seats[id]))) return null;
  } else if (game !== null) {
    return null;
  }
  const base = blankRoom(code, typeof raw.createdAt === 'number' ? raw.createdAt : Date.now());
  const savedMap = isObj(raw.map) ? raw.map : {};
  const map = {
    shape: normalizeMapShape(savedMap.shape) ?? base.map.shape,
    arrange: normalizeMapArrange(savedMap.arrange) ?? base.map.arrange,
  };
  return {
    ...base,
    ...raw,
    code,
    players,
    game,
    map,
    resourceCards: normalizeResourceCards(raw.resourceCards) ?? base.resourceCards,
    devCards: normalizeDevCards(raw.devCards) ?? base.devCards,
    unlimited: raw.unlimited === true,
    gameNumber: typeof raw.gameNumber === 'number' ? raw.gameNumber : base.gameNumber,
    touchedAt: typeof raw.touchedAt === 'number' ? raw.touchedAt : base.touchedAt,
  } as Room;
}

/** 저장 파일 내용을 방 목록으로 되살린다. 파일 자체가 깨졌으면 예외를 던지고, 방 하나가 이상하면 그 방만 건너뛴다. */
export function restoreRooms(text: string, now = Date.now(), maxAgeMs = DAY_MS): { rooms: Room[]; skipped: number; expired: number } {
  const data = JSON.parse(text) as unknown;
  if (!isObj(data) || data.format !== FORMAT || !Array.isArray(data.rooms)) throw new Error('저장 파일 형식이 다릅니다.');
  const rooms: Room[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let expired = 0;
  for (const raw of data.rooms) {
    const room = reviveRoom(raw);
    if (!room || seen.has(room.code)) {
      skipped++;
      continue;
    }
    if (isExpired(room, now, maxAgeMs)) {
      expired++;
      continue;
    }
    seen.add(room.code);
    rooms.push(room);
  }
  return { rooms, skipped, expired };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 임시 파일에 다 쓰고 디스크에 내린 뒤 원래 파일과 바꿔치기한다. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Windows 에서는 백신·검색 색인이 파일을 잠깐 열고 있으면 이름 바꾸기가 실패할 수 있어 몇 번 다시 해 본다.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** RoomManager 의 변화를 받아 파일에 저장하고, 서버가 켜질 때 되살린다. */
export class RoomStore {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  readonly maxAgeMs: number;
  private readonly log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private dirtySince = 0;
  private failing = false;
  /** 마지막으로 파일에 쓴 시각과 걸린 시간 (확인용) */
  lastWrite: { at: number; ms: number; bytes: number } | null = null;

  constructor(
    private readonly rooms: RoomManager,
    readonly file: string,
    opts: PersistOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.maxWaitMs = opts.maxWaitMs ?? 1000;
    this.maxAgeMs = opts.maxAgeMs ?? DAY_MS;
    this.log = opts.log ?? (() => {});
  }

  /** 저장 파일에서 방을 되살린다. 서버가 연결을 받기 전에 부른다. 되살린 방 수를 돌려준다. */
  load(now = Date.now()): number {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      this.log(`[저장] ${this.file} 을(를) 읽지 못해 빈 상태로 시작합니다: ${(err as Error).message}`);
      return 0;
    }
    let result: ReturnType<typeof restoreRooms>;
    try {
      result = restoreRooms(text, now, this.maxAgeMs);
    } catch (err) {
      const aside = `${this.file}.broken-${stamp()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* 옮기지 못해도 다음 저장 때 덮어쓴다 */
      }
      this.log(`[저장] 저장 파일이 깨져 ${path.basename(aside)} 로 옮겨 두고 빈 상태로 시작합니다: ${(err as Error).message}`);
      return 0;
    }
    for (const room of result.rooms) this.rooms.rooms.set(room.code, room);
    if (result.skipped) this.log(`[저장] 지금 규칙과 맞지 않거나 읽을 수 없는 방 ${result.skipped}개는 되살리지 않았습니다.`);
    // 정리한 방이 있으면 파일에도 곧 반영한다.
    if (result.skipped || result.expired) this.schedule();
    return result.rooms.length;
  }

  /** RoomManager 의 변화를 받아 저장을 예약하고, 한 시간마다 오래된 방을 정리한다. */
  attach(): void {
    this.rooms.onChange = () => this.schedule();
    this.sweep = setInterval(() => this.rooms.pruneStale(this.maxAgeMs), SWEEP_MS);
    this.sweep.unref();
  }

  /** 저장을 예약한다 (디바운스). */
  schedule(): void {
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.dirtySince + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** 기다리는 저장이 있으면 지금 바로 쓴다. 서버를 끌 때도 부른다. 쓰지 못하면 false. */
  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirtySince) return true;
    this.dirtySince = 0;
    const started = Date.now();
    try {
      const text = snapshotRooms(this.rooms.rooms.values(), started, this.maxAgeMs);
      writeFileAtomic(this.file, text);
      this.lastWrite = { at: started, ms: Date.now() - started, bytes: Buffer.byteLength(text) };
      if (this.failing) this.log('[저장] 다시 저장되기 시작했습니다.');
      this.failing = false;
      return true;
    } catch (err) {
      if (!this.failing) this.log(`[저장] ${this.file} 에 쓰지 못했습니다. 잠시 뒤 다시 시도합니다: ${(err as Error).message}`);
      this.failing = true;
      this.dirtySince = Date.now();
      this.timer = setTimeout(() => this.flush(), RETRY_MS);
      return false;
    }
  }

  /** 예약된 저장을 마저 쓰고 타이머를 멈춘다. */
  close(): void {
    this.flush();
    if (this.timer) clearTimeout(this.timer);
    if (this.sweep) clearInterval(this.sweep);
    this.timer = null;
    this.sweep = null;
    if (this.rooms.onChange) this.rooms.onChange = null;
  }
}
