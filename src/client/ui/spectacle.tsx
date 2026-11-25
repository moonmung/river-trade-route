// 큰 연출: 주사위 굴림(dice/ 의 3D 주사위가 멈춘 뒤 합계), 달성(최장 교역로·최강 기사단) 공지와 자랑, 황금 기사단 출격, 승리와 승리 자랑.
// 토스트와 같은 방식의 작은 전역 저장소로 띄운다.
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { Resource } from '../../shared/types';
import { victoryStepLabel, type VictoryPlan } from '../board/victory';
import { DiceShowHost } from '../dice/DiceShow';
import { colorWord } from '../game/derive';
import { bragWait, sendChatBrag } from '../net/chat';
import { sfx } from '../sound/sfx';
import { playerColor } from '../theme';
import { ArtImg } from './art';
import { nextBragLine } from './bragLines';
import { CrownIcon, ResourceIcon } from './icons';
import { josa } from './josa';
import { showToast } from './toast';

export interface AwardWho {
  colorIndex: number;
  nickname: string;
  /** 화면 주인이 달성했는지 */
  mine: boolean;
  /** "이어진 길 6칸 · +2점" 같은 덧붙임 */
  detail: string;
  /** 이미 가진 달성을 뽐내는 자랑하기 (달성 공지와 같은 연출에 글만 다르다) */
  brag?: boolean;
  /** 자랑할 때 함께 뜨는 한마디 */
  quote?: string;
}

/** 황금 기사단: 최강 기사단을 가진 사람이 기사 카드를 썼다 */
export interface GoldenShow {
  id: number;
  colorIndex: number;
  nickname: string;
  mine: boolean;
  /** 쓴 기사 장수 (이번 장 포함) */
  knights: number;
}

export interface AwardShow extends AwardWho {
  id: number;
  award: 'longest_road' | 'largest_army';
}

const AWARD_LABEL: Record<AwardShow['award'], string> = { longest_road: '최장 교역로', largest_army: '최강 기사단' };
/** 공지가 떠 있는 시간 (CSS 의 award-banner-life 와 같다) */
const AWARD_MS = 4200;
/** 황금 기사단 공지가 떠 있는 시간 (CSS 의 golden-banner-life 와 같다) */
const GOLDEN_MS = 3600;
/** 승리 자랑 한마디가 떠 있는 시간 (CSS 의 victory-quote-life 와 같다) */
const VICTORY_QUOTE_MS = 3800;

/** 승리 연출에서 점수를 셀 때마다 오른쪽 위에 한 장씩 놓이는 카드 */
export interface VictoryCard {
  /** 카드 그림 주소 (ui/art) */
  art: string;
  title: string;
  points: number;
  /** "2번째 건물", "길 11개" 같은 작은 설명 줄 */
  lines: string[];
  /** 건물이 닿은 땅: 자원과 숫자 패 */
  tiles?: { resource: Resource; number: number | null }[];
  /** 모아 보기 카드: 더한 점수 대신 모두 합친 점수를 적는다 */
  total?: boolean;
}

/** 승리 연출: 이긴 사람의 건물을 차례로 비추며 점수를 센 뒤 승리를 알린다 (3D 보드의 playVictory 와 같은 박자) */
export interface VictoryShow {
  id: number;
  colorIndex: number;
  nickname: string;
  mine: boolean;
  winPoints: number;
  plan: VictoryPlan;
  /** plan.steps 와 같은 차례로 놓을 카드 */
  cards: VictoryCard[];
  /** 마무리에 맨 위로 놓는 모아 보기 카드 */
  summary: VictoryCard;
  /** 연출을 시작하기까지 (마지막에 지은 조각이 솟아오를 틈) */
  delay: number;
  /** 건너뛰기를 눌렀을 때 (3D 보드 연출을 멈춘다) */
  onSkip?: () => void;
}

/** 이긴 사람이 승리를 뽐내며 외친 한마디 */
export interface VictoryQuote {
  id: number;
  colorIndex: number;
  nickname: string;
  mine: boolean;
  quote: string;
}

interface State {
  award: AwardShow | null;
  golden: GoldenShow | null;
  victory: VictoryShow | null;
  quote: VictoryQuote | null;
}

let state: State = { award: null, golden: null, victory: null, quote: null };
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** 달성 공지: 화면 위쪽에 "철수 최장 교역로 달성"을 그 사람 색으로 크게 띄운다 (약 4초) */
export function showAward(award: AwardShow['award'], who: AwardWho): void {
  const id = nextId++;
  state = { ...state, award: { id, award, ...who } };
  emit();
  window.setTimeout(() => {
    if (state.award?.id !== id) return;
    state = { ...state, award: null };
    emit();
  }, AWARD_MS);
}

