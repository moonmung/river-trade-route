// 게임 기록 보기: 보드 왼쪽 위에 이번 턴에 한 일이 한 줄씩 떴다가 천천히 사라지고(TurnFeed),
// 그 위 [기록] 단추를 누르면 처음부터 지금까지의 기록을 화면 가득 턴별로 묶어 보여 준다(LogOverlay).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RoomView } from '../../shared/protocol';
import type { GameEvent } from '../../shared/types';
import { playerColor } from '../theme';
import { PersonIcon } from '../ui/icons';
import { formatEvent, type PlayerInfo } from './derive';
import { groupByTurn } from './logTurns';

type Players = Map<string, PlayerInfo>;

/** 한 줄이 떠 있는 시간 (CSS 의 feed-life 와 같다). 마지막 4초 동안 천천히 옅어진다. */
export const FEED_LIFE_MS = 12_000;
/** 턴이 바뀌면 지난 턴 줄은 이만큼 걸려 빨리 사라진다 (CSS 의 feed-out 과 같다) */
const FEED_OUT_MS = 900;
const FEED_MAX = 6;

/** 그 일을 한 사람 (아이콘 색) */
function actorOf(e: GameEvent): string | null {
  if ('player' in e && typeof e.player === 'string') return e.player;
  if ('from' in e && typeof e.from === 'string') return e.from;
  return null;
}

/** 화면에 띄우지 않는 자잘한 기록: 턴 넘기기, 교환 제안에 대한 하나하나의 응답, 순서 주사위 */
function feedWorthy(e: GameEvent): boolean {
  return e.kind !== 'turn_end' && e.kind !== 'trade_response' && e.kind !== 'order_roll' && e.kind !== 'order_tie';
}

interface FeedItem {
  seq: number;
  turn: number;
  text: string;
  actor: string | null;
  /** 턴이 바뀌어 빨리 사라지는 중 */
  out: boolean;
}

/**
 * 이번 턴 기록: 새로 생긴 일이 보드 왼쪽 위에 한 줄씩 쌓이고, 한 줄마다 12초쯤 떠 있다가 천천히 옅어져 사라진다.
 * 다음 사람 차례가 되면 지난 턴 줄은 빨리 걷힌다. 처음 들어왔을 때(새로고침 포함)는 지난 기록을 다시 띄우지 않는다.
 */
