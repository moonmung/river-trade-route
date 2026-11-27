// WebGL 2 를 쓸 수 없는 기기를 위한 2D 보드. 3D 보드와 같은 타일·꼭짓점·변 ID 와 강조 규칙을 쓴다.
// 타일은 육각형과 숫자 패, 마을·도시는 꼭짓점의 작은 집 모양, 길은 변 위의 굵은 선, 기사단 동상은 방패 모양으로 그린다.
// 아직 길이 없는 변은 3D 보드의 샛길처럼 희끄무레하고 살짝 굽은 가는 선으로 그린다.
import { useMemo, type ReactNode } from 'react';
import { mulberry32, hashString } from './art/rng';
import { boardFor, edgeLabel, seaEdgeLabel, tileCenterUnit, vertexLabel } from '../../shared/board';
import { RESOURCE_LABEL, TILE_KIND_LABEL, numberPips } from '../../shared/constants';
import type { SeaCell, TileDef } from '../../shared/types';
import { playerColor } from '../theme';
import { GOLD_ART, RESOURCE_ART } from '../ui/art';
import { ResourceIcon } from '../ui/icons';
import type { BoardSelection, BoardState } from './BoardRenderer';
import { shipRoutes } from './fleet';

const HEX_R = 0.93;

function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 3;
    return `${(cx + Math.cos(a) * r).toFixed(3)},${(cy + Math.sin(a) * r).toFixed(3)}`;
  }).join(' ');
}

/**
 * pin: 고른 자리 바로 위에 붙일 것 (✓ / ✕ 단추). marks: 자리 한가운데에 겹쳐 놓을 것 (핑 물결).
 * 3D 보드의 BoardPin 과 같은 자리에 놓는다. Alt 키를 누른 채 누르면 onTap 의 alt 가 참이다 (핑 찍기).
 */
