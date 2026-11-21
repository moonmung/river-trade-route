// 큰 연출: 주사위 굴림과 달성(최장 교역로·최강 기사단) 공지. 토스트와 같은 방식의 작은 전역 저장소로 띄운다.
import { useSyncExternalStore, type CSSProperties } from 'react';
import { colorWord } from '../game/derive';
import { DieFace, AwardIcon } from '../game/panels';
import { playerColor } from '../theme';
import { Emblem } from './icons';

export interface DiceShow {
  id: number;
  dice: [number, number];
  who: string;
  colorIndex: number;
}

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
  dice: DiceShow | null;
  award: AwardShow | null;
}

let state: State = { dice: null, award: null };
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** 주사위 두 개가 굴러가다 멈추는 연출 (약 1.4초) */
export function showDice(dice: [number, number], who: string, colorIndex: number): void {
  const id = nextId++;
  state = { ...state, dice: { id, dice, who, colorIndex } };
  emit();
  window.setTimeout(() => {
    if (state.dice?.id !== id) return;
    state = { ...state, dice: null };
    emit();
  }, 1700);
}

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
  const total = s.dice ? s.dice.dice[0] + s.dice.dice[1] : 0;
  return (
    <>
      {s.dice && (
        <div className="dice-show" key={s.dice.id} aria-live="polite" aria-label={`주사위 ${s.dice.dice[0]}와 ${s.dice.dice[1]}, 합 ${total}`}>
          <div className="dice-pair">
            <span className="dice-roll d1">
              <DieFace value={s.dice.dice[0]} size={64} />
            </span>
            <span className="dice-roll d2">
              <DieFace value={s.dice.dice[1]} size={64} />
            </span>
          </div>
          <div className={`dice-total ${total === 7 ? 'dice-seven' : ''}`}>
            <Emblem colorIndex={s.dice.colorIndex} size={18} /> {s.dice.who} · {total}
            {total === 7 && <small> 기사단 동상이 움직입니다</small>}
          </div>
        </div>
      )}
      {s.award && <AwardBanner key={s.award.id} show={s.award} />}
    </>
  );
}

/** 달성 공지 띠: 위에서 내려와 잠시 머물다 올라간다. 색 이름과 그 색으로 누가 달성했는지 먼저 읽히게 한다. */
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
      style={{ ['--pc' as string]: color.hex, ['--pc-soft' as string]: color.soft, ['--pc-ink' as string]: color.ink } as CSSProperties}
    >
      <div className="award-ribbon">
        <span className="award-seal" aria-hidden>
          <AwardIcon kind={show.award} size={34} />
        </span>
        <div className="award-text">
          <div className="award-headline">
            <span className="award-color">{word} 플레이어</span> <span className="award-what">{label} 달성</span>
          </div>
          <div className="award-sub">
            <Emblem colorIndex={show.colorIndex} size={15} /> {show.nickname}
            {show.mine && <span className="tag">나</span>} · {show.detail}
          </div>
        </div>
      </div>
    </div>
  );
}
