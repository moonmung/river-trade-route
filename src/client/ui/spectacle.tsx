// 큰 연출: 주사위 굴림(dice/ 의 3D 주사위가 멈춘 뒤 합계), 달성(최장 교역로·최강 기사단) 공지와 자랑, 황금 기사단 출격, 승리.
// 토스트와 같은 방식의 작은 전역 저장소로 띄운다.
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { victoryStepLabel, type VictoryPlan } from '../board/victory';
import { DiceShowHost } from '../dice/DiceShow';
import { colorWord } from '../game/derive';
import { sfx } from '../sound/sfx';
import { playerColor } from '../theme';
import { CrownIcon } from './icons';
import { josa } from './josa';

export interface AwardWho {
  colorIndex: number;
  nickname: string;
  /** 화면 주인이 달성했는지 */
  mine: boolean;
  /** "이어진 길 6칸 · +2점" 같은 덧붙임 */
  detail: string;
  /** 이미 가진 달성을 뽐내는 자랑하기 (달성 공지와 같은 연출에 글만 다르다) */
  brag?: boolean;
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

/** 승리 연출: 이긴 사람의 건물을 차례로 비추며 점수를 센 뒤 승리를 알린다 (3D 보드의 playVictory 와 같은 박자) */
export interface VictoryShow {
  id: number;
  colorIndex: number;
  nickname: string;
  mine: boolean;
  winPoints: number;
  plan: VictoryPlan;
  /** 연출을 시작하기까지 (마지막에 지은 조각이 솟아오를 틈) */
  delay: number;
  /** 건너뛰기를 눌렀을 때 (3D 보드 연출을 멈춘다) */
  onSkip?: () => void;
}

interface State {
  award: AwardShow | null;
  golden: GoldenShow | null;
  victory: VictoryShow | null;
}

let state: State = { award: null, golden: null, victory: null };
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
    </>
  );
}

/**
 * 승리 연출 화면: 위아래 먹빛 영화 띠. 위 띠에는 "철수가 걸어온 길", 아래 띠에는 카메라가 건물에 닿을 때마다 오르는 점수와
 * 점수 구슬, 방금 더한 것("도시 +2", "최장 교역로 +2")이 뜬다. 다 세면 가운데에 이긴 사람 이름과 "승리!"가 크게 튀어나온다.
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
      <div className="victory-bar victory-bar-top">
        <span className="victory-title">
          <CrownIcon size={22} />
          <b className="victory-name">{show.nickname}</b>
          {show.mine ? ' · 내가 걸어온 길' : `${josa(show.nickname, '이/가').slice(show.nickname.length)} 걸어온 길`}
        </span>
      </div>
      <div className="victory-bar victory-bar-bottom">
        <div className="victory-score" aria-hidden>
          <b key={total} className={`victory-total ${total ? 'is-bump' : ''}`}>
            {total}
          </b>
          <span className="victory-unit">점</span>
        </div>
        <div className="victory-tally" aria-hidden>
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
 * 달성 공지: 띠나 도장 없이 글자만 보드 위에 크게 띄운다. 어떤 칸 위에서도 읽히게 글자에 먹 테두리를 두르고,
 * 맨 앞 닉네임을 그 플레이어 색으로 칠한다. 아래 줄에 색 이름과 덧붙임이 온다. 움직임 없이 나타났다가 흐려지며 사라진다.
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
      aria-label={`${show.nickname}${show.mine ? '(나)' : ''} ${show.brag ? `님이 ${josa(label, '을/를')} 뽐냅니다` : `${label} 달성`}. ${word} 플레이어, ${show.detail}`}
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
