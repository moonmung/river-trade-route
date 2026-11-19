import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TILES } from '../../shared/constants';
import type { RoomView } from '../../shared/protocol';
import type { BoardRenderer, BoardState, Insets } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import { FlatBoard } from '../board/FlatBoard';
import type { PerfStats } from '../board/perf';
import { buildBlocker, formatEvent, highlightTiles, playerMap } from '../game/derive';
import { MarketDialog, MenuDialog, PlacementBanner, ResultOverlay, TileCard, TradeDialog, type GameSettings } from '../game/dialogs';
import { useGameEffects } from '../game/effects';
import { ActionBar, ContractsPanel, MyResources, PlayersPanel, TopBar, TradeBanner } from '../game/panels';
import { useLocalSetting, useMediaQuery } from '../game/ui';

const DEFAULT_SETTINGS: GameSettings = { quality: 'auto', labels: true, flat: false, perf: false };

export default function Game({ view }: { view: RoomView }) {
  const g = view.game!;
  const players = useMemo(() => playerMap(view), [view.players]);
  // 넓은 화면이나 가로로 눕힌 휴대폰은 오른쪽 패널 배치를 쓴다.
  const wide = useMediaQuery('(min-width: 900px), (orientation: landscape) and (min-width: 640px)');
  const [settings, setSettings] = useLocalSetting<GameSettings>('rr.settings', DEFAULT_SETTINGS);
  const [buildMode, setBuildMode] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'market' | 'trade' | 'menu'>(null);
  const [showResult, setShowResult] = useState(true);
  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [glFailed, setGlFailed] = useState(false);
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);

  // 건설 모드는 더 이상 지을 수 없게 되면(턴 종료, 비용 부족 등) 자동으로 끈다.
  useEffect(() => {
    if (buildMode && buildBlocker(view)) setBuildMode(false);
  }, [view, buildMode]);

  // 시작 배치 차례가 오면 놓을 수 있는 칸이 바로 강조된다. 단계가 바뀌면 선택을 지운다.
  useEffect(() => {
    setSelected(null);
  }, [g.phase, view.gameNumber]);

  useEffect(() => {
    if (g.phase === 'finished') setShowResult(true);
  }, [g.phase]);

  const highlightKind = g.phase === 'placement' ? 'placeable' : 'buildable';
  const highlights = useMemo(
    () => Object.fromEntries(highlightTiles(view, buildMode).map((id) => [id, highlightKind] as const)),
    [view, buildMode, highlightKind],
  );
  const boardState = useMemo<BoardState>(
    () => ({
      settlements: g.settlements.map((s) => ({
        tileId: s.tileId,
        owner: s.owner,
        colorIndex: players.get(s.owner)?.colorIndex ?? 0,
        label: `${players.get(s.owner)?.nickname ?? '?'}의 거점`,
      })),
      highlights,
      selected,
    }),
    [g.settlements, players, highlights, selected],
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

  const onTileTap = (id: string) => setSelected((cur) => (cur === id ? null : id));
  const useFlat = settings.flat || glFailed;
  const recent = g.events.slice(-8).reverse();
  // 좁은 화면에서는 보드 위에 떠 있고, 넓은 화면에서는 오른쪽 패널 맨 위에 놓인다 (보드를 가리지 않게).
  const banners = (
    <>
      <PlacementBanner view={view} players={players} />
      <TradeBanner view={view} players={players} />
      {buildMode && <div className="mode-banner">건설 모드 · 빛나는 칸을 눌러 거점을 지을 곳을 고르세요.</div>}
    </>
  );

  return (
    <div className={`game ${wide ? 'game-wide' : 'game-narrow'}`}>
      <div className="board-layer">
        {useFlat ? (
          <div className="flat-wrap" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, paddingRight: insets.right + 8 }}>
            {glFailed && <div className="notice notice-warn small">3D 보드를 표시할 수 없어 2D 보드로 보여 줍니다.</div>}
            <FlatBoard tiles={TILES} state={boardState} onTileTap={onTileTap} />
          </div>
        ) : (
          <BoardView
            tiles={TILES}
            state={boardState}
            insets={insets}
            quality={settings.quality}
            showTileLabels={settings.labels}
            onTileTap={onTileTap}
            onPerf={settings.perf ? setPerf : undefined}
            onError={() => setGlFailed(true)}
            onRenderer={setRenderer}
          />
        )}
      </div>

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
          <section>
            <h3>이번 라운드 공개 계약</h3>
            <ContractsPanel view={view} players={players} compact={false} />
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
                <li key={e.seq}>{formatEvent(e, players, view.you)}</li>
              ))}
            </ol>
          </section>
        </aside>
      )}

      <div className="hud-bottom" ref={bottomRef}>
        {selected && (
          <TileCard
            view={view}
            players={players}
            tileId={selected}
            buildMode={buildMode}
            onClose={() => setSelected(null)}
            onDone={() => {
              setSelected(null);
              setBuildMode(false);
            }}
          />
        )}
        {!wide && g.phase !== 'placement' && <ContractsPanel view={view} players={players} compact />}
        <div className="me-row">
          <MyResources view={view} />
          <ActionBar
            view={view}
            buildMode={buildMode}
            onToggleBuild={() => {
              setBuildMode((b) => !b);
              setSelected(null);
            }}
            onMarket={() => setDialog('market')}
            onTrade={() => setDialog('trade')}
          />
        </div>
      </div>

      {dialog === 'market' && <MarketDialog view={view} onClose={() => setDialog(null)} />}
      {dialog === 'trade' && <TradeDialog view={view} players={players} onClose={() => setDialog(null)} />}
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
