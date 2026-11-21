// 게임 중 연결이 끊긴 자리를 다른 브라우저·기기로 넘기는 버튼과 창.
// 원래 쓰던 브라우저로 돌아오면 저장된 참가 토큰으로 같은 자리에 붙으므로, 이 기능은 그럴 수 없을 때만 쓴다
// (다른 브라우저로 바꿈, 휴대폰이 꺼짐, 방장 PC 주소가 바뀌어 예전 링크의 저장소를 못 씀 등).
import { useCallback, useEffect, useState } from 'react';
import type { RoomView, SeatHandover } from '../../shared/protocol';
import { Sheet } from '../game/ui';
import { client } from '../net/client';
import { QrCode, inviteBase, useServerInfo } from '../screens/Lobby';
import { playerColor } from '../theme';
import { AsyncButton } from './common';
import { showToast } from './toast';
import './handover.css';

/** 방장에게(방장이 끊겼으면 접속해 있는 사람에게) 끊긴 자리가 있을 때만 보인다. */
export function SeatHandoverButton({ view }: { view: RoomView }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (view.phase !== 'game') return null;
  const host = view.players.find((p) => p.id === view.hostId);
  const canIssue = view.hostId === view.you || !host?.connected;
  const away = view.players.filter((p) => !p.connected && p.id !== view.you);
  if (!canIssue || (away.length === 0 && !open)) return null;
  return (
    <>
      <button type="button" className="handover-chip" onClick={() => setOpen(true)} title="다른 기기로 옮긴 사람에게 자리를 넘겨줍니다">
        끊긴 자리 넘기기 · {away.length}
      </button>
      {open && <HandoverSheet view={view} onClose={close} />}
    </>
  );
}

function HandoverSheet({ view, onClose }: { view: RoomView; onClose: () => void }) {
  const info = useServerInfo();
  const { base } = inviteBase(info, null);
  const [codes, setCodes] = useState<Record<string, SeatHandover>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const away = view.players.filter((p) => !p.connected && p.id !== view.you);

  const issue = async (playerId: string) => {
    const res = await client.handover(playerId);
    if (!res.ok) return showToast(res.error, 'error', 4200);
    setCodes((c) => ({ ...c, [playerId]: { playerId: res.playerId, code: res.code, expiresAt: res.expiresAt } }));
  };

  return (
    <Sheet title="끊긴 자리 넘기기" onClose={onClose}>
      <p className="muted small">
        원래 쓰던 브라우저로 다시 열 수 있으면 이 기능 없이 같은 자리로 돌아옵니다. 다른 브라우저나 기기로 옮겨야 할 때만 코드를 만들어 보여 주세요.
        코드를 쓰면 예전 기기의 자리 정보는 더 이상 쓸 수 없습니다.
      </p>
      {away.length === 0 && <p>지금 연결이 끊긴 자리가 없습니다.</p>}
      <ul className="handover-list">
        {away.map((p) => {
          const h = codes[p.id];
          const live = h && h.expiresAt > now ? h : null;
          const joinUrl = `${base}/join/${view.code}`;
          return (
            <li key={p.id} className="handover-item" style={{ borderColor: playerColor(p.colorIndex).hex }}>
              <div className="handover-head">
                <b>{p.nickname}</b>
                <span className="muted small">연결 끊김</span>
                <AsyncButton className="btn btn-small" onClick={() => issue(p.id)}>
                  {live ? '새 코드' : '코드 만들기'}
                </AsyncButton>
              </div>
              {live && (
                <div className="handover-code">
                  <QrCode text={`${joinUrl}?seat=${live.code}`} />
                  <div>
                    <div className="seat-code" aria-label={`자리 넘기기 코드 ${live.code}`}>
                      {live.code.slice(0, 3)} {live.code.slice(3)}
                    </div>
                    <p className="small">
                      새 기기에서 QR 코드를 찍으면 바로 이 자리로 들어갑니다. 또는 <span className="handover-url">{joinUrl}</span> 을(를) 열고 이 코드를
                      넣으세요. {Math.max(1, Math.ceil((live.expiresAt - Math.max(now, Date.now())) / 60_000))}분 안에 한 번만 쓸 수 있습니다.
                    </p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
