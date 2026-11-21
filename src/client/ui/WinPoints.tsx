// 승리 점수 고르기: 방을 만들 때와 대기실에서 방장이 10~20점 사이로 정한다.
import { WIN_POINTS, WIN_POINTS_MAX, WIN_POINTS_MIN } from '../../shared/constants';

const KEY = 'devilsland.winPoints';

/** 이 브라우저에서 마지막으로 고른 승리 점수 (처음이면 기본 10점) */
export function loadWinPoints(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n >= WIN_POINTS_MIN && n <= WIN_POINTS_MAX ? n : WIN_POINTS;
  } catch {
    return WIN_POINTS;
  }
}

export function saveWinPoints(n: number): void {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* 저장소를 쓸 수 없는 브라우저 */
  }
}

export function WinPointsStepper({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const set = (n: number) => onChange(Math.min(WIN_POINTS_MAX, Math.max(WIN_POINTS_MIN, n)));
  return (
    <div className="win-points" role="group" aria-label="승리 점수">
      <button type="button" className="wp-btn" onClick={() => set(value - 1)} disabled={disabled || value <= WIN_POINTS_MIN} aria-label="1점 낮추기">
        −
      </button>
      <output className="wp-value" aria-live="polite">
        <b>{value}</b>점
      </output>
      <button type="button" className="wp-btn" onClick={() => set(value + 1)} disabled={disabled || value >= WIN_POINTS_MAX} aria-label="1점 올리기">
        +
      </button>
    </div>
  );
}
