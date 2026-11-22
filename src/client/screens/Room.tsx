import { lazy, Suspense, useEffect } from 'react';
import { client } from '../net/client';
import { useClient } from '../net/hooks';
import { navigate } from '../router';
import { Brand, ConnectionBanner } from '../ui/common';
import { SeatHandoverButton } from '../ui/handover';
import { Lobby } from './Lobby';

const Game = lazy(() => import('./Game'));

/** /room/방코드 — 대기실과 게임 화면. 새로고침하면 저장된 참가 토큰으로 같은 자리에 다시 붙는다. */
export function RoomScreen({ code }: { code: string }) {
  const snap = useClient();
  const { session, view, interruption } = snap;

  // 이 탭의 자리(sessionStorage)가 있으면 새로고침으로 보고 그대로 이어 간다.
  // 없으면 참가 화면으로 보낸다. 거기서 "이전 자리로 돌아가기"를 직접 눌러야 기기에 저장된 자리로 돌아간다
  // (한 기기에서 여러 탭을 쓸 때 남의 자리를 자동으로 가져오지 않게).
  useEffect(() => {
    if (interruption) return;
    if (session?.roomCode === code) return;
    navigate(`/join/${code}`, true);
  }, [code, session, interruption]);

  // 게임 화면 코드를 미리 받아 두면 시작 버튼을 누른 뒤 바로 보드가 뜬다.
  useEffect(() => {
    void import('./Game');
  }, []);

  if (interruption) {
    const previous = interruption.session;
    return (
      <main className="page">
        <div className="card">
          <Brand small />
          <div className="notice notice-warn">{interruption.message}</div>
          <div className="row-buttons">
            {interruption.kind === 'replaced' && previous && (
              <button className="btn btn-primary" onClick={() => client.resume(previous)}>
                이 화면에서 계속하기
              </button>
            )}
            {interruption.kind !== 'replaced' && interruption.kind !== 'closed' && (
              <button
                className="btn"
                onClick={() => {
                  client.clearInterruption();
                  navigate(`/join/${code}`);
                }}
              >
                참가 화면으로
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                navigate('/');
              }}
            >
              처음 화면으로
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!view || view.code !== code) {
    return (
      <main className="page">
        <ConnectionBanner />
        <div className="center-note">
          <span className="spinner" aria-hidden /> 방 {code}에 연결하는 중…
        </div>
      </main>
    );
  }

  if (view.phase === 'lobby') {
    return (
      <>
        <ConnectionBanner />
        <Lobby view={view} />
      </>
    );
  }

  return (
    <>
      <ConnectionBanner />
      <Suspense fallback={<div className="center-note">게임 화면을 불러오는 중…</div>}>
        <Game view={view} />
      </Suspense>
      <SeatHandoverButton view={view} />
    </>
  );
}
