import { MiniHand } from './hand';
import { useEffect, useState } from 'react';
import { DEV_LABEL, PIECE_COST, PIECE_LABEL, PIECE_LIMIT, PIECE_POINTS, RESOURCES, RESOURCE_LABEL, WIN_POINTS } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { pieceCount } from '../../shared/rules';
import type { PieceKind } from '../../shared/types';
import { playerColor } from '../theme';
import { Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import { showToast } from '../ui/toast';
import { bankBlocker, buildBlocker, bundleText, isMyTurn, playDevBlocker, tradeBlocker, turnBlocker, type PlayerInfo } from './derive';
import { ActionButton, ResourceAmount, sendAction } from './ui';

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

export function PlayersPanel({ view, players }: { view: RoomView; players: Players }) {
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
        return (
          <li
            key={id}
            className={`player ${isCurrent ? 'player-current' : ''} ${p.connected ? '' : 'player-off'}`}
            style={{ borderColor: isCurrent ? color.hex : undefined }}
          >
            <Emblem colorIndex={p.colorIndex} size={18} title={`${color.name} 깃발`} />
            <span className="player-name">
              {p.nickname}
              {id === view.you && <span className="tag">나</span>}
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
            </span>
            <span className="player-stats">
              <span
                title={id === view.you ? '내 승점 (숨긴 승점 카드 포함)' : '공개된 승점 (숨긴 승점 카드는 보이지 않음)'}
                className="stat-score"
              >
                ★{points}
              </span>
              <MiniHand count={info.resourceTotal} kind="res" title={`자원 카드 ${info.resourceTotal}장 (종류는 본인만 봅니다)`} />
              <MiniHand count={info.devCardCount} kind="dev" title={`발전 카드 ${info.devCardCount}장`} />
              <span title={`쓴 기사 ${info.knightsPlayed}장 · 가장 긴 길 ${info.roadLength}칸`} className="stat-pieces">
                ⚔{info.knightsPlayed} <PieceIcon kind="road" size={13} />
                {info.roadLength}
              </span>
            </span>
            {!p.connected && <span className="off-dot" title="연결 끊김" aria-label="연결 끊김" />}
          </li>
        );
      })}
    </ul>
  );
}

