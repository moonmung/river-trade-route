import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { boardOf } from '../../shared/board';
import { PIECE_LABEL, RESOURCES, emptyBundle, hasBundle } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableRoads, buildableVillages, longestRoadPath, pieceCount, pieceLimit } from '../../shared/rules';
import type { BoardRenderer, BoardSelection, BoardState, Insets } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import { BoardPin } from '../board/BoardPin';
import { FlatBoard } from '../board/FlatBoard';
import type { PerfStats } from '../board/perf';
import type { Bundle, DevKind, PieceKind } from '../../shared/types';
import {
  boardHighlights,
  buildBlocker,
  formatScoreEvent,
  isScoreEvent,
  playDevBlocker,
  playerMap,
  roadStatus,
  spotAction,
  turnBlocker,
  type BoardPick,
} from '../game/derive';
import {
  DevPlayCard,
  DiscardDialog,
  MenuDialog,
  PlacementBanner,
  ResultOverlay,
  SpotConfirm,
  StealDialog,
  prefersReducedMotion,
  type GameSettings,
} from '../game/dialogs';
import { clearFlyingCards, useHeldCards } from '../game/cardFly';
import { useGameEffects } from '../game/effects';
import { usePaceWait } from '../game/pace';
import { Hand } from '../game/hand';
import { LogOverlay, TurnFeed } from '../game/log';
import { BankPanel, BragButtons, BuildBar, PlayersPanel, TradeButton, TurnButton } from '../game/panels';
import { TradeDeeds, TradePanel, handPickToDraft, newDraft, type TradeDraft } from '../game/trade';
import { OrderRollPanel, TurnStatus } from '../game/turn';
import { sendAction, useLocalSetting, useMediaQuery } from '../game/ui';
import { sendChatPing, useChat } from '../net/chat';
import { ChatBox, ChatDock, EmoteBar, PingButton, PingMark } from '../ui/chat';
import { PersonIcon } from '../ui/icons';
import { showToast } from '../ui/toast';
import { FullscreenButton } from '../ui/FullscreenButton';
import { AwayBanner, AwayButton, useAwayNotices } from '../game/away';
import { SpectacleHost, useVictoryActive, victoryBarHeight } from '../ui/spectacle';
import { DiceTray } from '../dice/DiceTray';

const DEFAULT_SETTINGS: GameSettings = { quality: 'auto', flat: false, perf: false };
/** 순서가 정해진 뒤 결과 창을 띄워 두는 시간 */
const ORDER_RESULT_MS = 4200;

