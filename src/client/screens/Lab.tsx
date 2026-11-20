// /lab — 작은 3D 테스트 장면 (구현 순서 2단계).
// 광장과 다섯 생산 칸(목재·곡물·양모·벽돌·석재)을 놓고 카메라 이동·확대, 타일 터치, 프레임 시간을 확인한다.
// 맵을 만들 때 쓰는 칸 코드(A1~E3)와 숫자 패를 함께 보고, 기사단 동상·주사위·달성 연출을 시험한다.
// 실제 휴대폰에서 이 화면을 열어 측정값을 README 에 기록한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { HARBORS, assignNumbers, boardGeometry, edgeLabel, vertexLabel } from '../../shared/board';
import { RESOURCES, TILES, TILE_KIND_LABEL } from '../../shared/constants';
import type { Bundle, DevKind, Harbor, Resource, TileDef } from '../../shared/types';
import { mulberry32 } from '../board/art/rng';
import type { ArtReport } from '../board/assets';
import type { BoardRenderer, BoardSelection, BoardState, QualityMode } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import type { PerfRecording, PerfStats } from '../board/perf';
import { Hand, MiniHand } from '../game/hand';
import { navigate } from '../router';
import { playerColor } from '../theme';
import { Emblem } from '../ui/icons';

// 가운데 광장을 다섯 생산 칸이 둘러싼 7칸 장면 (목재만 두 칸)
const MINI_TILES: TileDef[] = [
  { id: 'A1', row: 0, col: 0, q: 0, r: -1, kind: 'wood' },
  { id: 'A2', row: 0, col: 1, q: 1, r: -1, kind: 'wool' },
  { id: 'B1', row: 1, col: 0, q: -1, r: 0, kind: 'brick' },
  { id: 'B2', row: 1, col: 1, q: 0, r: 0, kind: 'plaza' },
  { id: 'B3', row: 1, col: 2, q: 1, r: 0, kind: 'stone' },
  { id: 'C1', row: 2, col: 0, q: -1, r: 1, kind: 'grain' },
  { id: 'C2', row: 2, col: 1, q: 0, r: 1, kind: 'wood' },
];

/** 플레이어 화면 미리보기에 띄우는 다른 플레이어 (손에 든 카드 장수만 보인다) */
const SAMPLE_PLAYERS = [
  { name: '버들', colorIndex: 1, score: 4, res: 6, dev: 1 },
  { name: '물레', colorIndex: 2, score: 3, res: 2, dev: 0 },
  { name: '나루', colorIndex: 3, score: 5, res: 9, dev: 3 },
];
const DEV_DRAW: DevKind[] = ['knight', 'monopoly', 'year_of_plenty', 'victory', 'road_building'];

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

