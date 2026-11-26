import { useEffect, useState, type CSSProperties } from 'react';
import { DEV_COST, DEV_LABEL, PIECE_COST, RESOURCES, RESOURCE_LABEL } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { pieceCount, pieceLimit } from '../../shared/rules';
import type { Bundle, PieceKind } from '../../shared/types';
import { throwDice } from '../dice';
import { ArtImg, DEV_BACK_ART, PIECE_ART, RESOURCE_ART } from '../ui/art';
import { playerColor } from '../theme';
import { PersonIcon, ResourceIcon } from '../ui/icons';
import { showToast } from '../ui/toast';
import { MiniHand } from './hand';
import { heldTotal, useHeldCards } from './cardFly';
import { TurnTimer, useTurnClock } from './turn';
import { buildBlocker, buyDevBlocker, isMyTurn, shortfall, turnBlocker, type PlayerInfo } from './derive';
import { canBankNow, tradeButtonBlocker } from './trade';
import { ActionButton, sendAction } from './ui';
import { bragWait, sendChatBrag } from '../net/chat';
import { nextBragLine } from '../ui/bragLines';

type Players = Map<string, PlayerInfo>;
type Award = 'longest_road' | 'largest_army';

const AWARD_NAME: Record<Award, string> = { longest_road: '최장 교역로', largest_army: '최강 기사단' };

/** 내가 가진 달성 (게임 중일 때만) */
function myAwards(view: RoomView): Award[] {
  const g = view.game;
  if (!g || g.phase !== 'playing') return [];
  return (['longest_road', 'largest_army'] as const).filter((a) => (a === 'longest_road' ? g.longestRoad.holder : g.largestArmy.holder) === view.you);
}

/** 자랑하기: 모두의 화면에 달성 연출을 띄운다. 한 번 뽐내면 5초 동안 단추가 흐려진다. */
function useBrag(): { cooling: boolean; brag: (award: Award) => void } {
  const [cooling, setCooling] = useState(false);
  useEffect(() => {
    if (!cooling) return;
    const t = window.setTimeout(() => setCooling(false), Math.max(200, bragWait()));
    return () => window.clearTimeout(t);
  }, [cooling]);
  const brag = (award: Award) => {
    if (bragWait(award) > 0) return;
    setCooling(true);
    // 누를 때마다 다른 한마디가 함께 뜬다.
    void sendChatBrag(award, nextBragLine(award)).then((res) => {
      if (!res.ok && res.code !== 'BRAG_SLOW') showToast(res.error, 'error');
    });
  };
  return { cooling, brag };
}

/**
 * 자랑 단추: 최장 교역로·최강 기사단을 가지고 있으면 그 표식 단추가 생기고, 누르면 같은 방 모두의 화면에 달성 연출이 다시 뜬다.
 * compact: 좁은 화면 오른쪽 아래의 둥근 단추 꼴.
 */
export function BragButtons({ view, compact = false }: { view: RoomView; compact?: boolean }) {
  const awards = myAwards(view);
  const { cooling, brag } = useBrag();
  if (!awards.length) return null;
  return (
    <>
      {awards.map((a) => (
        <button
          key={a}
          type="button"
          className={`${compact ? 'icon-btn chat-toggle brag-toggle' : 'brag-btn'} ${cooling ? 'is-cooling' : ''}`}
          aria-label={`${AWARD_NAME[a]} 자랑하기`}
          title={`${AWARD_NAME[a]} 자랑하기 · 모두의 화면에 달성 연출을 띄웁니다 (5초에 한 번)`}
          aria-disabled={cooling}
          onClick={() => brag(a)}
        >
          <AwardIcon kind={a} size={compact ? 20 : 17} />
          {!compact && <span>자랑</span>}
        </button>
      ))}
    </>
  );
}

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
 * 플레이어 상태 창 (화면 오른쪽 맨 아래). 왼쪽에 그 사람 색의 사람 아이콘, 가운데에 이름 줄과 손 카드·기사·길 줄,
 * 오른쪽 아래에 승점을 크게 적는다. 채팅 이모티콘은 이름 옆에 잠깐 떠오른다.
 */
