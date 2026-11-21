import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PIECE_LABEL, PIECE_LIMIT, TILES, emptyBundle, hasBundle } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableRoads, buildableVillages, longestRoadPath, pieceCount, placeableVertices, setupRoadEdges } from '../../shared/rules';
import type { BoardRenderer, BoardSelection, BoardState, Insets } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import { FlatBoard } from '../board/FlatBoard';
import type { PerfStats } from '../board/perf';
import type { DevKind, PieceKind } from '../../shared/types';
import { boardHighlights, buildBlocker, formatEvent, isScoreEvent, playDevBlocker, playerMap, roadStatus, spotAction, turnBlocker } from '../game/derive';
import {
  DevPlayCard,
  DiscardDialog,
  MenuDialog,
  PlacementBanner,
  ResultOverlay,
  SpotCard,
  StealDialog,
  prefersReducedMotion,
  type GameSettings,
} from '../game/dialogs';
import { useGameEffects } from '../game/effects';
import { Hand } from '../game/hand';
import { ActionBar, BuildBar, PlayersPanel, TopBar } from '../game/panels';
import { TradeDeeds, TradePanel, handPickToDraft, newDraft, type TradeDraft } from '../game/trade';
import { sendAction, useLocalSetting, useMediaQuery } from '../game/ui';
import { useChat } from '../net/chat';
import { ChatBox, ChatDock, EmoteBar } from '../ui/chat';
import { Emblem } from '../ui/icons';
import { showToast } from '../ui/toast';
import { SpectacleHost } from '../ui/spectacle';
import { DiceTray } from '../dice/DiceTray';

const DEFAULT_SETTINGS: GameSettings = { quality: 'auto', flat: false, perf: false };

