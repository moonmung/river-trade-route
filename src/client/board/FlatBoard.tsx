// WebGL 2 를 쓸 수 없는 기기를 위한 2D 보드. 3D 보드와 같은 타일·꼭짓점·변 ID 와 강조 규칙을 쓴다.
// 타일은 육각형과 숫자 패, 마을·도시는 꼭짓점의 작은 집 모양, 길은 변 위의 굵은 선, 기사단 동상은 방패 모양으로 그린다.
import { useMemo } from 'react';
import { boardGeometry, edgeLabel, tileCenterUnit, vertexLabel } from '../../shared/board';
import { RESOURCE_LABEL, TILE_KIND_LABEL, numberPips } from '../../shared/constants';
import type { TileDef } from '../../shared/types';
import { playerColor } from '../theme';
import { RESOURCE_ART } from '../ui/art';
import { ResourceIcon } from '../ui/icons';
import type { BoardSelection, BoardState } from './BoardRenderer';

const HEX_R = 0.93;

function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 3;
    return `${(cx + Math.cos(a) * r).toFixed(3)},${(cy + Math.sin(a) * r).toFixed(3)}`;
  }).join(' ');
}

export function FlatBoard({ tiles, state, onTap }: { tiles: readonly TileDef[]; state: BoardState; onTap?: (sel: BoardSelection) => void }) {
  const geo = useMemo(() => boardGeometry(tiles), [tiles]);
  const pad = state.harbors?.length ? 0.85 : 0.4;
  const xs = geo.vertices.map((v) => v.x);
  const ys = geo.vertices.map((v) => v.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - minX;
  const h = Math.max(...ys) + pad - minY;
  const hlV = new Set(state.highlights?.vertices ?? []);
  const hlE = new Set(state.highlights?.edges ?? []);
  const hlT = new Set(state.highlights?.tiles ?? []);
  const hintE = new Set(state.hints?.edges ?? []);
  const hintV = new Set(state.hints?.vertices ?? []);
  const traceE = new Set(state.trace ?? []);
  // 같은 사람의 길이 꼭짓점에서 이어지면(길끼리, 또는 내 마을·도시) 그쪽 끝을 꼭짓점까지 잇는다.
  const roadCount = new Map<string, number>();
  for (const r of state.roads) {
    const e = geo.edgeMap[r.edgeId];
    if (e) for (const v of [e.a, e.b]) roadCount.set(`${v}:${r.owner}`, (roadCount.get(`${v}:${r.owner}`) ?? 0) + 1);
  }
  const joins = (v: string, owner: string) => {
    const b = state.buildings.find((x) => x.vertexId === v);
    return b ? b.owner === owner : (roadCount.get(`${v}:${owner}`) ?? 0) >= 2;
  };
  const sel = state.selected;
  const isSel = (kind: BoardSelection['kind'], id: string) => sel?.kind === kind && sel.id === id;
  const robber = state.robber !== undefined ? state.robber : (tiles.find((t) => t.kind === 'plaza')?.id ?? null);

  return (
    <div className="flat-board" style={{ aspectRatio: `${w} / ${h}` }}>
      <svg className="flat-svg" viewBox={`${minX} ${minY} ${w} ${h}`} role="group" aria-label="2D 보드">
        {tiles.map((t) => {
          const c = tileCenterUnit(t);
          const num = state.numbers?.[t.id];
          const locked = robber === t.id && t.kind !== 'plaza';
          return (
            <g
              key={t.id}
              className={`flat-hex flat-${t.kind} ${isSel('tile', t.id) ? 'flat-selected' : ''} ${hlT.has(t.id) ? 'flat-target' : ''} ${locked ? 'flat-locked' : ''}`}
              onClick={() => onTap?.({ kind: 'tile', id: t.id })}
              role="button"
              aria-label={`${t.id} ${TILE_KIND_LABEL[t.kind]}${num ? ` 주사위 ${num}` : ''}${locked ? ' 기사단 동상에 막힘' : ''}`}
            >
              <polygon points={hexPoints(c.x, c.y, HEX_R)} />
              {t.kind === 'plaza' ? (
                <g transform={`translate(${c.x - 0.22}, ${c.y - 0.5})`}>
                  <ResourceIcon kind={t.kind} size={0.44} />
                </g>
              ) : (
                <image href={RESOURCE_ART[t.kind]} x={c.x - 0.26} y={c.y - 0.58} width={0.52} height={0.52} />
              )}
              {num ? (
                <>
                  <circle cx={c.x} cy={c.y + 0.18} r={0.27} className="flat-num" />
                  <text x={c.x} y={c.y + 0.24} className={`flat-num-text ${num === 6 || num === 8 ? 'flat-num-hot' : ''}`}>
                    {num}
                  </text>
                  <text x={c.x} y={c.y + 0.36} className={`flat-id ${num === 6 || num === 8 ? 'flat-num-hot' : ''}`}>
                    {'•'.repeat(numberPips(num))}
                  </text>
                </>
              ) : (
                <text x={c.x} y={c.y + 0.3} className="flat-kind">
                  {TILE_KIND_LABEL[t.kind]}
                </text>
              )}
              {robber === t.id && (
                <path
                  className="flat-statue"
                  transform={`translate(${c.x + 0.42}, ${c.y + 0.05})`}
                  d="M-0.16 -0.2 H0.16 V0 Q0.16 0.18 0 0.26 Q-0.16 0.18 -0.16 0 Z"
                />
              )}
            </g>
          );
        })}
        {(state.harbors ?? []).map((hb) => {
          const e = geo.edgeMap[hb.edgeId];
          if (!e || e.tiles.length !== 1) return null;
          const a = geo.vertexMap[e.a];
          const b = geo.vertexMap[e.b];
          const t = tiles.find((x) => x.id === e.tiles[0])!;
          const c = tileCenterUnit(t);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const len = Math.hypot(mx - c.x, my - c.y) || 1;
          const nx = (mx - c.x) / len;
          const ny = (my - c.y) / len;
          return (
            <text key={hb.edgeId} x={mx + nx * 0.5} y={my + ny * 0.5 + 0.07} className="flat-harbor">
              {hb.resource ? `${RESOURCE_LABEL[hb.resource]} 2:1` : '3:1'}
            </text>
          );
        })}
        {geo.edges.map((e) => {
          const a = geo.vertexMap[e.a];
          const b = geo.vertexMap[e.b];
          const road = state.roads.find((r) => r.edgeId === e.id);
          const x1 = a.x + (b.x - a.x) * 0.16;
          const y1 = a.y + (b.y - a.y) * 0.16;
          const x2 = a.x + (b.x - a.x) * 0.84;
          const y2 = a.y + (b.y - a.y) * 0.84;
          return (
            <g key={e.id} onClick={() => onTap?.({ kind: 'edge', id: e.id })} role="button" aria-label={`${edgeLabel(e.id)}${road ? ' 길' : ''}`}>
              {traceE.has(e.id) && <line x1={x1} y1={y1} x2={x2} y2={y2} className="flat-trace" />}
              {road && (
                <line
                  x1={joins(e.a, road.owner) ? a.x : x1}
                  y1={joins(e.a, road.owner) ? a.y : y1}
                  x2={joins(e.b, road.owner) ? b.x : x2}
                  y2={joins(e.b, road.owner) ? b.y : y2}
                  className="flat-road"
                  style={{ stroke: playerColor(road.colorIndex).hex }}
                />
              )}
              {!road && hintE.has(e.id) && !hlE.has(e.id) && <line x1={x1} y1={y1} x2={x2} y2={y2} className="flat-hint-line" />}
              {(hlE.has(e.id) || isSel('edge', e.id)) && (
                <line x1={x1} y1={y1} x2={x2} y2={y2} className={`flat-edge-hl ${isSel('edge', e.id) ? 'flat-edge-sel' : ''}`} />
              )}
              <line x1={x1} y1={y1} x2={x2} y2={y2} className="flat-hit-line" />
            </g>
          );
        })}
        {geo.vertices.map((v) => {
          const b = state.buildings.find((x) => x.vertexId === v.id);
          const s = b?.kind === 'city' ? 0.24 : 0.17;
          return (
            <g key={v.id} onClick={() => onTap?.({ kind: 'vertex', id: v.id })} role="button" aria-label={`${vertexLabel(v.id)}${b ? ` ${b.label}` : ''}`}>
              {(hlV.has(v.id) || isSel('vertex', v.id)) && <circle cx={v.x} cy={v.y} r={0.24} className={`flat-spot-hl ${isSel('vertex', v.id) ? 'flat-spot-sel' : ''}`} />}
              {!hlV.has(v.id) && hintV.has(v.id) && <circle cx={v.x} cy={v.y} r={0.15} className="flat-hint-ring" />}
              {b && (
                <path
                  className="flat-building"
                  style={{ fill: playerColor(b.colorIndex).hex }}
                  d={`M${v.x - s} ${v.y + s * 0.8} V${v.y - s * 0.1} L${v.x} ${v.y - s} L${v.x + s} ${v.y - s * 0.1} V${v.y + s * 0.8} Z`}
                />
              )}
              <circle cx={v.x} cy={v.y} r={0.26} className="flat-hit" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