/** 황금 기사단 출격: 최강 기사단을 가진 사람이 기사를 쓰면 금빛 글자를 달성 공지보다 크게 띄운다 (약 3.6초) */
export function showGoldenKnight(who: Omit<GoldenShow, 'id'>): void {
  const id = nextId++;
  state = { ...state, golden: { id, ...who } };
  emit();
  window.setTimeout(() => {
    if (state.golden?.id !== id) return;
    state = { ...state, golden: null };
    emit();
  }, GOLDEN_MS);
}

/** 승리 자랑: 이긴 사람의 한마디를 두루마리처럼 화면 아래쪽에 띄운다. 새로 뽐내면 앞의 것을 바로 바꾼다. */
export function showVictoryQuote(who: Omit<VictoryQuote, 'id'>): void {
  const id = nextId++;
  state = { ...state, quote: { id, ...who } };
  emit();
  window.setTimeout(() => {
    if (state.quote?.id !== id) return;
    state = { ...state, quote: null };
    emit();
  }, VICTORY_QUOTE_MS);
}

/**
 * 승리 연출을 띄운다. 연출이 끝날 때까지(useVictoryActive) 결과 창을 미루고 화면 위아래에 영화 띠를 두른다.
 * 같은 판의 달성 공지는 승리 연출이 대신 보여 주므로 지운다.
 */
export function showVictory(show: Omit<VictoryShow, 'id'>): void {
  const id = nextId++;
  state = { ...state, award: null, golden: null, victory: { id, ...show } };
  emit();
  window.setTimeout(() => {
    if (state.victory?.id === id) hideVictory();
  }, show.delay + show.plan.end);
}

