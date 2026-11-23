import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import type { RoomView, ServerInfo } from '../../shared/protocol';
import { client } from '../net/client';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { useChat } from '../net/chat';
import { ChatBox, EmoteBar } from '../ui/chat';
import { AsyncButton, Brand, CloseRoomButton, copyText } from '../ui/common';
import { PersonIcon } from '../ui/icons';
import { RulesSummary } from '../ui/RulesSummary';
import { showToast } from '../ui/toast';
import { NumberStepper, WinPointsStepper, saveWinPoints, turnSecondsLabel } from '../ui/WinPoints';
import {
  DEV_CARDS_MAX,
  DEV_CARDS_MIN,
  DEV_LABEL,
  HAND_LIMIT_MAX,
  HAND_LIMIT_MIN,
  RESOURCE_CARDS_MAX,
  RESOURCE_CARDS_MIN,
  TURN_SECONDS_OPTIONS,
  devDeckFor,
} from '../../shared/constants';
import type { DevKind } from '../../shared/types';
import { MAP_ARRANGES, MAP_ARRANGE_LABEL, MAP_SHAPES, MAP_SHAPE_LABEL, mapTileCount, maxPlayersFor } from '../../shared/maps';
import type { MapArrange, MapShape } from '../../shared/types';
import { MapPreview } from '../ui/MapPreview';
import { DICE_MODE_LABEL, type DiceMode } from '../../shared/fairDice';

