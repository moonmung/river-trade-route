// 자리 비움(자동): 잠시 자리를 비울 때 켜 두면 서버가 내 차례와 할 일(굴리기, 건설, 7 버리기, 동상 옮기기)을 대신 둔다.
// 교환 제안은 모두 거절하고 제안도 하지 않는다. 직접 두거나 [돌아왔어요]를 누르면 꺼진다.
import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '../../shared/protocol';
import { showToast } from '../ui/toast';
import type { PlayerInfo } from './derive';
import { sendAuto } from './ui';

/** 커피잔: 자리 비움 */
function AwayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3.5c-.6.8-.6 1.7 0 2.5M12 3.5c-.6.8-.6 1.7 0 2.5" />
    </svg>
  );
}

/** 자리 비움 켜기/끄기 단추. withLabel 이면 아이콘 옆에 글자도 쓴다 (넓은 화면). */
export function AwayButton({ on, withLabel = false }: { on: boolean; withLabel?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`icon-btn away-btn ${on ? 'away-on' : ''} ${withLabel ? 'away-labeled' : ''}`}
      aria-pressed={on}
      aria-label={on ? '자리 비움 끄기 (다시 직접 두기)' : '자리 비움: 컴퓨터가 대신 두기'}
      title={on ? '자리 비움 끄기: 다시 직접 둡니다' : '자리 비움: 잠시 자리를 비우는 동안 컴퓨터가 대신 둡니다 (교환은 하지 않음)'}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await sendAuto(!on);
        setBusy(false);
      }}
    >
      <AwayIcon />
      {withLabel && <span>{on ? '자동 중' : '자리 비움'}</span>}
    </button>
  );
}

/** 내가 자리 비움 중이면 보드 위쪽에 띄우는 띠: 무엇을 하는지와 [돌아왔어요] */
export function AwayBanner() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="away-banner" role="status">
      <AwayIcon />
      <span>
        <b>자리 비움 중</b> · 컴퓨터가 대신 두고 있습니다. 교환 제안은 모두 거절합니다.
      </span>
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await sendAuto(false);
          setBusy(false);
        }}
      >
        돌아왔어요
      </button>
    </div>
  );
}

/** 누가 자리를 비우거나 돌아오면 알린다 (나는 무엇이 바뀌는지까지). 처음 받은 화면은 알리지 않는다. */
export function useAwayNotices(view: RoomView, players: Map<string, PlayerInfo>): void {
  const prev = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const now = new Map([...players.values()].map((p) => [p.id, p.auto]));
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    for (const [id, auto] of now) {
      const was = before.get(id);
      if (was === undefined || was === auto) continue;
      const p = players.get(id)!;
      if (id === view.you) {
        showToast(auto ? '자리 비움: 돌아올 때까지 컴퓨터가 대신 둡니다. 직접 두면 저절로 꺼집니다.' : '다시 직접 둡니다.', auto ? 'info' : 'good', 3600);
      } else {
        showToast(auto ? `${p.nickname}님이 자리를 비워 컴퓨터가 대신 둡니다.` : `${p.nickname}님이 돌아왔습니다.`, 'info', 3200);
      }
    }
  }, [players, view.you]);
}
