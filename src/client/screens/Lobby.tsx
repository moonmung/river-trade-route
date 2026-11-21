import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import type { RoomView, ServerInfo } from '../../shared/protocol';
import { client } from '../net/client';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { useChat } from '../net/chat';
import { ChatBox, EmoteBar } from '../ui/chat';
import { AsyncButton, Brand, copyText } from '../ui/common';
import { Emblem } from '../ui/icons';
import { RulesSummary } from '../ui/RulesSummary';
import { showToast } from '../ui/toast';
import { WinPointsStepper, saveWinPoints } from '../ui/WinPoints';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/info', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ServerInfo>) : null))
      .then((data) => alive && setInfo(data))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/**
 * 초대 링크 주소. 방장이 이 PC에서 localhost 로 열었다면 휴대폰이 접속할 수 있는 사설 IP로 바꾼다.
 * 이미 사설 IP로 접속한 화면(휴대폰 등)은 지금 주소를 그대로 쓴다.
 */
export function inviteBase(info: ServerInfo | null, chosen: string | null): { base: string; local: boolean; missingLan: boolean } {
  const local = LOCAL_HOSTS.has(window.location.hostname);
  if (!local) return { base: window.location.origin, local, missingLan: false };
  const address = chosen ?? info?.lanAddresses[0]?.address ?? null;
  if (!address || !info) return { base: window.location.origin, local, missingLan: !!info };
  return { base: `http://${address}:${info.port}`, local, missingLan: false };
}

