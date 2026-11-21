// 방 채팅. 방마다 최근 메시지를 메모리에 보관하고 길이·간격 제한을 둔다.
// rooms.ts 의 Room 을 건드리지 않으려고 방 객체를 키로 하는 WeakMap 에 둔다. 방이 사라지면 기록도 함께 사라진다.
import { CHAT_EMOTES, CHAT_HISTORY } from '../shared/constants';
import type { ChatEmote, ChatMessage } from '../shared/protocol';
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
  /** 사람마다 최근에 보낸 시각 (글, 이모티콘 따로) */
  textTimes: Map<string, number[]>;
  emoteTimes: Map<string, number[]>;
}

/** 간격·횟수 제한을 넘지 않으면 now 를 기록하고 true */
function allow(times: Map<string, number[]>, who: string, now: number, gap: number, perWindow: number): boolean {
  const recent = (times.get(who) ?? []).filter((t) => now - t < CHAT_LIMITS.windowMs);
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

export class ChatHub {
  private readonly chats = new WeakMap<Room, RoomChat>();

  private of(room: Room): RoomChat {
    let c = this.chats.get(room);
    if (!c) {
      c = { seq: 0, messages: [], textTimes: new Map(), emoteTimes: new Map() };
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
}
