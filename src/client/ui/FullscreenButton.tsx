// 게임 화면을 브라우저 전체화면으로 띄우고 끄는 단추.
// 넓은 화면은 보드 오른쪽 위(오른쪽 패널 바로 왼쪽), 좁은 화면은 위쪽 차례 쪽지 맨 오른쪽에 둔다.
// 전체화면을 못 쓰는 브라우저(아이폰 사파리 등)에서는 단추를 그리지 않는다.
import { useEffect, useState } from 'react';
import { showToast } from './toast';

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fsDoc = () => document as FsDocument;

function fullscreenElement(): Element | null {
  return fsDoc().fullscreenElement ?? fsDoc().webkitFullscreenElement ?? null;
}

function canFullscreen(): boolean {
  return typeof document !== 'undefined' && !!(fsDoc().fullscreenEnabled || fsDoc().webkitFullscreenEnabled);
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreenElement()) {
    if (document.exitFullscreen) await document.exitFullscreen();
    else await fsDoc().webkitExitFullscreen?.();
    return;
  }
  const el = document.documentElement as FsElement;
  if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
  else await el.webkitRequestFullscreen?.();
}

/** 지금 전체화면인지. 단추 말고 Esc·F11 로 바꿔도 따라간다. */
function useFullscreen(): boolean {
  const [on, setOn] = useState(() => !!fullscreenElement());
  useEffect(() => {
    const sync = () => setOn(!!fullscreenElement());
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);
  return on;
}

/** 네 귀퉁이 꺾쇠: 바깥으로 벌어지면 전체화면으로, 안으로 모이면 전체화면 끄기 */
function FullscreenIcon({ on }: { on: boolean }) {
  const d = on
    ? 'M8 3v3a2 2 0 0 1-2 2H3 M21 8h-3a2 2 0 0 1-2-2V3 M3 16h3a2 2 0 0 1 2 2v3 M16 21v-3a2 2 0 0 1 2-2h3'
    : 'M3 8V5a2 2 0 0 1 2-2h3 M16 3h3a2 2 0 0 1 2 2v3 M21 16v3a2 2 0 0 1-2 2h-3 M8 21H5a2 2 0 0 1-2-2v-3';
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function FullscreenButton({ className = '' }: { className?: string }) {
  const on = useFullscreen();
  if (!canFullscreen()) return null;
  return (
    <button
      type="button"
      className={`icon-btn fullscreen-btn ${className}`}
      onClick={() => {
        toggleFullscreen().catch(() => showToast('이 브라우저에서는 전체화면으로 바꿀 수 없습니다. F11 키를 눌러 보세요.', 'error'));
      }}
      aria-label={on ? '전체화면 끄기' : '전체화면으로 보기'}
      aria-pressed={on}
      title={on ? '전체화면 끄기 (Esc)' : '전체화면으로 보기'}
    >
      <FullscreenIcon on={on} />
    </button>
  );
}
