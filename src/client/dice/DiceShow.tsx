// 3D 주사위는 보드 위에 멈춰 눈을 그대로 보여 주므로 합계는 따로 띄우지 않는다 (차례 쪽지에 "=합"이 나온다).
// 화면 읽기 프로그램에는 굴린 사람과 눈, 합을 알린다.
// 3D 를 그릴 수 없는 기기는 예전처럼 화면 가운데에서 2D 주사위 그림이 굴러와 멈춘다 (합계 글은 없이, 7 이면 안내만).
import { DieFace } from '../game/panels';
import { useDiceUi } from './index';
import './dice.css';

export function DiceShowHost() {
  const { show } = useDiceUi();
  if (!show) return null;
  const [a, b] = show.dice;
  const total = a + b;
  const seven = total === 7;
  const label = `${show.who} 주사위 ${a}와 ${b}, 합 ${total}${seven ? '. 기사단 동상이 움직입니다' : ''}`;

  if (show.at) {
    return (
      <span className="sr-only" key={show.id} role="status" aria-live="polite">
        {label}
      </span>
    );
  }
  return (
    <div className="dice-show" key={show.id} role="status" aria-live="polite" aria-label={label}>
      <div className="dice-pair">
        <span className="dice-roll d1">
          <DieFace value={a} size={64} />
        </span>
        <span className="dice-roll d2">
          <DieFace value={b} size={64} />
        </span>
      </div>
      {seven && (
        <div className="dice-total dice-seven">
          <small>기사단 동상이 움직입니다</small>
        </div>
      )}
    </div>
  );
}
