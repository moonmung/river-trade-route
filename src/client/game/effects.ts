// 새로 들어온 게임 기록에 맞춰 짧은 연출과 알림을 낸다.
import { useEffect, useRef } from 'react';
import { CONTRACT_MAP, RESOURCES, TILE_MAP } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { Resource } from '../../shared/types';
import type { BoardRenderer } from '../board/BoardRenderer';
import { josa } from '../ui/josa';
import { showToast } from '../ui/toast';
import { bundleText, type PlayerInfo } from './derive';

function buzz(ms: number): void {
  // 브라우저는 사용자가 화면을 한 번이라도 누르기 전에는 진동을 막는다.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 진동을 지원하지 않는 기기 */
  }
}

export function useGameEffects(view: RoomView, renderer: BoardRenderer | null, players: Map<string, PlayerInfo>): void {
  const lastSeq = useRef<number | null>(null);
  const lastGame = useRef<number>(view.gameNumber);
  const lastTurn = useRef<string | null>(null);
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  useEffect(() => {
    const g = view.game;
    if (!g) return;
    const me = view.you;
    const name = (id: string) => players.get(id)?.nickname ?? '?';
    const maxSeq = g.events.length ? g.events[g.events.length - 1].seq : 0;

    if (lastSeq.current === null || lastGame.current !== view.gameNumber) {
      // 처음 받은 화면(새로고침·재접속 포함)은 지난 기록을 다시 연출하지 않는다.
      lastSeq.current = maxSeq;
      lastGame.current = view.gameNumber;
      lastTurn.current = g.currentPlayerId ?? g.placementPlayerId;
      return;
    }
    const fresh = g.events.filter((e) => e.seq > lastSeq.current!);
    lastSeq.current = maxSeq;
    const animate = fresh.length <= 12;

    for (const e of fresh) {
      switch (e.kind) {
        case 'round_start': {
          const mine = e.detail?.[me];
          showToast(`${e.round}라운드 시작 · 내 생산 ${mine ? bundleText(mine) : '없음'}`, 'good', 3600);
          if (animate) {
            const items = g.settlements
              .map((s) => {
                const kind = TILE_MAP[s.tileId]?.kind;
                if (!kind || kind === 'market') return null;
                return {
                  tileId: s.tileId,
                  resource: kind as Resource,
                  amount: 1 + (kind === e.forecast ? 1 : 0),
                  colorIndex: players.get(s.owner)?.colorIndex ?? 0,
                };
              })
              .filter((x): x is NonNullable<typeof x> => !!x);
            rendererRef.current?.playProduction(items);
          }
          break;
        }
        case 'deliver': {
          const c = CONTRACT_MAP[e.contractId];
          if (e.player !== me) showToast(`${josa(name(e.player), '이/가')} ${c.name}을(를) 납품했습니다 (+${e.points}점).`);
          else showToast(`${c.name} 납품 완료 · +${e.points}점`, 'good');
          if (animate) {
            const from = g.settlements.filter((s) => s.owner === e.player).map((s) => s.tileId);
            const tokens: Resource[] = RESOURCES.flatMap((r) => Array<Resource>(c.cost[r]).fill(r));
            rendererRef.current?.playDelivery(from, tokens, e.points);
          }
          break;
        }
        case 'trade_proposed':
          if (e.to === me) {
            showToast(`${name(e.from)}의 교환 제안이 도착했습니다.`, 'warn', 4000);
            buzz(120);
          }
          break;
        case 'trade_accepted':
          if (e.from === me) showToast(`${josa(name(e.to), '이/가')} 교환을 수락했습니다.`, 'good');
          else if (e.to === me) showToast('교환이 성사되었습니다.', 'good');
          break;
        case 'trade_closed':
          if (e.from === me && e.reason === 'rejected') showToast(`${josa(name(e.to), '이/가')} 교환 제안을 거절했습니다.`, 'warn');
          if (e.to === me && e.reason !== 'rejected') showToast(`${name(e.from)}의 교환 제안이 닫혔습니다.`);
          break;
        case 'game_end':
          buzz(200);
          break;
        default:
          break;
      }
    }

    const turn = g.currentPlayerId ?? g.placementPlayerId;
    if (turn !== lastTurn.current) {
      lastTurn.current = turn;
      if (turn === me) {
        showToast(g.phase === 'placement' ? '시작 거점을 놓을 차례입니다.' : '내 차례입니다 · 행동 2회', 'good', 3000);
        buzz(80);
      }
    }
  }, [view, players]);
}