export function TurnFeed({ view, players, compact = false, onOpenLog }: { view: RoomView; players: Players; compact?: boolean; onOpenLog: () => void }) {
  const g = view.game!;
  const [items, setItems] = useState<FeedItem[]>([]);
  const lastSeq = useRef<number | null>(null);
  const lastGame = useRef(view.gameNumber);
  /** 줄마다 지울 때를 잰 타이머. 키는 "번호:빨리 걷는 중인지" (빨리 걷게 되면 짧은 타이머로 바꾼다) */
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const maxSeq = g.events.length ? g.events[g.events.length - 1].seq : 0;
    if (lastSeq.current === null || lastGame.current !== view.gameNumber) {
      lastSeq.current = maxSeq;
      lastGame.current = view.gameNumber;
      setItems([]);
      return;
    }
    const fresh = g.events.filter((e) => e.seq > lastSeq.current!);
    lastSeq.current = maxSeq;
    if (!fresh.length) return;
    const turn = g.turn;
    const add = fresh.filter(feedWorthy).map((e) => ({ seq: e.seq, turn: e.turn, text: formatEvent(e, players, view.you, g), actor: actorOf(e), out: false }));
    setItems((cur) => {
      // 턴이 바뀌었으면 지난 턴 줄은 빨리 걷는다.
      const kept = cur.map((it) => (it.turn !== turn && !it.out ? { ...it, out: true } : it));
      return [...kept, ...add].slice(-FEED_MAX - 4);
    });
  }, [g.events, view.gameNumber]);

  // 줄마다 수명이 다하면 지운다 (애니메이션이 멈춰 있는 화면에서도 반드시 지운다).
  useEffect(() => {
    for (const it of items) {
      const key = `${it.seq}:${it.out}`;
      if (timers.current.has(key)) continue;
      // 빨리 걷게 된 줄은 원래 타이머를 거두고 짧은 타이머로 바꾼다.
      const old = `${it.seq}:false`;
      if (it.out && timers.current.has(old)) {
        window.clearTimeout(timers.current.get(old));
        timers.current.delete(old);
      }
      const t = window.setTimeout(
        () => {
          timers.current.delete(key);
          setItems((cur) => cur.filter((x) => x.seq !== it.seq));
        },
        it.out ? FEED_OUT_MS : FEED_LIFE_MS,
      );
      timers.current.set(key, t);
    }
  }, [items]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const shown = items.filter((it) => !it.out).slice(-FEED_MAX);
  const leaving = items.filter((it) => it.out);
  return (
    <div className={`turn-feed ${compact ? 'turn-feed-compact' : ''}`}>
      <button type="button" className="feed-open" onClick={onOpenLog} title="처음부터 지금까지의 기록을 화면 가득 봅니다" aria-label="전체 기록 보기">
        <ScrollIcon />
        <span>기록</span>
      </button>
      <ol className="feed-list" aria-live="polite" aria-label="이번 턴 기록">
        {[...leaving, ...shown].map((it) => (
          <li key={it.seq} className={`feed-line ${it.out ? 'feed-out' : ''}`} style={feedStyle(players, it.actor)}>
            {it.actor && <PersonIcon colorIndex={players.get(it.actor)?.colorIndex ?? 0} size={compact ? 12 : 14} />}
            <span>{it.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function feedStyle(players: Players, actor: string | null): CSSProperties {
  const c = actor ? playerColor(players.get(actor)?.colorIndex ?? 0).hex : 'rgba(58, 42, 31, 0.5)';
  return { ['--pc' as string]: c } as CSSProperties;
}

/** 두루마리 아이콘 */
function ScrollIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="scroll-icon">
      <path d="M6 3.5h11a2.5 2.5 0 0 1 2.5 2.5v12.5a2.5 2.5 0 0 1-2.5 2.5H8.5A2.5 2.5 0 0 1 6 18.5z" fill="#f6ead0" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 3.5A2.5 2.5 0 0 0 3.5 6v1.5H6" fill="#e8d7b0" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9.5 9h7M9.5 12.5h7M9.5 16h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 전체 기록: 화면 가득 덮는 창에 처음부터 지금까지의 기록을 턴별로 묶어 보여 준다 (최근 턴이 위). 턴마다 그 턴을 둔 사람 색 띠를 두르고
 * 한 줄마다 한 사람 아이콘을 붙인다. Esc 나 닫기로 닫는다.
 */
export function LogOverlay({ view, players, onClose }: { view: RoomView; players: Players; onClose: () => void }) {
  const g = view.game!;
  const groups = useMemo(() => groupByTurn(g.events), [g.events]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const name = (id: string | null) => (!id ? '' : id === view.you ? '나' : (players.get(id)?.nickname ?? '?'));
  return (
    <div className="log-overlay" role="dialog" aria-modal="true" aria-label="전체 기록" tabIndex={-1} ref={ref}>
      <div className="log-overlay-head">
        <h2>
          <ScrollIcon size={22} /> 전체 기록
        </h2>
        <span className="muted small">
          {g.turn > 0 ? `${g.turn}턴째` : '시작 배치 중'} · 기록 {g.events.length}줄
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <div className="log-overlay-body">
        {groups.map((grp) => (
          <section
            key={`${grp.turn}-${grp.events[0].seq}`}
            className={`log-turn ${grp.turn === g.turn ? 'log-turn-now' : ''}`}
            style={{ ['--pc' as string]: grp.player ? playerColor(players.get(grp.player)?.colorIndex ?? 0).hex : 'rgba(58, 42, 31, 0.4)' } as CSSProperties}
          >
            <h3>
              {grp.player && <PersonIcon colorIndex={players.get(grp.player)?.colorIndex ?? 0} size={16} />}
              {grp.turn > 0 ? `${grp.turn}턴` : '시작 배치'}
              {grp.player && <span className="log-turn-who">{name(grp.player)}</span>}
              {grp.turn === g.turn && <span className="tag">지금</span>}
            </h3>
            <ol className="log">
              {[...grp.events].reverse().map((e) => {
                const actor = actorOf(e);
                return (
                  <li key={e.seq}>
                    {actor && <PersonIcon colorIndex={players.get(actor)?.colorIndex ?? 0} size={13} />} {formatEvent(e, players, view.you, g)}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
