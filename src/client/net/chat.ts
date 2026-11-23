// 방 채팅 저장소. 서버가 보낸 최근 대화와 이모티콘, 핑을 방 코드와 함께 들고 있다가 React 에 알린다.
import { useSyncExternalStore } from 'react';
import { CHAT_HISTORY, PING_LIMIT, PING_MS } from '../../shared/constants';
import type { AckResult, ChatEmote, ChatMessage, ChatPing } from '../../shared/protocol';
import { client } from './client';

/** 이모티콘이 이름 옆에 떠 있는 시간 (CSS 의 emote-pop 과 같다) */
export const EMOTE_MS = 2600;

export interface ChatState {
  code: string | null;
  messages: ChatMessage[];
  /** 사람마다 지금 떠 있는 이모티콘. key 가 바뀌면 처음부터 다시 떠오른다. */
  emotes: Record<string, { emote: string; key: number }>;
  /** 이 화면에서 읽은 마지막 메시지 번호 (새 글 표시용) */
  seen: number;
  /** 보드 위에 떠 있는 핑 (PING_MS 뒤 사라진다). key 는 화면 안에서만 쓰는 번호 */
  pings: (ChatPing & { key: number })[];
}

let state: ChatState = { code: null, messages: [], emotes: {}, seen: 0, pings: [] };
let pingKey = 0;
/** 내가 최근에 핑을 찍은 시각 (서버와 같은 제한을 화면에서도 미리 센다) */
let myPingTimes: number[] = [];
const listeners = new Set<() => void>();
let emoteKey = 0;

function set(next: ChatState): void {
  state = next;
  listeners.forEach((fn) => fn());
}

/**
 * 채팅을 서버 대신 받는 곳 (실험실 모의 게임). 정하면 보내기·이모티콘이 서버로 가지 않고 이리로 간다.
 */
export interface ChatSink {
  send: (text: string) => Promise<AckResult>;
  emote: (emote: string) => Promise<AckResult>;
  ping: (kind: ChatPing['kind'], target: string) => Promise<AckResult>;
}
let sink: ChatSink | null = null;

export function setChatSink(next: ChatSink | null): void {
  sink = next;
}

export function sendChatText(text: string): Promise<AckResult> {
  return sink ? sink.send(text) : client.sendChat(text);
}

export function sendChatEmote(emote: string): Promise<AckResult> {
  return sink ? sink.emote(emote) : client.sendEmote(emote);
}

/** 보드 한 자리를 가리킨다. 3초에 2번을 넘기면 서버에 묻지 않고 바로 거절한다 (서버도 같은 제한을 둔다). */
export function sendChatPing(kind: ChatPing['kind'], target: string, now = Date.now()): Promise<AckResult> {
  myPingTimes = myPingTimes.filter((t) => now - t < PING_LIMIT.windowMs);
  if (myPingTimes.length >= PING_LIMIT.perWindow) {
    return Promise.resolve({ ok: false, error: `핑은 ${PING_LIMIT.windowMs / 1000}초에 ${PING_LIMIT.perWindow}번까지 찍을 수 있습니다.`, code: 'PING_SLOW' });
  }
  myPingTimes.push(now);
  return sink ? sink.ping(kind, target) : client.sendPing(kind, target);
}

/** 서버가 보낸 것처럼 대화 한 줄·이모티콘을 넣는다 (실험실 모의 게임) */
export function injectChat(code: string, message: ChatMessage): void {
  onMessage({ code, message });
}

export function injectEmote(code: string, emote: ChatEmote): void {
  onEmote({ code, emote });
}

export function injectPing(code: string, ping: ChatPing): void {
  onPing({ code, ping });
}

client.onServer('chat:history', ({ code, messages }) => {
  // 새로고침해서 처음 받은 지난 대화는 읽은 것으로 친다. 같은 방에 다시 붙은 경우(잠깐 끊김)는 읽은 자리를 그대로 둔다.
  const last = messages.length ? messages[messages.length - 1].id : 0;
  const same = code === state.code;
  set({ code, messages: messages.slice(-CHAT_HISTORY), emotes: same ? state.emotes : {}, seen: same ? state.seen : last, pings: same ? state.pings : [] });
});

client.onServer('chat:message', (p) => onMessage(p));
client.onServer('chat:emote', (p) => onEmote(p));
client.onServer('chat:ping', (p) => onPing(p));

function onMessage({ code, message }: { code: string; message: ChatMessage }): void {
  if (code !== state.code) {
    set({ code, messages: [message], emotes: {}, seen: 0, pings: [] });
    return;
  }
  if (state.messages.some((m) => m.id === message.id)) return;
  set({ ...state, messages: [...state.messages, message].slice(-CHAT_HISTORY) });
}

function onEmote({ code, emote }: { code: string; emote: ChatEmote }): void {
  if (code !== state.code) return;
  const key = ++emoteKey;
  set({ ...state, emotes: { ...state.emotes, [emote.from]: { emote: emote.emote, key } } });
  window.setTimeout(() => {
    if (state.emotes[emote.from]?.key !== key) return;
    const { [emote.from]: _gone, ...rest } = state.emotes;
    set({ ...state, emotes: rest });
  }, EMOTE_MS);
}

function onPing({ code, ping }: { code: string; ping: ChatPing }): void {
  if (code !== state.code) {
    // 아직 대화 기록을 받기 전(실험실 등)이면 이 방으로 맞춘다.
    if (state.code !== null) return;
    state = { ...state, code };
  }
  const key = ++pingKey;
  set({ ...state, pings: [...state.pings, { ...ping, key }].slice(-8) });
  window.setTimeout(() => {
    if (!state.pings.some((p) => p.key === key)) return;
    set({ ...state, pings: state.pings.filter((p) => p.key !== key) });
  }, PING_MS);
}

export function markChatRead(): void {
  const last = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
  if (state.seen !== last) set({ ...state, seen: last });
}

/** 지금 방(code)의 채팅. 다른 방의 것은 비워서 돌려준다. */
export function useChat(code: string): ChatState {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
  return s.code === code ? s : EMPTY;
}

const EMPTY: ChatState = { code: null, messages: [], emotes: {}, seen: 0, pings: [] };
