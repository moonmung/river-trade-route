// 서버가 보낸 화면 정보에서 버튼 활성화·안내 문구를 계산한다. 실제 판정은 서버가 다시 한다.
import { EDGE_MAP, VERTEX_MAP } from '../../shared/board';
import {
  DEV_COST,
  DEV_LABEL,
  PIECE_COST,
  PIECE_LABEL,
  PIECE_LIMIT,
  RESOURCES,
  RESOURCE_LABEL,
  AWARD_POINTS,
  LONGEST_ROAD_MIN,
  TILES,
  TILE_MAP,
  bundleLabel,
  bundleTotal,
  hasBundle,
} from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableRoads, buildableVillages, pieceCount, placeableVertices, setupRoadEdges, upgradableVillages } from '../../shared/rules';
import type { Bundle, DevKind, GameEvent, PieceKind, TradeCloseReason } from '../../shared/types';
import { josa } from '../ui/josa';

export interface PlayerInfo {
  id: string;
  nickname: string;
  colorIndex: number;
  connected: boolean;
  isHost: boolean;
}

export function playerMap(view: RoomView): Map<string, PlayerInfo> {
  return new Map(
    view.players.map((p) => [p.id, { id: p.id, nickname: p.nickname, colorIndex: p.colorIndex, connected: p.connected, isHost: p.isHost }]),
  );
}

export function isMyTurn(view: RoomView): boolean {
  return view.game?.phase === 'playing' && view.game.currentPlayerId === view.you;
}

/** 교환·건설·턴 종료를 할 수 없는 이유 (주사위를 굴린 뒤 내 차례의 main 단계에서만 된다) */
export function turnBlocker(view: RoomView): string | null {
  const g = view.game;
  if (!g || g.phase !== 'playing') return '게임이 진행 중일 때 할 수 있습니다.';
  if (g.currentPlayerId !== view.you) return '내 차례에만 할 수 있습니다.';
  if (g.step === 'roll') return '먼저 주사위를 굴리세요.';
  if (g.step === 'discard') return '7이 나와 자원을 버리는 중입니다.';
  if (g.step === 'robber') return '먼저 기사단 동상을 옮길 칸을 고르세요.';
  if (g.step === 'steal') return '먼저 자원을 빼앗을 사람을 고르세요.';
  if (g.step === 'road_building') return '길 건설 카드의 공짜 길을 먼저 놓으세요.';
  return null;
}

/** 길·마을·도시를 지을 수 없는 이유 (지을 수 있으면 null) */
export function buildBlocker(view: RoomView, kind: PieceKind): string | null {
  const g = view.game;
  const free = kind === 'road' && g?.step === 'road_building' && g.currentPlayerId === view.you;
  if (!free) {
    const turn = turnBlocker(view);
    if (turn) return turn;
  }
  if (!g) return '게임이 없습니다.';
  if (pieceCount(g.buildings, g.roads, view.you, kind) >= PIECE_LIMIT[kind]) return `${PIECE_LABEL[kind]}은(는) 최대 ${PIECE_LIMIT[kind]}개까지입니다.`;
  if (!free && !hasBundle(g.myResources, PIECE_COST[kind])) return `${bundleLabel(PIECE_COST[kind])}가 필요합니다.`;
  if (buildSpots(view, kind).length === 0) {
    if (kind === 'road') return '내 마을이나 길과 이어진 빈 변이 없습니다.';
    if (kind === 'village') return '내 길 끝에 마을을 지을 빈 꼭짓점이 없습니다 (이웃 꼭짓점이 비어 있어야 합니다).';
    return '도시로 올릴 내 마을이 없습니다.';
  }
  return null;
}

/** 지을 수 있는 자리 (비용·차례는 따로 본다). 길은 변 ID, 마을·도시는 꼭짓점 ID */
export function buildSpots(view: RoomView, kind: PieceKind): string[] {
  const g = view.game;
  if (!g) return [];
  if (kind === 'road') return buildableRoads(g.buildings, g.roads, view.you);
  if (kind === 'village') return buildableVillages(g.buildings, g.roads, view.you);
  return upgradableVillages(g.buildings, view.you);
}

