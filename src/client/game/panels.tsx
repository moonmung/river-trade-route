import { useEffect, useState, type CSSProperties } from 'react';
import { DEV_COST, DEV_LABEL, PIECE_COST, PIECE_LIMIT, PIECE_POINTS, RESOURCES, RESOURCE_LABEL, WIN_POINTS } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { pieceCount } from '../../shared/rules';
import type { Bundle, PieceKind } from '../../shared/types';
import { throwDice } from '../dice';
import { playerColor } from '../theme';
import { Emblem, ResourceIcon } from '../ui/icons';
import { DevIcon, MiniHand } from './hand';
import { buildBlocker, buyDevBlocker, isMyTurn, shortfall, turnBlocker, type PlayerInfo } from './derive';
import { canBankNow, tradeButtonBlocker } from './trade';
import { ActionButton, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

/** 주사위 한 개 (점 무늬) */
export function DieFace({ value, size = 26 }: { value: number; size?: number }) {
  const pips: Record<number, [number, number][]> = {
    1: [[12, 12]],
    2: [[7, 7], [17, 17]],
    3: [[7, 7], [12, 12], [17, 17]],
    4: [[7, 7], [17, 7], [7, 17], [17, 17]],
    5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
    6: [[7, 7], [17, 7], [7, 12], [17, 12], [7, 17], [17, 17]],
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={`주사위 ${value}`} className="die">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#faf3e2" stroke="#3a2a1f" strokeWidth="1.6" />
      {(pips[value] ?? []).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.1" fill={value === 1 ? '#a8402c' : '#3a2a1f'} />
      ))}
    </svg>
  );
}

export function TopBar({ view, players, onMenu }: { view: RoomView; players: Players; onMenu: () => void }) {
  const g = view.game!;
  const current = g.currentPlayerId ? players.get(g.currentPlayerId) : null;
  const placing = g.placementPlayerId ? players.get(g.placementPlayerId) : null;
  const mine = isMyTurn(view);
  const who = (p: PlayerInfo | null | undefined) => (
    <>
      <Emblem colorIndex={p?.colorIndex ?? 0} size={14} /> {p?.nickname}
    </>
  );
  let status: React.ReactNode;
  if (g.phase === 'placement') {
    status = g.placementPlayerId === view.you ? <b className="turn-me">내가 시작 마을과 길을 놓을 차례</b> : <span>{who(placing)}이(가) 시작 마을과 길을 고르는 중</span>;
  } else if (g.phase === 'finished') {
    status = <b>게임 종료</b>;
  } else if (g.step === 'discard') {
    const mineDiscard = g.discards[view.you];
    status = mineDiscard ? <b className="turn-me">7! 자원 {mineDiscard}장을 버리세요</b> : <span>7! 자원이 많은 사람들이 절반을 버리는 중</span>;
  } else if (mine) {
    const text: Record<string, string> = {
      roll: '내 차례 · 주사위를 굴리세요',
      robber: '기사단 동상을 옮길 칸을 고르세요',
      steal: '자원을 빼앗을 사람을 고르세요',
      main: '내 차례 · 교환하고 지으세요',
      road_building: `공짜 길 ${g.freeRoads}개를 놓으세요`,
    };
    status = <b className="turn-me">{text[g.step] ?? '내 차례'}</b>;
  } else {
    const text: Record<string, string> = {
      roll: '주사위를 굴리는 중',
      robber: '기사단 동상을 옮기는 중',
      steal: '빼앗을 사람을 고르는 중',
      main: '교환·건설 중',
      road_building: '공짜 길을 놓는 중',
    };
    status = (
      <span>
        {who(current)}의 차례 · {text[g.step] ?? ''}
        {current && !current.connected && <em className="warn-text"> (연결 끊김 — 다시 접속할 때까지 기다립니다)</em>}
      </span>
    );
  }

  return (
    <div className="topbar">
      <div className="topbar-row">
        <div className="round-chip">{g.phase === 'placement' ? '시작 배치' : `${g.turn}턴`}</div>
        <div className="dice-now" aria-label="마지막 주사위">
          {g.dice ? (
            <>
              <DieFace value={g.dice[0]} />
              <DieFace value={g.dice[1]} />
              <b className={g.dice[0] + g.dice[1] === 7 ? 'dice-seven' : ''}>= {g.dice[0] + g.dice[1]}</b>
            </>
          ) : (
            <span className="muted small">아직 굴리지 않음</span>
          )}
        </div>
        <div className="goal small muted">{WIN_POINTS}점 먼저 내면 승리</div>
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="메뉴 열기">
          ☰
        </button>
      </div>
      <div className="turn-line">{status}</div>
    </div>
  );
}

