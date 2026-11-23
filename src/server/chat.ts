// 방 채팅. 방마다 최근 메시지를 메모리에 보관하고 길이·간격 제한을 둔다.
// rooms.ts 의 Room 을 건드리지 않으려고 방 객체를 키로 하는 WeakMap 에 둔다. 방이 사라지면 기록도 함께 사라진다.
import { boardOf } from '../shared/board';
import { BRAG_GAP_MS, CHAT_EMOTES, CHAT_HISTORY, PING_SLOW_TEXT, takePingToken, type PingBucket } from '../shared/constants';
import type { ChatBrag, ChatEmote, ChatMessage, ChatPing } from '../shared/protocol';
import { normalizeChatText } from '../shared/validate';
import type { Room, RoomPlayer } from './rooms';

/** 도배 방지: 같은 사람이 글을 보내는 최소 간격과, 10초 안에 보낼 수 있는 수 */
export const CHAT_LIMITS = {
  windowMs: 10_000,
  textGapMs: 700,
  textPerWindow: 6,
  emoteGapMs: 300,
  emotePerWindow: 10,
} as const;

type ChatFail = { ok: false; error: string; code: string };

interface RoomChat {
  seq: number;
  messages: ChatMessage[];
  /** 사람마다 최근에 보낸 시각 (글, 이모티콘, 핑 따로) */
  textTimes: Map<string, number[]>;
  emoteTimes: Map<string, number[]>;
  /** 사람마다 남은 핑 횟수 */
  pingBuckets: Map<string, PingBucket>;
  pingSeq: number;
  /** 사람마다 마지막으로 자랑한 시각 */
  bragTimes: Map<string, number>;
}

/** 간격·횟수 제한을 넘지 않으면 now 를 기록하고 true */
function allow(times: Map<string, number[]>, who: string, now: number, gap: number, perWindow: number, windowMs: number = CHAT_LIMITS.windowMs): boolean {
  const recent = (times.get(who) ?? []).filter((t) => now - t < windowMs);
  const last = recent[recent.length - 1];
  if ((last !== undefined && now - last < gap) || recent.length >= perWindow) {
    times.set(who, recent);
    return false;
  }
  recent.push(now);
  times.set(who, recent);
  return true;
}

const SLOW: ChatFail = { ok: false, error: '조금 천천히 보내 주세요.', code: 'CHAT_SLOW' };
const PING_SLOW: ChatFail = { ok: false, error: PING_SLOW_TEXT, code: 'PING_SLOW' };
/** 화면이 먼저 세고 보내므로, 두 핑의 네트워크 지연이 달라 서버에서 간격이 조금 짧게 보여도 거절하지 않게 둔다 */
const PING_SLACK_MS = 100;
const PING_KINDS = ['tile', 'vertex', 'edge'] as const;

export class ChatHub {
  private readonly chats = new WeakMap<Room, RoomChat>();

  private of(room: Room): RoomChat {
    let c = this.chats.get(room);
    if (!c) {
      c = { seq: 0, messages: [], textTimes: new Map(), emoteTimes: new Map(), pingBuckets: new Map(), pingSeq: 0, bragTimes: new Map() };
      this.chats.set(room, c);
    }
    return c;
  }

  /** 방에 남아 있는 최근 메시지 (오래된 것부터) */
  history(room: Room): ChatMessage[] {
    return this.chats.get(room)?.messages.map((m) => ({ ...m })) ?? [];
  }

  post(room: Room, player: RoomPlayer, raw: unknown, now = Date.now()): { ok: true; message: ChatMessage } | ChatFail {
    const text = normalizeChatText(raw);
    if (!text) {
      return typeof raw === 'string' && raw.trim()
        ? { ok: false, error: '글이 너무 깁니다.', code: 'CHAT_TOO_LONG' }
        : { ok: false, error: '보낼 글을 적으세요.', code: 'CHAT_EMPTY' };
    }
    const c = this.of(room);
    if (!allow(c.textTimes, player.id, now, CHAT_LIMITS.textGapMs, CHAT_LIMITS.textPerWindow)) return SLOW;
    c.seq += 1;
    const message: ChatMessage = { id: c.seq, from: player.id, nickname: player.nickname, colorIndex: player.colorIndex, text, at: now };
    c.messages.push(message);
    if (c.messages.length > CHAT_HISTORY) c.messages.splice(0, c.messages.length - CHAT_HISTORY);
    return { ok: true, message: { ...message } };
  }

