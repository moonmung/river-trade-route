import { useEffect, useRef, useState } from 'react';
import type { TileDef } from '../../shared/types';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Resource } from '../../shared/types';
import { PLAYER_COLORS, personSvgMarkup } from '../theme';
import { AnyResourceIcon, ResourceIcon } from '../ui/icons';
import type { ArtReport, LoadProgress } from './assets';
import { BoardRenderer, type BoardSelection, type BoardState, type Insets, type QualityMode } from './BoardRenderer';
import type { PerfStats } from './perf';

export interface BoardViewProps {
  tiles: readonly TileDef[];
  state: BoardState;
  insets?: Insets;
  quality?: QualityMode;
  showTileLabels?: boolean;
  /** 바람·양·연기 움직임 */
  motion?: boolean;
  /** 소품·조각이 드리우는 그림자 (기본 켬) */
  shadows?: boolean;
  onTap?: (sel: BoardSelection) => void;
  /** 마우스가 올라간 자리 (캔버스 좌표) */
  onHover?: (sel: BoardSelection | null, x: number, y: number) => void;
  onPerf?: (s: PerfStats) => void;
  onLoaded?: (report: ArtReport) => void;
  onError?: (message: string) => void;
  /** 연출 재생 등 명령형 기능이 필요할 때 렌더러를 넘겨받는다. */
  onRenderer?: (r: BoardRenderer | null) => void;
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 교역로 표지 아이콘 (자원 아이콘, 3:1 은 물음표). 보드 위 HTML 표지에 넣을 SVG 문자열로 한 번만 만든다. */
const harborIcons = new Map<string, string>();
function harborIcon(resource: Resource | null): string {
  const key = resource ?? 'any';
  let html = harborIcons.get(key);
  if (html === undefined) {
    html = renderToStaticMarkup(resource ? <ResourceIcon kind={resource} size={18} /> : <AnyResourceIcon size={18} />);
    harborIcons.set(key, html);
  }
  return html;
}

export default function BoardView(props: BoardViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [progress, setProgress] = useState<LoadProgress | null>({ done: 0, total: 1 });
  const [error, setError] = useState<string | null>(null);

  // 렌더러는 타일 구성이 바뀔 때만 새로 만든다. 나머지 값은 아래 효과들이 전달한다.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: BoardRenderer;
    try {
      renderer = new BoardRenderer(host, {
        tiles: props.tiles,
        playerColors: PLAYER_COLORS.map((c) => c.hex),
        ownerMarkup: (i) => personSvgMarkup(i, 16),
        harborIcon,
        quality: propsRef.current.quality,
        showTileLabels: propsRef.current.showTileLabels,
        motion: propsRef.current.motion ?? true,
        shadows: propsRef.current.shadows ?? true,
        onTap: (sel) => propsRef.current.onTap?.(sel),
        onHover: (sel, x, y) => propsRef.current.onHover?.(sel, x, y),
        onPerf: (s) => propsRef.current.onPerf?.(s),
        onLoadProgress: (p) => setProgress(p),
        onLoaded: (report) => {
          setProgress(null);
          propsRef.current.onLoaded?.(report);
        },
      });
    } catch (e) {
      const message = `3D 보드를 표시할 수 없습니다: ${(e as Error).message}`;
      setError(message);
      propsRef.current.onError?.(message);
      return;
    }
    rendererRef.current = renderer;
    renderer.setState(propsRef.current.state);
    renderer.setInsets(propsRef.current.insets ?? ZERO);
    propsRef.current.onRenderer?.(renderer);
    (window as unknown as { __rrBoard?: BoardRenderer }).__rrBoard = renderer;
    renderer.load().catch((e: Error) => {
      setError(`3D 에셋을 불러오지 못했습니다: ${e.message}`);
      propsRef.current.onError?.(e.message);
    });
    return () => {
      propsRef.current.onRenderer?.(null);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [props.tiles]);

  useEffect(() => {
    rendererRef.current?.setState(props.state);
  }, [props.state]);

  const insets = props.insets ?? ZERO;
  useEffect(() => {
    rendererRef.current?.setInsets(insets);
  }, [insets.top, insets.right, insets.bottom, insets.left]);

  useEffect(() => {
    if (props.quality) rendererRef.current?.setQuality(props.quality);
  }, [props.quality]);

  useEffect(() => {
    rendererRef.current?.setTileLabelsVisible(props.showTileLabels ?? true);
  }, [props.showTileLabels]);

  useEffect(() => {
    rendererRef.current?.setMotion(props.motion ?? true);
  }, [props.motion]);

  useEffect(() => {
    rendererRef.current?.setShadows(props.shadows ?? true);
  }, [props.shadows]);

  return (
    <div className="board-host" ref={hostRef}>
      {progress && !error && (
        <div className="board-loading">
          <span className="spinner" aria-hidden /> 3D 보드를 불러오는 중… {progress.total > 1 ? `${progress.done}/${progress.total}` : ''}
        </div>
      )}
      {error && <div className="board-error">{error}</div>}
    </div>
  );
}
