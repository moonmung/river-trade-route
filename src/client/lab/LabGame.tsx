// /lab 의 모의 게임: 실제 게임 화면(Game.tsx)을 서버 없이 띄우고, 다른 자리는 봇이 둔다.
// 왼쪽 '실험' 서랍에서 보는 자리 바꾸기, 주사위 값 정하기, 자원·발전 카드 받기, 해양 교역 배, 달성·승리 화면 같은 연출을 바로 시험한다.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { boardOf, harborVertices } from '../../shared/board';
import { DEV_LABEL, RESOURCES, RESOURCE_LABEL, TURN_SECONDS_OPTIONS, emptyBundle } from '../../shared/constants';
import { autoPlay, buildingAt, computeResult, tradeRatios, vertexOpen } from '../../shared/rules';
import { MAP_ARRANGES, MAP_ARRANGE_LABEL, MAP_SHAPES, MAP_SHAPE_LABEL, maxPlayersFor } from '../../shared/maps';
import type { Bundle, DevKind, MapConfig, Resource } from '../../shared/types';
import type { BoardRenderer } from '../board/BoardRenderer';
import { colorWord } from '../game/derive';
import { paceBusy } from '../game/pace';
import { setActionSink } from '../game/ui';
import { injectBrag, injectChat, injectEmote, injectPing, setChatSink } from '../net/chat';
import Game from '../screens/Game';
import { navigate } from '../router';
import { PersonIcon } from '../ui/icons';
import { showAward } from '../ui/spectacle';
import { showToast } from '../ui/toast';
import { turnSecondsLabel } from '../ui/WinPoints';
import { LAB_CODE, Sandbox } from './sandbox';

const DEV_KINDS: DevKind[] = ['knight', 'road_building', 'year_of_plenty', 'monopoly', 'victory'];
let welcomed = false;

export function LabGame({ onScene }: { onScene: () => void }) {
  const [sb] = useState(() => new Sandbox({ players: 3 }));
  const view = useSyncExternalStore(sb.subscribe, sb.getView);
  const rendererRef = useRef<BoardRenderer | null>(null);

  // 화면 버튼의 행동·채팅을 서버 대신 모의 게임으로 보낸다.
  useEffect(() => {
    setActionSink(async (a) => sb.actMine(a));
    setChatSink({
      send: async (t) => {
        sb.say(sb.you, t);
        return { ok: true };
      },
      emote: async (e) => {
        sb.emote(sb.you, e);
        return { ok: true };
      },
      ping: async (kind, target) => {
        sb.ping(sb.you, kind, target);
        return { ok: true };
      },
      brag: async (award) => sb.brag(sb.you, award),
    });
    sb.onChat = (m) => injectChat(LAB_CODE, m);
    sb.onEmote = (e) => injectEmote(LAB_CODE, e);
    sb.onPing = (p) => injectPing(LAB_CODE, p);
    sb.onBrag = (b) => injectBrag(b);
    // 봇은 화면이 주사위·생산·동상 연출을 다 보여 준 뒤에 다음 수를 둔다.
    sb.busy = () => paceBusy(sb.state.events);
    if (!welcomed) {
      welcomed = true;
      sb.say('p1', '실험실 모의 게임입니다. 왼쪽 🧪 서랍에서 자리 바꾸기·주사위 정하기·해양 교역 배 같은 연출을 시험해 보세요.');
    }
    sb.start();
    // 개발 모드에서는 콘솔·자동 시험에서 모의 게임과 보드를 바로 다룰 수 있게 한다.
    if (import.meta.env.DEV) Object.assign(window, { __lab: { sb, renderer: () => rendererRef.current } });
    return () => {
      setActionSink(null);
      setChatSink(null);
      sb.busy = null;
      sb.stop();
    };
  }, [sb]);

  return (
    <Game key={view.gameNumber} view={view} onRenderer={(r) => (rendererRef.current = r)}>
      <LabDrawer sb={sb} rendererRef={rendererRef} onScene={onScene} />
    </Game>
  );
}