/** 최장 교역로·최강 기사단 표식 */
export function AwardIcon({ kind, size = 14 }: { kind: 'longest_road' | 'largest_army'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="award-icon">
      {kind === 'longest_road' ? (
        <g>
          <path d="M3 19 C8 15 9 9 21 5" stroke="#6b4a2a" strokeWidth="5" fill="none" strokeLinecap="round" />
          <path d="M3 19 C8 15 9 9 21 5" stroke="#e8c27a" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeDasharray="3 2" />
        </g>
      ) : (
        <g stroke="#3a2a1f" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M12 2 L20 5 V12 C20 17 16 20.5 12 22 C8 20.5 4 17 4 12 V5 Z" fill="#a8402c" />
          <path d="M12 6 V17 M8 10 H16" stroke="#f3e2c4" strokeWidth="2" />
        </g>
      )}
    </svg>
  );
}

/**
 * 플레이어 상태 창 (화면 오른쪽 맨 아래). 이름·승점 줄과 손 카드·기사·길 줄 두 줄로 적는다.
 * 채팅 이모티콘은 이름 옆에 잠깐 떠오른다.
 */
export function PlayersPanel({
  view,
  players,
  emotes = {},
}: {
  view: RoomView;
  players: Players;
  emotes?: Record<string, { emote: string; key: number }>;
}) {
  const g = view.game!;
  return (
    <ul className="players" aria-label="플레이어">
      {g.order.map((id) => {
        const p = players.get(id);
        const info = g.players.find((x) => x.id === id)!;
        if (!p) return null;
        const isCurrent = g.currentPlayerId === id || g.placementPlayerId === id;
        const color = playerColor(p.colorIndex);
        const points = id === view.you ? g.myPoints : info.score;
        const offers = g.trades.filter((t) => t.from === id).length;
        const emote = emotes[id];
        return (
          <li
            key={id}
            className={`player ${isCurrent ? 'player-current' : ''} ${p.connected ? '' : 'player-off'} ${id === view.you ? 'player-me' : ''}`}
            style={{ ['--pc' as string]: color.hex } as CSSProperties}
          >
            <div className="player-line">
              <Emblem colorIndex={p.colorIndex} size={18} title={`${color.name} 깃발`} />
              <span className="player-name">
                <span className="player-nick">{p.nickname}</span>
                {id === view.you && <span className="tag">나</span>}
                {emote && (
                  <span key={emote.key} className="emote-pop" aria-label={`${p.nickname}: ${emote.emote}`}>
                    {emote.emote}
                  </span>
                )}
              </span>
              {g.longestRoad.holder === id && (
                <span className="tag tag-award" title={`최장 교역로 (길 ${g.longestRoad.length}칸, 2점)`}>
                  <AwardIcon kind="longest_road" />
                </span>
              )}
              {g.largestArmy.holder === id && (
                <span className="tag tag-award" title={`최강 기사단 (기사 ${g.largestArmy.size}장, 2점)`}>
                  <AwardIcon kind="largest_army" />
                </span>
              )}
              <span title={id === view.you ? '내 승점 (숨긴 승점 카드 포함)' : '공개된 승점 (숨긴 승점 카드는 보이지 않음)'} className="stat-score">
                ★{points}
              </span>
            </div>
            <div className="player-stats">
              <MiniHand count={info.resourceTotal} kind="res" title={`자원 카드 ${info.resourceTotal}장 (종류는 본인만 봅니다)`} />
              <MiniHand count={info.devCardCount} kind="dev" title={`발전 카드 ${info.devCardCount}장`} />
              <span title={`쓴 기사 ${info.knightsPlayed}장`} className="stat-pieces">
                ⚔{info.knightsPlayed}
              </span>
              <span title={`가장 긴 길 ${info.roadLength}칸`} className="stat-pieces">
                <PieceIcon kind="road" size={13} />
                {info.roadLength}
              </span>
              {offers > 0 && (
                <span className="stat-offers" title={`열린 교환 제안 ${offers}개`}>
                  ⇄{offers}
                </span>
              )}
            </div>
            {!p.connected && <span className="off-dot" title="연결 끊김" aria-label="연결 끊김" />}
          </li>
        );
      })}
    </ul>
  );
}