export function MyResources({ view }: { view: RoomView }) {
  const g = view.game!;
  const r = g.myResources;
  return (
    <div className="my-res" aria-label="내 자원">
      {RESOURCES.map((k) => (
        <div key={k} className={`my-res-item res-${k}`}>
          <ResourceIcon kind={k} size={22} />
          <div>
            <b>{r[k]}</b>
            <span>
              {RESOURCE_LABEL[k]}
              {g.myTradeRatios[k] < 4 && <em className="ratio-tag"> {g.myTradeRatios[k]}:1</em>}
            </span>
          </div>
        </div>
      ))}
    </div>
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

/** 건설 메뉴: 길·마을·도시 중 무엇을 지을지 고른다. 비용과 가진 개수, 못 짓는 이유를 함께 보여 준다. */
export function BuildMenu({ view, onPick, onClose }: { view: RoomView; onPick: (kind: PieceKind) => void; onClose: () => void }) {
  const g = view.game!;
  return (
    <div className="tile-card build-menu" role="dialog" aria-label="건설">
      <div className="tile-card-head">
        <b>무엇을 지을까요?</b>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <div className="pick-row">
        {(['road', 'village', 'city'] as const).map((kind) => {
          const blocker = buildBlocker(view, kind);
          const have = pieceCount(g.buildings, g.roads, view.you, kind);
          return (
            <button
              key={kind}
              className={`pick build-pick ${blocker ? 'is-blocked' : ''}`}
              aria-disabled={!!blocker}
              title={blocker ?? undefined}
              onClick={() => (blocker ? showToast(blocker, 'warn') : onPick(kind))}
            >
              <PieceIcon kind={kind} size={28} />
              {PIECE_LABEL[kind]}
              <span className="build-cost">
                {RESOURCES.filter((r) => PIECE_COST[kind][r] > 0).map((r) => (
                  <ResourceAmount key={r} resource={r} amount={PIECE_COST[kind][r]} size={15} />
                ))}
              </span>
              <small>
                {have}/{PIECE_LIMIT[kind]} · {PIECE_POINTS[kind] ? `${PIECE_POINTS[kind]}점` : '점수 없음'}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ActionBar({
  view,
  buildMode,
  menuOpen,
  onToggleBuild,
  onTrade,
  onDev,
}: {
  view: RoomView;
  buildMode: PieceKind | null;
  menuOpen: boolean;
  onToggleBuild: () => void;
  onTrade: () => void;
  onDev: () => void;
}) {
  const g = view.game!;
  const mine = isMyTurn(view);
  const [rolling, setRolling] = useState(false);
  useEffect(() => setRolling(false), [g.turn, g.dice?.[0], g.dice?.[1]]);

  if (g.phase !== 'playing') return null;
  const devCount = g.myDevCards.length;
  const devPlayable = (['knight', 'road_building', 'year_of_plenty', 'monopoly'] as const).some((k) => !playDevBlocker(view, k));
  if (mine && g.step === 'roll') {
    return (
      <div className="actions actions-roll">
        <ActionButton
          className="btn btn-primary act act-roll"
          label={rolling ? '굴리는 중…' : '주사위 굴리기'}
          blocker={null}
          onClick={async () => {
            setRolling(true);
            if (!(await sendAction({ type: 'roll' }))) setRolling(false);
          }}
          icon={
            <span className="act-ico dice-ico">
              <DieFace value={5} size={20} />
              <DieFace value={2} size={20} />
            </span>
          }
        />
        <ActionButton
          className={`btn act ${devPlayable ? 'pulse-soft' : ''}`}
          label={`발전 카드 ${devCount}`}
          blocker={mine ? null : '내 차례가 아닙니다.'}
          onClick={onDev}
          icon={<span className="act-ico">🂠</span>}
        />
      </div>
    );
  }
  const endBlocker = turnBlocker(view);
  return (
    <div className="actions">
      <ActionButton
        className="btn act"
        label={buildMode ? `${PIECE_LABEL[buildMode]} 취소` : '건설'}
        active={!!buildMode || menuOpen}
        blocker={buildMode || menuOpen ? null : turnBlocker(view)}
        onClick={onToggleBuild}
        icon={<PieceIcon kind={buildMode ?? 'village'} size={20} />}
      />
      <ActionButton
        className="btn act"
        label="교환"
        blocker={bankBlocker(view) && tradeBlocker(view) ? turnBlocker(view) ?? null : null}
        onClick={onTrade}
        icon={<span className="act-ico">⇄</span>}
      />
      <ActionButton
        className={`btn act ${devPlayable ? 'pulse-soft' : ''}`}
        label={`발전 카드 ${devCount}`}
        blocker={g.currentPlayerId === view.you ? null : '내 차례가 아닙니다.'}
        onClick={onDev}
        icon={<span className="act-ico">🂠</span>}
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

export function TradeBanner({ view, players }: { view: RoomView; players: Players }) {
  const g = view.game!;
  const t = g.trade;
  if (!t) return null;
  const from = players.get(t.from);
  const to = players.get(t.to);
  if (t.to === view.you && t.give && t.get) {
    const lacking = RESOURCES.filter((r) => g.myResources[r] < t.get![r]);
    return (
      <div className="trade-banner trade-incoming" role="alertdialog" aria-label="교환 제안 도착">
        <div className="trade-title">
          <Emblem colorIndex={from?.colorIndex ?? 0} size={16} /> {from?.nickname}의 교환 제안
        </div>
        <div className="trade-lines">
          <div>
            내가 받음: <b>{bundleText(t.give)}</b>
          </div>
          <div>
            내가 줌: <b>{bundleText(t.get)}</b>
          </div>
        </div>
        {lacking.length > 0 && (
          <div className="warn-text small">{lacking.map((r) => RESOURCE_LABEL[r]).join(', ')}이(가) 부족해 수락할 수 없습니다.</div>
        )}
        <div className="row-buttons">
          <ActionButton
            className="btn btn-primary"
            label="수락"
            blocker={lacking.length ? '요청받은 자원이 부족합니다.' : null}
            onClick={() => sendAction({ type: 'trade_accept', tradeId: t.id })}
          />
          <ActionButton className="btn" label="거절" blocker={null} onClick={() => sendAction({ type: 'trade_reject', tradeId: t.id })} />
        </div>
      </div>
    );
  }
  if (t.from === view.you && t.give && t.get) {
    return (
      <div className="trade-banner trade-outgoing">
        <div className="trade-title">
          {to?.nickname}에게 교환 제안 중 · 응답을 기다리는 중
          {to && !to.connected && <em className="warn-text"> (상대 연결 끊김)</em>}
        </div>
        <div className="trade-lines">
          <div>
            내가 줌: <b>{bundleText(t.give)}</b>
          </div>
          <div>
            내가 받음: <b>{bundleText(t.get)}</b>
          </div>
        </div>
        <div className="row-buttons">
          <ActionButton className="btn btn-small" label="제안 취소" blocker={null} onClick={() => sendAction({ type: 'trade_cancel', tradeId: t.id })} />
        </div>
      </div>
    );
  }
  return (
    <div className="trade-banner trade-other">
      {josa(from?.nickname ?? '?', '이/가')} {to?.nickname}에게 교환을 제안하는 중 (내용은 두 사람에게만 보입니다)
    </div>
  );
}

export { DEV_LABEL };
