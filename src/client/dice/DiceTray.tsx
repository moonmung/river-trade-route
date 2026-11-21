// 던지기 자리: 내 차례 굴리기 단계에 아래 HUD 바로 위에 뜬다.
// 주사위를 꾹 누르면 들어 올려 흔들고, 놓으면 던진다. 끌어서 튕기면 그 방향과 빠르기로 날아간다.
// 10초 안에 던지지 않으면 알아서 던진다. 발전 카드 창이 열린 동안은 시간을 멈춘다.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { RoomView } from '../../shared/protocol';
import { DieFace } from '../game/panels';
import { dice3d, throwDice, tray, useDiceUi } from './index';
import './dice.css';

/** 알아서 던지기까지 기다리는 시간 */
export const TRAY_SECONDS = 10;

/** 아래 HUD 바로 위, 보드가 보이는 영역 가운데 */
function useTrayPlace(open: boolean): CSSProperties {
  const [place, setPlace] = useState<CSSProperties>({ left: '50%', bottom: 180 });
  useLayoutEffect(() => {
    if (!open) return;
    const hud = document.querySelector('.hud-bottom');
    const measure = () => {
      const r = hud?.getBoundingClientRect();
      if (!r || !r.height) return setPlace({ left: '50%', bottom: 180 });
      setPlace({ left: r.left + r.width / 2, bottom: window.innerHeight - r.top + 14 });
    };
    measure();
    const ro = hud ? new ResizeObserver(measure) : null;
    if (hud) ro!.observe(hud);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open]);
  return place;
}

/** hold: 앞사람 주사위·생산 연출이 아직 끝나지 않아 자리를 띄우지 않는다 (game/pace.ts) */
export function DiceTray({ view, paused = false, hold = false }: { view: RoomView; paused?: boolean; hold?: boolean }) {
  const g = view.game;
  const active = !!g && g.phase === 'playing' && g.currentPlayerId === view.you && g.step === 'roll';
  const ui = useDiceUi();
  const open = active && !ui.throwing && !hold;
  const felt = useRef<HTMLDivElement>(null);
  const holding = useRef(false);
  const [held, setHeld] = useState(false);
  const [left, setLeft] = useState(TRAY_SECONDS);
  const remaining = useRef(TRAY_SECONDS * 1000);
  const place = useTrayPlace(open);
  const flat = open && !dice3d();
  const faces: [number, number] = g?.dice ?? [5, 2];

  // 자리가 새로 뜰 때마다 10초부터 센다.
  useEffect(() => {
    if (!open) return;
    remaining.current = TRAY_SECONDS * 1000;
    setLeft(TRAY_SECONDS);
  }, [open]);

  useEffect(() => {
    if (!open || paused) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      remaining.current -= now - last;
      last = now;
      setLeft(Math.max(0, Math.ceil(remaining.current / 1000)));
      if (remaining.current <= 0) {
        window.clearInterval(id);
        holding.current = false;
        setHeld(false);
        void throwDice();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [open, paused]);

  // 3D 장면에 자리를 알려 주사위를 그 위에 놓는다.
  useLayoutEffect(() => {
    if (!open || !felt.current) return;
    tray.show(felt.current, faces);
    return () => tray.hide();
    // 같은 자리가 떠 있는 동안 지난 주사위 값이 바뀌어도 다시 놓지 않는다.
  }, [open]);

  useEffect(() => {
    if (open) tray.setHidden(paused);
  }, [open, paused]);

  if (!open) return null;

  const end = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!holding.current) return;
    holding.current = false;
    setHeld(false);
    if (cancelled) return tray.drop();
    tray.drag(e.clientX, e.clientY);
    void throwDice();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    void throwDice();
  };
  const urgent = left <= 3;

  return (
    <div
      className={`dice-tray ${held ? 'is-held' : ''} ${paused ? 'is-paused' : ''} ${urgent ? 'is-urgent' : ''}`}
      style={place}
      role="button"
      tabIndex={0}
      aria-label={`주사위 던지기. 누르고 있다가 놓거나 끌어서 튕기세요. ${left}초 뒤 저절로 던집니다.`}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 이미 끝난 포인터 */
        }
        holding.current = true;
        setHeld(true);
        tray.grab(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => holding.current && tray.drag(e.clientX, e.clientY)}
      onPointerUp={(e) => end(e, false)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, true)}
    >
      <div className="dice-tray-felt" ref={felt}>
        {flat && (
          <span className="dice-tray-flat" aria-hidden>
            <DieFace value={faces[0]} size={46} />
            <DieFace value={faces[1]} size={46} />
          </span>
        )}
      </div>
      <div className="dice-tray-foot">
        <span className="dice-tray-hint">{held ? '놓으면 던집니다' : '꾹 눌러 흔들다 놓거나 끌어서 튕기세요'}</span>
        <span className="dice-tray-clock" aria-hidden style={{ ['--left' as string]: left / TRAY_SECONDS } as CSSProperties}>
          <b>{left}</b>
        </span>
      </div>
    </div>
  );
}