export function hideVictory(): void {
  if (!state.victory) return;
  state = { ...state, victory: null };
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 승리 연출이 진행 중인지 (그동안 결과 창을 열지 않고 손 카드·패널을 숨긴다) */
export function useVictoryActive(): boolean {
  return useSyncExternalStore(subscribe, () => state.victory !== null);
}

/** 위아래 영화 띠 높이 (px). 3D 보드는 그 사이 가운데에 장면을 맞춘다. */
export function victoryBarHeight(): number {
  return Math.round(Math.min(96, Math.max(46, window.innerHeight * 0.1)));
}

export function SpectacleHost() {
  const s = useSyncExternalStore(subscribe, () => state);
  return (
    <>
      <DiceShowHost />
      {s.award && <AwardBanner key={s.award.id} show={s.award} />}
      {s.golden && <GoldenBanner key={s.golden.id} show={s.golden} />}
      {s.victory && <VictoryOverlay key={s.victory.id} show={s.victory} />}
      {s.quote && <VictoryQuoteBanner key={s.quote.id} show={s.quote} />}
    </>
  );
}

/**
 * 승리 연출 화면: 위아래 먹빛 영화 띠. 위 가운데에 걸린 점수판에서 카메라가 건물에 닿을 때마다 점수가 오르고 점수 구슬이 차오르며,
 * 오른쪽 위에는 센 것이 카드로 한 장씩 놓인다(마을·도시 카드에는 몇 번째로 언제 지었는지와 닿은 땅, 길 카드에는 길 수, 기사 카드에는 쓴 기사 수).
 * 다 세면 모아 보기 카드가 맨 위에 놓이고 가운데에 이긴 사람 이름과 "승리!"가 크게 튀어나온다.
 * 아래 띠에는 이긴 사람에게만 보이는 자랑하기와 건너뛰기가 있다.
 */
function VictoryOverlay({ show }: { show: VictoryShow }) {
  const { plan } = show;
  const [reached, setReached] = useState(0);
  const [finale, setFinale] = useState(false);
  useEffect(() => {
    const timers = plan.steps.map((step, i) =>
      window.setTimeout(() => {
        setReached(i + 1);
        sfx.victoryCount(i, step.kind === 'longest_road' || step.kind === 'largest_army' || step.kind === 'cards');
      }, show.delay + step.at),
    );
    timers.push(
      window.setTimeout(() => {
        setFinale(true);
        sfx.gameEnd(show.mine);
      }, show.delay + plan.finaleAt),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [show]);
  const step = reached ? plan.steps[reached - 1] : null;
  const total = step?.total ?? 0;
  const color = playerColor(show.colorIndex);
  const bar = victoryBarHeight();
  const dealt = finale ? [...show.cards.slice(0, reached), show.summary] : show.cards.slice(0, reached);
  const skip = () => {
    show.onSkip?.();
    hideVictory();
  };
  return (
    <div
      className={`victory-show ${finale ? 'is-finale' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${show.nickname}${show.mine ? '(나)' : ''} 승리. 승점 ${plan.score}점`}
      style={
        {
          ['--pc' as string]: color.hex,
          ['--pc-ink' as string]: color.ink,
          ['--victory-bar' as string]: `${bar}px`,
          ['--victory-life' as string]: `${show.delay + plan.end}ms`,
        } as CSSProperties
      }
    >
      <div className="victory-bar victory-bar-top" />
      <div className="victory-plate" aria-hidden>
        <div className="victory-plate-who">
          <CrownIcon size={16} />
          <b className="victory-name">{show.nickname}</b>
          {show.mine ? ' (나)' : ''}
        </div>
        <div className="victory-plate-score">
          <b key={total} className={`victory-total ${total ? 'is-bump' : ''}`}>
            {total}
          </b>
          <span className="victory-unit">점</span>
        </div>
        <div className="victory-pips">
          {Array.from({ length: Math.max(plan.score, 1) }, (_, i) => (
            <i key={i} className={`${i < total ? 'is-on' : ''} ${i === show.winPoints - 1 ? 'is-goal' : ''}`} />
          ))}
        </div>
        <div key={reached} className="victory-step">
          {step ? (
            <>
              {victoryStepLabel(step)} <b>+{step.points}</b>
            </>
          ) : (
            `승점 ${show.winPoints}점 달성`
          )}
        </div>
      </div>
      <VictoryCardPile cards={dealt} />
      <div className="victory-bar victory-bar-bottom">
        {show.mine && <VictoryBragButton />}
        <button className="victory-skip" onClick={skip}>
          건너뛰기
        </button>
      </div>
      {finale && (
        <div className="victory-finale" aria-hidden>
          <div className="victory-finale-name">
            {show.nickname}
            {show.mine ? ' (나)' : ''}
          </div>
          <div className="victory-finale-word">승리!</div>
          <div className="victory-finale-sub">승점 {plan.score}점</div>
        </div>
      )}
    </div>
  );
}

/**
 * 오른쪽 위 카드 더미: 새 카드가 오른쪽에서 미끄러져 들어와 맨 앞에 놓이고 앞서 놓인 카드는 한 장씩 뒤로 밀려 비스듬히 겹친다.
 * 맨 앞 네 장까지만 보인다.
 */
function VictoryCardPile({ cards }: { cards: VictoryCard[] }) {
  const from = Math.max(0, cards.length - 4);
  return (
    <div className="victory-cards" aria-hidden>
      {cards.slice(from).map((card, i, shown) => (
        <VictoryCardView key={from + i} card={card} depth={shown.length - 1 - i} />
      ))}
    </div>
  );
}

function VictoryCardView({ card, depth }: { card: VictoryCard; depth: number }) {
  return (
    <div className={`victory-card ${depth ? '' : 'is-front'} ${card.total ? 'is-total' : ''}`} style={{ ['--depth' as string]: depth, zIndex: 10 - depth } as CSSProperties}>
      <b className="vc-points">{card.total ? `${card.points}점` : `+${card.points}`}</b>
      <div className="vc-art">
        <ArtImg src={card.art} size={76} />
      </div>
      <div className="vc-title">{card.title}</div>
      {card.tiles && card.tiles.length > 0 && (
        <div className="vc-tiles">
          {card.tiles.map((t, k) => (
            <span key={k} className={`vc-tile ${t.number === 6 || t.number === 8 ? 'is-hot' : ''}`}>
              <ResourceIcon kind={t.resource} size={15} />
              {t.number ?? ''}
            </span>
          ))}
        </div>
      )}
      {card.lines.map((line, k) => (
        <div key={k} className="vc-line">
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * 이긴 사람의 승리 자랑 단추 (승리 연출 아래 띠와 결과 창). 누를 때마다 중세풍 한마디가 한 줄씩 바뀌어 모두의 화면에 뜬다 (2초에 한 번).
 */
export function VictoryBragButton({ className = 'victory-brag' }: { className?: string }) {
  const [cooling, setCooling] = useState(false);
  useEffect(() => {
    if (!cooling) return;
    const t = window.setTimeout(() => setCooling(false), Math.max(200, bragWait('victory')));
    return () => window.clearTimeout(t);
  }, [cooling]);
  const brag = () => {
    if (bragWait('victory') > 0) return;
    setCooling(true);
    void sendChatBrag('victory', nextBragLine('victory')).then((res) => {
      if (!res.ok && res.code !== 'BRAG_SLOW') showToast(res.error, 'error');
    });
  };
  return (
    <button
      type="button"
      className={`${className} ${cooling ? 'is-cooling' : ''}`}
      aria-disabled={cooling}
      title="승리 자랑하기 · 누를 때마다 다른 한마디가 모두의 화면에 뜹니다"
      onClick={brag}
    >
      <CrownIcon size={18} />
      <span>자랑하기</span>
    </button>
  );
}

/** 승리 자랑 한마디: 화면 아래쪽에 양피지 두루마리처럼 떠올랐다가 사라진다. 이긴 사람 이름은 그 사람 색이다. */
function VictoryQuoteBanner({ show }: { show: VictoryQuote }) {
  const color = playerColor(show.colorIndex);
  return (
    <div
      className="victory-quote"
      role="status"
      aria-live="polite"
      aria-label={`${show.nickname}${show.mine ? '(나)' : ''}의 한마디: ${show.quote}`}
      style={{ ['--pc' as string]: color.hex, ['--pc-ink' as string]: color.ink } as CSSProperties}
    >
      <div className="vq-text">“{show.quote}”</div>
      <div className="vq-who">
        <CrownIcon size={14} /> <b>{show.nickname}</b>
        {show.mine ? ' (나)' : ''}
      </div>
    </div>
  );
}

/**
 * 달성 공지: 띠나 도장 없이 글자만 보드 위에 크게 띄운다. 어떤 칸 위에서도 읽히게 글자에 먹 테두리를 두르고,
 * 맨 앞 닉네임을 그 플레이어 색으로 칠한다. 아래 줄에 색 이름과 덧붙임이 온다. 자랑하기면 그 아래에 한마디가 붙는다.
 * 움직임 없이 나타났다가 흐려지며 사라진다.
 */
function AwardBanner({ show }: { show: AwardShow }) {
  const color = playerColor(show.colorIndex);
  const label = AWARD_LABEL[show.award];
  const word = colorWord(show.colorIndex);
  return (
    <div
      className="award-banner"
      role="status"
      aria-live="assertive"
      aria-label={`${show.nickname}${show.mine ? '(나)' : ''} ${show.brag ? `님이 ${josa(label, '을/를')} 뽐냅니다` : `${label} 달성`}. ${word} 플레이어, ${show.detail}${show.quote ? `. ${show.quote}` : ''}`}
      style={{ ['--pc' as string]: color.hex, ['--pc-ink' as string]: color.ink } as CSSProperties}
    >
      <div className="award-headline">
        <span className="award-color">{show.nickname}</span>
        {show.brag ? ' 님이 ' : ' '}
        <span className="award-what">{show.brag ? `${josa(label, '을/를')} 뽐냅니다` : `${label} 달성`}</span>
      </div>
      <div className="award-sub">
        {word} 플레이어
        {show.mine ? ' (나)' : ''} · {show.detail}
      </div>
      {show.quote && <div className="award-quote">“{show.quote}”</div>}
    </div>
  );
}

/**
 * 황금 기사단 출격: 달성 공지보다 크게, 금빛 글자에 빛이 한 번 훑고 지나간다. 글자 둘레는 먹 테두리로 감싸 어느 칸 위에서도 읽힌다.
 * 아래 줄에 쓴 사람과 쓴 기사 장수를 그 사람 색으로 적는다.
 */
function GoldenBanner({ show }: { show: GoldenShow }) {
  const color = playerColor(show.colorIndex);
  return (
    <div
      className="golden-banner"
      role="status"
      aria-live="assertive"
      aria-label={`황금 기사단 출격. ${show.nickname}${show.mine ? '(나)' : ''}, 최강 기사단 기사 ${show.knights}장`}
      style={{ ['--pc' as string]: color.hex } as CSSProperties}
    >
      <div className="golden-crest" aria-hidden>
        <svg viewBox="0 0 64 64" width="64" height="64">
          <path d="M32 4 L54 12 V31 C54 45 44 54 32 60 C20 54 10 45 10 31 V12 Z" className="gc-shield" />
          <path d="M32 11 L48 17 V31 C48 41 41 48 32 53 C23 48 16 41 16 31 V17 Z" className="gc-inner" />
          <path d="M32 18 V44 M22 27 H42" className="gc-cross" />
        </svg>
      </div>
      <div className="golden-headline">황금 기사단 출격</div>
      <div className="golden-sub">
        <span className="golden-who">{show.nickname}</span>
        {show.mine ? ' (나)' : ''} · 최강 기사단 · 기사 {show.knights}장
      </div>
    </div>
  );
}
