import { useMemo, useState } from 'react';
import {
  BUILD_COST,
  MARKET_GET,
  MARKET_GIVE,
  MAX_TRADE_AMOUNT,
  RESOURCES,
  RESOURCE_LABEL,
  TILE_KIND_LABEL,
  TILE_MAP,
  emptyBundle,
} from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableTiles, placeableTiles, validateTradeBundles } from '../../shared/rules';
import type { Bundle, Resource } from '../../shared/types';
import { client } from '../net/client';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { CrownIcon, Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import { RulesSummary } from '../ui/RulesSummary';
import { showToast } from '../ui/toast';
import { buildBlocker, bundleText, formatEvent, type PlayerInfo } from './derive';
import { ActionButton, Sheet, Stepper, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

export function MarketDialog({ view, onClose }: { view: RoomView; onClose: () => void }) {
  const mine = view.game!.myResources;
  const firstGive = RESOURCES.find((r) => mine[r] >= MARKET_GIVE) ?? null;
  const [give, setGive] = useState<Resource | null>(firstGive);
  const [get, setGet] = useState<Resource | null>(null);
  return (
    <Sheet title="시장 교환" onClose={onClose}>
      <p className="muted small">같은 종류 자원 {MARKET_GIVE}개를 내고 다른 종류 {MARKET_GET}개를 받습니다. 행동 1회를 씁니다.</p>
      <div className="pick-label">낼 자원 ({MARKET_GIVE}개)</div>
      <div className="pick-row">
        {RESOURCES.map((r) => (
          <button
            key={r}
            className={`pick ${give === r ? 'pick-on' : ''}`}
            disabled={mine[r] < MARKET_GIVE}
            onClick={() => {
              setGive(r);
              if (get === r) setGet(null);
            }}
          >
            <ResourceIcon kind={r} size={26} />
            {RESOURCE_LABEL[r]}
            <small>보유 {mine[r]}</small>
          </button>
        ))}
      </div>
      <div className="pick-label">받을 자원 ({MARKET_GET}개)</div>
      <div className="pick-row">
        {RESOURCES.map((r) => (
          <button key={r} className={`pick ${get === r ? 'pick-on' : ''}`} disabled={r === give} onClick={() => setGet(r)}>
            <ResourceIcon kind={r} size={26} />
            {RESOURCE_LABEL[r]}
          </button>
        ))}
      </div>
      <ActionButton
        className="btn btn-primary btn-wide"
        label={give && get ? `${RESOURCE_LABEL[give]} ${MARKET_GIVE}개 → ${RESOURCE_LABEL[get]} ${MARKET_GET}개로 교환` : '자원을 고르세요'}
        blocker={!give || !get ? '낼 자원과 받을 자원을 고르세요.' : null}
        onClick={async () => {
          if (!give || !get) return;
          if (await sendAction({ type: 'market', give, get })) onClose();
        }}
      />
    </Sheet>
  );
}

export function TradeDialog({ view, players, onClose }: { view: RoomView; players: Players; onClose: () => void }) {
  const g = view.game!;
  const others = g.order.filter((id) => id !== view.you);
  const [to, setTo] = useState<string | null>(others.length === 1 ? others[0] : null);
  const [give, setGive] = useState<Bundle>(emptyBundle());
  const [get, setGet] = useState<Bundle>(emptyBundle());
  const problem = !to ? '교환할 상대를 고르세요.' : validateTradeBundles(give, get);
  const target = to ? players.get(to) : null;
  const targetTotal = to ? (g.players.find((p) => p.id === to)?.resourceTotal ?? 0) : 0;

  return (
    <Sheet title="플레이어와 교환" onClose={onClose}>
      <p className="muted small">
        상대 한 명에게 줄 자원과 받을 자원을 제안합니다. 상대가 수락하면 양쪽 자원이 옮겨지고 내 행동 1회를 씁니다. 거절·취소는 행동을 쓰지
        않습니다.
      </p>
      <div className="pick-label">상대</div>
      <div className="pick-row">
        {others.map((id) => {
          const p = players.get(id)!;
          return (
            <button key={id} className={`pick pick-player ${to === id ? 'pick-on' : ''}`} onClick={() => setTo(id)}>
              <Emblem colorIndex={p.colorIndex} size={20} />
              {p.nickname}
              <small>
                자원 {g.players.find((x) => x.id === id)?.resourceTotal ?? 0}개{!p.connected ? ' · 연결 끊김' : ''}
              </small>
            </button>
          );
        })}
      </div>
      <div className="trade-grid">
        <div>
          <div className="pick-label">내가 줄 자원</div>
          {RESOURCES.map((r) => (
            <div key={r} className="trade-row">
              <ResourceIcon kind={r} size={22} />
              <span>
                {RESOURCE_LABEL[r]} <small className="muted">(보유 {g.myResources[r]})</small>
              </span>
              <Stepper
                label={`줄 ${RESOURCE_LABEL[r]}`}
                value={give[r]}
                max={Math.min(MAX_TRADE_AMOUNT, g.myResources[r])}
                disabled={get[r] > 0}
                onChange={(v) => setGive({ ...give, [r]: v })}
              />
            </div>
          ))}
        </div>
        <div>
          <div className="pick-label">내가 받을 자원</div>
          {RESOURCES.map((r) => (
            <div key={r} className="trade-row">
              <ResourceIcon kind={r} size={22} />
              <span>{RESOURCE_LABEL[r]}</span>
              <Stepper
                label={`받을 ${RESOURCE_LABEL[r]}`}
                value={get[r]}
                max={MAX_TRADE_AMOUNT}
                disabled={give[r] > 0}
                onChange={(v) => setGet({ ...get, [r]: v })}
              />
            </div>
          ))}
        </div>
      </div>
      <p className="small muted">같은 종류를 양쪽에 함께 넣을 수 없습니다. 상대가 가진 종류별 수량은 보이지 않습니다{target ? ` (${target.nickname}의 자원 총량 ${targetTotal}개)` : ''}.</p>
      {problem && <div className="small warn-text">{problem}</div>}
      <ActionButton
        className="btn btn-primary btn-wide"
        label={to && !problem ? `${target?.nickname}에게 제안 보내기` : '제안 보내기'}
        blocker={problem}
        onClick={async () => {
          if (!to) return;
          if (await sendAction({ type: 'trade_propose', to, give, get })) {
            showToast(`${target?.nickname}에게 교환을 제안했습니다.`, 'good');
            onClose();
          }
        }}
      />
    </Sheet>
  );
}

/** 타일을 눌렀을 때 나오는 정보 카드. 시작 배치·건설 버튼을 함께 보여 준다. */
export function TileCard({
  view,
  players,
  tileId,
  buildMode,
  onClose,
  onDone,
}: {
  view: RoomView;
  players: Players;
  tileId: string;
  buildMode: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const g = view.game!;
  const tile = TILE_MAP[tileId];
  const settlement = g.settlements.find((s) => s.tileId === tileId);
  const owner = settlement ? players.get(settlement.owner) : null;
  const canPlace = g.phase === 'placement' && g.placementPlayerId === view.you && placeableTiles(g.settlements).includes(tileId);
  const buildable = buildableTiles(g.settlements, view.you).includes(tileId);
  const blocker = buildBlocker(view);
  const forecastNow = g.phase === 'playing' ? g.forecast[g.round - 1] : g.forecast[0];

  let info: string;
  if (tile.kind === 'market') info = '시장: 누구나 위치와 관계없이 같은 종류 2개를 다른 종류 1개로 바꿀 수 있습니다. 거점은 놓을 수 없습니다.';
  else if (owner && settlement)
    info = `${owner.id === view.you ? '내' : `${owner.nickname}의`} 거점. 라운드마다 ${RESOURCE_LABEL[tile.kind]} 1개, 예보가 ${RESOURCE_LABEL[tile.kind]}인 라운드에는 2개를 생산합니다.${
      settlement.builtRound === g.round && g.phase === 'playing' && settlement.builtRound > 0 ? ' 이번 라운드에 지어서 다음 라운드부터 생산합니다.' : ''
    }`;
  else info = `빈 ${RESOURCE_LABEL[tile.kind]} 칸. 거점을 두면 라운드마다 ${RESOURCE_LABEL[tile.kind]}을(를) 생산합니다.`;

  return (
    <div className="tile-card" role="dialog" aria-label={`${tileId} 칸 정보`}>
      <div className="tile-card-head">
        <ResourceIcon kind={tile.kind} size={22} />
        <b>
          {tileId} · {TILE_KIND_LABEL[tile.kind]}
        </b>
        {owner && <Emblem colorIndex={owner.colorIndex} size={16} title={`${owner.nickname}의 거점`} />}
        {tile.kind !== 'market' && tile.kind === forecastNow && <span className="tag tag-first">{g.phase === 'placement' ? '1라운드 예보' : '이번 예보'}</span>}
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <p className="small">{info}</p>
      {canPlace && (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`${tileId}에 시작 거점 놓기`}
          blocker={null}
          onClick={async () => {
            if (await sendAction({ type: 'place', tileId })) onDone();
          }}
        />
      )}
      {g.phase === 'playing' && g.currentPlayerId === view.you && !settlement && tile.kind !== 'market' && (buildMode || buildable) && (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`${tileId}에 거점 짓기 (목재 ${BUILD_COST.wood} + 석재 ${BUILD_COST.stone})`}
          blocker={blocker ?? (buildable ? null : '내 거점과 변을 맞댄 칸에만 지을 수 있습니다.')}
          onClick={async () => {
            if (await sendAction({ type: 'build', tileId })) onDone();
          }}
        />
      )}
    </div>
  );
}

export interface GameSettings {
  quality: 'auto' | 'high' | 'low';
  labels: boolean;
  flat: boolean;
  perf: boolean;
}

export function MenuDialog({
  view,
  players,
  settings,
  onSettings,
  onResetView,
  onClose,
}: {
  view: RoomView;
  players: Players;
  settings: GameSettings;
  onSettings: (s: GameSettings) => void;
  onResetView: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'log' | 'settings' | 'rules'>('log');
  const events = view.game?.events ?? [];
  return (
    <Sheet title={`방 ${view.code}`} onClose={onClose} wide>
      <div className="tabs" role="tablist">
        {(
          [
            ['log', '기록'],
            ['settings', '설정'],
            ['rules', '규칙'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab-on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'log' && (
        <ol className="log">
          {[...events].reverse().map((e) => (
            <li key={e.seq}>
              <span className="log-round">{e.round > 0 ? `${e.round}R` : '배치'}</span> {formatEvent(e, players, view.you)}
            </li>
          ))}
        </ol>
      )}
      {tab === 'settings' && (
        <div className="settings">
          <label>
            그래픽 품질{' '}
            <select value={settings.quality} onChange={(e) => onSettings({ ...settings, quality: e.target.value as GameSettings['quality'] })}>
              <option value="auto">자동 (느리면 내부 해상도를 낮춤)</option>
              <option value="high">높음</option>
              <option value="low">낮음 (배터리 절약)</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={settings.labels} onChange={(e) => onSettings({ ...settings, labels: e.target.checked })} /> 칸 이름(A1~D4)
            표시
          </label>
          <label>
            <input type="checkbox" checked={settings.flat} onChange={(e) => onSettings({ ...settings, flat: e.target.checked })} /> 2D 보드로 보기 (3D가
            느리거나 보이지 않을 때)
          </label>
          <label>
            <input type="checkbox" checked={settings.perf} onChange={(e) => onSettings({ ...settings, perf: e.target.checked })} /> 프레임 시간 표시
          </label>
          <div className="row-buttons">
            <button
              className="btn btn-small"
              onClick={() => {
                onResetView();
                onClose();
              }}
            >
              보드 전체 보기
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                if (!window.confirm('처음 화면으로 갈까요? 자리는 그대로 남아 있어 같은 링크로 다시 돌아올 수 있습니다.')) return;
                client.detach();
                navigate('/');
              }}
            >
              처음 화면으로
            </button>
          </div>
        </div>
      )}
      {tab === 'rules' && <RulesSummary open />}
    </Sheet>
  );
}

export function ResultOverlay({ view, players, onClose }: { view: RoomView; players: Players; onClose: () => void }) {
  const result = view.game!.result!;
  const isHost = view.hostId === view.you;
  const winners = result.winners.map((id) => players.get(id)?.nickname ?? '?');
  const tiedTop = useMemo(() => {
    const top = Math.max(...result.ranking.map((e) => e.score));
    return result.ranking.filter((e) => e.score === top).length > 1;
  }, [result]);
  return (
    <div className="result-backdrop">
      <div className="result card" role="dialog" aria-label="게임 결과">
        <div className="result-crown">
          <CrownIcon size={42} />
        </div>
        <h1>{result.decidedBy === 'joint' ? `공동 승리: ${winners.join(', ')}` : `${josa(winners[0], '이/가')} 이겼습니다!`}</h1>
        <p className="muted small">
          {result.decidedBy === 'score' && '6라운드 동안 납품 점수가 가장 높았습니다.'}
          {result.decidedBy === 'resources' && '최고 점수가 같아 남은 자원 총량이 많은 사람이 이겼습니다.'}
          {result.decidedBy === 'joint' && '최고 점수와 남은 자원 총량이 모두 같아 공동 승리입니다.'}
        </p>
        <table className="result-table">
          <thead>
            <tr>
              <th>순위</th>
              <th>플레이어</th>
              <th>납품 점수</th>
              <th>남은 자원{tiedTop ? ' (동점 판정)' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {result.ranking.map((e) => {
              const p = players.get(e.playerId);
              return (
                <tr key={e.playerId} className={e.rank === 1 ? 'winner' : ''}>
                  <td>{e.rank}위</td>
                  <td>
                    <Emblem colorIndex={p?.colorIndex ?? 0} size={16} /> {p?.nickname}
                    {e.playerId === view.you && <span className="tag">나</span>}
                  </td>
                  <td>{e.score}점</td>
                  <td>{e.resourceTotal}개</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row-buttons">
          <button className="btn" onClick={onClose}>
            보드 보기
          </button>
          {isHost ? (
            <ActionButton
              className="btn btn-primary"
              label="같은 멤버로 새 게임 준비"
              blocker={null}
              onClick={async () => {
                const res = await client.rematch();
                if (!res.ok) showToast(res.error, 'error');
              }}
            />
          ) : (
            <span className="small muted">방장이 새 게임을 준비하면 대기실로 이동합니다.</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlacementBanner({ view, players }: { view: RoomView; players: Players }) {
  const g = view.game!;
  if (g.phase !== 'placement') return null;
  const mine = g.placementPlayerId === view.you;
  return (
    <div className={`placement-banner ${mine ? 'placement-mine' : ''}`}>
      {mine ? (
        <b>빛나는 빈 생산 칸을 눌러 시작 거점을 놓으세요.</b>
      ) : (
        <span>{josa(players.get(g.placementPlayerId ?? '')?.nickname ?? '?', '이/가')} 시작 거점을 고르는 중입니다.</span>
      )}
      <div className="small">
        배치 순서(마지막 자리부터):{' '}
        {g.placementOrder.map((id, i) => {
          const p = players.get(id);
          const done = i < g.settlements.length;
          return (
            <span key={id} className={`po ${done ? 'po-done' : ''} ${id === g.placementPlayerId ? 'po-now' : ''}`}>
              <Emblem colorIndex={p?.colorIndex ?? 0} size={12} /> {p?.nickname}
              {i < g.placementOrder.length - 1 ? ' → ' : ''}
            </span>
          );
        })}
      </div>
      <div className="small muted">시작 자원: 목재·곡물·석재 1개씩 · 1라운드 예보: {RESOURCE_LABEL[g.forecast[0]]}</div>
    </div>
  );
}

export function colorOf(players: Players, id: string): string {
  return playerColor(players.get(id)?.colorIndex ?? 0).hex;
}

export { bundleText };
