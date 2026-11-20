// 큰 연출: 주사위 굴림과 달성(최장 교역로·최강 기사단) 두루마리. 토스트와 같은 방식의 작은 전역 저장소로 띄운다.
import { useSyncExternalStore } from 'react';
import { DieFace, AwardIcon } from '../game/panels';
import { Emblem } from './icons';

export interface DiceShow {
  id: number;
  dice: [number, number];
  who: string;
  colorIndex: number;
}

export interface AwardShow {
  id: number;
  award: 'longest_road' | 'largest_army';
  who: string;
  colorIndex: number;
  detail: string;
}

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

/** 달성 두루마리가 펼쳐졌다 말리는 연출 (약 3초) */
export function showAward(award: AwardShow['award'], who: string, colorIndex: number, detail: string): void {
  const id = nextId++;
  state = { ...state, award: { id, award, who, colorIndex, detail } };
  emit();
  window.setTimeout(() => {
    if (state.award?.id !== id) return;
    state = { ...state, award: null };
    emit();
  }, 3200);
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
      {s.award && (
        <div className="award-show" key={s.award.id} role="status">
          <div className="award-scroll">
            <AwardIcon kind={s.award.award} size={44} />
            <div>
              <div className="award-title">{s.award.award === 'longest_road' ? '최장 교역로' : '최강 기사단'}</div>
              <div className="award-who">
                <Emblem colorIndex={s.award.colorIndex} size={18} /> {s.award.who} <b>+2점</b>
              </div>
              <div className="award-detail">{s.award.detail}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
