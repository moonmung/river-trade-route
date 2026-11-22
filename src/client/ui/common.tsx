import { useState, type ReactNode } from 'react';
import { client } from '../net/client';
import { useClient } from '../net/hooks';
import { navigate } from '../router';
import { showToast } from './toast';

/** 게임 이름. 그림이나 색 장식 없이 본문과 같은 글꼴, 같은 먹색으로 쓴다. */
export function Brand({ small = false }: { small?: boolean }) {
  return <div className={small ? 'brand brand-small' : 'brand'}>데블스랜드</div>;
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

/** 방장만 쓰는 "방 닫기": 대기실이든 게임 중이든 방을 없애고 모두를 처음 화면으로 보낸다. */
export function CloseRoomButton({ className = 'btn btn-small btn-danger' }: { className?: string }) {
  return (
    <AsyncButton
      className={className}
      onClick={async () => {
        if (!window.confirm('방을 닫을까요? 대기실과 진행 중인 게임이 모두 사라지고 참가자 모두 처음 화면으로 돌아갑니다.')) return;
        const res = await client.close();
        if (!res.ok) return showToast(res.error, 'error');
        showToast('방을 닫았습니다.');
        navigate('/');
      }}
    >
      방 닫기
    </AsyncButton>
  );
}
