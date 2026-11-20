import { useState, type ReactNode } from 'react';
import { useClient } from '../net/hooks';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'brand brand-small' : 'brand'}>
      <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden>
        {/* 수채화 삽화 색: 물(보드 밖 물 색), 주홍 지붕, 황토 깃발, 세피아 먹선 */}
        <path d="M4 34 C14 28 18 40 28 34 S40 28 44 31 L44 44 L4 44 Z" fill="#589eb5" stroke="#3a2a1f" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M7 38.5 C13 35.5 17 41 24 38" stroke="#e6f0ee" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <path d="M12 26 L20 16 L28 26 Z" fill="#a8402c" stroke="#3a2a1f" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="13.5" y="26" width="13" height="7" fill="#f2e6cc" stroke="#3a2a1f" strokeWidth="1.5" />
        <rect x="18.3" y="28.2" width="3.4" height="4.8" fill="#6b4a2a" />
        <path d="M33 30 L33 10" stroke="#3a2a1f" strokeWidth="2" strokeLinecap="round" />
        <path d="M33 11 L42 13.5 L38.5 15 L42 16.5 L33 18 Z" fill="#c9962f" stroke="#3a2a1f" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <div>
        <div className="brand-title">강줄기 교역로</div>
        {!small && <div className="brand-sub">같은 와이파이에서 3~4명이 함께하는 강변 교역 게임</div>}
      </div>
    </div>
  );
}

export function ConnectionBanner() {
  const { conn, session } = useClient();
  if (!session || conn === 'connected') return null;
  return (
    <div className="conn-banner" role="alert">
      <span className="spinner" aria-hidden />
      {conn === 'connecting' ? '서버에 연결하는 중…' : '서버와 연결이 끊겼습니다. 다시 연결하는 중… (방장 PC와 같은 와이파이인지 확인하세요)'}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** 중복 클릭을 막는 비동기 버튼. 요청이 끝날 때까지 비활성화한다. */
export function AsyncButton({
  onClick,
  children,
  className = 'btn',
  disabled,
  title,
}: {
  onClick: () => Promise<unknown> | void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 아래 방식으로 다시 시도 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
