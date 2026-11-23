// 방 채팅 화면 조각: 대화 목록과 입력칸, 빠른 이모티콘 줄, 좁은 화면에서 오른쪽 아래에 붙는 채팅 단추.
// 대기실과 게임 화면이 함께 쓴다. 판정(길이·간격)은 서버가 다시 한다.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { CHAT_EMOTES, CHAT_MAX_LENGTH, PING_LIMIT } from '../../shared/constants';
import type { ChatMessage } from '../../shared/protocol';
import { markChatRead, sendChatEmote, sendChatText, useChat } from '../net/chat';
import { playerColor } from '../theme';
import { PersonIcon } from './icons';
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
    const res = await sendChatText(t);
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
            <PersonIcon colorIndex={m.colorIndex} size={12} />
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
            const res = await sendChatEmote(e);
            if (!res.ok && res.code !== 'CHAT_SLOW') showToast(res.error, 'warn');
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** 핑 아이콘: 가운데 점과 둘레 고리, 네 방향 눈금 */
function PingIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="ping-icon">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 핑 단추: 누르면 핑 찍기가 켜지고, 보드에서 누른 자리가 모두의 보드에 내 색 물결로 잠깐 뜬다 (3초에 2번까지).
 * 마우스로는 Alt 키를 누른 채 보드를 눌러도 바로 찍힌다. compact: 좁은 화면 오른쪽 아래의 둥근 단추 꼴.
 */
export function PingButton({ active, onToggle, compact = false }: { active: boolean; onToggle: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      className={`${compact ? 'icon-btn chat-toggle ping-toggle' : 'ping-btn'} ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      aria-label="핑 찍기 (보드 한 곳을 모두에게 가리키기)"
      title={`핑 찍기 · Alt+클릭으로도 찍습니다 (${PING_LIMIT.windowMs / 1000}초에 ${PING_LIMIT.perWindow}번까지)`}
      onClick={onToggle}
    >
      <PingIcon size={compact ? 20 : 17} />
      {!compact && <span>핑</span>}
    </button>
  );
}

/** 보드 위 핑 물결: 찍은 사람 색의 점과 퍼지는 고리 두 겹, 위에 이름. PING_MS 동안 떠 있다가 옅어진다. */
export function PingMark({ colorIndex, name }: { colorIndex: number; name: string }) {
  const color = playerColor(colorIndex);
  return (
    <div className="ping-mark" style={{ ['--pc' as string]: color.hex } as CSSProperties} role="status" aria-label={`${name}의 핑`}>
      <span className="ping-ring" />
      <span className="ping-ring ping-ring-2" />
      <span className="ping-dot" />
      <span className="ping-name">
        <PersonIcon colorIndex={colorIndex} size={13} />
        {name}
      </span>
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
export function ChatDock({ code, you, extra }: { code: string; you: string; extra?: ReactNode }) {
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
        {extra}
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
