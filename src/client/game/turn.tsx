// 차례 안내: 예전 위쪽 띠를 대신하는 작은 상태 쪽지(턴·주사위·남은 시간·메뉴), 차례 시계, 자리 순서 정하기 주사위 창.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { GameView, RoomView } from '../../shared/protocol';
import { useDiceUi } from '../dice';
import { Emblem } from '../ui/icons';
import { josa } from '../ui/josa';
import { DieFace } from './panels';
import { isMyTurn, type PlayerInfo } from './derive';
import { ActionButton, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

export interface TurnClock {
  /** 남은 시간 (ms) */
  left: number;
  /** 한 차례 전체 시간 (ms) */
  total: number;
  /** 시간이 흐르는 사람들 */
  holders: string[];
}

/**
 * 차례 시계. 서버는 화면 정보를 만든 순간의 남은 시간(timeLeftMs)을 보내므로, 받은 시각에 더해 마감을 잡는다
 * (서버와 기기의 시계가 달라도 어긋나지 않는다). 제한이 없거나 멈춰 있으면 null.
 */
export function useTurnClock(g: GameView): TurnClock | null {
  const base = useMemo(() => ({ at: performance.now(), left: g.timeLeftMs }), [g]);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (base.left === null) return;
    setNow(performance.now());
    const t = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(t);
  }, [base]);
  if (base.left === null || !g.turnSeconds || g.phase === 'finished') return null;
  return { left: Math.max(0, base.left - (now - base.at)), total: g.turnSeconds * 1000, holders: g.clockHolders };
}