export function bankBlocker(view: RoomView): string | null {
  const turn = turnBlocker(view);
  if (turn) return turn;
  const g = view.game!;
  if (!RESOURCES.some((r) => g.myResources[r] >= g.myTradeRatios[r])) return '교환할 만큼 모인 자원이 없습니다 (기본 4개, 교역로는 3개·2개).';
  return null;
}

export function tradeBlocker(view: RoomView): string | null {
  const turn = turnBlocker(view);
  if (turn) return turn;
  const g = view.game!;
  if (g.trade) return '이미 열린 교환 제안이 있습니다.';
  if (bundleTotal(g.myResources) === 0) return '낼 자원이 없습니다.';
  return null;
}

export function buyDevBlocker(view: RoomView): string | null {
  const turn = turnBlocker(view);
  if (turn) return turn;
  const g = view.game!;
  if (g.devDeckCount <= 0) return '발전 카드가 모두 팔렸습니다.';
  if (!hasBundle(g.myResources, DEV_COST)) return `${bundleLabel(DEV_COST)}가 필요합니다.`;
  return null;
}

/** 발전 카드를 쓸 수 없는 이유 (굴리기 전이나 main 단계에서, 한 턴에 1장, 산 턴에 산 카드는 안 됨) */
export function playDevBlocker(view: RoomView, kind: DevKind): string | null {
  const g = view.game;
  if (!g || g.phase !== 'playing' || g.currentPlayerId !== view.you) return '내 차례에만 쓸 수 있습니다.';
  if (kind === 'victory') return '승점 카드는 들고만 있어도 점수에 들어갑니다.';
  if (g.step !== 'roll' && g.step !== 'main') return turnBlocker(view);
  if (g.devPlayedThisTurn) return '발전 카드는 한 턴에 1장만 쓸 수 있습니다.';
  if (!g.myDevCards.some((c) => c.kind === kind)) return `${DEV_LABEL[kind]} 카드가 없습니다.`;
  if (!g.myDevCards.some((c) => c.kind === kind && c.boughtTurn < g.turn)) return '이번 턴에 산 카드는 다음 턴부터 쓸 수 있습니다.';
  if (kind === 'road_building' && buildableRoads(g.buildings, g.roads, view.you).length === 0) return '공짜 길을 놓을 자리가 없습니다.';
  return null;
}

export interface BoardHighlights {
  vertices: string[];
  edges: string[];
  tiles: string[];
}

/**
 * 보드에서 빛낼 자리.
 * 시작 배치: 마을 자리 → (고른 뒤) 그 마을에 붙일 길. 동상 옮기기: 동상이 없는 칸. 길 건설 카드: 공짜 길 자리.
 * 건설 모드: 지을 수 있는 자리.
 */
export function boardHighlights(view: RoomView, mode: PieceKind | null, pendingVertex: string | null): BoardHighlights {
  const none = { vertices: [], edges: [], tiles: [] };
  const g = view.game;
  if (!g) return none;
  if (g.phase === 'placement' && g.placementPlayerId === view.you) {
    // 마을 자리를 고른 뒤에도 그 꼭짓점을 함께 빛내 어디에 붙이는 길인지 보이게 한다.
    if (pendingVertex) return { vertices: [pendingVertex], edges: setupRoadEdges(g.roads, pendingVertex), tiles: [] };
    return { vertices: placeableVertices(g.buildings), edges: [], tiles: [] };
  }
  if (g.phase !== 'playing' || g.currentPlayerId !== view.you) return none;
  if (g.step === 'robber') return { vertices: [], edges: [], tiles: TILES.map((t) => t.id).filter((id) => id !== g.robber) };
  if (g.step === 'road_building') return { vertices: [], edges: buildSpots(view, 'road'), tiles: [] };
  if (!mode || buildBlocker(view, mode)) return none;
  const spots = buildSpots(view, mode);
  return mode === 'road' ? { vertices: [], edges: spots, tiles: [] } : { vertices: spots, edges: [], tiles: [] };
}

