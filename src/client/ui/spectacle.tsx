// 큰 연출: 주사위 굴림(dice/ 의 3D 주사위가 멈춘 뒤 합계)과 달성(최장 교역로·최강 기사단) 공지. 토스트와 같은 방식의 작은 전역 저장소로 띄운다.
import { useSyncExternalStore, type CSSProperties } from 'react';
import { DiceShowHost } from '../dice/DiceShow';
import { colorWord } from '../game/derive';
import { playerColor } from '../theme';

export interface AwardWho {
  colorIndex: number;
  nickname: string;
  /** 화면 주인이 달성했는지 */
  mine: boolean;
  /** "이어진 길 6칸 · +2점" 같은 덧붙임 */
  detail: string;
}

export interface AwardShow extends AwardWho {
  id: number;
  award: 'longest_road' | 'largest_army';
}

const AWARD_LABEL: Record<AwardShow['award'], string> = { longest_road: '최장 교역로', largest_army: '최강 기사단' };
/** 공지가 떠 있는 시간 (CSS 의 award-banner-life 와 같다) */
const AWARD_MS = 4200;

interface State {
  award: AwardShow | null;
}

let state: State = { award: null };
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** 달성 공지: 화면 위쪽에 "빨강 플레이어 최장 교역로 달성"을 그 색으로 크게 띄운다 (약 4초) */
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

export function SpectacleHost() {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
  return (
    <>
      <DiceShowHost />
      {s.award && <AwardBanner key={s.award.id} show={s.award} />}
    </>
  );
}

/**
 * 달성 공지: 띠나 도장 없이 글자만 보드 위에 크게 띄운다. 어떤 칸 위에서도 읽히게 글자에 먹 테두리를 두르고,
 * 색 이름은 그 플레이어 색으로 칠한다. 움직임 없이 나타났다가 흐려지며 사라진다.
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
      aria-label={`${word} 플레이어 ${label} 달성. ${show.nickname}${show.mine ? '(나)' : ''}, ${show.detail}`}
      style={{ ['--pc' as string]: color.hex, ['--pc-ink' as string]: color.ink } as CSSProperties}
    >
      <div className="award-headline">
        <span className="award-color">{word} 플레이어</span> <span className="award-what">{label} 달성</span>
      </div>
      <div className="award-sub">
        {show.nickname}
        {show.mine ? ' (나)' : ''} · {show.detail}
      </div>
    </div>
  );
}