export default function Game({ view }: { view: RoomView }) {
  const g = view.game!;
  const players = useMemo(() => playerMap(view), [view.players]);
  // 넓은 화면이나 가로로 눕힌 휴대폰은 오른쪽 패널 배치를 쓴다.
  const wide = useMediaQuery('(min-width: 900px), (orientation: landscape) and (min-width: 640px)');
  const [settings, setSettings] = useLocalSetting<GameSettings>('rr.settings', DEFAULT_SETTINGS);
  /** 건설 모드: [도로]·[마을]·[도시]를 누르면 지을 수 있는 자리가 빛나고, 그 자리를 누르면 바로 짓는다 */
  const [buildMode, setBuildMode] = useState<PieceKind | null>(null);
  const [selected, setSelected] = useState<BoardSelection | null>(null);
  /** 시작 배치에서 고른 마을 자리 (길까지 고른 뒤 함께 보낸다) */
  const [pendingVertex, setPendingVertex] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'menu'>(null);
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
  const myTurn = g.phase === 'playing' && g.currentPlayerId === view.you;

  // 건설 모드는 더 이상 지을 수 없게 되면(턴 종료, 비용 부족 등) 자동으로 끈다.
  useEffect(() => {
    if (buildMode && buildBlocker(view, buildMode)) setBuildMode(null);
    if (devOpen && !g.myDevCards.some((c) => c.kind === devOpen)) setDevOpen(null);
    // 교환 창은 내 차례 main 단계에서만 연다. 자원이 바뀌어 고른 카드가 모자라면 낼 것을 비운다.
    if (tradeDraft && (!myTurn || g.step !== 'main')) setTradeDraft(null);
    else if (tradeDraft && !hasBundle(g.myResources, tradeDraft.give)) setTradeDraft({ ...tradeDraft, give: emptyBundle() });
  }, [view, buildMode, devOpen, tradeDraft]);

  // 단계가 바뀌면 고른 자리를 지운다 (시작 배치 차례, 동상 옮기기, 공짜 길 등).
  useEffect(() => {
    setSelected(null);
    setPendingVertex(null);
  }, [g.phase, view.gameNumber, g.placementPlayerId, g.buildings.length, g.step, g.currentPlayerId]);

  useEffect(() => {
    if (g.phase === 'finished') setShowResult(true);
  }, [g.phase]);

  const highlights = useMemo<BoardState['highlights']>(() => {
    const h = boardHighlights(view, buildMode, pendingVertex);
    if (!h.vertices.length && !h.edges.length && !h.tiles.length) return null;
    return { ...h, kind: g.phase === 'placement' ? 'placeable' : 'buildable' };
  }, [view, buildMode, pendingVertex, g.phase]);
  // 내 차례(건설 모드 밖)에는 길을 이을 수 있는 변과 마을을 지을 수 있는 꼭짓점을 은은하게 보여 준다.
  const hints = useMemo<BoardState['hints']>(() => {
    if (!myTurn || g.step !== 'main' || buildMode) return null;
    const me = view.you;
    return {
      edges: pieceCount(g.buildings, g.roads, me, 'road') < PIECE_LIMIT.road ? buildableRoads(g.buildings, g.roads, me) : [],
      vertices: pieceCount(g.buildings, g.roads, me, 'village') < PIECE_LIMIT.village ? buildableVillages(g.buildings, g.roads, me) : [],
    };
  }, [myTurn, g.step, buildMode, g.buildings, g.roads, view.you]);
  // 길에 마우스를 올리거나 길을 누르면 그 주인의 가장 긴 교역로를 금빛으로 따라 그린다.
  const traceOwner =
    (hoverRoad && g.roads.find((r) => r.edgeId === hoverRoad.edgeId)?.owner) ||
    (selected?.kind === 'edge' ? g.roads.find((r) => r.edgeId === selected.id)?.owner : undefined) ||
    null;
  const trace = useMemo(() => (traceOwner ? longestRoadPath(g.roads, g.buildings, traceOwner) : null), [traceOwner, g.roads, g.buildings]);
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
      highlights,
      selected: selected ?? (pendingVertex ? { kind: 'vertex', id: pendingVertex } : null),
      numbers: g.numbers,
      robber: g.robber,
      harbors: g.harbors,
      hints,
      trace,
    }),
    [g.buildings, g.roads, players, highlights, selected, pendingVertex, g.numbers, g.robber, g.harbors, hints, trace],
  );

  // HUD 가 가리는 영역을 재서 보드가 남은 공간 가운데에 오도록 한다.
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  useLayoutEffect(() => {
    const measure = () =>
      setInsets({
        top: topRef.current?.offsetHeight ?? 0,
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

  const onTap = (sel: BoardSelection) => {
    setTradeDraft(null);
    setDevOpen(null);
    // 시작 배치: 마을 자리(꼭짓점) → 그 마을에 붙일 길(변) 순서로 고른다.
    if (g.phase === 'placement' && g.placementPlayerId === view.you) {
      if (sel.kind === 'vertex' && placeableVertices(g.buildings).includes(sel.id)) {
        setPendingVertex(sel.id);
        setSelected(sel);
        return;
      }
      if (sel.kind === 'edge' && pendingVertex && setupRoadEdges(g.roads, pendingVertex).includes(sel.id)) {
        setSelected(sel);
        return;
      }
    }
    // 건설 모드나 길 건설 카드: 빛나는 자리를 누르면 확인 없이 바로 짓는다.
    const freeRoads = g.phase === 'playing' && g.step === 'road_building' && g.currentPlayerId === view.you;
    if (buildMode || freeRoads) {
      const act = spotAction(view, sel, null);
      const want = freeRoads || buildMode === 'road' ? 'build_road' : buildMode === 'village' ? 'build_village' : 'build_city';
      if (act && act.action.type === want && !act.blocker) {
        setSelected(null);
        void sendAction(act.action).then((ok) => ok && !freeRoads && setBuildMode(null));
        return;
      }
    }
    setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : sel));
  };
  const clearPick = () => {
    setSelected(null);
    setPendingVertex(null);
    setBuildMode(null);
  };
  const useFlat = settings.flat || glFailed;
  // 오른쪽 패널에는 점수와 이어진 기록만 몇 줄 (전체 기록은 메뉴)
  const recent = g.events.filter(isScoreEvent).slice(-5).reverse();
  const stepBanner =
    myTurn && g.step === 'robber'
      ? '기사단 동상을 옮길 칸을 누르세요. 그 칸은 동상이 떠날 때까지 생산하지 않습니다.'
      : myTurn && g.step === 'road_building'
        ? `길 건설 카드: 빛나는 변을 눌러 공짜 길 ${g.freeRoads}개를 놓으세요.`
        : null;
  // 좁은 화면에서는 보드 위에 떠 있고, 넓은 화면에서는 오른쪽 패널 맨 위에 놓인다 (보드를 가리지 않게).
  const banners = (
    <>
      <PlacementBanner view={view} players={players} pendingVertex={pendingVertex} />
      {stepBanner && <div className="mode-banner">{stepBanner}</div>}
      {buildMode && (
        <div className="mode-banner">
          {buildMode === 'road' && '길 놓기 · 빛나는 변을 눌러 고르세요.'}
          {buildMode === 'village' && '마을 짓기 · 빛나는 꼭짓점을 눌러 고르세요.'}
          {buildMode === 'city' && '도시로 올리기 · 빛나는 내 마을을 눌러 고르세요.'}{' '}
          <button className="link-btn small" onClick={() => setBuildMode(null)}>
            그만두기
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className={`game ${wide ? 'game-wide' : 'game-narrow'}`}>
      <div className="board-layer">
        {useFlat ? (
          <div className="flat-wrap" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, paddingRight: insets.right + 8 }}>
            {glFailed && <div className="notice notice-warn small">3D 보드를 표시할 수 없어 2D 보드로 보여 줍니다.</div>}
            <FlatBoard tiles={TILES} state={boardState} onTap={onTap} />
          </div>
        ) : (
          <BoardView
            tiles={TILES}
            state={boardState}
            insets={insets}
            quality={settings.quality}
            showTileLabels={false}
            motion={settings.motion ?? !prefersReducedMotion()}
            onTap={onTap}
            onHover={(sel, x, y) => setHoverRoad(sel?.kind === 'edge' && g.roads.some((r) => r.edgeId === sel.id) ? { edgeId: sel.id, x, y } : null)}
            onPerf={settings.perf ? setPerf : undefined}
            onError={() => setGlFailed(true)}
            onRenderer={setRenderer}
          />
        )}
      </div>

      {hoverRoad && traceOwner && trace && (
        <div className="road-tip" style={{ left: hoverRoad.x, top: hoverRoad.y }} role="tooltip">
          <div className="road-tip-head">
            <Emblem colorIndex={players.get(traceOwner)?.colorIndex ?? 0} size={14} />
            {traceOwner === view.you ? '내 교역로' : `${players.get(traceOwner)?.nickname ?? '?'}의 교역로`}
          </div>
          <div>
            이어진 길 <b>{trace.length}칸</b>
          </div>
          <div className="road-tip-note">{roadStatus(view, traceOwner, trace.length, (id) => players.get(id)?.nickname ?? '?')}</div>
        </div>
      )}

      <div className="hud-top" ref={topRef}>
        <TopBar view={view} players={players} onMenu={() => setDialog('menu')} />
        {/* 좁은 화면: 안내 띠와 교환 증서가 보드 위 왼쪽 위에 뜬다. 넓은 화면은 안내 띠가 오른쪽 패널로 간다. */}
        <div className="hud-float">
          {!wide && banners}
          <TradeDeeds view={view} players={players} compact={!wide} />
        </div>
      </div>

      {wide && (
        <aside className="hud-side" ref={sideRef}>
          {banners}
          <section className="side-log">
            <h3>
              최근 기록{' '}
              <button className="link-btn small" onClick={() => setDialog('menu')}>
                전체 보기
              </button>
            </h3>
            <ol className="log log-mini">
              {recent.length === 0 && <li className="log-empty">마을·도시, 기사, 달성 같은 점수 기록이 여기에 남습니다.</li>}
              {recent.map((e) => (
                <li key={e.seq}>{formatEvent(e, players, view.you, g.numbers)}</li>
              ))}
            </ol>
          </section>
          <section className="side-chat">
            <h3>대화</h3>
            <ChatBox code={view.code} you={view.you} />
            <EmoteBar />
          </section>
          <section className="side-players">
            <PlayersPanel view={view} players={players} emotes={chat.emotes} />
          </section>
        </aside>
      )}

      <div className="hud-bottom" ref={bottomRef}>
        {!wide && (
          <div className="hud-corner">
            <PlayersPanel view={view} players={players} emotes={chat.emotes} />
            <ChatDock code={view.code} you={view.you} />
          </div>
        )}
        {tradeDraft && <TradePanel view={view} players={players} draft={tradeDraft} onDraft={setTradeDraft} onClose={() => setTradeDraft(null)} />}
        {devOpen && !tradeDraft && <DevPlayCard key={devOpen} view={view} kind={devOpen} onClose={() => setDevOpen(null)} />}
        {selected && !tradeDraft && !devOpen && (
          <SpotCard
            view={view}
            sel={selected}
            pendingVertex={pendingVertex}
            onClose={() => {
              setSelected(null);
              if (selected.kind === 'vertex') setPendingVertex(null);
            }}
            onDone={clearPick}
          />
        )}
        <div className="me-row">
          <Hand
            resources={g.myResources}
            ratios={g.myTradeRatios}
            devCards={g.myDevCards.map((c) => ({ kind: c.kind, fresh: c.boughtTurn >= g.turn }))}
            devPlayable={(kind) => !playDevBlocker(view, kind)}
            activeDev={devOpen}
            onResource={(r) => {
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
              setTradeDraft(null);
              setSelected(null);
              setDevOpen((cur) => (cur === kind ? null : kind));
            }}
          />
          <div className="me-actions">
            <BuildBar
              view={view}
              buildMode={buildMode}
              onBuild={(kind) => {
                setSelected(null);
                setPendingVertex(null);
                setTradeDraft(null);
                setDevOpen(null);
                setBuildMode(kind);
              }}
            />
            <ActionBar
              view={view}
              tradeOpen={!!tradeDraft}
              onTrade={() => {
                if (tradeDraft) return setTradeDraft(null);
                setBuildMode(null);
                setSelected(null);
                setDevOpen(null);
                setTradeDraft(newDraft(view));
              }}
            />
          </div>
        </div>
      </div>

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
      {g.phase === 'playing' && g.step === 'discard' && g.discards[view.you] > 0 && <DiscardDialog key={`d-${g.turn}`} view={view} />}
      {myTurn && g.step === 'steal' && <StealDialog view={view} players={players} />}
      <SpectacleHost />
      <DiceTray view={view} paused={dialog !== null} />
      {g.phase === 'finished' && showResult && <ResultOverlay view={view} players={players} onClose={() => setShowResult(false)} />}
      {g.phase === 'finished' && !showResult && (
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
    </div>
  );
}