export function clockText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}`;
}

/** 모래시계 고리: 남은 시간만큼 테두리가 줄고, 10초 아래면 붉게 뛴다 */
export function TurnTimer({ clock, size = 30, mine }: { clock: TurnClock; size?: number; mine?: boolean }) {
  const frac = Math.max(0, Math.min(1, clock.left / clock.total));
  const low = clock.left <= 10_000;
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  return (
    <span
      className={`turn-timer ${low ? 'turn-timer-low' : ''} ${mine ? 'turn-timer-mine' : ''}`}
      style={{ width: size, height: size } as CSSProperties}
      role="timer"
      aria-label={`남은 시간 ${Math.ceil(clock.left / 1000)}초`}
      title={`남은 시간 ${Math.ceil(clock.left / 1000)}초`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="tt-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="tt-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <b>{clockText(clock.left)}</b>
    </span>
  );
}

/** 지금 단계를 한 줄로. wait 가 있으면(주사위·동상 연출을 기다리는 중) 다음 단계 대신 그 말을 적는다. */
function statusText(view: RoomView, players: Players, wait: string | null): ReactNode {
  const g = view.game!;
  const me = view.you;
  const who = (id: string | null) => {
    const p = id ? players.get(id) : null;
    return (
      <>
        <Emblem colorIndex={p?.colorIndex ?? 0} size={13} /> {p?.nickname ?? '?'}
      </>
    );
  };
  if (g.phase === 'order') {
    return g.startPending.includes(me) ? <b className="turn-me">주사위를 굴려 자리 순서를 정하세요</b> : <span>다른 사람이 순서 주사위를 굴리는 중</span>;
  }
  if (g.phase === 'placement') {
    if (g.placementPlayerId === me) return <b className="turn-me">{g.setupVillage ? '마을에 붙일 길을 고르세요' : '시작 마을 자리를 고르세요'}</b>;
    return <span>{who(g.placementPlayerId)}이(가) {g.setupVillage ? '길을' : '마을 자리를'} 고르는 중</span>;
  }
  if (g.phase === 'finished') return <b>게임 종료</b>;
  if (wait) {
    if (isMyTurn(view)) return <b className="turn-me">{wait}</b>;
    return (
      <span>
        {who(g.currentPlayerId)}의 차례 · {wait}
      </span>
    );
  }
  if (g.step === 'discard') {
    const n = g.discards[me];
    return n ? <b className="turn-me">7! 자원 {n}장을 버리세요</b> : <span>7! 자원이 많은 사람들이 절반을 버리는 중</span>;
  }
  if (isMyTurn(view)) {
    const text: Record<string, string> = {
      roll: '내 차례 · 주사위를 굴리세요',
      robber: '기사단 동상을 옮길 칸을 고르세요',
      steal: '자원을 빼앗을 사람을 고르세요',
      main: '내 차례 · 교환하고 지으세요',
      road_building: `공짜 길 ${g.freeRoads}개를 놓으세요`,
    };
    return <b className="turn-me">{text[g.step] ?? '내 차례'}</b>;
  }
  const text: Record<string, string> = {
    roll: '주사위를 굴리는 중',
    robber: '기사단 동상을 옮기는 중',
    steal: '빼앗을 사람을 고르는 중',
    main: '교환·건설 중',
    road_building: '공짜 길을 놓는 중',
  };
  const cur = g.currentPlayerId ? players.get(g.currentPlayerId) : null;
  return (
    <span>
      {who(g.currentPlayerId)}의 차례 · {text[g.step] ?? ''}
      {cur && !cur.connected && <em className="warn-text"> (연결 끊김)</em>}
    </span>
  );
}

/**
 * 차례 상태 쪽지: [☰] [n턴] [마지막 주사위] [남은 시간] 한 줄과 지금 할 일 한 줄.
 * 넓은 화면은 오른쪽 패널 맨 위, 좁은 화면은 보드 왼쪽 위에 작게 뜬다.
 */
export function TurnStatus({
  view,
  players,
  onMenu,
  wait = null,
  compact = false,
}: {
  view: RoomView;
  players: Players;
  onMenu: () => void;
  /** 연출을 기다리는 까닭 (game/pace.ts) */
  wait?: string | null;
  compact?: boolean;
}) {
  const g = view.game!;
  const dice = useDiceUi();
  const clock = useTurnClock(g);
  const mineNow = !!clock?.holders.includes(view.you);
  // 3D 주사위가 구르는 동안에는 결과를 미리 보여 주지 않는다 (주사위가 멈추면 그 값이 뜬다).
  const rolling = dice.throwing || (dice.landedSeq !== null && g.events.some((e) => e.kind === 'roll' && e.seq > dice.landedSeq!));
  const label = g.phase === 'order' ? '순서 정하기' : g.phase === 'placement' ? '시작 배치' : g.phase === 'finished' ? '끝' : `${g.turn}턴`;
  return (
    <div className={`turn-status ${compact ? 'turn-status-compact' : ''} ${mineNow ? 'turn-status-me' : ''}`}>
      <div className="ts-row">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="메뉴 열기">
          ☰
        </button>
        <span className="round-chip">{label}</span>
        {g.phase === 'playing' && (
          <span className="dice-now" aria-label="마지막 주사위">
            {rolling ? (
              <span className="muted small">굴리는 중…</span>
            ) : g.dice ? (
              <>
                <DieFace value={g.dice[0]} size={compact ? 18 : 22} />
                <DieFace value={g.dice[1]} size={compact ? 18 : 22} />
                <b className={g.dice[0] + g.dice[1] === 7 ? 'dice-seven' : ''}>={g.dice[0] + g.dice[1]}</b>
              </>
            ) : null}
          </span>
        )}
        <span className="ts-goal" title={`승점 ${g.winPoints}점에 먼저 닿으면 승리`}>
          ★{g.winPoints}
        </span>
        {clock && <TurnTimer clock={clock} mine={mineNow} size={compact ? 28 : 32} />}
      </div>
      <div className="turn-line">{statusText(view, players, wait)}</div>
      {clock && mineNow && <div className={`ts-bar ${clock.left <= 10_000 ? 'ts-bar-low' : ''}`} style={{ ['--f' as string]: clock.left / clock.total } as CSSProperties} />}
    </div>
  );
}

/** 굴린 주사위 두 개. 새로 굴린 값이면 잠깐 데굴데굴 구르다가 멈춘다. */
function TumblingDice({ dice, size = 26 }: { dice: [number, number]; size?: number }) {
  const [faces, setFaces] = useState<[number, number] | null>(null);
  useEffect(() => {
    let n = 0;
    setFaces([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]);
    const t = window.setInterval(() => {
      n++;
      if (n >= 9) {
        window.clearInterval(t);
        setFaces(null);
        return;
      }
      setFaces([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]);
    }, 85);
    return () => window.clearInterval(t);
  }, []);
  const show = faces ?? dice;
  return (
    <span className={`order-dice ${faces ? 'order-dice-rolling' : 'order-dice-landed'}`}>
      <DieFace value={show[0]} size={size} />
      <DieFace value={show[1]} size={size} />
      {!faces && <b>{dice[0] + dice[1]}</b>}
    </span>
  );
}

/** 순서 정하기 기록 비교 (높은 쪽이 앞) — rules.ts 의 compareStartRolls 와 같다 */
function compareRolls(a: [number, number][], b: [number, number][]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ? a[i][0] + a[i][1] : 0;
    const y = b[i] ? b[i][0] + b[i][1] : 0;
    if (x !== y) return y - x;
  }
  return 0;
}

/**
 * 자리 순서 정하기 창. 모두 동시에 주사위를 굴리고, 굴린 값이 사람마다 줄로 뜬다. 같은 수가 나온 사람은 다시 굴린다.
 * 다 정해지면(done) 높은 사람부터 순서를 보여 주고 곧 닫힌다.
 */
export function OrderRollPanel({ view, players, done = false, onClose }: { view: RoomView; players: Players; done?: boolean; onClose?: () => void }) {
  const g = view.game!;
  const me = view.you;
  const clock = useTurnClock(g);
  const pendingMe = g.phase === 'order' && g.startPending.includes(me);
  const ids = done ? g.order : [...g.order].sort((a, b) => compareRolls(g.startRolls[a] ?? [], g.startRolls[b] ?? []));
  const rolledAll = (id: string) => !g.startPending.includes(id) && (g.startRolls[id]?.length ?? 0) > 0;
  const tied = new Set(g.phase === 'order' ? g.startPending.filter((id) => (g.startRolls[id]?.length ?? 0) > 0) : []);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className={`order-panel ${done ? 'order-done' : ''}`}
      ref={ref}
      role="dialog"
      aria-label="자리 순서 정하기"
      title={done ? '누르면 닫힙니다' : undefined}
      onClick={done ? onClose : undefined}
    >
      <h2>{done ? '자리 순서가 정해졌습니다' : '자리 순서 정하기'}</h2>
      <p className="small muted">
        {done ? '이 순서로 시작 마을을 놓습니다 (한 바퀴 돌고 거꾸로 한 바퀴).' : '모두 동시에 주사위를 굴립니다. 높은 사람이 먼저, 가장 낮은 사람이 마지막입니다.'}
      </p>
      <ol className="order-list">
        {ids.map((id, i) => {
          const p = players.get(id);
          const rolls = g.startRolls[id] ?? [];
          const last = rolls.at(-1);
          const waiting = g.phase === 'order' && g.startPending.includes(id);
          return (
            <li key={id} className={`order-row ${id === me ? 'order-me' : ''} ${tied.has(id) ? 'order-tied' : ''}`}>
              <span className="order-rank">{done || (rolledAll(id) && g.phase !== 'order') ? `${i + 1}` : ''}</span>
              <Emblem colorIndex={p?.colorIndex ?? 0} size={18} />
              <span className="order-name">
                {p?.nickname ?? '?'}
                {id === me && <span className="tag">나</span>}
              </span>
              {rolls.length > 1 && (
                <span className="order-history small muted" title="앞서 굴린 값 (같은 수가 나와 다시 굴림)">
                  {rolls
                    .slice(0, -1)
                    .map((d) => d[0] + d[1])
                    .join('→')}
                  →
                </span>
              )}
              {last && !(waiting && tied.has(id)) ? <TumblingDice key={`${id}-${rolls.length}`} dice={last} /> : null}
              {waiting && <span className="order-wait small">{tied.has(id) ? '동점 · 다시 굴리기' : '굴리는 중…'}</span>}
              {done && i === 0 && <span className="tag tag-first">먼저</span>}
              {done && i === ids.length - 1 && <span className="tag">마지막</span>}
            </li>
          );
        })}
      </ol>
      {!done && (
        <div className="order-actions">
          {pendingMe ? (
            <ActionButton
              className="btn btn-primary btn-wide act-roll"
              label={tied.has(me) ? '다시 굴리기' : '주사위 굴리기'}
              blocker={null}
              onClick={() => sendAction({ type: 'order_roll' })}
            />
          ) : (
            <span className="small muted">{g.startPending.length ? `${g.startPending.map((id) => josa(players.get(id)?.nickname ?? '?', '을/를')).join(', ')} 기다리는 중` : ''}</span>
          )}
          {clock && <TurnTimer clock={clock} mine={pendingMe} />}
        </div>
      )}
    </div>
  );
}
