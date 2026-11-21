// 방 채팅 저장소. 서버가 보낸 최근 대화와 이모티콘을 방 코드와 함께 들고 있다가 React 에 알린다.
import { useSyncExternalStore } from 'react';
import { CHAT_HISTORY } from '../../shared/constants';
import type { ChatMessage } from '../../shared/protocol';
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
}

let state: ChatState = { code: null, messages: [], emotes: {}, seen: 0 };
const listeners = new Set<() => void>();
let emoteKey = 0;

function set(next: ChatState): void {
  state = next;
  listeners.forEach((fn) => fn());
}

client.onServer('chat:history', ({ code, messages }) => {
  // 새로고침해서 처음 받은 지난 대화는 읽은 것으로 친다. 같은 방에 다시 붙은 경우(잠깐 끊김)는 읽은 자리를 그대로 둔다.
  const last = messages.length ? messages[messages.length - 1].id : 0;
  const same = code === state.code;
  set({ code, messages: messages.slice(-CHAT_HISTORY), emotes: same ? state.emotes : {}, seen: same ? state.seen : last });
});

client.onServer('chat:message', ({ code, message }) => {
  if (code !== state.code) {
    set({ code, messages: [message], emotes: {}, seen: 0 });
    return;
  }
  if (state.messages.some((m) => m.id === message.id)) return;
  set({ ...state, messages: [...state.messages, message].slice(-CHAT_HISTORY) });
});

client.onServer('chat:emote', ({ code, emote }) => {
  if (code !== state.code) return;
  const key = ++emoteKey;
  set({ ...state, emotes: { ...state.emotes, [emote.from]: { emote: emote.emote, key } } });
  window.setTimeout(() => {
    if (state.emotes[emote.from]?.key !== key) return;
    const { [emote.from]: _gone, ...rest } = state.emotes;
    set({ ...state, emotes: rest });
  }, EMOTE_MS);
});

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

const EMPTY: ChatState = { code: null, messages: [], emotes: {}, seen: 0 };
