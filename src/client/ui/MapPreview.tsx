// 대기실에서 고른 맵을 작게 그려 보여 준다. 황금 배치는 땅과 숫자 패까지, 섞기는 칸 자리와 광장만 보여 준다.
import { useMemo } from 'react';
import { tileCenterUnit } from '../../shared/board';
import { MAP_ARRANGE_LABEL, MAP_SHAPE_LABEL, goldenMap } from '../../shared/maps';
import type { MapConfig } from '../../shared/types';

const R = 0.94;

function hexPoints(cx: number, cy: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 3;
    return `${(cx + Math.cos(a) * R).toFixed(3)},${(cy + Math.sin(a) * R).toFixed(3)}`;
  }).join(' ');
}

export function MapPreview({ map }: { map: MapConfig }) {
  const golden = useMemo(() => goldenMap(map.shape), [map.shape]);
  const shuffle = map.arrange === 'shuffle';
  const cells = golden.tiles.map((t) => ({ t, c: tileCenterUnit(t) }));
  const xs = cells.map((p) => p.c.x);
  const ys = cells.map((p) => p.c.y);
  const minX = Math.min(...xs) - 1.1;
  const minY = Math.min(...ys) - 1.2;
  const w = Math.max(...xs) + 1.1 - minX;
  const h = Math.max(...ys) + 1.2 - minY;
  return (
    <svg
      className="map-preview"
      viewBox={`${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`}
      role="img"
      aria-label={`${MAP_SHAPE_LABEL[map.shape]} 맵, ${MAP_ARRANGE_LABEL[map.arrange]}`}
    >
      {cells.map(({ t, c }) => {
        const kind = shuffle && t.kind !== 'plaza' ? 'unknown' : t.kind;
        const num = golden.numbers[t.id];
        return (
          <g key={t.id} className={`map-hex flat-${kind}`}>
            <polygon points={hexPoints(c.x, c.y)} />
            {!shuffle && num ? (
              <>
                <circle cx={c.x} cy={c.y} r={0.42} className="map-num" />
                <text x={c.x} y={c.y + 0.17} className={`map-num-text ${num === 6 || num === 8 ? 'map-num-hot' : ''}`}>
                  {num}
                </text>
              </>
            ) : null}
            {shuffle && t.kind !== 'plaza' ? (
              <text x={c.x} y={c.y + 0.2} className="map-num-text map-unknown-text">
                ?
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
