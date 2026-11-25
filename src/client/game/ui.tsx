import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RESOURCE_LABEL } from '../../shared/constants';
import type { AckResult } from '../../shared/protocol';
import type { GameAction, Resource } from '../../shared/types';
import { client } from '../net/client';
import { ResourceIcon } from '../ui/icons';
import { showToast } from '../ui/toast';

/** 행동을 서버 대신 받는 곳 (실험실 모의 게임). 정하면 행동이 서버로 가지 않고 이리로 간다. */
let actionSink: ((action: GameAction) => Promise<AckResult>) | null = null;

/** 실험실 모의 게임처럼 서버 대신 다른 곳으로 행동을 보내는 중인지 (실제 방이 없다) */
export function isSandboxed(): boolean {
  return actionSink !== null;
}

export function setActionSink(sink: ((action: GameAction) => Promise<AckResult>) | null): void {
  actionSink = sink;
}

/** 자리 비움을 서버 대신 받는 곳 (실험실 모의 게임) */
let autoSink: ((on: boolean) => AckResult) | null = null;

export function setAutoSink(sink: ((on: boolean) => AckResult) | null): void {
  autoSink = sink;
}

/** 자리 비움(자동)을 켜고 끈다. 거절되면 이유를 보여 준다. */
export async function sendAuto(on: boolean): Promise<boolean> {
  const res = autoSink ? autoSink(on) : await client.setAuto(on);
  if (!res.ok) showToast(res.error, 'error', 4200);
  return res.ok;
}

/** 행동을 서버에 보내고, 거절되면 이유를 보여 준다. */
export async function sendAction(action: GameAction): Promise<boolean> {
  const res = actionSink ? await actionSink(action) : await client.act(action);
  if (!res.ok) showToast(res.error, 'error', 4200);
  return res.ok;
}

export function Sheet({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className={`sheet ${wide ? 'sheet-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function ResourceAmount({ resource, amount, size = 20 }: { resource: Resource; amount: number; size?: number }) {
  return (
    <span className={`res-amount res-${resource}`} title={`${RESOURCE_LABEL[resource]} ${amount}`}>
      <ResourceIcon kind={resource} size={size} />
      <b>{amount}</b>
    </span>
  );
}

export function Stepper({
  value,
  min = 0,
  max,
  disabled,
  onChange,
  label,
}: {
  value: number;
  min?: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <span className={`stepper ${disabled ? 'stepper-off' : ''}`}>
      <button type="button" aria-label={`${label} 줄이기`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <b aria-live="polite">{value}</b>
      <button type="button" aria-label={`${label} 늘리기`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </span>
  );
}

/** 비활성처럼 보이지만 누르면 이유를 알려 주는 버튼 (휴대폰에는 마우스 툴팁이 없으므로) */
export function ActionButton({
  label,
  blocker,
  onClick,
  className = 'btn',
  active,
  icon,
}: {
  label: ReactNode;
  blocker: string | null;
  onClick: () => Promise<unknown> | void;
  className?: string;
  active?: boolean;
  icon?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`${className} ${blocker ? 'is-blocked' : ''} ${active ? 'is-active' : ''}`}
      aria-disabled={!!blocker || busy}
      aria-pressed={active}
      aria-label={typeof label === 'string' ? (blocker ? `${label} (${blocker})` : label) : undefined}
      title={blocker ?? undefined}
      onClick={async () => {
        if (busy) return;
        if (blocker) {
          showToast(blocker, 'warn');
          return;
        }
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function useLocalSetting<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* 저장소를 쓸 수 없으면 이번 화면에서만 유지 */
    }
  };
  return [value, set];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
