import { useEffect, useState, type ReactNode } from 'react';
import { CONTRACTS, RESOURCES, RESOURCE_LABEL } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { ContractId } from '../../shared/types';
import { playerColor } from '../theme';
import { Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import {
  buildBlocker,
  bundleText,
  deliverBlocker,
  isMyTurn,
  marketBlocker,
  tradeBlocker,
  type PlayerInfo,
} from './derive';
import { ActionButton, ResourceAmount, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

export function TopBar({ view, players, onMenu }: { view: RoomView; players: Players; onMenu: () => void }) {
  const g = view.game!;
  const current = g.currentPlayerId ? players.get(g.currentPlayerId) : null;
  const placing = g.placementPlayerId ? players.get(g.placementPlayerId) : null;
  const mine = isMyTurn(view);
  let status: ReactNode;
  if (g.phase === 'placement' && placing) {
    status =
      g.placementPlayerId === view.you ? (
        <b className="turn-me">내가 시작 거점을 놓을 차례</b>
      ) : (
        <span>
          <Emblem colorIndex={placing.colorIndex} size={14} /> {josa(placing.nickname, '이/가')} 시작 거점을 고르는 중
        </span>
      );
  } else if (g.phase === 'playing' && current) {
    status = mine ? (
      <b className="turn-me">
        내 차례 · 행동 {g.actionsLeft}/{2} 남음
      </b>
    ) : (
      <span>
        <Emblem colorIndex={current.colorIndex} size={14} /> {current.nickname}의 차례 · 행동 {g.actionsLeft}회 남음
        {!current.connected && <em className="warn-text"> (연결 끊김 — 다시 접속할 때까지 기다립니다)</em>}
      </span>
    );
  } else if (g.phase === 'finished') {
    status = <b>게임 종료</b>;
  }

  return (
    <div className="topbar">
      <div className="topbar-row">
        <div className="round-chip" aria-label={g.phase === 'placement' ? '시작 배치' : `${g.round}/${g.totalRounds} 라운드`}>
          {g.phase === 'placement' ? '시작 배치' : `${g.round}/${g.totalRounds}R`}
        </div>
        <ForecastStrip view={view} />
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="메뉴 열기">
          ☰
        </button>
      </div>
      <div className="turn-line">{status}</div>
    </div>
  );
}

function ForecastStrip({ view }: { view: RoomView }) {
  const g = view.game!;
  return (
    <ol className="forecast" aria-label="라운드별 예보">
      {g.forecast.map((r, i) => {
        const round = i + 1;
        const state = round === g.round ? 'now' : round === g.round + 1 || (g.phase === 'placement' && round === 1) ? 'next' : round < g.round ? 'past' : '';
        return (
          <li key={i} className={`fc fc-${state}`} title={`${round}라운드 예보: ${RESOURCE_LABEL[r]}`}>
            <ResourceIcon kind={r} size={18} />
            <span className="fc-n">{round}</span>
            {state === 'now' && <span className="fc-tag">이번</span>}
            {state === 'next' && <span className="fc-tag">다음</span>}
          </li>
        );
      })}
    </ol>
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
              {g.firstPlayerId === id && <span className="tag tag-first" title="이번 라운드 선 플레이어">선</span>}
            </span>
            <span className="player-stats">
              <span title="납품 점수" className="stat-score">★{info.score}</span>
              <span title="보유 자원 총량 (종류별 수량은 비공개)">자원 {info.resourceTotal}</span>
              <span title="거점 수">거점 {info.settlementCount}</span>
            </span>
            {!p.connected && <span className="off-dot" title="연결 끊김" aria-label="연결 끊김" />}
          </li>
        );
      })}
    </ul>
  );
}

