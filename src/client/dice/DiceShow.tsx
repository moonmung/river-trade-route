// 주사위가 멈춘 뒤 합계를 주사위 위에 크게 띄운다 (7 이면 붉게 흔들며 강조).
// 3D 를 그릴 수 없는 기기는 예전처럼 화면 가운데에서 2D 주사위 그림이 굴러와 멈춘다.
import type { CSSProperties } from 'react';
import { DieFace } from '../game/panels';
import { playerColor } from '../theme';
import { Emblem } from '../ui/icons';
import { useDiceUi } from './index';
import './dice.css';

export function DiceShowHost() {
  const { show } = useDiceUi();
  if (!show) return null;
  const [a, b] = show.dice;
  const total = a + b;
  const seven = total === 7;
  const label = `${show.who} 주사위 ${a}와 ${b}, 합 ${total}${seven ? '. 기사단 동상이 움직입니다' : ''}`;

  if (!show.at) {
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
        <div className={`dice-total ${seven ? 'dice-seven' : ''}`}>
          <Emblem colorIndex={show.colorIndex} size={18} /> {show.who} · {total}
          {seven && <small> 기사단 동상이 움직입니다</small>}
        </div>
      </div>
    );
  }

  // 화면 밖으로 넘치지 않게 가운데 자리를 조금 안쪽으로 당긴다.
  const x = Math.min(Math.max(show.at.x, 96), window.innerWidth - 96);
  const y = Math.min(Math.max(show.at.y, 150), window.innerHeight - 40);
  const color = playerColor(show.colorIndex);
  return (
    <div
      className={`dice-badge ${seven ? 'dice-badge-seven' : ''}`}
      key={show.id}
      role="status"
      aria-live="polite"
      aria-label={label}
      style={{ left: x, top: y, ['--pc' as string]: color.hex } as CSSProperties}
    >
      <div className="dice-badge-seal">
        <b className="dice-badge-total">{total}</b>
      </div>
      <div className="dice-badge-line">
        <Emblem colorIndex={show.colorIndex} size={15} />
        <span>
          {show.who} · {a} + {b}
        </span>
      </div>
      {seven && <div className="dice-badge-note">기사단 동상이 움직입니다</div>}
    </div>
  );
}
