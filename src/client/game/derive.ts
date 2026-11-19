// 서버가 보낸 화면 정보에서 버튼 활성화·안내 문구를 계산한다. 실제 판정은 서버가 다시 한다.
import {
  BUILD_COST,
  CONTRACT_MAP,
  MARKET_GIVE,
  MAX_SETTLEMENTS,
  RESOURCES,
  RESOURCE_LABEL,
  TILE_KIND_LABEL,
  TILE_MAP,
  hasBundle,
} from '../../shared/constants';
import type { GameView, RoomView } from '../../shared/protocol';
import { buildableTiles, placeableTiles } from '../../shared/rules';
import type { Bundle, ContractId, GameEvent, TradeCloseReason } from '../../shared/types';
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

export function canAct(view: RoomView): boolean {
  return isMyTurn(view) && (view.game?.actionsLeft ?? 0) > 0;
}

export function mySettlementCount(g: GameView, me: string): number {
  return g.settlements.filter((s) => s.owner === me).length;
}

/** 거점 건설을 할 수 없는 이유 (할 수 있으면 null) */
export function buildBlocker(view: RoomView): string | null {
  const g = view.game;
  if (!g || g.phase !== 'playing') return '라운드가 시작된 뒤 지을 수 있습니다.';
  if (g.currentPlayerId !== view.you) return '내 차례에만 지을 수 있습니다.';
  if (g.actionsLeft <= 0) return '이번 턴의 행동을 모두 썼습니다.';
  if (mySettlementCount(g, view.you) >= MAX_SETTLEMENTS) return `거점은 최대 ${MAX_SETTLEMENTS}개까지입니다.`;
  if (!hasBundle(g.myResources, BUILD_COST)) return '목재 1개와 석재 1개가 필요합니다.';
  if (buildableTiles(g.settlements, view.you).length === 0) return '내 거점과 닿은 빈 생산 칸이 없습니다.';
  return null;
}

export function marketBlocker(view: RoomView): string | null {
  const g = view.game;
  if (!g || g.phase !== 'playing') return '라운드가 시작된 뒤 교환할 수 있습니다.';
  if (g.currentPlayerId !== view.you) return '내 차례에만 시장을 이용할 수 있습니다.';
  if (g.actionsLeft <= 0) return '이번 턴의 행동을 모두 썼습니다.';
  if (!RESOURCES.some((r) => g.myResources[r] >= MARKET_GIVE)) return '같은 종류 자원 2개가 필요합니다.';
  return null;
}

export function tradeBlocker(view: RoomView): string | null {
  const g = view.game;
  if (!g || g.phase !== 'playing') return '라운드가 시작된 뒤 교환할 수 있습니다.';
  if (g.currentPlayerId !== view.you) return '차례인 사람만 교환을 제안할 수 있습니다.';
  if (g.actionsLeft <= 0) return '이번 턴의 행동을 모두 썼습니다.';
  if (g.trade) return '이미 열린 교환 제안이 있습니다.';
  if (RESOURCES.every((r) => g.myResources[r] === 0)) return '낼 자원이 없습니다.';
  return null;
}

export function deliverBlocker(view: RoomView, contractId: ContractId): string | null {
  const g = view.game;
  const c = CONTRACT_MAP[contractId];
  if (!g || g.phase !== 'playing') return '라운드가 시작된 뒤 납품할 수 있습니다.';
  const status = g.contracts.find((x) => x.id === contractId);
  if (status?.completedBy) return '이번 라운드에 이미 완료된 계약입니다.';
  if (g.currentPlayerId !== view.you) return '내 차례에만 납품할 수 있습니다.';
  if (g.actionsLeft <= 0) return '이번 턴의 행동을 모두 썼습니다.';
  if (!hasBundle(g.myResources, c.cost)) return `${c.name}에 필요한 자원이 부족합니다.`;
  return null;
}

export function highlightTiles(view: RoomView, buildMode: boolean): string[] {
  const g = view.game;
  if (!g) return [];
  if (g.phase === 'placement' && g.placementPlayerId === view.you) return placeableTiles(g.settlements);
  if (buildMode && !buildBlocker(view)) return buildableTiles(g.settlements, view.you);
  return [];
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
  no_actions: '행동이 남지 않아 제안이 닫혔습니다',
};

/** 기록 한 줄. 비공개 내용(detail)은 서버가 볼 수 있는 사람에게만 보낸다. */
export function formatEvent(e: GameEvent, players: Map<string, PlayerInfo>, me: string): string {
  const name = (id: string) => (id === me ? '나' : (players.get(id)?.nickname ?? '?'));
  const subj = (id: string) => (id === me ? '내가' : josa(name(id), '이/가'));
  switch (e.kind) {
    case 'game_start':
      return `게임 시작. 자리 순서: ${e.order.map(name).join(' → ')}`;
    case 'placement':
      return `${subj(e.player)} ${e.tileId}(${TILE_KIND_LABEL[TILE_MAP[e.tileId].kind]})에 시작 거점을 놓았습니다.`;
    case 'round_start': {
      const mine = e.detail?.[me];
      const myText = mine ? ` 내 생산: ${bundleText(mine)}.` : '';
      return `${e.round}라운드 시작 · 예보 ${RESOURCE_LABEL[e.forecast]} · 선 ${name(e.firstPlayer)}.${myText}`;
    }
    case 'build':
      return `${subj(e.player)} ${e.tileId}(${TILE_KIND_LABEL[TILE_MAP[e.tileId].kind]})에 거점을 지었습니다.`;
    case 'market':
      return e.detail
        ? `${subj(e.player)} 시장에서 ${RESOURCE_LABEL[e.detail.give]} 2개를 ${RESOURCE_LABEL[e.detail.get]} 1개로 바꿨습니다.`
        : `${subj(e.player)} 시장에서 교환했습니다.`;
    case 'deliver':
      return `${subj(e.player)} ${CONTRACT_MAP[e.contractId].name}을(를) 납품해 ${e.points}점을 얻었습니다.`;
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
    case 'turn_end':
      return `${subj(e.player)} 턴을 마쳤습니다.`;
    case 'game_end':
      return `게임 종료. 승리: ${e.winners.map(name).join(', ')}`;
  }
}