export function bundleText(b: Bundle): string {
  const parts = RESOURCES.filter((r) => b[r] > 0).map((r) => `${RESOURCE_LABEL[r]} ${b[r]}`);
  return parts.length ? parts.join(', ') : '없음';
}

const CLOSE_REASON: Record<TradeCloseReason, string> = {
  cancelled: '제안을 취소했습니다',
  rejected: '제안을 거절했습니다',
  turn_end: '턴이 끝나 제안이 닫혔습니다',
  unaffordable: '제안한 자원이 바뀌어 제안이 닫혔습니다',
};

/**
 * 한 사람의 가장 긴 교역로(이어진 길)가 최장 교역로 달성과 얼마나 떨어져 있는지 알려 주는 한 줄.
 * len 은 그 사람의 가장 긴 길 칸 수.
 */
export function roadStatus(view: RoomView, owner: string, len: number, name: (id: string) => string): string {
  const g = view.game!;
  const holder = g.longestRoad.holder;
  if (holder === owner) return `최장 교역로 보유 중 (+${AWARD_POINTS}점)`;
  if (holder) {
    const top = g.longestRoad.length;
    return len > top ? '최장 교역로를 곧 가져옵니다' : `최장 교역로는 ${name(holder)} ${top}칸 · ${top + 1 - len}칸 더 이으면 가져옵니다`;
  }
  if (len >= LONGEST_ROAD_MIN) return '가장 긴 길이 같은 사람이 있어 아직 아무도 최장 교역로를 갖지 못했습니다';
  return `최장 교역로까지 ${LONGEST_ROAD_MIN - len}칸 더 (${LONGEST_ROAD_MIN}칸 이상)`;
}

/** 게임 화면에서 칸을 부르는 이름. 칸 코드(A1~E3) 대신 자원과 숫자 패로 부른다: "곡물 10", "광장" */
export function tileName(numbers: Record<string, number>, tileId: string): string {
  const t = TILE_MAP[tileId];
  if (!t) return '?';
  if (t.kind === 'plaza') return '광장';
  return numbers[tileId] ? `${RESOURCE_LABEL[t.kind]} ${numbers[tileId]}` : RESOURCE_LABEL[t.kind];
}

/** 꼭짓점·변의 이름: 닿은 칸들 사이, 바닷가면 "바닷가" */
export function spotName(numbers: Record<string, number>, kind: 'vertex' | 'edge', id: string): string {
  const tiles = (kind === 'vertex' ? VERTEX_MAP[id]?.tiles : EDGE_MAP[id]?.tiles) ?? [];
  const names = tiles.map((t) => tileName(numbers, t)).join('·');
  const coast = kind === 'vertex' ? tiles.length < 3 : tiles.length < 2;
  return coast ? `${names} 바닷가` : `${names} 사이`;
}