/** 길·마을·도시 아이콘 (작은 선화) */
export function PieceIcon({ kind, size = 22 }: { kind: PieceKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="piece-icon">
      {kind === 'road' && (
        <g>
          <path d="M3 17 L21 7" stroke="#6b4a2a" strokeWidth="5.5" strokeLinecap="round" />
          <path d="M3 17 L21 7" stroke="#d9b07a" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M8 14.2 L9.4 16.6 M12.5 11.7 L13.9 14.1 M17 9.2 L18.4 11.6" stroke="#6b4a2a" strokeWidth="0.9" />
        </g>
      )}
      {kind === 'village' && (
        <g stroke="#3a2a1f" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M5 11 L12 5 L19 11 Z" fill="#a8402c" />
          <rect x="6.5" y="11" width="11" height="8" fill="#f2e6cc" />
          <rect x="10.5" y="14" width="3" height="5" fill="#6b4a2a" />
        </g>
      )}
      {kind === 'city' && (
        <g stroke="#3a2a1f" strokeWidth="1.2" strokeLinejoin="round">
          <rect x="3" y="12" width="12" height="8" fill="#bbb09c" />
          <path d="M2.5 12 L9 7 L15.5 12 Z" fill="#a8402c" />
          <rect x="15" y="8" width="6" height="12" fill="#c9c0ad" />
          <path d="M14.5 8 L18 3 L21.5 8 Z" fill="#a8402c" />
          <rect x="7.5" y="15" width="3" height="5" fill="#6b4a2a" />
        </g>
      )}
    </svg>
  );
}

type BuildKey = PieceKind | 'dev';

const BUILD_ITEMS: { key: BuildKey; label: string; cost: Bundle }[] = [
  { key: 'road', label: '도로', cost: PIECE_COST.road },
  { key: 'village', label: '마을', cost: PIECE_COST.village },
  { key: 'city', label: '도시', cost: PIECE_COST.city },
  { key: 'dev', label: '발전 카드', cost: DEV_COST },
];

/** 버튼 아래 재료: 아이콘과 개수. 모자란 재료는 흐리게 */
function CostRow({ cost, have }: { cost: Bundle; have: Bundle }) {
  const lack = shortfall(have, cost);
  return (
    <span className="bb-cost">
      {RESOURCES.filter((r) => cost[r] > 0).map((r) => (
        <span key={r} className={`bb-res ${lack[r] ? 'bb-lack' : ''}`} title={`${RESOURCE_LABEL[r]} ${cost[r]}${lack[r] ? ` (${lack[r]} 모자람)` : ''}`}>
          <ResourceIcon kind={r} size={15} />
          <b>{cost[r]}</b>
        </span>
      ))}
    </span>
  );
}

/**
 * 손 카드 옆의 네모 버튼 네 개: [도로] [마을] [도시] [발전 카드].
 * 도로·마을·도시는 누르면 지을 수 있는 자리가 빛나고 그 자리를 누르면 바로 짓는다. 발전 카드는 누르면 바로 산다.
 * 못 하는 까닭은 마우스를 올리거나 누르면 버튼 위 말풍선으로 짧게 알려 준다.
 */
