import { Fragment, useState } from 'react';
import { DEV_HELP, DEV_LABEL, bundleTotal, RESOURCES, RESOURCE_LABEL, emptyBundle } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { Bundle, DevKind, GameAction, Resource } from '../../shared/types';
import { client } from '../net/client';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { CrownIcon, Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import { RulesSummary } from '../ui/RulesSummary';
import { showToast } from '../ui/toast';
import type { BoardSelection } from '../board/BoardRenderer';
import { DevIcon } from './hand';
import { AwardIcon } from './panels';
import { bundleText, formatEvent, playDevBlocker, spotAction, type PlayerInfo } from './derive';
import { ActionButton, Sheet, Stepper, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

/** 자원 다섯 가지를 아이콘 단추로 고른다. 고른 개수를 단추 위에 적는다. */
function ResourcePicker({ picked, onPick, label }: { picked: Resource[]; onPick: (r: Resource) => void; label: string }) {
  return (
    <div className="res-picker" role="group" aria-label={label}>
      {RESOURCES.map((r) => {
        const n = picked.filter((x) => x === r).length;
        return (
          <button key={r} type="button" className={`res-pick ${n ? 'res-pick-on' : ''}`} aria-pressed={n > 0} onClick={() => onPick(r)} title={RESOURCE_LABEL[r]}>
            <ResourceIcon kind={r} size={22} />
            <span>{RESOURCE_LABEL[r]}</span>
            {n > 1 && <b>×{n}</b>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 손에 든 발전 카드를 누르면 카드 위에 붙어 열리는 쪽지: 카드가 하는 일 한 줄과 쓰기 버튼.
 * 풍년은 받을 자원 2개, 독점은 가져올 자원 1개를 먼저 고른다. wait 동안은(주사위·동상 연출 중, game/pace.ts) 쓸 수 없다.
 */
export function DevPlayCard({ view, kind, wait = null, onClose }: { view: RoomView; kind: DevKind; wait?: string | null; onClose: () => void }) {
  const g = view.game!;
  const [picked, setPicked] = useState<Resource[]>([]);
  const total = g.myDevCards.filter((c) => c.kind === kind).length;
  const fresh = g.myDevCards.filter((c) => c.kind === kind && c.boughtTurn >= g.turn).length;
  const need = kind === 'year_of_plenty' ? 2 : kind === 'monopoly' ? 1 : 0;
  const pick = (r: Resource) => setPicked((cur) => (need === 1 ? [r] : cur.length >= need ? [r] : [...cur, r]));
  const blocker =
    wait ??
    playDevBlocker(view, kind) ??
    (picked.length < need ? (kind === 'monopoly' ? '가져올 자원을 고르세요.' : `받을 자원 ${need - picked.length}개를 더 고르세요.`) : null);
  return (
    <div className="tile-card dev-play" role="dialog" aria-label={`${DEV_LABEL[kind]} 카드`}>
      <div className="tile-card-head">
        <DevIcon kind={kind} size={22} />
        <b>{DEV_LABEL[kind]}</b>
        {total > 1 && <span className="tag">×{total}</span>}
        {fresh > 0 && <span className="tag">새 카드 {fresh}</span>}
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <p className="small">{DEV_HELP[kind]}</p>
      {need > 0 && <ResourcePicker picked={picked} onPick={pick} label={kind === 'monopoly' ? '가져올 자원' : '받을 자원 2개'} />}
      {kind !== 'victory' && (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`${DEV_LABEL[kind]} 쓰기`}
          blocker={blocker}
          onClick={async () => {
            const action: GameAction =
              kind === 'year_of_plenty'
                ? { type: 'play_dev', kind, resources: [picked[0], picked[1]] }
                : kind === 'monopoly'
                  ? { type: 'play_dev', kind, resource: picked[0] }
                  : { type: 'play_dev', kind: kind as 'knight' | 'road_building' };
            if (await sendAction(action)) onClose();
          }}
        />
      )}
    </div>
  );
}

/** 7이 나왔을 때 자원 8장 이상이면 절반(내림)을 골라 버린다 */
export function DiscardDialog({ view }: { view: RoomView }) {
  const g = view.game!;
  const need = g.discards[view.you] ?? 0;
  const [pick, setPick] = useState<Bundle>(emptyBundle());
  const chosen = bundleTotal(pick);
  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="자원 버리기">
        <div className="sheet-head">
          <h2>7! 자원 {need}장 버리기</h2>
        </div>
        <div className="sheet-body">
          <p className="small muted">자원이 보유 한도 {g.handLimit}장보다 많아 절반을 버려야 합니다. 버릴 자원을 고르세요.</p>
          {RESOURCES.map((r) => (
            <div key={r} className="trade-row">
              <ResourceIcon kind={r} size={22} />
              <span>
                {RESOURCE_LABEL[r]} <small className="muted">(보유 {g.myResources[r]})</small>
              </span>
              <Stepper label={`버릴 ${RESOURCE_LABEL[r]}`} value={pick[r]} max={g.myResources[r]} onChange={(v) => setPick({ ...pick, [r]: v })} />
            </div>
          ))}
          <ActionButton
            className="btn btn-start btn-wide"
            label={`${chosen}/${need}장 버리기`}
            blocker={chosen !== need ? `정확히 ${need}장을 고르세요.` : null}
            onClick={() => sendAction({ type: 'discard', bundle: pick })}
          />
        </div>
      </div>
    </div>
  );
}

/** 기사단 동상을 옮긴 칸에 닿은 사람 중 누구에게서 자원 1장을 빼앗을지 고른다 */
export function StealDialog({ view, players }: { view: RoomView; players: Players }) {
  const g = view.game!;
  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="자원 빼앗기">
        <div className="sheet-head">
          <h2>누구에게서 빼앗을까요?</h2>
        </div>
        <div className="sheet-body">
          <p className="small muted">기사단 동상이 선 칸에 마을·도시가 닿은 사람입니다. 고른 사람의 자원 중 1장을 무작위로 가져옵니다.</p>
          <div className="pick-row">
            {g.stealFrom.map((id) => {
              const p = players.get(id);
              const info = g.players.find((x) => x.id === id);
              return (
                <ActionButton
                  key={id}
                  className="pick pick-player"
                  label={`${p?.nickname ?? '?'} · 자원 ${info?.resourceTotal ?? 0}장`}
                  blocker={null}
                  onClick={() => sendAction({ type: 'steal', from: id })}
                  icon={<Emblem colorIndex={p?.colorIndex ?? 0} size={20} />}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 보드를 눌렀을 때 그 자리에서 할 수 있는 일(동상 옮기기, 시작 배치, 길·마을 짓기, 도시로 올리기)만 버튼으로 띄운다.
 * 할 수 있는 일이 없는 자리는 아무것도 띄우지 않는다 (칸 설명은 보드 그림과 숫자 패로 충분하다).
 */
export function SpotCard({ view, sel, onClose, onDone }: { view: RoomView; sel: BoardSelection; onClose: () => void; onDone: () => void }) {
  const act = spotAction(view, sel);
  if (!act) return null;
  return (
    <div className={`spot-actions ${act.confirm ? 'spot-confirm' : ''}`} role="dialog" aria-label={act.label}>
      <ActionButton
        className={`btn btn-primary ${act.confirm ? 'btn-check' : ''}`}
        label={act.label}
        blocker={act.blocker}
        icon={act.confirm ? <span className="check-ico" aria-hidden>✓</span> : undefined}
        onClick={async () => {
          if (await sendAction(act.action)) onDone();
        }}
      />
      <button className="icon-btn" onClick={onClose} aria-label="닫기">
        ✕
      </button>
    </div>
  );
}

export interface GameSettings {
  quality: 'auto' | 'high' | 'low';
  flat: boolean;
  perf: boolean;
  /** 보드 움직임 (바람·양·가마 연기). 저장된 값이 없으면 기기의 '동작 줄이기' 설정을 따른다. */
  motion?: boolean;
  /** 소품·조각이 바닥에 드리우는 그림자 (저장된 값이 없으면 켬) */
  shadows?: boolean;
}

/** 기기에서 '동작 줄이기'를 켰는지 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
              <span className="log-round">{e.turn > 0 ? `${e.turn}턴` : '배치'}</span> {formatEvent(e, players, view.you, view.game)}
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
            <input type="checkbox" checked={settings.flat} onChange={(e) => onSettings({ ...settings, flat: e.target.checked })} /> 2D 보드로 보기 (3D가
            느리거나 보이지 않을 때)
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.motion ?? !prefersReducedMotion()}
              onChange={(e) => onSettings({ ...settings, motion: e.target.checked })}
            />{' '}
            보드 움직임 (흔들리는 나무·밀, 거니는 양, 가마 연기). 끄면 배터리를 아낍니다
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.shadows ?? true}
              disabled={settings.quality === 'low'}
              onChange={(e) => onSettings({ ...settings, shadows: e.target.checked })}
            />{' '}
            물체 그림자 (나무·집·바위가 바닥에 드리우는 그림자, 그래픽 품질이 낮음이면 꺼짐)
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
  const tiedTop = false;
  return (
    <div className="result-backdrop">
      <div className="result card" role="dialog" aria-label="게임 결과">
        <div className="result-crown">
          <CrownIcon size={42} />
        </div>
        <h1>{`${josa(winners[0], '이/가')} 이겼습니다!`}</h1>
        <p className="muted small">
          자기 차례에 승점 {view.game!.winPoints}점에 먼저 닿았습니다. 숨겨 두었던 승점 카드도 이제 공개됩니다.
        </p>
        <table className="result-table">
          <thead>
            <tr>
              <th>순위</th>
              <th>플레이어</th>
              <th>승점</th>
              <th>마을·도시</th>
              <th>달성·카드</th>
              <th>남은 자원{tiedTop ? ' (동점 판정)' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {result.ranking.map((e) => {
              const p = players.get(e.playerId);
              const info = view.game!.players.find((x) => x.id === e.playerId);
              return (
                <tr key={e.playerId} className={e.rank === 1 ? 'winner' : ''}>
                  <td>{e.rank}위</td>
                  <td>
                    <Emblem colorIndex={p?.colorIndex ?? 0} size={16} /> {p?.nickname}
                    {e.playerId === view.you && <span className="tag">나</span>}
                  </td>
                  <td>
                    <b>{e.score}점</b>
                  </td>
                  <td>{info ? `마을 ${info.villages} · 도시 ${info.cities}` : '-'}</td>
                  <td>
                    {view.game!.longestRoad.holder === e.playerId && <AwardIcon kind="longest_road" />}
                    {view.game!.largestArmy.holder === e.playerId && <AwardIcon kind="largest_army" />}
                    {info ? ` 기사 ${info.knightsPlayed}` : ''}
                  </td>
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

export function PlacementBanner({ view, players, picked }: { view: RoomView; players: Players; picked: boolean }) {
  const g = view.game!;
  if (g.phase !== 'placement') return null;
  const mine = g.placementPlayerId === view.you;
  const step = g.setupVillage ? 2 : 1;
  return (
    <div className={`placement-banner ${mine ? 'placement-mine' : ''}`}>
      {mine ? (
        <b>
          <span className="pb-step">{step}/2</span>{' '}
          {g.setupVillage
            ? picked
              ? '고른 변에 길을 놓으려면 ✓ 를 누르세요.'
              : '빛나는 변을 눌러 방금 지은 마을에 붙일 길을 고르세요.'
            : picked
              ? '고른 자리에 마을을 지으려면 ✓ 를 누르세요.'
              : '빛나는 꼭짓점을 눌러 시작 마을 자리를 고르세요.'}
        </b>
      ) : (
        <span>
          {josa(players.get(g.placementPlayerId ?? '')?.nickname ?? '?', '이/가')} {g.setupVillage ? '마을을 짓고 길을 고르는 중입니다.' : '시작 마을 자리를 고르는 중입니다.'}
        </span>
      )}
      <div className="small">
        배치 순서(한 바퀴 돌고 거꾸로 한 바퀴):{' '}
        {g.placementOrder.map((id, i) => {
          const p = players.get(id);
          const done = i < g.roads.length;
          const now = i === g.roads.length;
          return (
            <Fragment key={`${id}-${i}`}>
              <span className={`po ${done ? 'po-done' : ''} ${now ? 'po-now' : ''}`}>
                <Emblem colorIndex={p?.colorIndex ?? 0} size={12} /> {p?.nickname}
              </span>
              {i < g.placementOrder.length - 1 ? ' → ' : ''}
            </Fragment>
          );
        })}
      </div>
      <div className="small muted">
        두 번째 시작 마을은 닿은 칸마다 자원 1장을 바로 받습니다. 그다음부터는 주사위 숫자가 나온 칸만 생산합니다.
      </div>
    </div>
  );
}

export function colorOf(players: Players, id: string): string {
  return playerColor(players.get(id)?.colorIndex ?? 0).hex;
}

export { bundleText };
