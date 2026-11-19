// /lab — 작은 3D 테스트 장면 (구현 순서 2단계).
// 시장·목재·곡물·석재 칸을 하나씩 놓고 카메라 이동·확대, 타일 터치, 프레임 시간을 확인한다.
// 실제 휴대폰에서 이 화면을 열어 측정값을 README 에 기록한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { TILES, TILE_KIND_LABEL } from '../../shared/constants';
import type { Resource, TileDef } from '../../shared/types';
import type { ArtReport } from '../board/assets';
import type { BoardRenderer, BoardState, QualityMode } from '../board/BoardRenderer';
import BoardView from '../board/BoardView';
import type { PerfRecording, PerfStats } from '../board/perf';
import { navigate } from '../router';
import { playerColor } from '../theme';

// 가운데 시장을 목재·곡물·석재가 두 번씩 둘러싼 7칸 장면
const MINI_TILES: TileDef[] = [
  { id: 'A1', row: 0, col: 0, q: 0, r: -1, kind: 'wood' },
  { id: 'A2', row: 0, col: 1, q: 1, r: -1, kind: 'grain' },
  { id: 'B1', row: 1, col: 0, q: -1, r: 0, kind: 'stone' },
  { id: 'B2', row: 1, col: 1, q: 0, r: 0, kind: 'market' },
  { id: 'B3', row: 1, col: 2, q: 1, r: 0, kind: 'stone' },
  { id: 'C1', row: 2, col: 0, q: -1, r: 1, kind: 'grain' },
  { id: 'C2', row: 2, col: 1, q: 0, r: 1, kind: 'wood' },
];

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

export default function Lab() {
  const [full, setFull] = useState(false);
  const tiles = full ? TILES : MINI_TILES;
  const [selected, setSelected] = useState<string | null>(null);
  const [settlements, setSettlements] = useState<BoardState['settlements']>([]);
  const [quality, setQuality] = useState<QualityMode>('auto');
  const [labels, setLabels] = useState(true);
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
      setInsets({ top: 0, left: 0, right: wide ? el.offsetWidth + 16 : 0, bottom: wide ? 0 : el.offsetHeight + 16 });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const state = useMemo<BoardState>(
    () => ({ settlements, highlights: {}, selected }),
    [settlements, selected],
  );
  const selectedTile = tiles.find((t) => t.id === selected) ?? null;

  const toggleSettlement = () => {
    if (!selectedTile || selectedTile.kind === 'market') return;
    setSettlements((list) => {
      const existing = list.find((s) => s.tileId === selectedTile.id);
      if (existing) return list.filter((s) => s !== existing);
      const colorIndex = list.length % 4;
      return [...list, { tileId: selectedTile.id, owner: `p${colorIndex}`, colorIndex, label: `${playerColor(colorIndex).name} 깃발 거점` }];
    });
  };

  const playProduction = () => {
    const items = settlements.map((s) => {
      const kind = tiles.find((t) => t.id === s.tileId)!.kind as Resource;
      return { tileId: s.tileId, resource: kind, amount: kind === 'wood' ? 2 : 1, colorIndex: s.colorIndex };
    });
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
        insets={insets}
        onTileTap={(id) => {
          setSelected((cur) => (cur === id ? null : id));
          setTaps((n) => n + 1);
        }}
        onPerf={setPerf}
        onLoaded={setReport}
        onRenderer={(r) => (rendererRef.current = r)}
      />
      <div className="lab-panel" ref={panelRef}>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => navigate('/')}>
            ← 처음으로
          </button>
          <b>3D 장면 테스트</b>
        </div>
        <div className="lab-row small">
          선택: {selectedTile ? `${selectedTile.id} · ${TILE_KIND_LABEL[selectedTile.kind]}` : '없음 (타일을 눌러 보세요)'} · 터치 {taps}회
        </div>
        <div className="lab-row">
          <button className="btn btn-small" onClick={() => rendererRef.current?.resetView()}>
            전체 보기
          </button>
          <button className="btn btn-small" onClick={toggleSettlement} disabled={!selectedTile || selectedTile.kind === 'market'}>
            거점 놓기/치우기
          </button>
          <button className="btn btn-small" onClick={playProduction} disabled={settlements.length === 0}>
            생산 연출
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
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> 칸 이름
          </label>
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
