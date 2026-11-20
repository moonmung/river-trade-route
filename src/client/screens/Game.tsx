import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PIECE_LABEL, PIECE_LIMIT, TILES } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import { buildableRoads, buildableVillages, longestRoadPath, pieceCount, placeableVertices, setupRoadEdges } from '../../shared/rules';
import type { PieceKind } from '../../shared/types';
import type { BoardRenderer, BoardSelection, BoardState, Insets } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import { FlatBoard } from '../board/FlatBoard';
import type { PerfStats } from '../board/perf';
import { boardHighlights, buildBlocker, formatEvent, playDevBlocker, playerMap, roadStatus } from '../game/derive';
import {
  BankTradeDialog,
  DevCardDialog,
  DiscardDialog,
  MenuDialog,
  PlacementBanner,
  ResultOverlay,
  SpotCard,
  StealDialog,
  TradeDialog,
  prefersReducedMotion,
  type GameSettings,
} from '../game/dialogs';
import { useGameEffects } from '../game/effects';
import { Hand } from '../game/hand';
import { ActionBar, BuildMenu, PlayersPanel, TopBar, TradeBanner } from '../game/panels';
import { useLocalSetting, useMediaQuery } from '../game/ui';
import { Emblem } from '../ui/icons';
import { SpectacleHost } from '../ui/spectacle';

const DEFAULT_SETTINGS: GameSettings = { quality: 'auto', flat: false, perf: false };

export default function Game({ view }: { view: RoomView }) {
  const g = view.game!;
  const players = useMemo(() => playerMap(view), [view.players]);
  // 넓은 화면이나 가로로 눕힌 휴대폰은 오른쪽 패널 배치를 쓴다.
  const wide = useMediaQuery('(min-width: 900px), (orientation: landscape) and (min-width: 640px)');
  const [settings, setSettings] = useLocalSetting<GameSettings>('rr.settings', DEFAULT_SETTINGS);
  /** 건설 모드: 지을 것을 고르면 지을 수 있는 자리가 빛난다 */
  const [buildMode, setBuildMode] = useState<PieceKind | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<BoardSelection | null>(null);
  /** 시작 배치에서 고른 마을 자리 (길까지 고른 뒤 함께 보낸다) */
  const [pendingVertex, setPendingVertex] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'bank' | 'trade' | 'dev' | 'menu'>(null);
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
    if (menuOpen && (!myTurn || g.step !== 'main')) setMenuOpen(false);
  }, [view, buildMode, menuOpen]);

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
    if (!myTurn || g.step !== 'main' || buildMode || menuOpen) return null;
    const me = view.you;
    return {
      edges: pieceCount(g.buildings, g.roads, me, 'road') < PIECE_LIMIT.road ? buildableRoads(g.buildings, g.roads, me) : [],
      vertices: pieceCount(g.buildings, g.roads, me, 'village') < PIECE_LIMIT.village ? buildableVillages(g.buildings, g.roads, me) : [],
    };
  }, [myTurn, g.step, buildMode, menuOpen, g.buildings, g.roads, view.you]);
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
    setMenuOpen(false);
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
    setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : sel));
  };
  const clearPick = () => {
    setSelected(null);
    setPendingVertex(null);
    setBuildMode(null);
  };
  const useFlat = settings.flat || glFailed;
  const recent = g.events.slice(-8).reverse();
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
      <TradeBanner view={view} players={players} />
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
        {!wide && <PlayersPanel view={view} players={players} />}
        {!wide && <div className="hud-float">{banners}</div>}
      </div>

      {wide && (
        <aside className="hud-side" ref={sideRef}>
          {banners}
          <section>
            <h3>플레이어</h3>
            <PlayersPanel view={view} players={players} />
          </section>
          <section className="side-log">
            <h3>
              최근 기록{' '}
              <button className="link-btn small" onClick={() => setDialog('menu')}>
                전체 보기
              </button>
            </h3>
            <ol className="log">
              {recent.map((e) => (
                <li key={e.seq}>{formatEvent(e, players, view.you, g.numbers)}</li>
              ))}
            </ol>
          </section>
        </aside>
      )}

      <div className="hud-bottom" ref={bottomRef}>
        {selected && !menuOpen && (
          <SpotCard
            view={view}
            players={players}
            sel={selected}
            pendingVertex={pendingVertex}
            onClose={() => {
              setSelected(null);
              if (selected.kind === 'vertex') setPendingVertex(null);
            }}
            onDone={clearPick}
          />
        )}
        {menuOpen && (
          <BuildMenu
            view={view}
            onPick={(kind) => {
              setMenuOpen(false);
              setSelected(null);
              setBuildMode(kind);
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
        <div className="me-row">
          <Hand
            resources={g.myResources}
            ratios={g.myTradeRatios}
            devCards={g.myDevCards.map((c) => ({ kind: c.kind, fresh: c.boughtTurn >= g.turn }))}
            devPlayable={(kind) => !playDevBlocker(view, kind)}
            onResource={() => setDialog(myTurn && g.step === 'main' ? 'bank' : 'dev')}
            onDev={() => setDialog('dev')}
          />
          <ActionBar
            view={view}
            buildMode={buildMode}
            menuOpen={menuOpen}
            onToggleBuild={() => {
              setSelected(null);
              if (buildMode) setBuildMode(null);
              else setMenuOpen((o) => !o);
            }}
            onTrade={() => setDialog('bank')}
            onDev={() => setDialog('dev')}
          />
        </div>
      </div>

      {dialog === 'bank' && <BankTradeDialog view={view} onClose={() => setDialog(null)} onPlayerTrade={() => setDialog('trade')} />}
      {dialog === 'trade' && <TradeDialog view={view} players={players} onClose={() => setDialog(null)} />}
      {dialog === 'dev' && <DevCardDialog view={view} onClose={() => setDialog(null)} />}
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