export function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#2b2116', light: '#fffaf0' },
    })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [text]);
  // QR 이미지는 이 앱이 만든 초대 링크로만 생성된 SVG 다.
  return <div className="qr" aria-label="초대 링크 QR 코드" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Lobby({ view }: { view: RoomView }) {
  const info = useServerInfo();
  const [chosen, setChosen] = useState<string | null>(null);
  const me = view.players.find((p) => p.id === view.you);
  const isHost = view.hostId === view.you;
  const { emotes } = useChat(view.code);
  const { base, local, missingLan } = inviteBase(info, chosen);
  const link = `${base}/join/${view.code}`;
  const n = view.players.length;
  const notReady = view.players.filter((p) => !p.ready || !p.connected);
  const startProblem =
    n < view.minPlayers
      ? `${view.minPlayers - n}명이 더 들어와야 시작할 수 있습니다 (방장 포함 ${view.minPlayers}~${view.maxPlayers}명).`
      : notReady.length > 0
        ? `준비 대기: ${notReady.map((p) => p.nickname + (p.connected ? '' : '(연결 끊김)')).join(', ')}`
        : null;

  const slots = useMemo(() => {
    const out: (RoomView['players'][number] | null)[] = [...view.players];
    while (out.length < view.maxPlayers) out.push(null);
    return out;
  }, [view.players, view.maxPlayers]);

  return (
    <main className="page lobby">
      <div className="card">
        <div className="lobby-head">
          <Brand small />
          <div className="room-badge">
            방 코드 <span className="room-code">{view.code}</span>
          </div>
        </div>
        {view.gameNumber > 1 && <p className="muted small">{view.gameNumber}번째 게임을 준비하는 중입니다.</p>}

        <section className="invite">
          <div className="invite-text">
            <h2>초대</h2>
            <p className="muted">같은 와이파이에 연결된 휴대폰이나 PC에서 아래 링크를 열거나 QR 코드를 찍으세요.</p>
            <div className="invite-link">
              <code>{link}</code>
              <button
                className="btn btn-small"
                onClick={async () => showToast((await copyText(link)) ? '초대 링크를 복사했습니다.' : '복사하지 못했습니다. 링크를 길게 눌러 복사하세요.')}
              >
                복사
              </button>
            </div>
            {local && info && info.lanAddresses.length > 1 && (
              <label className="addr-pick small">
                접속 주소
                <select value={chosen ?? info.lanAddresses[0].address} onChange={(e) => setChosen(e.target.value)}>
                  {info.lanAddresses.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.address} ({a.name})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {local && missingLan && (
              <div className="notice notice-warn small">이 PC의 사설 IP를 찾지 못했습니다. 와이파이 연결을 확인하세요.</div>
            )}
            {local && !info && <div className="muted small">이 PC의 사설 IP를 확인하는 중…</div>}
          </div>
          <QrCode text={link} />
        </section>

        <section className="lobby-points">
          <h2>승리 점수</h2>
          {isHost ? (
            <WinPointsStepper
              value={view.winPoints}
              onChange={async (p) => {
                saveWinPoints(p);
                const res = await client.setWinPoints(p);
                if (!res.ok) showToast(res.error, 'error');
              }}
            />
          ) : (
            <div className="wp-fixed">
              <b>{view.winPoints}</b>점
            </div>
          )}
          <p className="muted small">{isHost ? '10~20점 사이로 정합니다. 바꾸면 다른 사람은 다시 준비해야 합니다.' : '방장이 정한 점수입니다. 이 점수에 먼저 닿으면 이깁니다.'}</p>
        </section>

        <section>
          <h2>
            참가자 {n}/{view.maxPlayers}
          </h2>
          <ul className="seat-list">
            {slots.map((p, i) =>
              p ? (
                <li key={p.id} className={`seat ${p.connected ? '' : 'seat-off'}`} style={{ borderColor: playerColor(p.colorIndex).hex }}>
                  <Emblem colorIndex={p.colorIndex} size={22} title={`${playerColor(p.colorIndex).name} 깃발`} />
                  <span className="seat-name">
                    {p.nickname}
                    {p.id === view.you && <span className="tag">나</span>}
                    {p.isHost && <span className="tag tag-host">방장</span>}
                    {emotes[p.id] && (
                      <span key={emotes[p.id].key} className="emote-pop">
                        {emotes[p.id].emote}
                      </span>
                    )}
                  </span>
                  <span className={`seat-state ${p.ready ? 'ready' : ''}`}>
                    {!p.connected ? '연결 끊김' : p.ready ? '준비 완료' : '준비 중'}
                  </span>
                  {isHost && p.id !== view.you && (
                    <AsyncButton
                      className="link-btn small"
                      onClick={async () => {
                        if (!window.confirm(`${p.nickname} 님을 대기실에서 내보낼까요?`)) return;
                        const res = await client.kick(p.id);
                        if (!res.ok) showToast(res.error, 'error');
                      }}
                    >
                      내보내기
                    </AsyncButton>
                  )}
                </li>
              ) : (
                <li key={`empty-${i}`} className="seat seat-empty">
                  빈 자리
                </li>
              ),
            )}
          </ul>
        </section>

        <div className="lobby-actions">
          <AsyncButton
            className={`btn btn-wide ${me?.ready ? 'btn-ready' : 'btn-primary'}`}
            onClick={async () => {
              const res = await client.setReady(!me?.ready);
              if (!res.ok) showToast(res.error, 'error');
            }}
          >
            {me?.ready ? '준비 완료 ✓ (누르면 취소)' : '준비하기'}
          </AsyncButton>
          {isHost && (
            <AsyncButton
              className="btn btn-start btn-wide"
              disabled={!!startProblem}
              onClick={async () => {
                const res = await client.start();
                if (!res.ok) showToast(res.error, 'error');
              }}
            >
              게임 시작
            </AsyncButton>
          )}
          <p className="muted small">
            {startProblem ?? (isHost ? '모두 준비되었습니다. 게임을 시작하세요.' : '모두 준비되었습니다. 방장이 시작하면 게임이 열립니다.')}
          </p>
          <AsyncButton
            className="link-btn"
            onClick={async () => {
              if (!window.confirm('대기실에서 나갈까요? 자리가 비워집니다.')) return;
              const res = await client.leave();
              if (res.ok) navigate('/');
              else showToast(res.error, 'error');
            }}
          >
            대기실에서 나가기
          </AsyncButton>
        </div>
      </div>
      <section className="card lobby-chat" aria-label="대기실 대화">
        <h2>대화</h2>
        <ChatBox code={view.code} you={view.you} />
        <EmoteBar />
      </section>
      <RulesSummary />
    </main>
  );
}
