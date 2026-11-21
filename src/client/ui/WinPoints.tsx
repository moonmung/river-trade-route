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
  return <NumberStepper value={value} min={WIN_POINTS_MIN} max={WIN_POINTS_MAX} unit="점" label="승리 점수" onChange={onChange} disabled={disabled} />;
}

/** 방 규칙 숫자 하나를 −/+ 로 고른다 (승리 점수, 자원 보유 한도) */
export function NumberStepper({
  value,
  min,
  max,
  unit,
  label,
  onChange,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  label: string;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <div className="win-points" role="group" aria-label={label}>
      <button type="button" className="wp-btn" onClick={() => set(value - 1)} disabled={disabled || value <= min} aria-label={`${label} 1${unit} 낮추기`}>
        −
      </button>
      <output className="wp-value" aria-live="polite">
        <b>{value}</b>
        {unit}
      </output>
      <button type="button" className="wp-btn" onClick={() => set(value + 1)} disabled={disabled || value >= max} aria-label={`${label} 1${unit} 올리기`}>
        +
      </button>
    </div>
  );
}

/** 차례 시간을 읽기 좋게: 0 → "제한 없음", 90 → "1분 30초" */
export function turnSecondsLabel(s: number): string {
  if (s <= 0) return '제한 없음';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m && r ? `${m}분 ${r}초` : m ? `${m}분` : `${r}초`;
}
