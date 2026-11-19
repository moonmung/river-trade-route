// WebGL 2 를 쓸 수 없는 기기를 위한 2D 육각 보드. 3D 보드와 같은 타일 ID·강조 규칙을 쓴다.
import type { CSSProperties } from 'react';
import { TILE_KIND_LABEL } from '../../shared/constants';
import type { TileDef } from '../../shared/types';
import { playerColor } from '../theme';
import { Emblem, ResourceIcon } from '../ui/icons';
import type { BoardState } from './BoardRenderer';

// pointy-top 육각형: 가로 W, 세로 W × 2/√3. 줄 간격은 세로의 3/4.
const W = 100;
const H = (W * 2) / Math.sqrt(3);

export function FlatBoard({ tiles, state, onTileTap }: { tiles: readonly TileDef[]; state: BoardState; onTileTap?: (id: string) => void }) {
  const units = tiles.map((t) => t.q + t.r / 2);
  const minU = Math.min(...units);
  const maxU = Math.max(...units);
  const minR = Math.min(...tiles.map((t) => t.r));
  const maxR = Math.max(...tiles.map((t) => t.r));
  const boardW = (maxU - minU + 1) * W;
  const boardH = (maxR - minR) * H * 0.75 + H;
  return (
    <div className="flat-board" style={{ aspectRatio: `${boardW} / ${boardH}` }}>
      {tiles.map((t) => {
        const st = state.settlements.find((s) => s.tileId === t.id);
        const hl = state.highlights[t.id];
        const selected = state.selected === t.id;
        const style: CSSProperties = {
          left: `${(((t.q + t.r / 2 - minU) * W) / boardW) * 100}%`,
          top: `${(((t.r - minR) * H * 0.75) / boardH) * 100}%`,
          width: `${(W / boardW) * 100}%`,
          height: `${(H / boardH) * 100}%`,
        };
        if (st) style.background = `linear-gradient(${playerColor(st.colorIndex).soft}, ${playerColor(st.colorIndex).soft})`;
        return (
          <button
            key={t.id}
            className={`flat-tile flat-${t.kind} ${hl ? 'flat-hl' : ''} ${selected ? 'flat-selected' : ''}`}
            style={style}
            onClick={() => onTileTap?.(t.id)}
            aria-label={`${t.id} ${TILE_KIND_LABEL[t.kind]}${st ? `, ${st.label}` : ''}`}
          >
            <span className="flat-inner">
              <span className="flat-id">{t.id}</span>
              <ResourceIcon kind={t.kind} size={26} />
              <span className="flat-kind">{TILE_KIND_LABEL[t.kind]}</span>
              {st && <Emblem colorIndex={st.colorIndex} size={16} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