export default function Game({ view, onRenderer, children }: { view: RoomView; onRenderer?: (r: BoardRenderer | null) => void; children?: ReactNode }) {
  const g = view.game!;
  const players = useMemo(() => playerMap(view), [view.players]);
  // 넓은 화면이나 가로로 눕힌 휴대폰은 오른쪽 패널 배치를 쓴다.
  const wide = useMediaQuery('(min-width: 900px), (orientation: landscape) and (min-width: 640px)');
  const [settings, setSettings] = useLocalSetting<GameSettings>('rr.settings', DEFAULT_SETTINGS);
  /** 건설 모드: [도로]·[마을]·[도시]·[배]를 누르면 지을 수 있는 자리가 빛나고, 그 자리를 고르면 자리 위에 ✓ / ✕ 가 뜬다 */
  const [buildMode, setBuildModeRaw] = useState<PieceKind | null>(null);
  /** 옮기려고 고른 내 배 (섬 맵). 고르면 옮겨 댈 수 있는 바닷길이 빛난다. */
  const [moveFrom, setMoveFrom] = useState<string | null>(null);
  const setBuildMode = (kind: PieceKind | null) => {
    setBuildModeRaw(kind);
    setMoveFrom(null);
  };
  const pick = useMemo<BoardPick>(() => ({ mode: buildMode, moveFrom }), [buildMode, moveFrom]);
  /** 보드에서 고른 자리. 할 일이 있는 자리면 그 위에 ✓ / ✕ 가 붙고 ✓ 를 눌러야 짓는다. */
  const [selected, setSelected] = useState<BoardSelection | null>(null);
  const [dialog, setDialog] = useState<null | 'menu' | 'log'>(null);
  /** 쓰기 창을 연 발전 카드 (손에 든 발전 카드를 눌러 연다) */
  const [devOpen, setDevOpen] = useState<DevKind | null>(null);
  const chat = useChat(view.code);
  /** 교환 창 (손에 든 카드 위에 붙어 열린다). 고르는 중인 낼 것·받을 것 */
  const [tradeDraft, setTradeDraft] = useState<TradeDraft | null>(null);
  const [showResult, setShowResult] = useState(true);
  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [glFailed, setGlFailed] = useState(false);
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);
  /** 마우스를 올린 길 (캔버스 좌표) */
  const [hoverRoad, setHoverRoad] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  /** 자리 순서가 막 정해져 결과를 잠깐 보여 주는 중 */
  const [orderDone, setOrderDone] = useState(false);
  /** 핑 찍기: 켜져 있으면 다음에 누른 보드 자리를 모두에게 가리킨다 (Alt+클릭은 켜지 않아도 바로 찍는다) */
  const [pingMode, setPingMode] = useState(false);
  useEffect(() => {
    if (!pingMode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPingMode(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pingMode]);
  const myTurn = g.phase === 'playing' && g.currentPlayerId === view.you;
  /**
   * 주사위가 멈추고 합계를 읽을 틈, 생산 카드가 손에 닿을 때, 옮긴 동상이 내려앉을 때까지 기다리는 중이면 그 까닭.
   * 서버는 이미 다음 단계지만 그동안은 단계에 따라 열리는 것(빛나는 자리, 버리기·빼앗기 창, 버튼)을 미룬다.
   */
  const wait = usePaceWait(view);
  const held = useHeldCards();
  // 날아오는 중인 카드는 손에 닿을 때 센다.
  const shownResources = useMemo<Bundle>(() => {
    const h = held[view.you];
    if (!h) return g.myResources;
    const out = { ...g.myResources };
    for (const r of RESOURCES) out[r] = Math.max(0, out[r] - h[r]);
    return out;
  }, [g.myResources, held, view.you]);

  useEffect(() => () => clearFlyingCards(), []);

  // 건설 모드는 더 이상 지을 수 없게 되면(턴 종료, 비용 부족 등) 자동으로 끈다. 배 옮기기도 차례가 끝나거나 이미 옮겼으면 끈다.
  useEffect(() => {
    if (buildMode && buildBlocker(view, buildMode)) setBuildMode(null);
    if (moveFrom && (!myTurn || g.step !== 'main' || g.shipMoved || !g.ships.some((s) => s.edgeId === moveFrom && s.owner === view.you))) setMoveFrom(null);
    if (devOpen && !g.myDevCards.some((c) => c.kind === devOpen)) setDevOpen(null);
    // 교환 창은 내 차례 main 단계에서만 연다. 자원이 바뀌어 고른 카드가 모자라면 낼 것을 비운다.
    if (tradeDraft && (!myTurn || g.step !== 'main')) setTradeDraft(null);
    else if (tradeDraft && !hasBundle(g.myResources, tradeDraft.give)) setTradeDraft({ ...tradeDraft, give: emptyBundle() });
  }, [view, buildMode, moveFrom, devOpen, tradeDraft]);

  // 단계가 바뀌면 고른 자리를 지운다 (시작 배치 차례·마을을 지은 뒤 길 고르기, 동상 옮기기, 공짜 길 등).
  useEffect(() => {
    setSelected(null);
  }, [g.phase, view.gameNumber, g.placementPlayerId, g.setupVillage, g.buildings.length, g.step, g.currentPlayerId]);

  useEffect(() => {
    if (g.phase === 'finished') setShowResult(true);
  }, [g.phase]);

  // 순서 정하기가 끝나면 정해진 순서를 잠깐 보여 준다.
  const prevPhase = useRef(g.phase);
  const orderTimer = useRef(0);
  useEffect(() => {
    // 시작 배치가 금방 끝나 단계가 또 바뀌어도 정해진 시간이 지나면 닫힌다 (타이머는 화면을 떠날 때만 거둔다).
    if (prevPhase.current === 'order' && g.phase !== 'order') {
      setOrderDone(true);
      window.clearTimeout(orderTimer.current);
      orderTimer.current = window.setTimeout(() => setOrderDone(false), ORDER_RESULT_MS);
    }
    prevPhase.current = g.phase;
  }, [g.phase]);
  useEffect(() => () => window.clearTimeout(orderTimer.current), []);

  const highlights = useMemo<BoardState['highlights']>(() => {
    if (wait) return null;
    const h = boardHighlights(view, pick);
    if (!h.vertices.length && !h.edges.length && !h.shipEdges.length && !h.tiles.length) return null;
    return { ...h, kind: g.phase === 'placement' ? 'placeable' : 'buildable' };
  }, [view, pick, g.phase, wait]);
  // 내 차례(건설 모드 밖)에는 길을 이을 수 있는 변과 마을을 지을 수 있는 꼭짓점을 은은하게 보여 준다.
  const hints = useMemo<BoardState['hints']>(() => {
    if (!myTurn || g.step !== 'main' || buildMode || moveFrom || wait) return null;
    const me = view.you;
    return {
      edges: pieceCount(g.buildings, g.roads, me, 'road') < pieceLimit(g, 'road') ? buildableRoads(boardOf(g), g.buildings, g.roads, me, g.ships) : [],
      vertices: pieceCount(g.buildings, g.roads, me, 'village') < pieceLimit(g, 'village') ? buildableVillages(boardOf(g), g.buildings, g.roads, me, g.ships) : [],
    };
  }, [myTurn, g.step, buildMode, moveFrom, wait, g.buildings, g.roads, g.ships, view.you]);
  // 길·배에 마우스를 올리거나 누르면 그 주인의 가장 긴 교역로를 금빛으로 따라 그린다.
  const pieceOwner = (edgeId: string) => g.roads.find((r) => r.edgeId === edgeId)?.owner ?? g.ships.find((s) => s.edgeId === edgeId)?.owner;
  const traceOwner = (hoverRoad && pieceOwner(hoverRoad.edgeId)) || (selected?.kind === 'edge' ? pieceOwner(selected.id) : undefined) || null;
  const trace = useMemo(
    () => (traceOwner ? longestRoadPath(boardOf(g), g.roads, g.buildings, traceOwner, g.ships) : null),
    [traceOwner, g.roads, g.buildings, g.ships],
  );
  const boardState = useMemo<BoardState>(
    () => ({
      buildings: g.buildings.map((b) => ({
        vertexId: b.vertexId,
        kind: b.kind,
        owner: b.owner,
        colorIndex: players.get(b.owner)?.colorIndex ?? 0,
        label: `${players.get(b.owner)?.nickname ?? '?'}의 ${PIECE_LABEL[b.kind]}`,
      })),
      roads: g.roads.map((r) => ({ edgeId: r.edgeId, owner: r.owner, colorIndex: players.get(r.owner)?.colorIndex ?? 0 })),
      ships: g.ships.map((s) => ({ edgeId: s.edgeId, owner: s.owner, colorIndex: players.get(s.owner)?.colorIndex ?? 0 })),
      movingShip: moveFrom,
      highlights,
      selected,
      numbers: g.numbers,
      robber: g.robber,
      harbors: g.harbors,
      hints,
      trace,
    }),
    [g.buildings, g.roads, g.ships, moveFrom, players, highlights, selected, g.numbers, g.robber, g.harbors, hints, trace],
  );

  // HUD 가 가리는 영역을 재서 보드가 남은 공간 가운데에 오도록 한다.
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  useLayoutEffect(() => {
    const measure = () =>
      setInsets({
        // 좁은 화면은 왼쪽 위 상태 쪽지 아래부터 보드를 놓는다. 넓은 화면은 위쪽을 가리는 것이 없다.
        top: wide ? 0 : (topRef.current?.offsetHeight ?? 0),
        bottom: bottomRef.current?.offsetHeight ?? 0,
        right: wide ? (sideRef.current?.offsetWidth ?? 0) : 0,
        left: 0,
      });
    const ro = new ResizeObserver(measure);
    for (const el of [topRef.current, bottomRef.current, sideRef.current]) if (el) ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [wide]);

  useGameEffects(view, renderer, players);
  useAwayNotices(view, players);
  /** 승리 연출 중: 손 카드·패널을 숨기고 위아래 영화 띠 사이에 보드를 맞추며, 끝날 때까지 결과 창을 미룬다 */
  const victoryOn = useVictoryActive();
  const boardInsets = useMemo<Insets>(() => {
    if (!victoryOn) return insets;
    const bar = victoryBarHeight();
    return { top: bar, bottom: bar, left: 0, right: 0 };
  }, [victoryOn, insets]);
  /** 내가 자리 비움(자동) 중인지: 서버가 대신 두므로 주사위 던지기 자리를 띄우지 않는다 */
  const away = !!players.get(view.you)?.auto && g.phase !== 'finished';
  const takeRenderer = (r: BoardRenderer | null) => {
    setRenderer(r);
    onRenderer?.(r);
  };

  const onTap = (sel: BoardSelection, info?: { alt: boolean }) => {
    // 핑: 핑 단추를 켰거나 Alt 키를 누른 채 누르면 그 자리를 모두에게 가리킨다 (고르기·짓기는 하지 않는다).
    // 횟수 제한에 걸리면 알림 없이 그냥 찍히지 않는다.
    if (pingMode || info?.alt) {
      setPingMode(false);
      void sendChatPing(sel.kind, sel.id);
      return;
    }
    // 연출이 끝나기 전에는 동상 칸·공짜 길 자리를 고를 수 없다.
    if (wait) return;
    setTradeDraft(null);
    setDevOpen(null);
    // 시작 배치(마을 → 길), 길 건설 카드, 건설 모드, 동상 옮기기 모두 같은 방식이다.
    // 빛나는 자리를 고르면 그 위에 파란 ✓ 와 빨간 ✕ 가 뜨고, ✓ 를 눌러야 짓는다. 같은 자리를 다시 누르면 무른다.
    if (g.phase === 'placement' && g.placementPlayerId === view.you) {
      setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : spotAction(view, sel) ? sel : null));
      return;
    }
    if (g.phase === 'playing' && g.step === 'road_building' && g.currentPlayerId === view.you) {
      setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : spotAction(view, sel, pick) ? sel : null));
      return;
    }
    // 배를 옮기는 중: 옮기려던 배를 다시 누르면 그만둔다.
    if (moveFrom && sel.kind === 'edge' && sel.id === moveFrom) {
      setMoveFrom(null);
      setSelected(null);
      return;
    }
    setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : sel));
  };
  const clearPick = () => {
    setSelected(null);
    setBuildMode(null);
  };
  const useFlat = settings.flat || glFailed;
  // 오른쪽 패널에는 점수와 이어진 기록만 몇 줄 (전체 기록은 메뉴)
  const recent = g.events.filter(isScoreEvent).slice(-4).reverse();
  const stepBanner = wait
    ? null
    : myTurn && g.step === 'robber'
      ? '기사단 동상을 옮길 칸을 누르세요. 그 칸은 동상이 떠날 때까지 생산하지 않습니다.'
      : myTurn && g.step === 'road_building'
        ? `길 건설 카드: 빛나는 변을 고르고 ✓ 를 누르세요. 공짜 길이 ${g.freeRoads}개 남았습니다.`
        : null;
  // 좁은 화면에서는 보드 위에 떠 있고, 넓은 화면에서는 오른쪽 패널 위쪽에 놓인다 (보드를 가리지 않게).
  const banners = (
    <>
      <PlacementBanner view={view} players={players} picked={!!selected} />
      {pingMode && (
        <div className="mode-banner mode-banner-ping">
          핑 찍기 · 보드에서 모두에게 가리킬 곳을 누르세요.{' '}
          <button className="link-btn small" onClick={() => setPingMode(false)}>
            그만두기
          </button>
        </div>
      )}
      {stepBanner && <div className="mode-banner">{stepBanner}</div>}
      {buildMode && (
        <div className="mode-banner">
          {buildMode === 'road' && '길 놓기 · 빛나는 변을 고르고 ✓ 를 누르세요.'}
          {buildMode === 'village' && '마을 짓기 · 빛나는 꼭짓점을 고르고 ✓ 를 누르세요.'}
          {buildMode === 'city' && '도시로 업그레이드 · 빛나는 내 마을을 고르고 ✓ 를 누르세요.'}
          {buildMode === 'ship' && '배 띄우기 · 빛나는 바닷길을 고르고 ✓ 를 누르세요.'}{' '}
          <button className="link-btn small" onClick={() => setBuildMode(null)}>
            그만두기
          </button>
        </div>
      )}
      {moveFrom && (
        <div className="mode-banner">
          배 옮기기 · 빛나는 바닷길을 고르고 ✓ 를 누르세요. 한 턴에 한 번 옮길 수 있습니다.{' '}
          <button className="link-btn small" onClick={() => setMoveFrom(null)}>
            그만두기
          </button>
        </div>
      )}
    </>
  );
  const openMenu = () => setDialog('menu');
  const openLog = () => setDialog('log');
  // 보드 위 핑 물결 (찍은 사람 색). 3D 보드는 BoardPin 으로, 2D 보드는 marks 로 그 자리 한가운데에 겹친다.
  const pingMarks = chat.pings.map((p) => ({
    key: p.key,
    sel: { kind: p.kind, id: p.target } as BoardSelection,
    node: <PingMark colorIndex={players.get(p.from)?.colorIndex ?? 0} name={players.get(p.from)?.nickname ?? '?'} />,
  }));
  const pingButton = (compact: boolean) => <PingButton compact={compact} active={pingMode} onToggle={() => setPingMode((v) => !v)} />;
  // 고른 자리 위의 ✓ / ✕ (할 일이 있는 자리만). 교환·발전 카드 창이 열려 있거나 연출을 기다리는 동안은 숨긴다.
  const pinNode =
    selected && !tradeDraft && !devOpen && !wait && spotAction(view, selected, pick) ? (
      <SpotConfirm
        view={view}
        sel={selected}
        pick={pick}
        onClose={() => setSelected(null)}
        onDone={clearPick}
        onStartMove={(edgeId) => {
          setSelected(null);
          setBuildModeRaw(null);
          setMoveFrom(edgeId);
        }}
      />
    ) : null;

  return (
    <div className={`game ${wide ? 'game-wide' : 'game-narrow'} ${pingMode ? 'is-pinging' : ''} ${victoryOn ? 'is-victory' : ''}`}>
      <div className="board-layer">
        {useFlat ? (
          <div className="flat-wrap" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, paddingRight: insets.right + 8 }}>
            {glFailed && <div className="notice notice-warn small">3D 보드를 표시할 수 없어 2D 보드로 보여 줍니다.</div>}
            <FlatBoard
              tiles={boardOf(g).tiles}
              sea={boardOf(g).sea?.cells}
              state={boardState}
              onTap={onTap}
              pin={pinNode && selected ? { sel: selected, node: pinNode } : null}
              marks={pingMarks}
            />
          </div>
        ) : (
          <BoardView
            tiles={boardOf(g).tiles}
            sea={boardOf(g).sea?.cells}
            state={boardState}
            insets={boardInsets}
            quality={settings.quality}
            showTileLabels={false}
            motion={settings.motion ?? !prefersReducedMotion()}
            shadows={settings.shadows ?? true}
            onTap={onTap}
            onHover={(sel, x, y) => setHoverRoad(sel?.kind === 'edge' && pieceOwner(sel.id) ? { edgeId: sel.id, x, y } : null)}
            onPerf={settings.perf ? setPerf : undefined}
            onError={() => setGlFailed(true)}
            onRenderer={takeRenderer}
          />
        )}
        {!useFlat && renderer && pinNode && selected && (
          <BoardPin renderer={renderer} sel={selected}>
            {pinNode}
          </BoardPin>
        )}
        {!useFlat &&
          renderer &&
          pingMarks.map((m) => (
            <BoardPin key={m.key} renderer={renderer} sel={m.sel} center>
              {m.node}
            </BoardPin>
          ))}
      </div>

      {hoverRoad && traceOwner && trace && (
        <div className="road-tip" style={{ left: hoverRoad.x, top: hoverRoad.y }} role="tooltip">
          <div className="road-tip-head">
            <PersonIcon colorIndex={players.get(traceOwner)?.colorIndex ?? 0} size={14} />
            {traceOwner === view.you ? '내 교역로' : `${players.get(traceOwner)?.nickname ?? '?'}의 교역로`}
          </div>
          <div>
            {g.sea.length ? '이어진 길·배' : '이어진 길'} <b>{trace.length}칸</b>
          </div>
          <div className="road-tip-note">{roadStatus(view, traceOwner, trace.length, (id) => players.get(id)?.nickname ?? '?')}</div>
        </div>
      )}

      {/* 넓은 화면 보드 왼쪽 위: [기록] 단추와 이번 턴 기록 (좁은 화면은 차례 상태 쪽지 아래) */}
      {wide && (
        <div className="hud-feed">
          <TurnFeed view={view} players={players} onOpenLog={openLog} />
        </div>
      )}

      {/* 넓은 화면 보드 오른쪽 위(오른쪽 패널 바로 왼쪽): 전체화면 단추 (좁은 화면은 차례 상태 쪽지 맨 오른쪽) */}
      {wide && (
        <div className="hud-fs">
          {g.phase !== 'finished' && <AwayButton on={away} withLabel />}
          <FullscreenButton />
        </div>
      )}

      {/* 보드 왼쪽 위: 좁은 화면은 차례 상태 쪽지와 안내 띠, 넓은 화면은 교환 증서만 */}
      <div className="hud-top">
        {!wide && (
          <div className="hud-status" ref={topRef}>
            <TurnStatus view={view} players={players} onMenu={openMenu} wait={wait} compact
              tail={
                <>
                  {g.phase !== 'finished' && <AwayButton on={away} />}
                  <FullscreenButton />
                </>
              }
            />
            <PlayersPanel view={view} players={players} emotes={chat.emotes} compact />
            <BankPanel view={view} compact />
          </div>
        )}
        {!wide && <TurnFeed view={view} players={players} compact onOpenLog={openLog} />}
        <div className="hud-float">
          {!wide && banners}
          <TradeDeeds view={view} players={players} compact={!wide} />
        </div>
      </div>

      {wide && (
        <aside className="hud-side" ref={sideRef}>
          <TurnStatus view={view} players={players} onMenu={openMenu} wait={wait} />
          {banners}
          <section className="side-log">
            <h3>
              최근 기록{' '}
              <button className="link-btn small" onClick={openLog}>
                전체 보기
              </button>
            </h3>
            <ol className="log log-mini">
              {recent.length === 0 && <li className="log-empty">마을·도시, 발전 카드, 달성처럼 점수와 이어진 일이 여기에 남습니다.</li>}
              {recent.map((e) => (
                <li key={e.seq}>{formatScoreEvent(e, players, view.you, g)}</li>
              ))}
            </ol>
          </section>
          <section className="side-chat">
            <h3>대화</h3>
            <ChatBox code={view.code} you={view.you} />
            <div className="emote-row">
              <EmoteBar />
              <BragButtons view={view} />
              {pingButton(false)}
            </div>
          </section>
          <BankPanel view={view} />
          <section className="side-players">
            {/* 5명이 넘으면(대형 맵) 한 줄에 두 사람씩 작은 꼴로 놓아 오른쪽 칸 안에 다 들어가게 한다 */}
            <PlayersPanel view={view} players={players} emotes={chat.emotes} compact={g.order.length > 4} />
          </section>
        </aside>
      )}

      <div className="hud-bottom" ref={bottomRef}>
        {!wide && (
          <div className="hud-corner">
            <ChatDock
              code={view.code}
              you={view.you}
              extra={
                <>
                  <BragButtons view={view} compact />
                  {pingButton(true)}
                </>
              }
            />
          </div>
        )}
        {tradeDraft && <TradePanel view={view} players={players} draft={tradeDraft} onDraft={setTradeDraft} onClose={() => setTradeDraft(null)} />}
        {devOpen && !tradeDraft && <DevPlayCard key={devOpen} view={view} kind={devOpen} wait={wait} onClose={() => setDevOpen(null)} />}
        <div className="me-row">
          <Hand
            resources={shownResources}
            ratios={g.myTradeRatios}
            devCards={g.myDevCards.map((c) => ({ kind: c.kind, fresh: c.boughtTurn >= g.turn }))}
            // 주사위가 구르는 동안(wait)에도 쓸 수 있음 표시는 그대로 둔다. 껐다 켜면 카드가 내려갔다 올라와 움찔한다.
            devPlayable={(kind) => !playDevBlocker(view, kind)}
            activeDev={devOpen}
            onResource={(r) => {
              if (wait) {
                showToast(wait, 'info');
                return;
              }
              // 내 차례 main 단계면 교환 창을 열고 누른 카드를 낼 것에 넣는다.
              const next = handPickToDraft(view, tradeDraft, r);
              if (!next) {
                showToast(turnBlocker(view) ?? '지금은 교환할 수 없습니다.', 'warn');
                return;
              }
              if (next === tradeDraft) {
                const bank = tradeDraft.mode === 'bank';
                showToast(bank ? `은행에는 같은 자원을 ${g.myTradeRatios[r]}장씩 냅니다. 남은 카드가 모자랍니다.` : '이 카드는 더 낼 수 없습니다.', 'warn');
                return;
              }
              setBuildMode(null);
              setSelected(null);
              setDevOpen(null);
              setTradeDraft(next);
            }}
            onDev={(kind) => {
              // 열어 둔 창을 닫는 것은 기다리지 않는다.
              if (wait && devOpen !== kind) {
                showToast(wait, 'info');
                return;
              }
              setTradeDraft(null);
              setSelected(null);
              setDevOpen((cur) => (cur === kind ? null : kind));
            }}
          />
          <div className={`me-actions ${g.sea.length ? 'me-actions-sea' : ''}`}>
            <TradeButton
              view={view}
              tradeOpen={!!tradeDraft}
              wait={wait}
              onTrade={() => {
                if (tradeDraft) return setTradeDraft(null);
                setBuildMode(null);
                setSelected(null);
                setDevOpen(null);
                setTradeDraft(newDraft(view));
              }}
            />
            <BuildBar
              view={view}
              buildMode={buildMode}
              wait={wait}
              onBuild={(kind) => {
                setSelected(null);
                setTradeDraft(null);
                setDevOpen(null);
                setBuildMode(kind);
              }}
            />
            <TurnButton view={view} wait={wait} />
          </div>
        </div>
      </div>

      {(g.phase === 'order' || orderDone) && (
        <div className="order-layer" style={{ paddingRight: insets.right, paddingBottom: insets.bottom }}>
          <OrderRollPanel view={view} players={players} done={g.phase !== 'order'} onClose={() => setOrderDone(false)} />
        </div>
      )}

      {dialog === 'menu' && (
        <MenuDialog
          view={view}
          players={players}
          settings={settings}
          onSettings={setSettings}
          onResetView={() => renderer?.resetView()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'log' && <LogOverlay view={view} players={players} onClose={() => setDialog(null)} />}
      {g.phase === 'playing' && g.step === 'discard' && g.discards[view.you] > 0 && !wait && <DiscardDialog key={`d-${g.turn}`} view={view} />}
      {myTurn && g.step === 'steal' && !wait && <StealDialog view={view} players={players} />}
      <SpectacleHost />
      {!away && <DiceTray view={view} paused={dialog !== null} hold={!!wait} />}
      {away && <AwayBanner />}
      {g.phase === 'finished' && showResult && !victoryOn && <ResultOverlay view={view} players={players} onClose={() => setShowResult(false)} />}
      {g.phase === 'finished' && !showResult && !victoryOn && (
        <button className="btn btn-primary result-reopen" onClick={() => setShowResult(true)}>
          결과 보기
        </button>
      )}
      {settings.perf && !useFlat && (
        <div className="perf-hud" aria-live="off">
          {perf && perf.samples > 0
            ? `${perf.fps.toFixed(0)}fps · 평균 ${perf.avgMs.toFixed(1)}ms · p95 ${perf.p95Ms.toFixed(1)}ms · ×${perf.pixelRatio.toFixed(2)} · 호출 ${perf.drawCalls}`
            : '보드를 움직이면 프레임 시간을 잽니다'}
        </div>
      )}
      {children}
    </div>
  );
}