export function FlatBoard({
  tiles,
  sea,
  state,
  onTap,
  pin = null,
  marks = [],
}: {
  tiles: readonly TileDef[];
  /** 배를 띄울 바다 칸 (섬 맵) */
  sea?: readonly SeaCell[];
  state: BoardState;
  onTap?: (sel: BoardSelection, info: { alt: boolean }) => void;
  pin?: { sel: BoardSelection; node: ReactNode } | null;
  marks?: { key: string | number; sel: BoardSelection; node: ReactNode }[];
}) {
  const geo = useMemo(() => boardFor(tiles, sea), [tiles, sea]);
  const net = geo.sea;
  const pad = state.harbors?.length ? 0.85 : 0.4;
  // 섬 맵은 바닷길까지 다 보이게 바다 칸 꼭짓점까지 담는다.
  const xs = [...geo.vertices, ...Object.values(net?.vertexMap ?? {})].map((v) => v.x);
  const ys = [...geo.vertices, ...Object.values(net?.vertexMap ?? {})].map((v) => v.y);
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
  // 빈 변의 샛길: 변마다 휘는 정도를 달리한 곡선을 한 경로로 묶어 그린다.
  const roadEdges = new Set(state.roads.map((r) => r.edgeId));
  const trails = geo.edges
    .filter((e) => !roadEdges.has(e.id))
    .map((e) => {
      const a = geo.vertexMap[e.a];
      const b = geo.vertexMap[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const rand = mulberry32(hashString(e.id) + 41);
      const o1 = (rand() - 0.5) * 0.07;
      const o2 = (rand() - 0.5) * 0.07;
      const f = (n: number) => n.toFixed(3);
      return `M${f(a.x)} ${f(a.y)}C${f(a.x + dx / 3 + nx * o1)} ${f(a.y + dy / 3 + ny * o1)} ${f(a.x + (dx * 2) / 3 + nx * o2)} ${f(a.y + (dy * 2) / 3 + ny * o2)} ${f(b.x)} ${f(b.y)}`;
    })
    .join('');
  const sel = state.selected;
  const isSel = (kind: BoardSelection['kind'], id: string) => sel?.kind === kind && sel.id === id;
  const robber = state.robber !== undefined ? state.robber : (tiles.find((t) => t.kind === 'plaza')?.id ?? null);
  // 배: 바다 한가운데 변은 변 위, 바닷가 변은 땅 칸 반대쪽(바다 쪽)으로 조금 비켜 띄운다.
  const shipEdges = new Set((state.ships ?? []).map((s) => s.edgeId));
  const hlS = new Set(state.highlights?.shipEdges ?? []);
  const hlSea = new Set(state.highlights?.seaCells ?? []);
  const onWater = (id: string) => !!net?.edgeMap[id] && (shipEdges.has(id) || !geo.edgeMap[id] || (hlS.has(id) && !hlE.has(id)));
  // 뱃길 꼭짓점: 땅에 닿은 바닷가 꼭짓점은 닿은 땅 칸들 가운데에서 먼 쪽(바다 쪽)으로 밀어 이웃한 뱃길과 같은 점에서 만난다.
  const lanePoint = (v: string) => {
    const p = net!.vertexMap[v];
    const land = geo.vertexMap[v];
    if (!land?.tiles.length) return { x: p.x, y: p.y };
    let cx = 0;
    let cy = 0;
    for (const id of land.tiles) {
      const c = tileCenterUnit(tiles.find((t) => t.id === id)!);
      cx += c.x / land.tiles.length;
      cy += c.y / land.tiles.length;
    }
    const len = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / len) * 0.3, y: p.y + ((p.y - cy) / len) * 0.3 };
  };
  const shipSpot = (id: string) => {
    const e = net?.edgeMap[id];
    if (!net || !e) return null;
    const a = lanePoint(e.a);
    const b = lanePoint(e.b);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, deg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
  };
  const spotAt = (sel: BoardSelection): { x: number; y: number } | null => {
    const { kind, id } = sel;
    if (kind === 'vertex') return geo.vertexMap[id] ?? null;
    if (kind === 'edge') {
      if (onWater(id)) return shipSpot(id);
      const e = geo.edgeMap[id];
      return e ? { x: (geo.vertexMap[e.a].x + geo.vertexMap[e.b].x) / 2, y: (geo.vertexMap[e.a].y + geo.vertexMap[e.b].y) / 2 } : null;
    }
    const t = tiles.find((x) => x.id === id) ?? net?.cellMap[id];
    return t ? tileCenterUnit(t) : null;
  };
  const pinAt = pin ? spotAt(pin.sel) : null;
  // 항로: 배는 변마다 그리지 않고 항로마다 섬에 닿은 첫 뱃길에 한 척만 그린다. 뱃길은 그 사람 색 띠로 잇는다.
  const fleetAt = new Set(
    shipRoutes(state.ships ?? [], {
      ends: (id) => net?.edgeMap[id] ?? null,
      isCoast: (v) => !!geo.vertexMap[v],
      ownsBuilding: (v, owner) => state.buildings.some((b) => b.vertexId === v && b.owner === owner),
    }).map((r) => r.edges[0] ?? r.all[0]),
  );
  // 섬 땅따먹기: 처음 닿은 사람 색으로 섬 칸을 옅게 물들이고 테두리를 두른다.
  const claimColor = new Map<string, string>();
  for (const c of state.claims ?? []) for (const id of c.tiles) claimColor.set(id, playerColor(c.colorIndex).hex);
  const pct = (p: { x: number; y: number }) => ({ left: `${((p.x - minX) / w) * 100}%`, top: `${((p.y - minY) / h) * 100}%` });

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
              onClick={(e) => onTap?.({ kind: 'tile', id: t.id }, { alt: e.altKey })}
              role="button"
              aria-label={`${t.id} ${TILE_KIND_LABEL[t.kind]}${num ? ` 주사위 ${num}` : ''}${locked ? ' 기사단 동상에 막힘' : ''}`}
            >
              <polygon points={hexPoints(c.x, c.y, HEX_R)} />
              {claimColor.has(t.id) && <polygon points={hexPoints(c.x, c.y, HEX_R * 0.94)} className="flat-claim" style={{ fill: claimColor.get(t.id), stroke: claimColor.get(t.id) }} />}
              {t.kind === 'plaza' ? (
                <g transform={`translate(${c.x - 0.22}, ${c.y - 0.5})`}>
                  <ResourceIcon kind={t.kind} size={0.44} />
                </g>
              ) : (
                <image href={t.kind === 'gold' ? GOLD_ART : RESOURCE_ART[t.kind]} x={c.x - 0.26} y={c.y - 0.58} width={0.52} height={0.52} />
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
        {net &&
          Object.entries(net.cellMap).map(([id, cell]) => {
            // 바다 칸: 해적선을 옮길 수 있으면 빛나는 육각형으로, 해적선이 선 칸에는 검은 돛배를 그린다.
            const lit = hlSea.has(id) || isSel('tile', id);
            const pirate = state.pirate === id;
            if (!lit && !pirate) return null;
            const c = tileCenterUnit(cell);
            return (
              <g
                key={id}
                className={`flat-sea-cell ${isSel('tile', id) ? 'flat-selected' : ''} ${hlSea.has(id) ? 'flat-target' : ''}`}
                onClick={(e) => onTap?.({ kind: 'tile', id }, { alt: e.altKey })}
                role="button"
                aria-label={pirate ? '해적선이 선 바다' : '바다 칸'}
              >
                <polygon points={hexPoints(c.x, c.y, HEX_R)} />
                {pirate && (
                  <g transform={`translate(${c.x.toFixed(3)} ${c.y.toFixed(3)}) scale(1.6)`} className="flat-pirate">
                    <path d="M-0.24 0.02 H0.24 L0.16 0.11 H-0.17 Z" className="flat-ship-hull" />
                    <path d="M0.02 0.01 V-0.27 L0.17 -0.02 Z" className="flat-pirate-sail" />
                  </g>
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
        <path d={trails} className="flat-trail" />
        {geo.edges.map((e) => {
          const a = geo.vertexMap[e.a];
          const b = geo.vertexMap[e.b];
          const road = state.roads.find((r) => r.edgeId === e.id);
          const x1 = a.x + (b.x - a.x) * 0.16;
          const y1 = a.y + (b.y - a.y) * 0.16;
          const x2 = a.x + (b.x - a.x) * 0.84;
          const y2 = a.y + (b.y - a.y) * 0.84;
          return (
            <g key={e.id} onClick={(ev) => onTap?.({ kind: 'edge', id: e.id }, { alt: ev.altKey })} role="button" aria-label={`${edgeLabel(geo, e.id)}${road ? ' 길' : ''}`}>
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
              {(hlE.has(e.id) || (isSel('edge', e.id) && !onWater(e.id))) && (
                <line x1={x1} y1={y1} x2={x2} y2={y2} className={`flat-edge-hl ${isSel('edge', e.id) && !onWater(e.id) ? 'flat-edge-sel' : ''}`} />
              )}
              {!shipEdges.has(e.id) && <line x1={x1} y1={y1} x2={x2} y2={y2} className="flat-hit-line" />}
            </g>
          );
        })}
        {net?.edges.map((e) => {
          // 바닷길: 배가 떠 있거나, 배 자리로 빛나거나, 고른 배 자리만 그린다 (빈 바다는 비워 둔다).
          const ship = state.ships?.find((s) => s.edgeId === e.id);
          const lit = hlS.has(e.id);
          const picked = (isSel('edge', e.id) && onWater(e.id)) || state.movingShip === e.id;
          if (!ship && !lit && !picked) return null;
          const sp = shipSpot(e.id)!;
          const cut = (t: number) => ({ x: sp.x1 + (sp.x2 - sp.x1) * t, y: sp.y1 + (sp.y2 - sp.y1) * t });
          const p1 = cut(0.24);
          const p2 = cut(0.76);
          return (
            <g
              key={`sea-${e.id}`}
              onClick={(ev) => onTap?.({ kind: 'edge', id: e.id }, { alt: ev.altKey })}
              role="button"
              aria-label={`${seaEdgeLabel(geo, e.id)}${ship ? ' 배' : ' 배 자리'}`}
            >
              {ship && traceE.has(e.id) && <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="flat-trace" />}
              {ship && (
                <>
                  <line x1={sp.x1} y1={sp.y1} x2={sp.x2} y2={sp.y2} className="flat-lane-edge" />
                  <line x1={sp.x1} y1={sp.y1} x2={sp.x2} y2={sp.y2} className="flat-lane" style={{ stroke: playerColor(ship.colorIndex).hex }} />
                  <line x1={sp.x1} y1={sp.y1} x2={sp.x2} y2={sp.y2} className="flat-lane-dash" />
                </>
              )}
              {(lit || picked) && <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className={`flat-edge-hl flat-sea-hl ${picked ? 'flat-edge-sel' : ''}`} />}
              {ship && fleetAt.has(e.id) && (
                <g transform={`translate(${sp.x.toFixed(3)} ${sp.y.toFixed(3)}) rotate(${sp.deg.toFixed(1)})`} className="flat-ship">
                  <path d="M-0.24 0.02 H0.24 L0.16 0.11 H-0.17 Z" className="flat-ship-hull" />
                  <path d="M0.02 0.01 V-0.27 L0.17 -0.02 Z" style={{ fill: playerColor(ship.colorIndex).hex }} className="flat-ship-sail" />
                </g>
              )}
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="flat-hit-line" />
            </g>
          );
        })}
        {geo.vertices.map((v) => {
          const b = state.buildings.find((x) => x.vertexId === v.id);
          const s = b?.kind === 'city' ? 0.24 : 0.17;
          return (
            <g key={v.id} onClick={(e) => onTap?.({ kind: 'vertex', id: v.id }, { alt: e.altKey })} role="button" aria-label={`${vertexLabel(geo, v.id)}${b ? ` ${b.label}` : ''}`}>
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
      {pin && pinAt && (
        <div className={`flat-pin flat-pin-${pin.sel.kind}`} style={pct(pinAt)}>
          {pin.node}
        </div>
      )}
      {marks.map((m) => {
        const at = spotAt(m.sel);
        return at ? (
          <div key={m.key} className="flat-mark" style={pct(at)}>
            {m.node}
          </div>
        ) : null;
      })}
    </div>
  );
}