export function PlayersPanel({
  view,
  players,
  emotes = {},
  compact = false,
}: {
  view: RoomView;
  players: Players;
  emotes?: Record<string, { emote: string; key: number }>;
  /** 좁은 화면: 차례 상태 쪽지 아래에 두 칸씩 나란히 놓는 작은 꼴 (보드를 가리지 않게) */
  compact?: boolean;
}) {
  const g = view.game!;
  const held = useHeldCards();
  const clock = useTurnClock(g);
  const { cooling, brag } = useBrag();
  const mine = myAwards(view);
  /** 달성 표식. 내 것이면 눌러서 자랑할 수 있는 단추다. */
  const awardTag = (id: string, a: Award, title: string) =>
    id === view.you && mine.includes(a) ? (
      <button
        type="button"
        className={`tag tag-award tag-brag ${cooling ? 'is-cooling' : ''}`}
        title={`${title} · 눌러서 모두에게 자랑하기`}
        aria-label={`${AWARD_NAME[a]} 자랑하기`}
        onClick={() => brag(a)}
      >
        <AwardIcon kind={a} />
      </button>
    ) : (
      <span className="tag tag-award" title={title}>
        <AwardIcon kind={a} />
      </span>
    );
  return (
    <ul className={`players ${compact ? 'players-compact' : ''}`} aria-label="플레이어">
      {g.order.map((id) => {
        const p = players.get(id);
        const info = g.players.find((x) => x.id === id)!;
        if (!p) return null;
        const isCurrent = g.currentPlayerId === id || g.placementPlayerId === id;
        // 날아오는 중인 카드는 닿을 때 센다
        const resCount = Math.max(0, info.resourceTotal - heldTotal(held, id));
        const ticking = clock && clock.holders.includes(id);
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
            <PersonIcon colorIndex={p.colorIndex} size={compact ? 20 : 26} title={color.name} />
            <div className="player-line">
              <span className="player-name">
                <span className="player-nick">{p.nickname}</span>
                {id === view.you && <span className="tag">나</span>}
                {p.auto && (
                  <span className="tag tag-auto" title="자리 비움: 컴퓨터가 대신 두는 중">
                    자동
                  </span>
                )}
                {emote && (
                  <span key={emote.key} className="emote-pop" aria-label={`${p.nickname}: ${emote.emote}`}>
                    {emote.emote}
                  </span>
                )}
              </span>
              {g.longestRoad.holder === id && awardTag(id, 'longest_road', `최장 교역로 (길 ${g.longestRoad.length}칸, 2점)`)}
              {g.largestArmy.holder === id && awardTag(id, 'largest_army', `최강 기사단 (기사 ${g.largestArmy.size}장, 2점)`)}
              {offers > 0 && (
                <span className="stat-offers" title={`열린 교환 제안 ${offers}개`}>
                  ⇅{offers}
                </span>
              )}
              {ticking && clock && <TurnTimer clock={clock} size={22} mine={id === view.you} />}
            </div>
            <div className="player-stats">
              <MiniHand count={info.devCardCount} kind="dev" title={`발전 카드 ${info.devCardCount}장`} />
              <span title={`쓴 기사 ${info.knightsPlayed}장`} className="stat-pieces">
                ⚔{info.knightsPlayed}
              </span>
              <span title={g.sea.length ? `가장 긴 교역로(길·배) ${info.roadLength}칸, 띄운 배 ${info.ships}척` : `가장 긴 길 ${info.roadLength}칸`} className="stat-pieces">
                <PieceIcon kind="road" size={13} />
                {info.roadLength}
              </span>
              {/* 자원 카드 뭉치는 오른쪽 아래(승점 바로 왼쪽): 생산한 카드가 여기로 날아든다 */}
              <span className="player-res">
                <MiniHand count={resCount} kind="res" fly={`hand-${id}`} title={`자원 카드 ${resCount}장 (종류는 본인만 봅니다)`} />
              </span>
            </div>
            <span
              className="player-score"
              title={id === view.you ? '내 승점 (숨긴 승점 카드 포함)' : '공개된 승점 (숨긴 승점 카드는 보이지 않음)'}
              aria-label={`승점 ${points}점`}
            >
              <span className="ps-star" aria-hidden>
                ★
              </span>
              <b>{points}</b>
            </span>
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
      {kind === 'ship' && (
        <g stroke="#3a2a1f" strokeWidth="1.2" strokeLinejoin="round">
          <path d="M3 15 H21 L18.5 19.5 H6 Z" fill="#9a6a3c" />
          <path d="M12 3 V15" />
          <path d="M12.8 4.5 C16 6 18 9.5 18.5 13.5 H12.8 Z" fill="#f2e6cc" />
          <path d="M2 21.5 C5 20.3 7 20.3 10 21.5 S15 22.7 18 21.5 S21 20.8 22 21.2" fill="none" stroke="#5f9fb2" strokeWidth="1.4" />
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
  { key: 'ship', label: '배', cost: PIECE_COST.ship },
  { key: 'dev', label: '발전 카드', cost: DEV_COST },
];

/** 말풍선 안의 재료: 아이콘과 개수. 모자란 재료는 흐리게 */
function CostRow({ cost, have }: { cost: Bundle; have: Bundle }) {
  const lack = shortfall(have, cost);
  return (
    <span className="bb-cost">
      {RESOURCES.filter((r) => cost[r] > 0).map((r) => (
        <span key={r} className={`bb-res ${lack[r] ? 'bb-lack' : ''}`}>
          <ResourceIcon kind={r} size={16} />
          <b>{cost[r]}</b>
        </span>
      ))}
    </span>
  );
}

function costText(cost: Bundle): string {
  return RESOURCES.filter((r) => cost[r] > 0)
    .map((r) => `${RESOURCE_LABEL[r]} ${cost[r]}`)
    .join(', ');
}

/**
 * 교환과 턴 종료 사이의 버튼 네 개: [도로] [마을] [도시] [발전 카드]. 섬 맵은 [도시] 다음에 [배]가 붙어 다섯 개다.
 * 버튼에는 큰 그림과 작은 이름만 두고, 오른쪽 위 모서리에 앞으로 더 지을 수 있는 개수(발전 카드는 더미에 남은 장수)를 적는다.
 * 재료는 마우스를 올리거나 누르면 버튼 위 말풍선에 아이콘과 개수로만 보인다. 못 하는 버튼을 누르면 까닭은 교환 버튼처럼 알림으로 띄운다.
 * 도로·마을·도시는 누르면 지을 수 있는 자리가 빛나고 그 자리를 누르면 바로 짓는다. 발전 카드는 누르면 바로 산다.
 * wait: 주사위·생산·동상 연출이 끝나기를 기다리는 중이면 그 까닭 (game/pace.ts). 그동안은 모두 막는다.
 */
export function BuildBar({
  view,
  buildMode,
  wait = null,
  onBuild,
}: {
  view: RoomView;
  buildMode: PieceKind | null;
  wait?: string | null;
  onBuild: (kind: PieceKind | null) => void;
}) {
  const g = view.game!;
  const [tip, setTip] = useState<{ key: BuildKey; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const t = window.setTimeout(() => setTip(null), 2200);
    return () => window.clearTimeout(t);
  }, [tip]);
  if (g.phase !== 'playing') return null;
  const sea = g.sea.length > 0;
  return (
    <div className={`build-bar ${sea ? 'build-bar-sea' : ''}`} role="group" aria-label="건설과 발전 카드">
      {BUILD_ITEMS.filter((item) => sea || item.key !== 'ship').map((item) => {
        const active = item.key !== 'dev' && buildMode === item.key;
        const blocker = active ? null : (wait ?? (item.key === 'dev' ? buyDevBlocker(view) : buildBlocker(view, item.key)));
        // 개수 제한 없음이면 남은 수가 끝이 없다 (∞ 로 적는다).
        const left = g.unlimited ? Infinity : item.key === 'dev' ? g.devDeckCount : pieceLimit(g, item.key) - pieceCount(g.buildings, g.roads, view.you, item.key, g.ships);
        const leftText = left === Infinity ? '∞' : String(left);
        const unit = item.key === 'dev' ? '장' : '개';
        return (
          <div key={item.key} className="bb-slot">
            <button
              type="button"
              className={`bb-btn bb-${item.key} ${blocker ? 'is-blocked' : ''} ${active ? 'is-active' : ''}`}
              aria-disabled={!!blocker || busy}
              aria-pressed={item.key === 'dev' ? undefined : active}
              aria-label={`${item.label}${active ? ' 그만두기' : ''}, ${item.key === 'dev' ? '남은 카드' : '남은 수'} ${left === Infinity ? '제한 없음' : `${left}${unit}`}, 재료 ${costText(item.cost)}${blocker ? ` (${blocker})` : ''}`}
              onClick={async () => {
                if (active) return onBuild(null);
                // 터치 화면에는 마우스 올리기가 없으니 누를 때 재료 말풍선을 잠깐 띄운다.
                setTip({ key: item.key, n: Date.now() });
                if (blocker) {
                  showToast(blocker, 'warn');
                  return;
                }
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
              <span className="bb-ico">
                <ArtImg src={item.key === 'dev' ? DEV_BACK_ART : PIECE_ART[item.key]} size={44} />
              </span>
              <span className="bb-name">{active ? '그만두기' : item.label}</span>
              <span className={`bb-count ${left <= 0 ? 'bb-count-out' : ''} ${left === Infinity ? 'bb-count-inf' : ''}`} aria-hidden>
                {leftText}
              </span>
            </button>
            <span className={`bb-tip ${tip?.key === item.key ? 'bb-tip-show' : ''}`} aria-hidden>
              <CostRow cost={item.cost} have={g.myResources} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 아래 버튼 줄 맨 왼쪽의 교환 버튼. 은행·교역로와 바로 바꿀 수 있는 자원이 있으면 황토 점이 붙는다. */
export function TradeButton({ view, tradeOpen, wait = null, onTrade }: { view: RoomView; tradeOpen: boolean; wait?: string | null; onTrade: () => void }) {
  const g = view.game!;
  if (g.phase !== 'playing') return null;
  const bankable = !wait && canBankNow(view);
  return (
    <div className="act-slot">
      <ActionButton
        className={`btn act act-trade ${bankable ? 'act-bankable' : ''}`}
        label="교환"
        active={tradeOpen}
        blocker={tradeOpen ? null : (wait ?? tradeButtonBlocker(view))}
        onClick={onTrade}
        icon={
          <span className="act-ico">
            ⇅{bankable && <i className="act-dot" title="은행·교역로와 바로 바꿀 수 있는 자원이 있습니다" aria-label="은행 교환 가능" />}
          </span>
        }
      />
    </div>
  );
}

/** 아래 버튼 줄 맨 오른쪽: 굴리기 단계에는 주사위 굴리기, 그 밖에는 턴 종료. wait 는 BuildBar 와 같다. */
export function TurnButton({ view, wait = null }: { view: RoomView; wait?: string | null }) {
  const g = view.game!;
  const mine = isMyTurn(view);
  const [rolling, setRolling] = useState(false);
  useEffect(() => setRolling(false), [g.turn, g.dice?.[0], g.dice?.[1]]);

  if (g.phase !== 'playing') return null;
  if (mine && g.step === 'roll') {
    return (
      <div className="act-slot act-slot-turn">
        <ActionButton
          className="btn btn-primary act act-roll"
          label={rolling ? '굴리는 중…' : '주사위 굴리기'}
          blocker={wait}
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
  // 주사위 굴리기와 같은 넓은 칸: 굴리고 나서 버튼 줄 너비가 줄면 손 카드 간격이 바뀌어 카드가 움찔한다.
  return (
    <div className="act-slot act-slot-turn">
      <ActionButton
        className="btn act act-end"
        label="턴 종료"
        blocker={wait ?? turnBlocker(view)}
        onClick={() => sendAction({ type: 'end_turn' })}
        icon={<span className="act-ico">⏭</span>}
      />
    </div>
  );
}

/** 은행 건물: 세모 지붕과 기둥 셋 (먹선) */
function BankIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g fill="#efe2c2" stroke="#3a2a1f" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2.5 9 L12 3.5 L21.5 9 Z" />
        <rect x="4" y="9.5" width="16" height="1.8" />
        <rect x="5.2" y="11.8" width="2.4" height="6.6" />
        <rect x="10.8" y="11.8" width="2.4" height="6.6" />
        <rect x="16.4" y="11.8" width="2.4" height="6.6" />
        <rect x="3" y="18.6" width="18" height="2.2" />
      </g>
    </svg>
  );
}

/**
 * 은행: 자원마다 은행에 남은 카드와 발전 카드 더미에 남은 장수. 손 카드와 같은 물감 색의 작은 카드 더미로 그리고 오른쪽 위에 장수를 적는다.
 * 세 장 이하로 줄면 장수를 황토색, 다 떨어지면 카드를 흐리게 하고 장수를 붉게 칠한다. 장수를 정하기 전에 저장한 게임(무제한)은 ∞ 로 적는다.
 * compact: 좁은 화면의 차례 쪽지 아래에 아이콘과 숫자만 한 줄로 놓는 작은 꼴
 */
export function BankPanel({ view, compact = false }: { view: RoomView; compact?: boolean }) {
  const g = view.game!;
  if (g.phase === 'order') return null;
  const items: { key: string; label: string; src: string; n: number | null }[] = [
    ...RESOURCES.map((r) => ({ key: r as string, label: RESOURCE_LABEL[r], src: RESOURCE_ART[r], n: g.bank ? g.bank[r] : null })),
    { key: 'dev', label: '발전 카드', src: DEV_BACK_ART, n: g.devDeckCount },
  ];
  const state = (n: number | null) => (n === null ? '' : n === 0 ? 'bank-empty' : n <= 3 ? 'bank-low' : '');
  const title = (it: (typeof items)[number]) => `${it.label} ${it.n === null ? '무제한' : `${it.n}장 남음`}`;
  if (compact) {
    return (
      <div className="bank-strip" role="group" aria-label="은행에 남은 카드">
        <BankIcon size={15} />
        {items.map((it) => (
          <span key={it.key} className={`bank-chip ${state(it.n)}`} title={title(it)} aria-label={title(it)}>
            <ArtImg src={it.src} size={15} />
            <b>{it.n === null ? '∞' : it.n}</b>
          </span>
        ))}
      </div>
    );
  }
  return (
    <section className="side-bank" aria-label="은행에 남은 카드">
      <h3>
        <BankIcon size={18} /> 은행
      </h3>
      <ul className="bank-cards">
        {items.map((it) => (
          <li key={it.key} className={`bank-card bank-${it.key} ${state(it.n)}`} title={title(it)} aria-label={title(it)}>
            <span className="bank-face">
              <ArtImg src={it.src} size={28} />
            </span>
            <b className="bank-n">{it.n === null ? '∞' : it.n}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { DEV_LABEL };
