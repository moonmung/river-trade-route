import { useState } from 'react';
import { NICKNAME_MAX } from '../../shared/constants';
import { normalizeNickname, normalizeRoomCode } from '../../shared/validate';
import { client } from '../net/client';
import { useClient } from '../net/hooks';
import { loadNickname } from '../net/session';
import { navigate } from '../router';
import { AsyncButton, Brand, Field } from '../ui/common';
import { RulesSummary } from '../ui/RulesSummary';

export function Home() {
  const snap = useClient();
  const [nickname, setNickname] = useState(loadNickname);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    const nick = normalizeNickname(nickname);
    if (!nick) return setError(`닉네임을 1~${NICKNAME_MAX}자로 입력하세요.`);
    const res = await client.createRoom(nick);
    if (!res.ok) return setError(res.error);
    navigate(`/room/${res.roomCode}`);
  };

  const goJoin = () => {
    setError(null);
    const c = normalizeRoomCode(code);
    if (!c) return setError('방 코드 4자리를 입력하세요. (예: 6QK8)');
    navigate(`/join/${c}`);
  };

  const interruption = snap.interruption;

  return (
    <main className="page">
      <div className="card hero">
        <Brand />
        {interruption && (
          <div className="notice notice-warn">
            {interruption.message}
            <button className="link-btn" onClick={() => client.clearInterruption()}>
              닫기
            </button>
          </div>
        )}
        {snap.session && (
          <div className="notice">
            진행 중인 방 <b>{snap.session.roomCode}</b>에 <b>{snap.session.nickname}</b>(으)로 참가해 있습니다.
            <button className="btn btn-small" onClick={() => navigate(`/room/${snap.session!.roomCode}`)}>
              방으로 돌아가기
            </button>
          </div>
        )}

        <Field label="닉네임" hint={`1~${NICKNAME_MAX}자, 같은 방 안에서 겹치지 않게`}>
          <input
            className="input"
            value={nickname}
            maxLength={NICKNAME_MAX + 4}
            autoComplete="nickname"
            enterKeyHint="go"
            placeholder="예: 강나루"
            onChange={(e) => setNickname(e.target.value)}
          />
        </Field>

        <div className="home-actions">
          <section>
            <h2>방 만들기</h2>
            <p className="muted">이 PC가 방장입니다. 만든 뒤 초대 링크나 QR 코드를 같은 와이파이의 친구에게 보여 주세요.</p>
            <AsyncButton className="btn btn-primary btn-wide" onClick={create} disabled={snap.conn !== 'connected'}>
              방 만들기
            </AsyncButton>
          </section>
          <section>
            <h2>방 코드로 참가</h2>
            <div className="inline-form">
              <input
                className="input code-input"
                value={code}
                maxLength={6}
                autoCapitalize="characters"
                autoComplete="off"
                inputMode="text"
                placeholder="6QK8"
                aria-label="방 코드"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && goJoin()}
              />
              <button className="btn" onClick={goJoin}>
                참가
              </button>
            </div>
          </section>
        </div>

        {error && <div className="notice notice-error">{error}</div>}
        {snap.conn !== 'connected' && <div className="muted small">서버에 연결하는 중…</div>}
      </div>

      <RulesSummary />

      <footer className="footer muted small">
        <a href="/lab" onClick={(e) => (e.preventDefault(), navigate('/lab'))}>
          3D 보드 장면 테스트
        </a>
        <span> · 휴대폰에서 물자 구분, 타일 터치, 프레임 시간을 확인하는 화면</span>
      </footer>
    </main>
  );
}