/** 기록 한 줄. 비공개 내용(detail)은 서버가 볼 수 있는 사람에게만 보낸다. */
export function formatEvent(e: GameEvent, players: Map<string, PlayerInfo>, me: string, numbers: Record<string, number> = {}): string {
  const place = (kind: 'vertex' | 'edge', id: string) => spotName(numbers, kind, id);
  const name = (id: string) => (id === me ? '나' : (players.get(id)?.nickname ?? '?'));
  const subj = (id: string) => (id === me ? '내가' : josa(name(id), '이/가'));
  switch (e.kind) {
    case 'game_start':
      return `게임 시작. 자리 순서: ${e.order.map(name).join(' → ')}`;
    case 'placement':
      return `${subj(e.player)} ${place('vertex', e.vertexId)}에 시작 마을과 길을 놓았습니다.${e.gained ? ` 받은 자원: ${bundleText(e.gained)}.` : ''}`;
    case 'roll': {
      const total = e.dice[0] + e.dice[1];
      if (total === 7) return `${subj(e.player)} 주사위 ${e.dice[0]}+${e.dice[1]} = 7. 기사단 동상이 움직입니다.`;
      const mine = e.detail?.[me];
      const blocked = e.blocked.length ? ` (${e.blocked.map((t) => tileName(numbers, t)).join(', ')} 칸은 동상에 막힘)` : '';
      return `${subj(e.player)} 주사위 ${e.dice[0]}+${e.dice[1]} = ${total}.${mine && bundleTotal(mine) ? ` 내 생산: ${bundleText(mine)}.` : ''}${blocked}`;
    }
    case 'discard':
      return `${subj(e.player)} 자원 ${e.count}장을 버렸습니다${e.detail ? ` (${bundleText(e.detail)})` : ''}.`;
    case 'robber':
      return `${subj(e.player)} 기사단 동상을 ${tileName(numbers, e.tileId)} 칸으로 옮겼습니다.`;
    case 'steal':
      return e.detail
        ? `${subj(e.player)} ${name(e.from)}에게서 ${RESOURCE_LABEL[e.detail]} 1장을 빼앗았습니다.`
        : `${subj(e.player)} ${name(e.from)}에게서 자원 1장을 빼앗았습니다.`;
    case 'build':
      if (e.piece === 'road') return `${subj(e.player)} ${place('edge', e.at)}에 ${e.free ? '공짜 ' : ''}길을 놓았습니다.`;
      if (e.piece === 'city') return `${subj(e.player)} ${place('vertex', e.at)}의 마을을 도시로 올렸습니다.`;
      return `${subj(e.player)} ${place('vertex', e.at)}에 마을을 지었습니다.`;
    case 'buy_dev':
      return `${subj(e.player)} 발전 카드를 샀습니다${e.detail ? ` (${DEV_LABEL[e.detail]})` : ''}.`;
    case 'play_dev':
      if (e.card === 'monopoly') return `${subj(e.player)} 독점 카드로 ${RESOURCE_LABEL[e.resources![0]]}을(를) 모두 가져갔습니다 (${e.amount ?? 0}장).`;
      if (e.card === 'year_of_plenty') return `${subj(e.player)} 풍년 카드로 ${e.resources!.map((r) => RESOURCE_LABEL[r]).join('·')}을(를) 받았습니다.`;
      return `${subj(e.player)} ${DEV_LABEL[e.card]} 카드를 썼습니다.`;
    case 'bank_trade':
      return `${subj(e.player)} ${e.ratio === 4 ? '은행' : '해상 교역로'}에서 ${RESOURCE_LABEL[e.give]} ${e.ratio}개를 ${RESOURCE_LABEL[e.get]} 1개로 바꿨습니다.`;
    case 'trade_proposed':
      return e.detail
        ? `${subj(e.from)} ${name(e.to)}에게 교환 제안: ${bundleText(e.detail.give)} ↔ ${bundleText(e.detail.get)}`
        : `${subj(e.from)} ${name(e.to)}에게 교환을 제안했습니다.`;
    case 'trade_accepted':
      return e.detail
        ? `${name(e.from)}와(과) ${name(e.to)}의 교환 성사: ${bundleText(e.detail.give)} ↔ ${bundleText(e.detail.get)}`
        : `${name(e.from)}와(과) ${name(e.to)}의 교환이 성사되었습니다.`;
    case 'trade_closed':
      if (e.reason === 'rejected') return `${subj(e.to)} ${name(e.from)}의 교환 제안을 거절했습니다.`;
      if (e.reason === 'cancelled') return `${subj(e.from)} 교환 제안을 취소했습니다.`;
      return `${name(e.from)} → ${name(e.to)}: ${CLOSE_REASON[e.reason]}.`;
    case 'award': {
      const label = e.award === 'longest_road' ? '최장 교역로' : '최강 기사단';
      const unit = e.award === 'longest_road' ? `길 ${e.size}칸` : `기사 ${e.size}장`;
      if (!e.player) return `${label}를 가진 사람이 없어졌습니다.`;
      return `${subj(e.player)} ${label}를 차지했습니다 (${unit}, +2점).`;
    }
    case 'turn_end':
      return `${subj(e.player)} 턴을 마쳤습니다.`;
    case 'game_end':
      return `게임 종료. 승리: ${e.winners.map(name).join(', ')}`;
  }
}