function LabDrawer({ sb, rendererRef, onScene }: { sb: Sandbox; rendererRef: React.RefObject<BoardRenderer | null>; onScene: () => void }) {
  const view = useSyncExternalStore(sb.subscribe, sb.getView);
  const g = view.game!;
  const [open, setOpen] = useState(false);
  const [players, setPlayers] = useState(sb.players.length);
  /** 달성 공지를 띄울 자리 (누를 때마다 다음 자리로 돌아 색마다 어떻게 보이는지 본다) */
  const [awardSeat, setAwardSeat] = useState(0);
  const nextAwardName = sb.players[awardSeat % sb.players.length]?.nickname ?? '';
  const announce = (award: 'longest_road' | 'largest_army') => {
    const p = sb.players[awardSeat % sb.players.length];
    setAwardSeat((n) => n + 1);
    showAward(award, {
      colorIndex: p.colorIndex,
      nickname: p.nickname,
      mine: p.id === me,
      detail: award === 'longest_road' ? '이어진 길 5칸 · +2점' : '기사 3장 · +2점',
    });
    rendererRef.current?.playAward(award, p.colorIndex, p.id);
  };
  const [map, setMap] = useState<MapConfig>(sb.map);
  /** 개수 제한 없음 (길·마을·도시·발전 카드) */
  const [unlimited, setUnlimited] = useState(!!sb.state.unlimited);
  /** 고르게 굴리기 */
  const [fair, setFair] = useState(sb.state.diceMode === 'balanced');
  const diceMode = fair ? ('balanced' as const) : ('random' as const);
  const [dice, setDice] = useState(8);
  const me = sb.you;
  const s = sb.state;

  const give = (who: string, b: Partial<Bundle>) =>
    sb.cheat((st) => {
      for (const r of RESOURCES) st.players[who].resources[r] += b[r] ?? 0;
    });
  const giveEach = (n: number) => give(me, Object.fromEntries(RESOURCES.map((r) => [r, n])));

  /** 해양 교역 배: 내 마을이 교역로에 없으면 하나 지어 주고, 내 차례 교환 단계면 실제 교환을, 아니면 연출만 보여 준다. */
  const harborTrade = () => {
    const board = boardOf(s);
    let mine = s.harbors.find((h) => harborVertices(board, h).some((v) => buildingAt(s.buildings, v)?.owner === me));
    if (!mine) {
      for (const h of s.harbors) {
        const v = harborVertices(board, h).find((x) => vertexOpen(board, s.buildings, x));
        if (!v) continue;
        sb.cheat((st) => st.buildings.push({ vertexId: v, owner: me, kind: 'village', builtTurn: st.turn }));
        mine = h;
        break;
      }
    }
    if (!mine) return showToast('빈 교역로 자리가 없습니다.', 'warn');
    const ratios = tradeRatios(s, me);
    const pay: Resource = mine.resource ?? RESOURCES.reduce((a, b) => (ratios[b] < ratios[a] ? b : a));
    const want: Resource = RESOURCES.find((r) => r !== pay)!;
    const giveB: Bundle = { ...emptyBundle(), [pay]: ratios[pay] };
    const getB: Bundle = { ...emptyBundle(), [want]: 1 };
    if (s.phase === 'playing' && view.game!.currentPlayerId === me && s.step === 'main') {
      if (s.players[me].resources[pay] < ratios[pay]) give(me, { [pay]: ratios[pay] });
      const res = sb.actMine({ type: 'bank_trade', give: giveB, get: getB });
      if (!res.ok) showToast(res.error, 'warn');
      return;
    }
    // 내 차례가 아니면 연출만 (자원은 바뀌지 않는다)
    window.setTimeout(() => rendererRef.current?.playHarborTrade(me, giveB, getB), 60);
    showToast(`해양 교역 연출만 보여 줍니다 (${RESOURCE_LABEL[pay]} ${ratios[pay]} → ${RESOURCE_LABEL[want]} 1). 내 차례 교환 단계에서 누르면 실제로 바꿉니다.`, 'info', 4200);
  };

  /** 다음 주사위를 내 마을이 닿은 숫자로 정한다 (카드가 날아드는 것을 보기 좋게) */
  const myNumber = (): number | null => {
    const nums = s.buildings
      .filter((b) => b.owner === me)
      .flatMap((b) => boardOf(s).vertexMap[b.vertexId].tiles.filter((t) => t !== s.robber && s.numbers[t]).map((t) => s.numbers[t]));
    return nums.length ? nums[Math.floor(Math.random() * nums.length)] : null;
  };

  const setNext = (total: number) => {
    const a = Math.max(1, Math.min(6, total - 1 - Math.floor(Math.random() * Math.min(5, total - 2))));
    const b = total - a;
    sb.nextDice = b >= 1 && b <= 6 ? [a, b] : [Math.min(6, total - 1), total - Math.min(6, total - 1)];
    showToast(`다음 주사위는 ${sb.nextDice[0]}+${sb.nextDice[1]} = ${total}`, 'info', 2200);
  };

  const finish = () =>
    sb.cheat((st) => {
      st.phase = 'finished';
      st.trades = [];
      st.result = computeResult(st, me);
    });

  if (!open) {
    return (
      <button className="lab-tab" onClick={() => setOpen(true)} aria-label="실험 서랍 열기">
        🧪<span>실험</span>
      </button>
    );
  }

  return (
    <div className="lab-drawer" role="region" aria-label="실험 서랍">
      <div className="lab-drawer-head">
        <b>🧪 실험실 모의 게임</b>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="서랍 접기">
          ‹
        </button>
      </div>

      <section>
        <h4>보는 자리</h4>
        <div className="lab-seats">
          {sb.players.map((p) => (
            <button key={p.id} className={`lab-seat ${p.id === me ? 'is-on' : ''}`} onClick={() => sb.setYou(p.id)} title={`${colorWord(p.colorIndex)} 자리로 보기`}>
              <PersonIcon colorIndex={p.colorIndex} size={14} /> {p.nickname}
            </button>
          ))}
        </div>
        <label className="lab-check">
          <input
            type="checkbox"
            defaultChecked={sb.bots}
            onChange={(e) => {
              sb.bots = e.target.checked;
              sb.setYou(sb.you);
            }}
          />{' '}
          다른 자리는 봇이 둡니다
        </label>
        <label className="lab-check">
          봇 빠르기{' '}
          <select defaultValue={sb.botDelay} onChange={(e) => (sb.botDelay = Number(e.target.value))}>
            <option value={250}>빠르게</option>
            <option value={750}>보통</option>
            <option value={1600}>천천히</option>
          </select>
        </label>
      </section>

      <section>
        <h4>게임</h4>
        <div className="lab-row">
          <select value={players} onChange={(e) => setPlayers(Number(e.target.value))} aria-label="인원">
            <option value={2}>2명</option>
            <option value={3}>3명</option>
            <option value={4}>4명</option>
            {maxPlayersFor(map.shape) > 4 ? (
              <>
                <option value={5}>5명</option>
                <option value={6}>6명</option>
                <option value={7}>7명</option>
                <option value={8}>8명</option>
              </>
            ) : null}
          </select>
          <select value={map.shape} onChange={(e) => setMap({ ...map, shape: e.target.value as MapConfig['shape'] })} aria-label="맵 모양">
            {MAP_SHAPES.map((s) => (
              <option key={s} value={s}>
                {MAP_SHAPE_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={map.arrange} onChange={(e) => setMap({ ...map, arrange: e.target.value as MapConfig['arrange'] })} aria-label="맵 배치">
            {MAP_ARRANGES.map((a) => (
              <option key={a} value={a}>
                {MAP_ARRANGE_LABEL[a]}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={() => sb.reset({ players, turnSeconds: sb.turnSeconds, map, unlimited, diceMode })}>
            새 게임
          </button>
          <button
            className="btn btn-small"
            onClick={() => sb.reset({ players, turnSeconds: sb.turnSeconds, map, unlimited, diceMode, rollForOrder: false })}
            title="순서 주사위 없이 바로 시작 배치"
          >
            순서 건너뛰기
          </button>
        </div>
        <label className="lab-row small">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> 개수 제한 없음 (새 게임부터)
        </label>
        <label className="lab-row small">
          <input type="checkbox" checked={fair} onChange={(e) => setFair(e.target.checked)} /> 주사위 고르게 굴리기 (새 게임부터)
        </label>
        <div className="lab-row">
          <button
            className="btn btn-small"
            disabled={g.phase !== 'order' && g.phase !== 'placement'}
            onClick={() => {
              const target = g.phase;
              for (let i = 0; i < 40 && sb.state.phase === target; i++) sb.cheat((st) => void autoPlay(st));
            }}
          >
            {g.phase === 'order' ? '순서 자동' : '시작 배치 자동'}
          </button>
          <label>
            차례 시간{' '}
            <select value={sb.turnSeconds} onChange={(e) => sb.setTurnSeconds(Number(e.target.value))}>
              {[10, ...TURN_SECONDS_OPTIONS].map((t) => (
                <option key={t} value={t}>
                  {turnSecondsLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="lab-check">
            <input type="checkbox" checked={sb.paused} onChange={(e) => sb.setPaused(e.target.checked)} /> 멈춤
          </label>
        </div>
      </section>

      <section>
        <h4>주사위 (다음 굴림)</h4>
        <div className="lab-row">
          <select value={dice} onChange={(e) => setDice(Number(e.target.value))} aria-label="다음 주사위 합">
            {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={() => setNext(dice)}>
            정하기
          </button>
          <button
            className="btn btn-small"
            onClick={() => {
              const n = myNumber();
              if (!n) return showToast('내 마을이 닿은 숫자 칸이 없습니다.', 'warn');
              setNext(n);
            }}
          >
            내 땅 숫자
          </button>
          <button className="btn btn-small" onClick={() => setNext(7)}>
            7
          </button>
        </div>
      </section>

      <section>
        <h4>자원·카드 (나에게)</h4>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => giveEach(1)}>
            모두 +1
          </button>
          <button className="btn btn-small" onClick={() => giveEach(3)}>
            모두 +3
          </button>
          <button className="btn btn-small" onClick={() => sb.cheat((st) => (st.players[me].resources = emptyBundle()))}>
            비우기
          </button>
        </div>
        <div className="lab-row">
          {DEV_KINDS.map((k) => (
            <button key={k} className="btn btn-small" onClick={() => sb.cheat((st) => st.players[me].devCards.push({ kind: k, boughtTurn: 0 }))}>
              {DEV_LABEL[k]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h4>연출</h4>
        <div className="lab-row">
          <button className="btn btn-small" onClick={harborTrade}>
            ⛵ 해양 교역 배
          </button>
          <button className="btn btn-small" onClick={finish}>
            승리 화면
          </button>
        </div>
        <div className="lab-row" title="누를 때마다 다음 자리의 색으로 띄웁니다">
          <span className="small">달성 공지 ({nextAwardName})</span>
          <button className="btn btn-small" onClick={() => announce('longest_road')}>
            최장 교역로
          </button>
          <button className="btn btn-small" onClick={() => announce('largest_army')}>
            최강 기사단
          </button>
        </div>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => navigate('/')}>
            처음으로
          </button>
          <button className="btn btn-small" onClick={onScene}>
            3D 장면 시험
          </button>
        </div>
      </section>
    </div>
  );
}