export function ContractsPanel({ view, players, compact }: { view: RoomView; players: Players; compact: boolean }) {
  const g = view.game!;
  return (
    <div className={`contracts ${compact ? 'contracts-compact' : ''}`} aria-label="공개 계약">
      {CONTRACTS.map((c) => {
        const status = g.contracts.find((x) => x.id === c.id);
        const doneBy = status?.completedBy ? players.get(status.completedBy) : null;
        const blocker = deliverBlocker(view, c.id as ContractId);
        const canDeliver = !blocker;
        return (
          <div key={c.id} className={`contract ${doneBy ? 'contract-done' : ''} ${canDeliver ? 'contract-ready' : ''}`}>
            <div className="contract-head">
              <span className="contract-name">{c.name}</span>
              <span className="contract-pts">{c.points}점</span>
            </div>
            <div className="contract-cost" aria-label={`필요: ${bundleText(c.cost)}`}>
              {RESOURCES.filter((r) => c.cost[r] > 0).map((r) => (
                <ResourceAmount key={r} resource={r} amount={c.cost[r]} size={compact ? 16 : 18} />
              ))}
            </div>
            {doneBy ? (
              <div className="contract-status">
                <Emblem colorIndex={doneBy.colorIndex} size={12} /> {doneBy.id === view.you ? '내가' : doneBy.nickname} 완료
              </div>
            ) : g.phase === 'playing' && g.currentPlayerId === view.you ? (
              <ActionButton
                className="btn btn-small btn-deliver"
                label="납품"
                blocker={blocker}
                onClick={() => sendAction({ type: 'deliver', contractId: c.id })}
              />
            ) : (
              <div className="contract-status open">열림</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MyResources({ view }: { view: RoomView }) {
  const r = view.game!.myResources;
  return (
    <div className="my-res" aria-label="내 자원">
      {RESOURCES.map((k) => (
        <div key={k} className={`my-res-item res-${k}`}>
          <ResourceIcon kind={k} size={26} />
          <div>
            <b>{r[k]}</b>
            <span>{RESOURCE_LABEL[k]}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ActionBar({
  view,
  buildMode,
  onToggleBuild,
  onMarket,
  onTrade,
}: {
  view: RoomView;
  buildMode: boolean;
  onToggleBuild: () => void;
  onMarket: () => void;
  onTrade: () => void;
}) {
  const g = view.game!;
  const mine = isMyTurn(view);
  const [confirmEnd, setConfirmEnd] = useState(false);
  useEffect(() => {
    if (!confirmEnd) return;
    const t = window.setTimeout(() => setConfirmEnd(false), 3500);
    return () => window.clearTimeout(t);
  }, [confirmEnd]);
  useEffect(() => setConfirmEnd(false), [g.currentPlayerId, g.round]);

  if (g.phase !== 'playing') return null;
  const endBlocker = mine ? null : '내 차례가 아닙니다.';
  return (
    <div className="actions">
      <ActionButton
        className="btn act"
        label={buildMode ? '건설 취소' : '거점 건설'}
        active={buildMode}
        blocker={buildMode ? null : buildBlocker(view)}
        onClick={onToggleBuild}
        icon={<span className="act-ico">⌂</span>}
      />
      <ActionButton className="btn act" label="시장 교환" blocker={marketBlocker(view)} onClick={onMarket} icon={<ResourceIcon kind="market" size={18} />} />
      <ActionButton className="btn act" label="교환 제안" blocker={tradeBlocker(view)} onClick={onTrade} icon={<span className="act-ico">⇄</span>} />
      <ActionButton
        className={`btn act act-end ${mine && g.actionsLeft === 0 ? 'pulse' : ''} ${confirmEnd ? 'act-confirm' : ''}`}
        label={confirmEnd ? `정말 끝내기 (행동 ${g.actionsLeft}회 남음)` : '턴 종료'}
        blocker={endBlocker}
        onClick={async () => {
          if (g.actionsLeft > 0 && !confirmEnd) {
            setConfirmEnd(true);
            return;
          }
          setConfirmEnd(false);
          await sendAction({ type: 'end_turn' });
        }}
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
      {from?.nickname} → {to?.nickname} 교환 제안 중 (내용은 두 사람에게만 보입니다)
    </div>
  );
}