  emote(room: Room, player: RoomPlayer, raw: unknown, now = Date.now()): { ok: true; emote: ChatEmote } | ChatFail {
    if (typeof raw !== 'string' || !(CHAT_EMOTES as readonly string[]).includes(raw)) {
      return { ok: false, error: '고를 수 있는 이모티콘이 아닙니다.', code: 'CHAT_BAD_EMOTE' };
    }
    const c = this.of(room);
    if (!allow(c.emoteTimes, player.id, now, CHAT_LIMITS.emoteGapMs, CHAT_LIMITS.emotePerWindow)) return SLOW;
    return { ok: true, emote: { from: player.id, emote: raw, at: now } };
  }

  /** 보드 한 자리를 가리킨다. 게임 중인 방에서, 그 게임 보드에 있는 칸·꼭짓점·변만 받고 한 사람이 연달아 3번, 그 뒤로는 1초에 한 번씩. 보관하지 않는다. */
  ping(room: Room, player: RoomPlayer, raw: unknown, now = Date.now()): { ok: true; ping: ChatPing } | ChatFail {
    const p = (raw ?? {}) as { kind?: unknown; target?: unknown };
    const kind = PING_KINDS.find((k) => k === p.kind);
    const target = typeof p.target === 'string' ? p.target : '';
    if (!room.game) return { ok: false, error: '게임 중에만 핑을 찍을 수 있습니다.', code: 'PING_NO_GAME' };
    const board = boardOf(room.game);
    const map = kind === 'tile' ? board.tileMap : kind === 'vertex' ? board.vertexMap : kind === 'edge' ? board.edgeMap : null;
    const exists = !!map && Object.hasOwn(map, target);
    if (!kind || !exists) return { ok: false, error: '보드에 없는 자리입니다.', code: 'PING_BAD_TARGET' };
    const c = this.of(room);
    const taken = takePingToken(c.pingBuckets.get(player.id), now, PING_SLACK_MS);
    c.pingBuckets.set(player.id, taken.bucket);
    if (!taken.ok) return PING_SLOW;
    c.pingSeq += 1;
    return { ok: true, ping: { id: c.pingSeq, from: player.id, kind, target, at: now } };
  }

  /** 지금 가진 달성(최장 교역로·최강 기사단)만 뽐낼 수 있고, 한 사람이 BRAG_GAP_MS 에 한 번. 보관하지 않는다. */
  brag(room: Room, player: RoomPlayer, raw: unknown, now = Date.now()): { ok: true; brag: ChatBrag } | ChatFail {
    const award = (raw as { award?: unknown } | null)?.award;
    if (award !== 'longest_road' && award !== 'largest_army') return { ok: false, error: '뽐낼 수 있는 달성이 아닙니다.', code: 'BRAG_BAD' };
    const g = room.game;
    if (!g || g.phase !== 'playing') return { ok: false, error: '게임 중에만 자랑할 수 있습니다.', code: 'BRAG_NO_GAME' };
    const held = award === 'longest_road' ? g.longestRoad : g.largestArmy;
    if (held.holder !== player.id) return { ok: false, error: '가지고 있는 달성만 자랑할 수 있습니다.', code: 'BRAG_NOT_HOLDER' };
    const c = this.of(room);
    const last = c.bragTimes.get(player.id);
    if (last !== undefined && now - last < BRAG_GAP_MS - PING_SLACK_MS) return { ok: false, error: '자랑은 잠시 뒤에 다시 할 수 있습니다.', code: 'BRAG_SLOW' };
    c.bragTimes.set(player.id, now);
    const size = 'length' in held ? held.length : held.size;
    return { ok: true, brag: { from: player.id, award, size, at: now } };
  }
}
