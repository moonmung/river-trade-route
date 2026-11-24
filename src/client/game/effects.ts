// 새로 들어온 게임 기록에 맞춰 연출과 알림, 효과음을 낸다: 주사위, 칸 생산, 건설, 기사단 동상, 빼앗기, 교환, 달성 공지, 황금 기사단, 자랑하기.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { boardOf } from '../../shared/board';
import { DEV_LABEL, RESOURCE_LABEL } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { Resource } from '../../shared/types';
import type { BoardRenderer } from '../board/BoardRenderer';
import { josa } from '../ui/josa';
import { rollDice, settleDice } from '../dice';
import { onChatBrag } from '../net/chat';
import { showAward, showGoldenKnight } from '../ui/spectacle';
import { showToast } from '../ui/toast';
import { flyCards, holdCards, stealCard, type FlyCard } from './cardFly';
import { paradeTiming } from '../board/parade';
import { sfx } from '../sound/sfx';
import { bundleText, tileName, type PlayerInfo } from './derive';
import { resetPace, startPaced } from './pace';
import { RESOURCES } from '../../shared/constants';

/** 주사위가 멈춘 뒤 다음 행동을 열기까지: 7 은 합계 봉인이 튀어나와 두 번 흔들릴 때까지 (dice.css) */
const SEVEN_READ_MS = 1450;
/** 보통 굴림은 칸이 빛나는 것을 볼 틈. 내 손으로 날아오는 카드가 있으면 다 닿을 때까지 더 기다린다 (pace.ts) */
const ROLL_READ_MS = 600;
/** 옮긴 동상이 날아가 내려앉기까지 (BoardRenderer 의 syncRobber) */
const ROBBER_FLIGHT_MS = 1200;
/** 빼앗은 카드가 날아가기 시작하는 때: 동상이 막 옮겨 갔으면 내려앉은 뒤, 아니면(고르는 창으로 골랐으면) 바로 */
const STEAL_AFTER_LANDING_MS = ROBBER_FLIGHT_MS + 150;
const STEAL_SOON_MS = 150;

/** 날아오는 카드가 내 손에 닿는 때 (cardFly.ts 의 MINE_MS) */
const CARD_LAND_MS = 760;

/** 달성 효과음: 최장 교역로는 오르는 화음, 최강 기사단은 광장 사열의 북과 나팔 (3D 보드와 같은 박자) */
export function awardSound(award: 'longest_road' | 'largest_army'): void {
  if (award === 'longest_road') sfx.longestRoad();
  else sfx.army(paradeTiming(false));
}

/** 보드 위 꼭짓점의 화면 좌표 (렌더러가 없으면 보드 가운데) */
function boardPoint(renderer: BoardRenderer | null, vertexId: string): { x: number; y: number } {
  const layer = document.querySelector('.board-layer')?.getBoundingClientRect();
  const ox = layer?.left ?? 0;
  const oy = layer?.top ?? 0;
  const p = renderer?.spotScreenPosition('vertex', vertexId);
  if (p) return { x: ox + p.x, y: oy + p.y };
  return { x: ox + (layer?.width ?? window.innerWidth) / 2, y: oy + (layer?.height ?? window.innerHeight) / 2 };
}

