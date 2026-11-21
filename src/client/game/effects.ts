// 새로 들어온 게임 기록에 맞춰 연출과 알림을 낸다: 주사위, 칸 생산, 기사단 동상, 빼앗기, 달성 두루마리.
import { useEffect, useRef } from 'react';
import { VERTEX_MAP } from '../../shared/board';
import { DEV_LABEL, RESOURCE_LABEL, TILE_MAP } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { Resource } from '../../shared/types';
import type { BoardRenderer } from '../board/BoardRenderer';
import { josa } from '../ui/josa';
import { showAward, showDice } from '../ui/spectacle';
import { showToast } from '../ui/toast';
import { bundleText, tileName, type PlayerInfo } from './derive';

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
    const color = (id: string) => players.get(id)?.colorIndex ?? 0;
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
        case 'roll': {
          const total = e.dice[0] + e.dice[1];
          if (animate) showDice(e.dice, e.player === me ? '나' : name(e.player), color(e.player));
          if (total === 7) {
            if (g.discards[me]) {
              showToast(`7! 자원 ${g.discards[me]}장을 버려야 합니다.`, 'warn', 4200);
              buzz(160);
            }
            break;
          }
          const mine = e.detail?.[me];
          if (mine && Object.values(mine).some((n) => n > 0)) showToast(`${total} · 내 생산 ${bundleText(mine)}`, 'good', 3200);
          if (e.blocked.length) showToast(`${e.blocked.map((t) => tileName(g.numbers, t)).join(', ')} 칸은 기사단 동상에 막혀 생산하지 않았습니다.`, 'warn', 3200);
          if (animate) {
            // 숫자가 나온 칸에서 그 칸에 닿은 마을·도시로 자원이 솟아 날아간다 (공개 정보로 계산).
            const items: { tileId: string; vertexId: string; resource: Resource; amount: number }[] = [];
            for (const tileId of e.tiles) {
              const kind = TILE_MAP[tileId]?.kind;
              if (!kind || kind === 'plaza') continue;
              for (const b of g.buildings) {
                if (!VERTEX_MAP[b.vertexId]?.tiles.includes(tileId)) continue;
                items.push({ tileId, vertexId: b.vertexId, resource: kind, amount: b.kind === 'city' ? 2 : 1 });
              }
            }
            window.setTimeout(() => rendererRef.current?.playRoll(e.tiles, e.blocked, items), 1100);
          }
          break;
        }
        case 'robber':
          if (e.player !== me) showToast(`${josa(name(e.player), '이/가')} 기사단 동상을 ${tileName(g.numbers, e.tileId)} 칸으로 옮겼습니다.`, 'warn');
          break;
        case 'steal':
          if (e.from === me) {
            showToast(`${josa(name(e.player), '이/가')} ${e.detail ? RESOURCE_LABEL[e.detail] : '자원'} 1장을 빼앗아 갔습니다.`, 'error', 4000);
            buzz(120);
          } else if (e.player === me && e.detail) showToast(`${name(e.from)}에게서 ${RESOURCE_LABEL[e.detail]} 1장을 빼앗았습니다.`, 'good');
          break;
        case 'buy_dev':
          if (e.player === me && e.detail) showToast(`발전 카드: ${DEV_LABEL[e.detail]}`, 'good');
          break;
        case 'play_dev':
          if (e.player !== me) showToast(`${josa(name(e.player), '이/가')} ${DEV_LABEL[e.card]} 카드를 썼습니다.`);
          break;
        case 'award':
          if (e.player) {
            // 화면 위쪽에 "빨강 플레이어 최장 교역로 달성" 공지를 크게 띄운다.
            const unit = e.award === 'longest_road' ? `이어진 길 ${e.size}칸` : `기사 ${e.size}장`;
            const from = e.previous ? ` · ${name(e.previous)}에게서 가져옴` : '';
            showAward(e.award, { colorIndex: color(e.player), nickname: name(e.player), mine: e.player === me, detail: `${unit} · +2점${from}` });
            rendererRef.current?.playAward(e.award, color(e.player), e.player);
            buzz(180);
          }
          break;
        // 교환 제안·응답·성사·거절·취소는 알림 대신 왼쪽 위 교환 증서에 적고 도장을 찍는다 (trade.tsx 의 TradeDeeds).
        case 'trade_proposed':
          if (e.to.includes(me)) buzz(120);
          break;
        case 'trade_accepted':
          if (e.from === me || e.to === me) buzz(60);
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
        showToast(g.phase === 'placement' ? '시작 마을과 길을 놓을 차례입니다.' : '내 차례입니다 · 주사위를 굴리세요', 'good', 3000);
        buzz(80);
      }
    }
  }, [view, players]);
}