export function BuildBar({ view, buildMode, onBuild }: { view: RoomView; buildMode: PieceKind | null; onBuild: (kind: PieceKind | null) => void }) {
  const g = view.game!;
  const [tip, setTip] = useState<{ key: BuildKey; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const t = window.setTimeout(() => setTip(null), 2200);
    return () => window.clearTimeout(t);
  }, [tip]);
  if (g.phase !== 'playing') return null;
  return (
    <div className="build-bar" role="group" aria-label="건설과 발전 카드">
      {BUILD_ITEMS.map((item) => {
        const active = item.key !== 'dev' && buildMode === item.key;
        const blocker = active ? null : item.key === 'dev' ? buyDevBlocker(view) : buildBlocker(view, item.key);
        const left =
          item.key === 'dev'
            ? `남은 카드 ${g.devDeckCount}장`
            : `${PIECE_LIMIT[item.key] - pieceCount(g.buildings, g.roads, view.you, item.key)}개 남음${PIECE_POINTS[item.key] ? ` · ${PIECE_POINTS[item.key]}점` : ''}`;
        return (
          <div key={item.key} className="bb-slot">
            <button
              type="button"
              className={`bb-btn bb-${item.key} ${blocker ? 'is-blocked' : ''} ${active ? 'is-active' : ''}`}
              aria-disabled={!!blocker || busy}
              aria-pressed={item.key === 'dev' ? undefined : active}
              aria-label={`${item.label}${active ? ' 그만두기' : ''}${blocker ? ` (${blocker})` : ''}`}
              onClick={async () => {
                if (active) return onBuild(null);
                if (blocker) return setTip({ key: item.key, n: Date.now() });
                if (item.key !== 'dev') return onBuild(item.key);
                if (busy) return;
                setBusy(true);
                try {
                  await sendAction({ type: 'buy_dev' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="bb-ico">{item.key === 'dev' ? <DevIcon kind="knight" size={26} /> : <PieceIcon kind={item.key} size={26} />}</span>
              <span className="bb-name">{active ? '그만두기' : item.label}</span>
              <CostRow cost={item.cost} have={g.myResources} />
            </button>
            <span className={`bb-tip ${tip?.key === item.key ? 'bb-tip-show' : ''}`} role={tip?.key === item.key ? 'status' : undefined}>
              {blocker ?? (active ? '빛나는 자리를 누르면 짓습니다' : left)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 건설 버튼 줄 옆의 큰 버튼: 굴리기 단계에는 주사위 굴리기, 그 밖에는 교환과 턴 종료 */
export function ActionBar({ view, tradeOpen, onTrade }: { view: RoomView; tradeOpen: boolean; onTrade: () => void }) {
  const g = view.game!;
  const mine = isMyTurn(view);
  const [rolling, setRolling] = useState(false);
  useEffect(() => setRolling(false), [g.turn, g.dice?.[0], g.dice?.[1]]);

  if (g.phase !== 'playing') return null;
  if (mine && g.step === 'roll') {
    return (
      <div className="actions actions-roll">
        <ActionButton
          className="btn btn-primary act act-roll"
          label={rolling ? '굴리는 중…' : '주사위 굴리기'}
          blocker={null}
          onClick={async () => {
            setRolling(true);
            // 3D 주사위를 던지고 서버에 굴리기를 보낸다 (주사위는 값이 오기 전부터 날아간다).
            if (!(await throwDice())) setRolling(false);
          }}
          icon={
            <span className="act-ico dice-ico">
              <DieFace value={5} size={20} />
              <DieFace value={2} size={20} />
            </span>
          }
        />
      </div>
    );
  }
  const endBlocker = turnBlocker(view);
  return (
    <div className="actions">
      <ActionButton
        className={`btn act act-trade ${canBankNow(view) ? 'act-bankable' : ''}`}
        label="교환"
        active={tradeOpen}
        blocker={tradeOpen ? null : tradeButtonBlocker(view)}
        onClick={onTrade}
        icon={
          <span className="act-ico">
            ⇄{canBankNow(view) && <i className="act-dot" title="은행·교역로와 바로 바꿀 수 있는 자원이 있습니다" aria-label="은행 교환 가능" />}
          </span>
        }
      />
      <ActionButton
        className="btn act act-end"
        label="턴 종료"
        blocker={endBlocker}
        onClick={() => sendAction({ type: 'end_turn' })}
        icon={<span className="act-ico">⏭</span>}
      />
    </div>
  );
}

export { DEV_LABEL };