export default function Lab() {
  const [full, setFull] = useState(false);
  const tiles = full ? TILES : MINI_TILES;
  // 장면을 바꾸면 꼭짓점·변 ID 가 달라지므로 놓은 조각을 비운다.
  useEffect(() => {
    setBuildings([]);
    setRoads([]);
    setSelected(null);
    setRobber(null);
  }, [full]);
  const [selected, setSelected] = useState<BoardSelection | null>(null);
  const [buildings, setBuildings] = useState<BoardState['buildings']>([]);
  const [roads, setRoads] = useState<BoardState['roads']>([]);
  const [quality, setQuality] = useState<QualityMode>('auto');
  const [labels, setLabels] = useState(false);
  const [robber, setRobber] = useState<string | null>(null);
  const [motion, setMotion] = useState(true);
  // 플레이어 화면 미리보기: 실제 게임에서 플레이어가 보는 손(카드)과 다른 사람의 손을 장면 위에 띄운다.
  const [playerView, setPlayerView] = useState(true);
  const [hand, setHand] = useState<Bundle>({ wood: 2, grain: 1, wool: 3, brick: 1, stone: 0 });
  const [devHand, setDevHand] = useState<{ kind: DevKind; fresh: boolean }[]>([
    { kind: 'knight', fresh: false },
    { kind: 'victory', fresh: false },
    { kind: 'road_building', fresh: true },
  ]);
  const gainCard = () => {
    const r = RESOURCES[Math.floor(Math.random() * RESOURCES.length)];
    setHand((h) => ({ ...h, [r]: h[r] + 1 }));
  };
  const spendCard = (r?: Resource) =>
    setHand((h) => {
      const have = RESOURCES.filter((x) => h[x] > 0);
      const pick = r && h[r] > 0 ? r : have[Math.floor(Math.random() * have.length)];
      return pick ? { ...h, [pick]: h[pick] - 1 } : h;
    });
  const drawDev = () => setDevHand((d) => [...d, { kind: DEV_DRAW[d.length % DEV_DRAW.length], fresh: true }]);
  const handRef = useRef<HTMLDivElement>(null);
  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [recording, setRecording] = useState<PerfRecording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [report, setReport] = useState<ArtReport | null>(null);
  const [taps, setTaps] = useState(0);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  // 조작 패널이 가리지 않는 영역에 보드가 오도록 한다 (넓은 화면은 오른쪽, 좁은 화면은 아래).
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const wide = window.innerWidth >= 900;
      const handH = handRef.current?.offsetHeight ?? 0;
      setInsets({ top: 0, left: 0, right: wide ? el.offsetWidth + 16 : 0, bottom: (wide ? 0 : el.offsetHeight + 16) + handH });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (handRef.current) ro.observe(handRef.current);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [playerView]);

  const geo = useMemo(() => boardGeometry(tiles), [tiles]);
  // 숫자 패는 고정 시드로 놓아 새로고침해도 같은 판이 나온다.
  const numbers = useMemo(() => assignNumbers(mulberry32(full ? 11 : 5), tiles), [tiles, full]);
  const harbors = useMemo<Harbor[]>(() => {
    if (full) return [...HARBORS];
    const coast = geo.edges.filter((e) => e.tiles.length === 1).map((e) => e.id);
    return [
      { edgeId: coast[1], resource: null },
      { edgeId: coast[Math.floor(coast.length / 2)], resource: 'wool' },
    ];
  }, [geo, full]);
  const state = useMemo<BoardState>(
    () => ({ buildings, roads, highlights: null, selected, numbers, harbors, robber: robber ?? undefined }),
    [buildings, roads, selected, numbers, harbors, robber],
  );
  /** 주사위를 굴린 셈 치고 생산 연출을 보여 준다 (동상이 선 칸은 막힘 연출). */
  const playRoll = () => {
    const values = [...new Set(Object.values(numbers))];
    const total = values[Math.floor(Math.random() * values.length)];
    const hit = tiles.filter((t) => numbers[t.id] === total).map((t) => t.id);
    const blocked = hit.filter((id) => id === robber);
    const items = buildings.flatMap((b) =>
      (geo.vertexMap[b.vertexId]?.tiles ?? [])
        .filter((id) => hit.includes(id))
        .map((id) => ({ tileId: id, vertexId: b.vertexId, resource: tiles.find((t) => t.id === id)!.kind as Resource, amount: b.kind === 'city' ? 2 : 1 })),
    );
    rendererRef.current?.playRoll(hit, blocked, items);
  };
  const selectedText = !selected
    ? '없음 (타일·꼭짓점·변을 눌러 보세요)'
    : selected.kind === 'tile'
      ? `${selected.id} · ${TILE_KIND_LABEL[tiles.find((t) => t.id === selected.id)!.kind]}`
      : selected.kind === 'vertex'
        ? `꼭짓점 ${full ? vertexLabel(selected.id) : selected.id}`
        : `변 ${full ? edgeLabel(selected.id) : selected.id}`;

  /** 고른 꼭짓점은 빈 자리 → 마을 → 도시 → 빈 자리, 고른 변은 길을 놓고 치운다. 색은 놓을 때마다 돌아간다. */
  const togglePiece = () => {
    if (!selected || selected.kind === 'tile') return;
    const colorIndex = (buildings.length + roads.length) % 4;
    const owner = `p${colorIndex}`;
    if (selected.kind === 'edge') {
      setRoads((list) => (list.some((r) => r.edgeId === selected.id) ? list.filter((r) => r.edgeId !== selected.id) : [...list, { edgeId: selected.id, owner, colorIndex }]));
      return;
    }
    setBuildings((list) => {
      const existing = list.find((b) => b.vertexId === selected.id);
      if (!existing) return [...list, { vertexId: selected.id, kind: 'village', owner, colorIndex, label: `${playerColor(colorIndex).name} 마을` }];
      if (existing.kind === 'village') return list.map((b) => (b === existing ? { ...b, kind: 'city', label: `${playerColor(b.colorIndex).name} 도시` } : b));
      return list.filter((b) => b !== existing);
    });
  };

  const playProduction = () => {
    const items = buildings.flatMap((b) =>
      (geo.vertexMap[b.vertexId]?.tiles ?? [])
        .map((id) => tiles.find((t) => t.id === id)!.kind)
        .filter((k) => k !== 'plaza')
        .map((k) => ({ vertexId: b.vertexId, resource: k as Resource, amount: b.kind === 'city' ? 2 : 1 })),
    );
    rendererRef.current?.playProduction(items);
  };

  const toggleRecording = () => {
    const r = rendererRef.current;
    if (!r) return;
    if (isRecording) {
      setRecording(r.stopPerfRecording());
      setIsRecording(false);
    } else {
      r.startPerfRecording();
      setRecording(null);
      setIsRecording(true);
    }
  };

  return (
    <div className="lab">
      <BoardView
        key={full ? 'full' : 'mini'}
        tiles={tiles}
        state={state}
        quality={quality}
        showTileLabels={labels}
        motion={motion}
        insets={insets}
        onTap={(sel) => {
          setSelected((cur) => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : sel));
          setTaps((n) => n + 1);
        }}
        onPerf={setPerf}
        onLoaded={setReport}
        onRenderer={(r) => (rendererRef.current = r)}
      />
      {playerView && (
        <>
          <ul className="players lab-players" style={{ right: insets.right + 8 }} aria-label="다른 플레이어 (미리보기)">
            {SAMPLE_PLAYERS.map((p) => (
              <li key={p.name} className="player">
                <Emblem colorIndex={p.colorIndex} size={16} />
                <span className="player-name">{p.name}</span>
                <span className="player-stats">
                  <span className="stat-score">★{p.score}</span>
                  <MiniHand count={p.res} kind="res" title={`자원 카드 ${p.res}장`} />
                  <MiniHand count={p.dev} kind="dev" title={`발전 카드 ${p.dev}장`} />
                </span>
              </li>
            ))}
          </ul>
          <div className="lab-hand" ref={handRef} style={{ right: insets.right, bottom: window.innerWidth >= 900 ? 0 : insets.bottom - (handRef.current?.offsetHeight ?? 0) }}>
            <div className="lab-hand-title small muted">플레이어 화면 미리보기 · 카드를 누르면 한 장 씁니다</div>
            <Hand
              resources={hand}
              ratios={{ wood: 4, grain: 4, wool: 2, brick: 4, stone: 3 }}
              devCards={devHand}
              devPlayable={(k) => k !== 'victory'}
              onResource={(r) => spendCard(r)}
              onDev={(k) => setDevHand((d) => d.filter((c, i) => i !== d.findIndex((x) => x.kind === k && !x.fresh)))}
            />
          </div>
        </>
      )}
      <div className="lab-panel" ref={panelRef}>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => navigate('/')}>
            ← 처음으로
          </button>
          <b>3D 장면 테스트</b>
        </div>
        <div className="lab-row small">
          선택: {selectedText} · 터치 {taps}회
        </div>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => rendererRef.current?.resetView()}>
            전체 보기
          </button>
          <button className="btn btn-small" onClick={togglePiece} disabled={!selected || selected.kind === 'tile'}>
            {selected?.kind === 'edge' ? '길 놓기/치우기' : '마을 → 도시 → 치우기'}
          </button>
          <button className="btn btn-small" onClick={playProduction} disabled={buildings.length === 0}>
            생산 연출
          </button>
          <button className="btn btn-small" onClick={playRoll}>
            주사위 생산
          </button>
          <button
            className="btn btn-small"
            onClick={() => selected?.kind === 'tile' && setRobber(selected.id)}
            disabled={selected?.kind !== 'tile'}
          >
            동상 옮기기
          </button>
          <button className="btn btn-small" onClick={() => rendererRef.current?.playAward('longest_road', 0, 'p0')}>
            최장 교역로
          </button>
          <button className="btn btn-small" onClick={() => rendererRef.current?.playAward('largest_army', 1, 'p1')}>
            최강 기사단
          </button>
          <button className="btn btn-small" onClick={() => setFull((f) => !f)}>
            {full ? '작은 장면' : '전체 보드 (19칸)'}
          </button>
        </div>
        <div className="lab-row small">
          <label>
            품질{' '}
            <select value={quality} onChange={(e) => setQuality(e.target.value as QualityMode)}>
              <option value="auto">자동</option>
              <option value="high">높음</option>
              <option value="low">낮음</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> 칸 코드
          </label>
          <label>
            <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} /> 움직임
          </label>
          <label>
            <input type="checkbox" checked={playerView} onChange={(e) => setPlayerView(e.target.checked)} /> 플레이어 화면
          </label>
        </div>
        <div className="lab-row">
          <button className="btn btn-small" onClick={gainCard} disabled={!playerView}>
            자원 카드 받기
          </button>
          <button className="btn btn-small" onClick={() => spendCard()} disabled={!playerView}>
            자원 카드 쓰기
          </button>
          <button className="btn btn-small" onClick={drawDev} disabled={!playerView}>
            발전 카드 뽑기
          </button>
        </div>
        <div className="lab-perf small">
          <button className={`btn btn-small ${isRecording ? 'btn-start' : ''}`} onClick={toggleRecording}>
            {isRecording ? '측정 끝내기' : '프레임 측정 시작'}
          </button>
          <span className="muted"> 측정 중에 보드를 끌거나 확대해 보세요.</span>
          {perf && (
            <div>
              최근 움직임: {fmt(perf.fps, 0)}fps · 평균 {fmt(perf.avgMs)}ms · p95 {fmt(perf.p95Ms)}ms · 렌더 {fmt(perf.renderMs, 2)}ms
              <br />
              해상도 배율 {fmt(perf.pixelRatio, 2)} ({perf.canvas}) · 그리기 호출 {perf.drawCalls} · 삼각형 {perf.triangles.toLocaleString()}
            </div>
          )}
          {recording && (
            <div className="lab-result">
              측정 결과 ({fmt(recording.durationMs / 1000)}초, 프레임 {recording.stats.samples}개): 평균 {fmt(recording.stats.fps, 0)}fps ·
              평균 {fmt(recording.stats.avgMs)}ms · p95 {fmt(recording.stats.p95Ms)}ms · 최악 {fmt(recording.stats.worstMs)}ms · 배율{' '}
              {fmt(recording.stats.pixelRatio, 2)}
              <br />
              <span className="muted">{navigator.userAgent}</span>
            </div>
          )}
        </div>
        {report && (
          <div className="small muted">
            에셋: GLB {report.glbModels}개, KTX2 {report.ktx2Textures}개
            {report.temporaryAssets > 0 && ` (그중 임시 에셋 ${report.temporaryAssets}개)`}
            {report.fallbackModels.length > 0 && ` · 코드 대체 모델 ${report.fallbackModels.length}개`}
            {!report.manifestFound && ' · art/manifest.json 없음 → 모든 모델을 코드로 만든 대체 모델로 표시'}
            {report.errors.length > 0 && ` · 오류 ${report.errors.length}건: ${report.errors.slice(0, 3).join(' / ')}`}
          </div>
        )}
      </div>
    </div>
  );
}
