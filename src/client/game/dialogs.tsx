import { useMemo, useState, type ReactNode } from 'react';
import { EDGE_MAP, VERTEX_MAP, harborVertices } from '../../shared/board';
import {
  DEV_COST,
  DEV_DECK,
  DEV_HELP,
  DEV_LABEL,
  MAX_TRADE_AMOUNT,
  WIN_POINTS,
  bundleTotal,
  numberPips,
  RESOURCES,
  RESOURCE_LABEL,
  TILE_KIND_LABEL,
  TILE_MAP,
  PIECE_COST,
  PIECE_LABEL,
  bundleLabel,
  emptyBundle,
} from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { placeableVertices, setupRoadEdges, validateTradeBundles, longestRoadPath } from '../../shared/rules';
import type { Bundle, DevKind, GameAction, Resource } from '../../shared/types';
import { client } from '../net/client';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { AnyResourceIcon, CrownIcon, Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import { RulesSummary } from '../ui/RulesSummary';
import { showToast } from '../ui/toast';
import type { BoardSelection } from '../board/BoardRenderer';
import { AwardIcon } from './panels';
import { bankBlocker, buildBlocker, buildSpots, bundleText, buyDevBlocker, formatEvent, playDevBlocker, roadStatus, tileName, tradeBlocker, type PlayerInfo } from './derive';
import { ActionButton, Sheet, Stepper, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

/** 은행·해상 교역로 교환: 내는 자원마다 내 비율(4:1, 교역로 3:1·2:1)이 붙는다. 한 번에 1개를 받는다. */
export function BankTradeDialog({ view, onClose, onPlayerTrade }: { view: RoomView; onClose: () => void; onPlayerTrade: () => void }) {
  const g = view.game!;
  const mine = g.myResources;
  const ratio = g.myTradeRatios;
  const firstGive = RESOURCES.find((r) => mine[r] >= ratio[r]) ?? null;
  const [give, setGive] = useState<Resource | null>(firstGive);
  const [get, setGet] = useState<Resource | null>(null);
  const harbors = g.harbors.filter((h) => {
    const e = EDGE_MAP[h.edgeId];
    return [e.a, e.b].some((v) => g.buildings.some((b) => b.vertexId === v && b.owner === view.you));
  });
  return (
    <Sheet title="교환" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button className="tab tab-on" role="tab" aria-selected>
          은행·해상 교역로
        </button>
        <button className="tab" role="tab" aria-selected={false} onClick={onPlayerTrade} disabled={!!tradeBlocker(view)} title={tradeBlocker(view) ?? undefined}>
          플레이어와 교환
        </button>
      </div>
      <p className="muted small">
        같은 자원을 은행에 4개 내면 원하는 자원 1개를 받습니다. 마을·도시가 해상 교역로에 닿아 있으면 아무 자원 3개, 교역로에 그려진 자원은 2개로 바꿀 수 있습니다.
        {harbors.length > 0 && (
          <>
            {' '}
            내 교역로:{' '}
            {harbors.map((h) => (
              <span key={h.edgeId} className="cost-inline">
                {h.resource ? (
                  <>
                    <ResourceIcon kind={h.resource} size={14} />
                    2:1
                  </>
                ) : (
                  <>
                    <AnyResourceIcon size={14} />
                    3:1
                  </>
                )}
              </span>
            ))}
          </>
        )}
      </p>
      <div className="pick-label">낼 자원</div>
      <div className="pick-row">
        {RESOURCES.map((r) => (
          <button
            key={r}
            className={`pick ${give === r ? 'pick-on' : ''}`}
            disabled={mine[r] < ratio[r]}
            onClick={() => {
              setGive(r);
              if (get === r) setGet(null);
            }}
          >
            <ResourceIcon kind={r} size={26} />
            {RESOURCE_LABEL[r]} {ratio[r]}개
            <small>
              보유 {mine[r]}
              {ratio[r] < 4 && <b className="ratio-tag"> 교역로</b>}
            </small>
          </button>
        ))}
      </div>
      <div className="pick-label">받을 자원 (1개)</div>
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
        label={give && get ? `${RESOURCE_LABEL[give]} ${ratio[give]}개 → ${RESOURCE_LABEL[get]} 1개로 교환` : '자원을 고르세요'}
        blocker={bankBlocker(view) ?? (!give || !get ? '낼 자원과 받을 자원을 고르세요.' : null)}
        onClick={async () => {
          if (!give || !get) return;
          if (await sendAction({ type: 'bank_trade', give, get })) {
            setGet(null);
            if (mine[give] - ratio[give] < ratio[give]) setGive(null);
          }
        }}
      />
    </Sheet>
  );
}

/** 발전 카드: 사기, 손에 든 카드 보기, 쓰기 (풍년·독점은 자원을 고른다) */
export function DevCardDialog({ view, onClose }: { view: RoomView; onClose: () => void }) {
  const g = view.game!;
  const [yop, setYop] = useState<[Resource, Resource]>(['wood', 'brick']);
  const [mono, setMono] = useState<Resource>('wool');
  const counts = (Object.keys(DEV_DECK) as DevKind[]).map((k) => ({
    kind: k,
    total: g.myDevCards.filter((c) => c.kind === k).length,
    fresh: g.myDevCards.filter((c) => c.kind === k && c.boughtTurn >= g.turn).length,
  }));
  return (
    <Sheet title="발전 카드" onClose={onClose}>
      <p className="muted small">
        한 장에 {bundleLabel(DEV_COST)}. 남은 카드 {g.devDeckCount}장. 한 턴에 1장만 쓸 수 있고 산 턴에는 쓰지 못합니다. 기사는 주사위를 굴리기 전에도 쓸 수 있습니다.
      </p>
      <ActionButton
        className="btn btn-primary btn-wide"
        label={`발전 카드 사기 (${bundleLabel(DEV_COST)})`}
        blocker={buyDevBlocker(view)}
        onClick={() => sendAction({ type: 'buy_dev' })}
      />
      <div className="dev-list">
        {counts
          .filter((c) => c.total > 0)
          .map(({ kind, total, fresh }) => (
            <div key={kind} className={`dev-card dev-${kind}`}>
              <div className="dev-card-head">
                <b>{DEV_LABEL[kind]}</b>
                <span className="tag">×{total}</span>
                {fresh > 0 && <span className="tag">이번 턴에 산 {fresh}장</span>}
              </div>
              <p className="small">{DEV_HELP[kind]}</p>
              {kind === 'year_of_plenty' && (
                <div className="pick-row compact">
                  {[0, 1].map((i) => (
                    <select
                      key={i}
                      value={yop[i]}
                      onChange={(e) => setYop((cur) => (i === 0 ? [e.target.value as Resource, cur[1]] : [cur[0], e.target.value as Resource]))}
                    >
                      {RESOURCES.map((r) => (
                        <option key={r} value={r}>
                          {RESOURCE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              )}
              {kind === 'monopoly' && (
                <div className="pick-row compact">
                  <select value={mono} onChange={(e) => setMono(e.target.value as Resource)}>
                    {RESOURCES.map((r) => (
                      <option key={r} value={r}>
                        {RESOURCE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {kind !== 'victory' && (
                <ActionButton
                  className="btn btn-small"
                  label={`${DEV_LABEL[kind]} 쓰기`}
                  blocker={playDevBlocker(view, kind)}
                  onClick={async () => {
                    const action: GameAction =
                      kind === 'year_of_plenty'
                        ? { type: 'play_dev', kind, resources: yop }
                        : kind === 'monopoly'
                          ? { type: 'play_dev', kind, resource: mono }
                          : { type: 'play_dev', kind: kind as 'knight' | 'road_building' };
                    if (await sendAction(action)) onClose();
                  }}
                />
              )}
            </div>
          ))}
        {g.myDevCards.length === 0 && <p className="muted small">아직 가진 발전 카드가 없습니다.</p>}
      </div>
    </Sheet>
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
          <p className="small muted">자원이 7장보다 많아 절반을 버려야 합니다. 버릴 자원을 고르세요.</p>
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

/** 보드에서 고른 자리 이름 (칸 코드 없이) */
function spotTitle(sel: BoardSelection, buildingKind: string | null, hasRoad: boolean): string {
  if (sel.kind === 'vertex') return buildingKind ?? '마을 자리';
  if (sel.kind === 'edge') return hasRoad ? '길' : '길 자리';
  return `${TILE_KIND_LABEL[TILE_MAP[sel.id].kind]} 칸`;
}

/** 꼭짓점이 닿은 칸을 자원 아이콘과 숫자 패로 */
function TouchedTiles({ vertexId, numbers }: { vertexId: string; numbers: Record<string, number> }) {
  const tiles = VERTEX_MAP[vertexId]?.tiles ?? [];
  return (
    <span className="touched">
      {tiles.map((id) => (
        <span key={id} className="cost-inline" title={tileName(numbers, id)}>
          <ResourceIcon kind={TILE_MAP[id].kind} size={16} />
          {numbers[id] ? <b className={numbers[id] === 6 || numbers[id] === 8 ? 'num-hot-text' : ''}>{numbers[id]}</b> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * 보드를 눌렀을 때 나오는 카드. 타일·꼭짓점·변의 정보와, 그 자리에서 할 수 있는 일(시작 배치, 길·마을 짓기, 도시로 올리기)을 보여 준다.
 */
export function SpotCard({
  view,
  players,
  sel,
  pendingVertex,
  onClose,
  onDone,
}: {
  view: RoomView;
  players: Players;
  sel: BoardSelection;
  pendingVertex: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const g = view.game!;
  const me = view.you;
  const myPlacement = g.phase === 'placement' && g.placementPlayerId === me;
  const myTurn = g.phase === 'playing' && g.currentPlayerId === me && g.step === 'main';
  const ownerName = (id: string) => (id === me ? '내' : `${players.get(id)?.nickname ?? '?'}의`);

  let icon: ReactNode = null;
  let info: ReactNode = null;
  let action: ReactNode = null;

  if (sel.kind === 'tile') {
    const tile = TILE_MAP[sel.id];
    const num = g.numbers[sel.id];
    icon = <ResourceIcon kind={tile.kind} size={22} />;
    const around = g.buildings.filter((b) => VERTEX_MAP[b.vertexId]?.tiles.includes(sel.id));
    const locked = g.robber === sel.id;
    if (tile.kind === 'plaza') info = '마을 광장: 자원이 나지 않는 빈 땅입니다. 기사단 동상이 처음 서 있는 곳입니다.';
    else
      info = (
        <>
          주사위 합이 <b>{num}</b>(나올 경우 {numberPips(num)}/36)이면 이 칸 꼭짓점의 마을은 {RESOURCE_LABEL[tile.kind]} 1장, 도시는 2장을 받습니다.
          {locked && <b className="warn-text"> 지금은 기사단 동상이 막고 있어 생산하지 않습니다.</b>}
          {around.length > 0 && ' '}
          {around.length > 0 && (
            <span className="touched">
              둘레:{' '}
              {around.map((b) => (
                <span key={b.vertexId} className="cost-inline">
                  <Emblem colorIndex={players.get(b.owner)?.colorIndex ?? 0} size={13} /> {PIECE_LABEL[b.kind]}
                </span>
              ))}
            </span>
          )}
        </>
      );
    if (g.step === 'robber' && g.currentPlayerId === me) {
      action = (
        <ActionButton
          className="btn btn-start btn-wide"
          label="여기로 기사단 동상 옮기기"
          blocker={locked ? '동상은 다른 칸으로 옮겨야 합니다.' : null}
          onClick={async () => {
            if (await sendAction({ type: 'move_robber', tileId: sel.id })) onDone();
          }}
        />
      );
    }
  } else if (sel.kind === 'vertex') {
    const b = g.buildings.find((x) => x.vertexId === sel.id);
    icon = b ? <Emblem colorIndex={players.get(b.owner)?.colorIndex ?? 0} size={18} /> : null;
    const harbor = g.harbors.find((h) => harborVertices(h).includes(sel.id));
    info = (
      <>
        {b ? `${ownerName(b.owner)} ${PIECE_LABEL[b.kind]}. ` : '빈 꼭짓점. '}닿은 칸: <TouchedTiles vertexId={sel.id} numbers={g.numbers} />
        {harbor && (
          <b className="harbor-note">
            {' '}
            · 해상 교역로 {harbor.resource ? `${RESOURCE_LABEL[harbor.resource]} 2:1` : '아무 자원 3:1'}
          </b>
        )}
      </>
    );
    if (myPlacement) {
      if (pendingVertex === sel.id) info = <>시작 마을 자리. 닿은 칸: <TouchedTiles vertexId={sel.id} numbers={g.numbers} /> · 이어서 빛나는 변을 눌러 길을 붙이세요.</>;
      else if (!placeableVertices(g.buildings).includes(sel.id)) info = <>{info} · 이웃 꼭짓점에 마을이 있어 놓을 수 없습니다.</>;
    } else if (myTurn && b && b.owner === me && b.kind === 'village') {
      action = (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`도시로 올리기 (${bundleLabel(PIECE_COST.city)})`}
          blocker={buildBlocker(view, 'city')}
          onClick={async () => {
            if (await sendAction({ type: 'build_city', vertexId: sel.id })) onDone();
          }}
        />
      );
    } else if (myTurn && !b) {
      const ok = buildSpots(view, 'village').includes(sel.id);
      action = (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`마을 짓기 (${bundleLabel(PIECE_COST.village)})`}
          blocker={buildBlocker(view, 'village') ?? (ok ? null : '내 길이 닿아 있고 이웃 꼭짓점이 모두 비어 있어야 지을 수 있습니다.')}
          onClick={async () => {
            if (await sendAction({ type: 'build_village', vertexId: sel.id })) onDone();
          }}
        />
      );
    }
  } else {
    const road = g.roads.find((r) => r.edgeId === sel.id);
    icon = road ? <Emblem colorIndex={players.get(road.owner)?.colorIndex ?? 0} size={18} /> : null;
    if (road) {
      const len = longestRoadPath(g.roads, g.buildings, road.owner).length;
      info = (
        <>
          {ownerName(road.owner)} 길. 가장 긴 교역로 <b>{len}칸</b> (금빛으로 표시). {roadStatus(view, road.owner, len, (id) => players.get(id)?.nickname ?? '?')}
        </>
      );
    } else info = '빈 변. 길은 내 마을·도시나 내 길에 이어서 놓습니다.';
    if (myPlacement && pendingVertex) {
      const ok = setupRoadEdges(g.roads, pendingVertex).includes(sel.id);
      info = ok ? '고른 자리에 시작 마을을, 이 변에 길을 놓습니다.' : '시작 길은 방금 고른 마을 자리에 붙은 변에만 놓을 수 있습니다.';
      action = (
        <ActionButton
          className="btn btn-primary btn-wide"
          label="시작 마을과 길 놓기"
          blocker={ok ? null : '빛나는 변을 고르세요.'}
          onClick={async () => {
            if (await sendAction({ type: 'place', vertexId: pendingVertex, edgeId: sel.id })) onDone();
          }}
        />
      );
    } else if (g.step === 'road_building' && g.currentPlayerId === me && !road) {
      const ok = buildSpots(view, 'road').includes(sel.id);
      action = (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`공짜 길 놓기 (남은 ${g.freeRoads}개)`}
          blocker={ok ? null : '내 마을·도시나 내 길에 이어지는 변에만 놓을 수 있습니다.'}
          onClick={async () => {
            if (await sendAction({ type: 'build_road', edgeId: sel.id })) onDone();
          }}
        />
      );
    } else if (myTurn && !road) {
      const ok = buildSpots(view, 'road').includes(sel.id);
      action = (
        <ActionButton
          className="btn btn-primary btn-wide"
          label={`길 놓기 (${bundleLabel(PIECE_COST.road)})`}
          blocker={buildBlocker(view, 'road') ?? (ok ? null : '내 마을·도시나 내 길에 이어지는 변에만 놓을 수 있습니다.')}
          onClick={async () => {
            if (await sendAction({ type: 'build_road', edgeId: sel.id })) onDone();
          }}
        />
      );
    }
  }

  const tileKind = sel.kind === 'tile' ? TILE_MAP[sel.id].kind : null;
  const here = sel.kind === 'vertex' ? g.buildings.find((x) => x.vertexId === sel.id) : null;
  const title = spotTitle(sel, here ? `${ownerName(here.owner)} ${PIECE_LABEL[here.kind]}` : null, sel.kind === 'edge' && g.roads.some((r) => r.edgeId === sel.id));
  return (
    <div className="tile-card" role="dialog" aria-label={`${title} 정보`}>
      <div className="tile-card-head">
        {icon}
        <b>{title}</b>
        {tileKind && tileKind !== 'plaza' && <span className={`tag num-tag ${[6, 8].includes(g.numbers[sel.id]) ? 'num-hot' : ''}`}>{g.numbers[sel.id]}</span>}
        {sel.kind === 'tile' && g.robber === sel.id && <span className="tag tag-lock">🔒 동상</span>}
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <p className="small">{info}</p>
      {action}
    </div>
  );
}

export interface GameSettings {
  quality: 'auto' | 'high' | 'low';
  flat: boolean;
  perf: boolean;
  /** 보드 움직임 (바람·양·가마 연기). 저장된 값이 없으면 기기의 '동작 줄이기' 설정을 따른다. */
  motion?: boolean;
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
              <span className="log-round">{e.turn > 0 ? `${e.turn}턴` : '배치'}</span> {formatEvent(e, players, view.you, view.game?.numbers)}
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
          자기 차례에 승점 {WIN_POINTS}점에 먼저 닿았습니다. 숨겨 두었던 승점 카드도 이제 공개됩니다.
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

export function PlacementBanner({ view, players, pendingVertex }: { view: RoomView; players: Players; pendingVertex: string | null }) {
  const g = view.game!;
  if (g.phase !== 'placement') return null;
  const mine = g.placementPlayerId === view.you;
  return (
    <div className={`placement-banner ${mine ? 'placement-mine' : ''}`}>
      {mine ? (
        <b>{pendingVertex ? '빛나는 변을 눌러 마을에 붙일 길을 고르세요.' : '빛나는 꼭짓점을 눌러 시작 마을 자리를 고르세요.'}</b>
      ) : (
        <span>{josa(players.get(g.placementPlayerId ?? '')?.nickname ?? '?', '이/가')} 시작 마을과 길을 고르는 중입니다.</span>
      )}
      <div className="small">
        배치 순서(한 바퀴 돌고 거꾸로 한 바퀴):{' '}
        {g.placementOrder.map((id, i) => {
          const p = players.get(id);
          const done = i < g.buildings.length;
          const now = i === g.buildings.length;
          return (
            <span key={`${id}-${i}`} className={`po ${done ? 'po-done' : ''} ${now ? 'po-now' : ''}`}>
              <Emblem colorIndex={p?.colorIndex ?? 0} size={12} /> {p?.nickname}
              {i < g.placementOrder.length - 1 ? ' → ' : ''}
            </span>
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
