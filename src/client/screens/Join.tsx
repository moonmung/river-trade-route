import { useEffect, useRef, useState } from 'react';
import { NICKNAME_MAX } from '../../shared/constants';
import { SEAT_CODE_LENGTH, normalizeSeatCode, type RoomPeek } from '../../shared/protocol';
import { normalizeNickname, normalizeRoomCode } from '../../shared/validate';
import { client } from '../net/client';
import { useClient } from '../net/hooks';
import { deviceSessionFor, loadNickname } from '../net/session';
import { navigate } from '../router';
import { AsyncButton, Brand, Field } from '../ui/common';

/** /join/방코드 — 휴대폰에서 초대 링크를 열면 나오는 참가 화면 */
export function Join({ code: rawCode }: { code: string }) {
  const snap = useClient();
  const code = normalizeRoomCode(rawCode);
  const [nickname, setNickname] = useState(loadNickname);
  const [peek, setPeek] = useState<RoomPeek | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previous = code ? deviceSessionFor(code) : null;
  // 방장 화면의 자리 넘기기 QR 코드로 열면 주소에 ?seat=123456 이 붙어 온다.
  const [linkSeat] = useState(() => normalizeSeatCode(new URLSearchParams(window.location.search).get('seat')));
  const [seatCode, setSeatCode] = useState(linkSeat ?? '');
  const triedLinkSeat = useRef(false);

  // 이 탭이 이미 이 방에 들어가 있으면 바로 방 화면으로 간다.
  useEffect(() => {
    if (code && snap.session?.roomCode === code) navigate(`/room/${code}`, true);
  }, [code, snap.session]);

  // 자리 넘기기 QR 로 열었으면 서버에 연결되자마자 한 번 자동으로 자리를 받는다.
  useEffect(() => {
    if (!code || !linkSeat || snap.conn !== 'connected' || triedLinkSeat.current) return;
    triedLinkSeat.current = true;
    void client.claimSeat(code, linkSeat).then((res) => {
      if (res.ok) navigate(`/room/${code}`, true);
      else setError(res.error);
    });
  }, [code, linkSeat, snap.conn]);

  useEffect(() => {
    if (!code || snap.conn !== 'connected') return;
    let alive = true;
    void client.peek(code).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setPeek(res);
        setPeekError(null);
      } else {
        setPeek(null);
        setPeekError(res.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [code, snap.conn, snap.connectCount]);

  if (!code) {
    return (
      <main className="page">
        <div className="card">
          <Brand small />
          <div className="notice notice-error">초대 링크의 방 코드({rawCode})가 올바르지 않습니다.</div>
          <button className="btn" onClick={() => navigate('/')}>
            처음 화면으로
          </button>
        </div>
      </main>
    );
  }

  const join = async () => {
    setError(null);
    const nick = normalizeNickname(nickname);
    if (!nick) return setError(`닉네임을 1~${NICKNAME_MAX}자로 입력하세요.`);
    const res = await client.joinRoom(code, nick);
    if (!res.ok) return setError(res.error);
    navigate(`/room/${code}`);
  };

  const resume = () => {
    if (!previous) return;
    client.resume(previous);
    navigate(`/room/${code}`);
  };

  const claim = async () => {
    setError(null);
    const seat = normalizeSeatCode(seatCode);
    if (!seat) return setError(`자리 넘기기 코드는 숫자 ${SEAT_CODE_LENGTH}자리입니다.`);
    const res = await client.claimSeat(code, seat);
    if (!res.ok) return setError(res.error);
    navigate(`/room/${code}`, true);
  };

  const inGame = peek?.phase === 'game';

  return (
    <main className="page">
      <div className="card hero">
        <Brand small />
        <h1 className="room-title">
          방 <span className="room-code">{code}</span> 참가
        </h1>
        {peek && (
          <p className="muted">
            {peek.hostNickname}의 방 · {peek.playerCount}/{peek.maxPlayers}명 · {peek.phase === 'lobby' ? '대기 중' : '게임 진행 중'}
          </p>
        )}
        {peekError && <div className="notice notice-error">{peekError}</div>}
        {snap.interruption && <div className="notice notice-warn">{snap.interruption.message}</div>}

        {previous && (
          <div className="notice">
            이 기기는 이 방에 <b>{previous.nickname}</b>(으)로 참가했었습니다.
            <button className="btn btn-primary btn-small" onClick={resume}>
              이전 자리로 돌아가기
            </button>
          </div>
        )}

        {(!peek || peek.joinable) && (
          <>
            <Field label={previous ? '새 참가자로 들어가기' : '닉네임'} hint={`1~${NICKNAME_MAX}자`}>
              <input
                className="input"
                value={nickname}
                maxLength={NICKNAME_MAX + 4}
                autoComplete="nickname"
                enterKeyHint="go"
                placeholder="예: 강나루"
                autoFocus={!previous}
                onChange={(e) => setNickname(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void join()}
              />
            </Field>
            <AsyncButton className="btn btn-primary btn-wide" onClick={join} disabled={snap.conn !== 'connected'}>
              참가하기
            </AsyncButton>
          </>
        )}
        {peek && !peek.joinable && !previous && (
          <div className="notice notice-warn">
            {inGame ? '이미 게임이 시작되어 새로 참가할 수 없습니다.' : '방이 가득 찼습니다.'}
          </div>
        )}
        {inGame && (
          <>
            <Field
              label="자리 넘기기 코드"
              hint={`다른 브라우저나 기기로 옮겨 왔다면 방장에게 '끊긴 자리 넘기기'를 눌러 달라고 하고, 받은 숫자 ${SEAT_CODE_LENGTH}자리를 넣으세요.`}
            >
              <input
                className="input code-input"
                value={seatCode}
                maxLength={SEAT_CODE_LENGTH + 2}
                inputMode="numeric"
                autoComplete="one-time-code"
                enterKeyHint="go"
                placeholder="123456"
                onChange={(e) => setSeatCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void claim()}
              />
            </Field>
            <AsyncButton className={previous ? 'btn btn-wide' : 'btn btn-primary btn-wide'} onClick={claim} disabled={snap.conn !== 'connected'}>
              이 코드의 자리로 들어가기
            </AsyncButton>
          </>
        )}
        {error && <div className="notice notice-error">{error}</div>}
        {snap.conn !== 'connected' && (
          <div className="muted small">서버에 연결하는 중… 오래 걸리면 방장 PC와 같은 와이파이인지 확인하세요.</div>
        )}
        <button className="link-btn" onClick={() => navigate('/')}>
          처음 화면으로
        </button>
      </div>
    </main>
  );
}