function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

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
  const playersRef = useRef(players);
  playersRef.current = players;
  const youRef = useRef(view.you);
  youRef.current = view.you;

  // 자랑하기: 누가 뽐내면 모두의 화면에 달성 연출을 다시 띄운다 (글만 "뽐냅니다"로 다르다).
  useEffect(
    () =>
      onChatBrag((b) => {
        const p = playersRef.current.get(b.from);
        const colorIndex = p?.colorIndex ?? 0;
        const unit = b.award === 'longest_road' ? `이어진 길 ${b.size}칸` : `기사 ${b.size}장`;
        showAward(b.award, { colorIndex, nickname: p?.nickname ?? '?', mine: b.from === youRef.current, detail: unit, brag: true });
        rendererRef.current?.playAward(b.award, colorIndex, b.from);
        awardSound(b.award);
      }),
    [],
  );

  // 그리기 전에(useLayoutEffect) 처리한다. 굴림이 들어온 화면이 한 번 그려진 뒤에 생산 카드를 손에서 빼면
  // 주사위가 멈추기도 전에 손 장수가 +1 됐다가 돌아가며 카드가 움찔해서 결과가 먼저 보인다.
  useLayoutEffect(() => {
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
      // 이미 지난 굴림은 멈춘 것으로 쳐서 위쪽 줄에 바로 보이게 하고, 이후 굴림만 주사위가 멈출 때까지 감춘다.
      settleDice(g.events.reduce((n, e) => (e.kind === 'roll' ? e.seq : n), 0), true);
      // 지난 굴림·동상 연출을 기다리지 않고 지금 단계의 버튼과 창을 바로 연다.
      resetPace(g.events);
      return;
    }
    const fresh = g.events.filter((e) => e.seq > lastSeq.current!);
    lastSeq.current = maxSeq;
    const animate = fresh.length <= 12;

    for (const [i, e] of fresh.entries()) {
      switch (e.kind) {
        case 'roll': {
          const total = e.dice[0] + e.dice[1];
          const discard = g.discards[me];
          const mine = e.detail?.[me];
          const blocked = e.blocked.map((t) => tileName(g, t));
          // 숫자가 나온 칸에서 그 칸에 닿은 마을·도시로 자원이 솟아 날아간다 (공개 정보로 계산).
          const items: { tileId: string; vertexId: string; resource: Resource; amount: number; owner: string }[] = [];
          if (animate && total !== 7) {
            for (const tileId of e.tiles) {
              const kind = boardOf(g).tileMap[tileId]?.kind;
              // 은행에 모자라 나눠 주지 못한 자원은 날리지 않는다 (받은 장수는 서버 화면 정보에 이미 맞춰져 있다).
              if (!kind || kind === 'plaza' || e.short?.includes(kind)) continue;
              for (const b of g.buildings) {
                if (!boardOf(g).vertexMap[b.vertexId]?.tiles.includes(tileId)) continue;
                items.push({ tileId, vertexId: b.vertexId, resource: kind, amount: b.kind === 'city' ? 2 : 1, owner: b.owner });
              }
            }
          }
          // 3D 주사위가 서버가 정한 값으로 멈춘 뒤에 결과 알림과 보드 생산 연출을 낸다.
          // 다음 행동(동상 칸 빛, 버리기 창, 건설·교환 버튼)은 합계를 읽을 틈이 지나고 내 손으로 오는 카드가 다 닿은 뒤에 열린다.
          const who = e.player === me ? '나' : name(e.player);
          const open = startPaced('roll', e.seq);
          // 생산한 카드는 주사위가 구르는 동안 손 장수에 미리 보이지 않게 빼 두었다가, 멈춘 뒤 날아와 닿을 때 더한다.
          const release = holdCards(items.flatMap((it) => Array.from({ length: it.amount }, () => ({ player: it.owner, resource: it.resource }))));
          void rollDice(e.dice, { who, colorIndex: color(e.player), mine: e.player === me, animate, seq: e.seq }).then(() => {
            open(animate ? (total === 7 ? SEVEN_READ_MS : ROLL_READ_MS) : 0);
            // 같은 카드를 아래 flyCards 가 이 자리에서 다시 빼 두므로 장수가 그사이 튀지 않는다.
            release();
            if (total === 7) {
              if (animate) sfx.seven();
              if (discard) {
                showToast(`7! 자원 ${discard}장을 버려야 합니다.`, 'warn', 4200);
                sfx.alert();
                buzz(160);
              }
              return;
            }
            if (mine && Object.values(mine).some((n) => n > 0)) showToast(`${total} · 내 생산 ${bundleText(mine)}`, 'good', 3200);
            if (blocked.length) showToast(`${blocked.join(', ')} 칸은 기사단 동상에 막혀 생산하지 않았습니다.`, 'warn', 3200);
            if (!animate) return;
            rendererRef.current?.playRoll(e.tiles, e.blocked, items);
            // 내 자원이 나온 칸만 환해지고, 생산물이 마을·도시에 닿을 즈음 카드가 그 자리에서 손으로 날아든다.
            // 내 카드가 먼저 날아온다 (내 버튼은 내 카드가 다 닿으면 열린다).
            const cards: FlyCard[] = [];
            let n = 0;
            [...items.filter((it) => it.owner === me), ...items.filter((it) => it.owner !== me)].forEach((it) => {
              const from = boardPoint(rendererRef.current, it.vertexId);
              for (let k = 0; k < it.amount; k++) {
                cards.push({ player: it.owner, resource: it.resource, from, delay: 900 + n * 130, mine: it.owner === me });
                n++;
              }
            });
            rendererRef.current?.glowTiles(items.filter((it) => it.owner === me).map((it) => it.tileId));
            flyCards(cards, { reduced: reducedMotion() });
            // 내 카드가 손에 닿을 때마다 한 음씩 오르는 소리, 남만 생산했으면 작은 소리 한 번
            const mineCards = cards.filter((c) => c.mine).slice(0, 10);
            mineCards.forEach((c, k) => window.setTimeout(() => sfx.cardIn(k), (c.delay ?? 0) + CARD_LAND_MS));
            if (!mineCards.length && cards.length) window.setTimeout(() => sfx.production(), 900);
          }, () => {
            open();
            release();
          });
          break;
        }
        case 'placement':
          if (animate) sfx.build(e.step === 'road' ? 'road' : 'village');
          // 두 번째 시작 마을: 닿은 칸의 자원이 마을 자리에서 손으로 날아든다.
          if (animate && e.gained) {
            const from = boardPoint(rendererRef.current, e.vertexId);
            const cards: FlyCard[] = RESOURCES.flatMap((r) => Array.from({ length: e.gained![r] }, () => r)).map((r, i) => ({
              player: e.player,
              resource: r,
              from,
              delay: 450 + i * 150,
              mine: e.player === me,
            }));
            if (e.player === me && cards.length) {
              rendererRef.current?.glowTiles((boardOf(g).vertexMap[e.vertexId]?.tiles ?? []).filter((t) => boardOf(g).tileMap[t]?.kind !== 'plaza'));
            }
            flyCards(cards, { reduced: reducedMotion() });
          }
          break;
        case 'order_roll':
          if (animate) sfx.diceTumble();
          break;
        case 'order_tie':
          if (e.players.includes(me)) showToast(`주사위가 ${e.total}(으)로 같습니다. 다시 굴리세요.`, 'warn', 3200);
          break;
        case 'game_start':
          if (e.order.length) showToast(`자리 순서: ${e.order.map((id) => (id === me ? '나' : name(id))).join(' → ')}`, 'good', 4200);
          break;
        case 'timeout':
          if (e.player === me) {
            showToast('시간이 다 되어 자동으로 진행했습니다.', 'warn', 3600);
            sfx.alert();
          }
          else showToast(`${name(e.player)}의 시간이 다 되어 자동으로 진행했습니다.`, 'info', 2600);
          break;
        case 'robber': {
          // 3D 보드에서는 동상이 들려 날아가 내려앉는다. 내려앉은 뒤에 빼앗기 창과 버튼을 연다.
          startPaced('robber', e.seq)(animate && rendererRef.current ? ROBBER_FLIGHT_MS : 0);
          if (animate) sfx.robber(rendererRef.current ? (ROBBER_FLIGHT_MS - 150) / 1000 : 0);
          if (e.player !== me) showToast(`${josa(name(e.player), '이/가')} 기사단 동상을 ${tileName(g, e.tileId)} 칸으로 옮겼습니다.`, 'warn');
          // 동상이 선 칸에 자원을 가진 상대가 없으면 아무것도 빼앗지 않고 넘어간다. 옮긴 사람에게 그렇다고 알려 준다.
          const stoleLater = fresh.slice(i + 1).some((x) => x.kind === 'steal' && x.player === e.player);
          const last = fresh.slice(i + 1).every((x) => x.kind !== 'robber');
          if (e.player === me && !stoleLater && last && g.step !== 'steal') {
            showToast(`${tileName(g, e.tileId)} 칸에 닿은 상대 중 자원을 가진 사람이 없어 빼앗지 않았습니다.`, 'info', 3600);
          }
          break;
        }
        case 'steal': {
          // 뺏긴 사람의 카드 뭉치에서 가져간 사람 쪽으로 카드가 날아간다. 모두에게 보이고, 둘 중 하나가 나면 자원 그림이 보인다.
          const justMoved = fresh.slice(0, i).some((x) => x.kind === 'robber' && x.player === e.player);
          const delay = animate ? (justMoved ? STEAL_AFTER_LANDING_MS : STEAL_SOON_MS) : 0;
          stealCard({ thief: e.player, victim: e.from, resource: e.detail ?? null, me, delay, reduced: !animate || reducedMotion() });
          const what = e.detail ? RESOURCE_LABEL[e.detail] : '자원';
          window.setTimeout(() => {
            if (animate) sfx.steal();
            if (e.from === me) {
              showToast(`${josa(name(e.player), '이/가')} 내 ${what} 1장을 빼앗아 갔습니다.`, 'error', 4000);
              buzz(120);
            } else if (e.player === me) showToast(`${name(e.from)}에게서 ${what} 1장을 빼앗았습니다.`, 'good', 3600);
            else showToast(`${josa(name(e.player), '이/가')} ${name(e.from)}에게서 자원 1장을 빼앗았습니다.`, 'info', 3600);
          }, delay);
          break;
        }
        case 'build':
          if (animate) sfx.build(e.piece);
          break;
        case 'buy_dev':
          if (animate) sfx.buyDev();
          if (e.player === me && e.detail) showToast(`발전 카드: ${DEV_LABEL[e.detail]}`, 'good');
          break;
        case 'play_dev': {
          // 최강 기사단을 이미 가진 사람이 기사를 쓰면 황금 기사단으로 크게 출격한다 (이번 기사로 막 달성했으면 달성 공지가 뜬다).
          const justWon = fresh.slice(i + 1).some((x) => x.kind === 'award' && x.award === 'largest_army' && x.player === e.player);
          if (e.card === 'knight' && g.largestArmy.holder === e.player && !justWon) {
            const knights = g.players.find((p) => p.id === e.player)?.knightsPlayed ?? g.largestArmy.size;
            showGoldenKnight({ colorIndex: color(e.player), nickname: name(e.player), mine: e.player === me, knights });
            if (animate) rendererRef.current?.playGoldenKnight(e.player);
            sfx.playDev(e.card);
            sfx.army(paradeTiming(true), true);
            buzz(200);
            break;
          }
          if (animate) sfx.playDev(e.card);
          if (e.player !== me) showToast(`${josa(name(e.player), '이/가')} ${DEV_LABEL[e.card]} 카드를 썼습니다.`);
          break;
        }
        case 'award':
          if (e.player) {
            // 화면 위쪽에 "빨강 플레이어 최장 교역로 달성" 공지를 크게 띄운다.
            const unit = e.award === 'longest_road' ? `이어진 길 ${e.size}칸` : `기사 ${e.size}장`;
            const from = e.previous ? ` · ${name(e.previous)}에게서 가져옴` : '';
            showAward(e.award, { colorIndex: color(e.player), nickname: name(e.player), mine: e.player === me, detail: `${unit} · +2점${from}` });
            rendererRef.current?.playAward(e.award, color(e.player), e.player);
            awardSound(e.award);
            buzz(180);
          }
          break;
        case 'bank_trade':
          // 해상 교역로(3:1·2:1)로 바꿨으면 그 사람의 교역로 부두에 배가 들어와 짐을 주고받는다 (부두는 렌더러가 비율로 고른다).
          if (animate && e.harbor) rendererRef.current?.playHarborTrade(e.player, e.give, e.get);
          if (animate) {
            if (e.harbor && rendererRef.current) sfx.ship();
            else sfx.bankTrade();
          }
          break;
        // 교환 제안·응답·성사·거절·취소는 알림 대신 왼쪽 위 교환 증서에 적고 도장을 찍는다 (trade.tsx 의 TradeDeeds).
        case 'trade_proposed':
          if (e.to.includes(me)) {
            sfx.tradeOffer();
            buzz(120);
          }
          break;
        case 'trade_accepted':
          if (animate) sfx.tradeDone();
          if (e.from === me || e.to === me) buzz(60);
          break;
        case 'game_end':
          sfx.gameEnd(e.winners.includes(me));
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
        sfx.myTurn();
        buzz(80);
      }
    }
  }, [view, players]);
}