/** 발전 카드 더미 구성: "기사 14 · 승점 5 · 길 건설 2 · 풍년 2 · 독점 2" */
function devDeckText(total: number): string {
  const counts = devDeckFor(total);
  return (Object.keys(counts) as DevKind[]).map((k) => `${DEV_LABEL[k]} ${counts[k]}`).join(" · ");
}

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
          <h2>게임 규칙</h2>
          <div className="rule-rows">
            <div className="rule-row">
              <span className="rule-name">승리 점수</span>
              {isHost ? (
                <WinPointsStepper
                  value={view.winPoints}
                  onChange={async (p) => {
                    saveWinPoints(p);
                    const res = await client.setSettings({ winPoints: p });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                />
              ) : (
                <div className="wp-fixed">
                  <b>{view.winPoints}</b>점
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name" title="7이 나오면 이보다 많이 든 사람이 절반을 버립니다">
                자원 보유 한도
              </span>
              {isHost ? (
                <NumberStepper
                  value={view.handLimit}
                  min={HAND_LIMIT_MIN}
                  max={HAND_LIMIT_MAX}
                  unit="장"
                  label="자원 보유 한도"
                  onChange={async (n) => {
                    const res = await client.setSettings({ handLimit: n });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                />
              ) : (
                <div className="wp-fixed">
                  <b>{view.handLimit}</b>장
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name" title="은행에 자원마다 두는 카드 수. 다 떨어지면 그 자원은 받을 수 없습니다">
                자원 카드
              </span>
              {isHost ? (
                <NumberStepper
                  value={view.resourceCards}
                  min={RESOURCE_CARDS_MIN}
                  max={RESOURCE_CARDS_MAX}
                  unit="장씩"
                  label="자원 카드 장수 (종류마다)"
                  onChange={async (n) => {
                    const res = await client.setSettings({ resourceCards: n });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                />
              ) : (
                <div className="wp-fixed">
                  <b>{view.resourceCards}</b>장씩
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name" title="발전 카드 더미의 총 장수. 종류 비율은 그대로 둡니다">
                발전 카드
              </span>
              {isHost ? (
                <NumberStepper
                  value={view.devCards}
                  min={DEV_CARDS_MIN}
                  max={DEV_CARDS_MAX}
                  unit="장"
                  label="발전 카드 총 장수"
                  onChange={async (n) => {
                    const res = await client.setSettings({ devCards: n });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                />
              ) : (
                <div className="wp-fixed">
                  <b>{view.devCards}</b>장
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name" title="고르게: 숫자마다 확률대로 고르게 나오고 같은 숫자 연타·오랜 가뭄·한 사람에게 몰리는 7을 줄입니다">
                주사위
              </span>
              {isHost ? (
                <select
                  className="rule-select"
                  value={view.diceMode}
                  aria-label="주사위 방식"
                  onChange={async (e) => {
                    const res = await client.setSettings({ diceMode: e.target.value as DiceMode });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                >
                  <option value="balanced">고르게 (확률대로 고르게, 가뭄·연타 줄이기)</option>
                  <option value="random">무작위 (그냥 굴리기)</option>
                </select>
              ) : (
                <div className="wp-fixed">
                  <b>{DICE_MODE_LABEL[view.diceMode]}</b>
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name" title="없음으로 하면 길·마을·도시를 몇 개든 짓고 발전 카드도 떨어지지 않습니다">
                개수 제한
              </span>
              {isHost ? (
                <select
                  className="rule-select"
                  value={view.unlimited ? 'off' : 'on'}
                  aria-label="길·마을·도시·발전 카드 개수 제한"
                  onChange={async (e) => {
                    const res = await client.setSettings({ unlimited: e.target.value === 'off' });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                >
                  <option value="on">있음 (길 15·마을 5·도시 4, 발전 카드 소진)</option>
                  <option value="off">없음 (몇 개든 짓기, 발전 카드 무한)</option>
                </select>
              ) : (
                <div className="wp-fixed">
                  <b>{view.unlimited ? '없음' : '있음'}</b>
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name">차례 시간</span>
              {isHost ? (
                <select
                  className="rule-select"
                  value={view.turnSeconds}
                  aria-label="한 차례 제한 시간"
                  onChange={async (e) => {
                    const res = await client.setSettings({ turnSeconds: Number(e.target.value) });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                >
                  {TURN_SECONDS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {turnSecondsLabel(s)}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="wp-fixed">
                  <b>{turnSecondsLabel(view.turnSeconds)}</b>
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name">맵 모양</span>
              {isHost ? (
                <select
                  className="rule-select"
                  value={view.map.shape}
                  aria-label="맵 모양"
                  onChange={async (e) => {
                    const res = await client.setSettings({ mapShape: e.target.value as MapShape });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                >
                  {MAP_SHAPES.map((s) => (
                    <option key={s} value={s}>
                      {MAP_SHAPE_LABEL[s]} {mapTileCount(s)}칸 · {maxPlayersFor(s)}명까지
                    </option>
                  ))}
                </select>
              ) : (
                <div className="wp-fixed">
                  <b>{MAP_SHAPE_LABEL[view.map.shape]}</b> {mapTileCount(view.map.shape)}칸 · {maxPlayersFor(view.map.shape)}명까지
                </div>
              )}
            </div>
            <div className="rule-row">
              <span className="rule-name">땅 배치</span>
              {isHost ? (
                <select
                  className="rule-select"
                  value={view.map.arrange}
                  aria-label="땅 배치"
                  onChange={async (e) => {
                    const res = await client.setSettings({ mapArrange: e.target.value as MapArrange });
                    if (!res.ok) showToast(res.error, 'error');
                  }}
                >
                  {MAP_ARRANGES.map((a) => (
                    <option key={a} value={a}>
                      {MAP_ARRANGE_LABEL[a]}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="wp-fixed">
                  <b>{MAP_ARRANGE_LABEL[view.map.arrange]}</b>
                </div>
              )}
            </div>
          </div>
          <div className="map-pick">
            <MapPreview map={view.map} />
            <p className="muted small">
              {view.map.arrange === 'golden'
                ? '황금 배치는 땅, 숫자 패, 교역로가 정해져 있어 매판 같은 보드로 합니다. 자원마다 나올 확률이 고르게 나뉘도록 짜 두었습니다.'
                : '섞기는 게임을 시작할 때마다 땅과 숫자 패, 교역로 자원을 새로 섞습니다. 광장 자리만 그대로입니다.'}
              {view.map.shape === 'big' ? ' 대형 맵은 가운데가 바다라 교역로 10곳이 모두 그 둘레에 있고 8명까지 함께 할 수 있습니다.' : ''}
            </p>
          </div>
          <p className="muted small">
            {isHost ? '바꾸면 다른 사람은 다시 준비해야 합니다. ' : '방장이 정한 규칙입니다. '}
            7이 나오면 자원이 {view.handLimit}장보다 많은 사람이 절반을 버립니다.{' '}
            {view.turnSeconds > 0 ? `한 차례 ${turnSecondsLabel(view.turnSeconds)} 안에 끝내지 못하면 자동으로 진행합니다.` : '차례 시간 제한이 없습니다.'}{' '}
            은행에는 자원마다 {view.resourceCards}장이 있고 다 떨어진 자원은 생산과 교환으로 받을 수 없습니다. 발전 카드 {view.devCards}장은{' '}
            {devDeckText(view.devCards)}입니다.
            {view.unlimited
              ? ' 개수 제한이 없어서 길·마을·도시를 몇 개든 지을 수 있고, 발전 카드는 이 비율대로 무작위로 뽑혀 떨어지지 않습니다.'
              : ''}
            {view.diceMode === 'balanced'
              ? ' 주사위는 고르게 굴립니다: 36가지 눈을 카드처럼 뽑아 숫자마다 확률대로 나오고, 같은 숫자가 연달아 나오거나 한 사람만 오래 자원을 못 받거나 한 사람이 7을 몰아 굴리는 일을 줄입니다.'
              : ''}
          </p>
        </section>

        <section>
          <h2>
            참가자 {n}/{view.maxPlayers}
          </h2>
          <ul className="seat-list">
            {slots.map((p, i) =>
              p ? (
                <li key={p.id} className={`seat ${p.connected ? '' : 'seat-off'}`} style={{ borderColor: playerColor(p.colorIndex).hex }}>
                  <PersonIcon colorIndex={p.colorIndex} size={22} title={`${playerColor(p.colorIndex).name} 플레이어`} />
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
          {isHost && <CloseRoomButton className="link-btn link-danger" />}
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
