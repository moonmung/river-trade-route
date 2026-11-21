// 방 채팅 화면 조각: 대화 목록과 입력칸, 빠른 이모티콘 줄, 좁은 화면에서 오른쪽 아래에 붙는 채팅 단추.
// 대기실과 게임 화면이 함께 쓴다. 판정(길이·간격)은 서버가 다시 한다.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CHAT_EMOTES, CHAT_MAX_LENGTH } from '../../shared/constants';
import type { ChatMessage } from '../../shared/protocol';
import { markChatRead, useChat } from '../net/chat';
import { client } from '../net/client';
import { Emblem } from './icons';
import { showToast } from './toast';

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 대화 목록과 입력칸. 보이는 동안에는 새 글을 읽은 것으로 친다. */
export function ChatBox({ code, you, autoFocus = false }: { code: string; you: string; autoFocus?: boolean }) {
  const chat = useChat(code);
  const listRef = useRef<HTMLOListElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const last = chat.messages.length ? chat.messages[chat.messages.length - 1].id : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    markChatRead();
  }, [last]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const res = await client.sendChat(t);
    setSending(false);
    if (res.ok) setText('');
    else showToast(res.error, 'warn');
  };

  return (
    <div className="chat">
      <ol className="chat-list" ref={listRef} aria-live="polite" aria-label="대화">
        {chat.messages.length === 0 && <li className="chat-empty">아직 대화가 없습니다. 인사를 건네 보세요.</li>}
        {chat.messages.map((m) => (
          <li key={m.id} className={`chat-msg ${m.from === you ? 'chat-mine' : ''}`}>
            <Emblem colorIndex={m.colorIndex} size={12} />
            <b className="chat-who">{m.from === you ? '나' : m.nickname}</b>
            <span className="chat-text">{m.text}</span>
            <time className="chat-time" dateTime={new Date(m.at).toISOString()}>
              {clock(m.at)}
            </time>
          </li>
        ))}
      </ol>
      <form className="chat-form" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={CHAT_MAX_LENGTH}
          placeholder="한마디 남기기"
          aria-label="채팅 입력"
          enterKeyHint="send"
          autoComplete="off"
          autoFocus={autoFocus}
        />
        <button type="submit" className="btn btn-small" disabled={sending || !text.trim()}>
          보내기
        </button>
      </form>
    </div>
  );
}

/** 누르면 내 이름 옆에 잠깐 떠오르는 이모티콘 줄 */
export function EmoteBar() {
  return (
    <div className="emote-bar" role="group" aria-label="이모티콘 띄우기">
      {CHAT_EMOTES.map((e) => (
        <button
          key={e}
          type="button"
          className="emote-btn"
          aria-label={`${e} 띄우기`}
          onClick={async () => {
            const res = await client.sendEmote(e);
            if (!res.ok && res.code !== 'CHAT_SLOW') showToast(res.error, 'warn');
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** 읽지 않은 새 글 수 (내가 쓴 것 빼고) */
export function useUnread(code: string, you: string): number {
  const chat = useChat(code);
  return chat.messages.filter((m) => m.id > chat.seen && m.from !== you).length;
}

/**
 * 좁은 화면: 오른쪽 아래의 채팅 단추와 이모티콘 단추. 누르면 위로 대화 창이 열린다.
 * 닫혀 있을 때 새 글이 오면 단추 옆에 잠깐 한 줄을 보여 준다.
 */
export function ChatDock({ code, you }: { code: string; you: string }) {
  const chat = useChat(code);
  const [open, setOpen] = useState<null | 'chat' | 'emote'>(null);
  const unread = useUnread(code, you);
  const last: ChatMessage | undefined = chat.messages[chat.messages.length - 1];
  const [peek, setPeek] = useState<ChatMessage | null>(null);
  useEffect(() => {
    if (!last || open === 'chat' || last.from === you || last.id <= chat.seen) return;
    setPeek(last);
    const t = window.setTimeout(() => setPeek(null), 4000);
    return () => window.clearTimeout(t);
  }, [last?.id]);

  return (
    <div className="chat-dock">
      {open === 'chat' && (
        <div className="chat-pop" role="dialog" aria-label="채팅">
          <ChatBox code={code} you={you} autoFocus />
          <EmoteBar />
        </div>
      )}
      {open === 'emote' && (
        <div className="chat-pop chat-pop-emote" role="dialog" aria-label="이모티콘">
          <EmoteBar />
        </div>
      )}
      {open !== 'chat' && peek && (
        <button type="button" className="chat-peek" onClick={() => setOpen('chat')}>
          <b>{peek.nickname}</b> {peek.text}
        </button>
      )}
      <div className="chat-dock-btns">
        <button
          type="button"
          className={`icon-btn chat-toggle ${open === 'emote' ? 'is-active' : ''}`}
          aria-label="이모티콘 띄우기"
          aria-expanded={open === 'emote'}
          onClick={() => setOpen((o) => (o === 'emote' ? null : 'emote'))}
        >
          😊
        </button>
        <button
          type="button"
          className={`icon-btn chat-toggle ${open === 'chat' ? 'is-active' : ''}`}
          aria-label={`채팅${unread ? ` (새 글 ${unread})` : ''}`}
          aria-expanded={open === 'chat'}
          onClick={() => {
            setPeek(null);
            setOpen((o) => (o === 'chat' ? null : 'chat'));
          }}
        >
          💬{unread > 0 && <i className="chat-badge">{unread}</i>}
        </button>
      </div>
    </div>
  );
}
