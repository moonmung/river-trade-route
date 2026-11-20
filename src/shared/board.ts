// 보드의 꼭짓점(마을·도시 자리)과 변(길 자리).
// 육각 타일 19칸의 꼭짓점 54개, 변 72개를 타일 좌표에서 계산한다. 서버와 화면이 같은 ID 를 쓴다.
// 좌표 단위: 타일 외접원 반지름 = 1. x 는 오른쪽, y 는 아래쪽(A 줄이 위)이며 타일 중심은 (√3·(q + r/2), 1.5·r) 이다.
import { NUMBER_TOKENS, TILES, TILE_MAP } from './constants';
import type { Harbor, Resource, TileDef, TileId } from './types';

export type VertexId = string;
export type EdgeId = string;

export interface VertexDef {
  id: VertexId;
  x: number;
  y: number;
  /** 이 꼭짓점에 닿은 타일 (1~3칸) */
  tiles: TileId[];
  /** 변 하나로 이어진 이웃 꼭짓점 */
  neighbors: VertexId[];
  /** 이 꼭짓점에서 뻗은 변 */
  edges: EdgeId[];
}

export interface EdgeDef {
  id: EdgeId;
  /** 양 끝 꼭짓점 */
  a: VertexId;
  b: VertexId;
  /** 이 변을 낀 타일 (바닷가 변은 1칸) */
  tiles: TileId[];
}

const SQRT3 = Math.sqrt(3);

export function tileCenterUnit(t: { q: number; r: number }): { x: number; y: number } {
  return { x: SQRT3 * (t.q + t.r / 2), y: 1.5 * t.r };
}

/** 타일의 여섯 꼭짓점 (위쪽 꼭짓점부터 시계 방향) */
function cornersOf(t: { q: number; r: number }): { x: number; y: number }[] {
  const c = tileCenterUnit(t);
  return Array.from({ length: 6 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 3;
    return { x: c.x + Math.cos(a), y: c.y + Math.sin(a) };
  });
}

const key = (p: { x: number; y: number }) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

export interface BoardGeometry {
  vertices: VertexDef[];
  edges: EdgeDef[];
  vertexMap: Record<VertexId, VertexDef>;
  edgeMap: Record<EdgeId, EdgeDef>;
}

/**
 * 타일 묶음의 꼭짓점·변을 계산한다. 정식 보드(TILES)로 만든 ID 가 서버와 화면의 공통 ID 이고,
 * /lab 의 작은 장면처럼 다른 타일 묶음도 같은 방식으로 자기만의 ID 를 얻는다.
 */
export function boardGeometry(tiles: readonly TileDef[]): BoardGeometry {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const sortTiles = (ids: TileId[]) => [...ids].sort((a, b) => byId.get(a)!.row - byId.get(b)!.row || byId.get(a)!.col - byId.get(b)!.col);
  const vmap = new Map<string, { x: number; y: number; tiles: TileId[] }>();
  const emap = new Map<string, { a: string; b: string; tiles: TileId[] }>();
  for (const t of tiles) {
    const cs = cornersOf(t);
    cs.forEach((p) => {
      const k = key(p);
      const v = vmap.get(k) ?? { x: p.x, y: p.y, tiles: [] };
      v.tiles.push(t.id);
      vmap.set(k, v);
    });
    for (let i = 0; i < 6; i++) {
      const ka = key(cs[i]);
      const kb = key(cs[(i + 1) % 6]);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = emap.get(ek) ?? { a: ka, b: kb, tiles: [] };
      e.tiles.push(t.id);
      emap.set(ek, e);
    }
  }
  // 위쪽 줄부터, 같은 줄은 왼쪽부터 번호를 매긴다.
  const vkeys = [...vmap.keys()].sort((a, b) => {
    const pa = vmap.get(a)!;
    const pb = vmap.get(b)!;
    return Math.round(pa.y * 100) - Math.round(pb.y * 100) || pa.x - pb.x;
  });
  const vid = new Map(vkeys.map((k, i) => [k, `v${i + 1}`]));
  const ekeys = [...emap.keys()].sort((a, b) => {
    const ea = emap.get(a)!;
    const eb = emap.get(b)!;
    const ma = { x: (vmap.get(ea.a)!.x + vmap.get(ea.b)!.x) / 2, y: (vmap.get(ea.a)!.y + vmap.get(ea.b)!.y) / 2 };
    const mb = { x: (vmap.get(eb.a)!.x + vmap.get(eb.b)!.x) / 2, y: (vmap.get(eb.a)!.y + vmap.get(eb.b)!.y) / 2 };
    return Math.round(ma.y * 100) - Math.round(mb.y * 100) || ma.x - mb.x;
  });
  const edges: EdgeDef[] = ekeys.map((k, i) => {
    const e = emap.get(k)!;
    return { id: `e${i + 1}`, a: vid.get(e.a)!, b: vid.get(e.b)!, tiles: sortTiles(e.tiles) };
  });
  const vertices: VertexDef[] = vkeys.map((k) => {
    const v = vmap.get(k)!;
    const id = vid.get(k)!;
    const mine = edges.filter((e) => e.a === id || e.b === id);
    return {
      id,
      x: v.x,
      y: v.y,
      tiles: sortTiles(v.tiles),
      neighbors: mine.map((e) => (e.a === id ? e.b : e.a)),
      edges: mine.map((e) => e.id),
    };
  });
  return {
    vertices,
    edges,
    vertexMap: Object.fromEntries(vertices.map((v) => [v.id, v])),
    edgeMap: Object.fromEntries(edges.map((e) => [e.id, e])),
  };
}

const built = boardGeometry(TILES);
export const VERTICES: readonly VertexDef[] = built.vertices;
export const EDGES: readonly EdgeDef[] = built.edges;
export const VERTEX_MAP: Readonly<Record<VertexId, VertexDef>> = built.vertexMap;
export const EDGE_MAP: Readonly<Record<EdgeId, EdgeDef>> = built.edgeMap;

/** 꼭짓점 a, b 를 잇는 변 (없으면 null) */
export function edgeBetween(a: VertexId, b: VertexId): EdgeId | null {
  return VERTEX_MAP[a]?.edges.find((id) => {
    const e = EDGE_MAP[id];
    return (e.a === a && e.b === b) || (e.a === b && e.b === a);
  }) ?? null;
}

/** 주어진 타일들에 모두 닿은 꼭짓점 (안쪽 꼭짓점은 타일 3칸으로 하나가 정해진다). 테스트와 안내 문구에 쓴다. */
export function vertexAt(...tiles: TileId[]): VertexId {
  const found = VERTICES.filter((v) => tiles.every((t) => v.tiles.includes(t)) && v.tiles.length === tiles.length);
  if (found.length !== 1) throw new Error(`꼭짓점을 하나로 정할 수 없습니다: ${tiles.join(',')} (${found.length}개)`);
  return found[0].id;
}

/** 꼭짓점 방향 (pointy-top: 위·아래로 꼭짓점이 난다) */
const CORNER_NAMES: [number, string][] = [
  [-90, '위'],
  [-30, '오른쪽 위'],
  [30, '오른쪽 아래'],
  [90, '아래'],
  [150, '왼쪽 아래'],
  [-150, '왼쪽 위'],
];
/** 변 방향 (변의 가운데가 향하는 쪽) */
const SIDE_NAMES: [number, string][] = [
  [-60, '오른쪽 위'],
  [0, '오른쪽'],
  [60, '오른쪽 아래'],
  [120, '왼쪽 아래'],
  [180, '왼쪽'],
  [-120, '왼쪽 위'],
];

/** 타일 중심에서 본 방향 이름 */
function directionFrom(tile: TileId, x: number, y: number, names: [number, string][]): string {
  const c = tileCenterUnit(TILE_MAP[tile]);
  const deg = (Math.atan2(y - c.y, x - c.x) * 180) / Math.PI; // 0 = 오른쪽, 90 = 아래
  let best = names[0];
  for (const n of names) {
    const d = Math.abs(((deg - n[0] + 540) % 360) - 180);
    if (d < Math.abs(((deg - best[0] + 540) % 360) - 180)) best = n;
  }
  return best[1];
}

/** 화면 표시용 이름: 안쪽 꼭짓점은 "A1·B1·B2", 바닷가 꼭짓점은 "A1 왼쪽 위" 처럼 쓴다. */
export function vertexLabel(id: VertexId): string {
  const v = VERTEX_MAP[id];
  if (!v) return id;
  return v.tiles.length === 1 ? `${v.tiles[0]} ${directionFrom(v.tiles[0], v.x, v.y, CORNER_NAMES)}` : v.tiles.join('·');
}

export function edgeLabel(id: EdgeId): string {
  const e = EDGE_MAP[id];
  if (!e) return id;
  if (e.tiles.length > 1) return `${e.tiles.join('·')} 사이`;
  const a = VERTEX_MAP[e.a];
  const b = VERTEX_MAP[e.b];
  return `${e.tiles[0]} ${directionFrom(e.tiles[0], (a.x + b.x) / 2, (a.y + b.y) / 2, SIDE_NAMES)} 바닷가`;
}

// ───────────────────────── 해상 교역로와 숫자 토큰 ─────────────────────────

/** 바닷가 변(타일 한 칸에만 닿은 변)을 보드 둘레를 따라 한 바퀴 순서로 늘어놓는다 (위쪽에서 시작해 시계 방향). */
export function coastEdges(): EdgeId[] {
  const mid = (e: EdgeDef) => {
    const a = VERTEX_MAP[e.a];
    const b = VERTEX_MAP[e.b];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  return EDGES.filter((e) => e.tiles.length === 1)
    .map((e) => {
      const m = mid(e);
      // 위쪽(-y)을 0으로 두고 시계 방향으로 커지는 각도
      return { id: e.id, a: (Math.atan2(m.x, -m.y) + Math.PI * 2) % (Math.PI * 2) };
    })
    .sort((p, q) => p.a - q.a)
    .map((p) => p.id);
}

/**
 * 해상 교역로 9곳: 바닷가 변 30개에 고르게 나눠 놓는다. 아무 자원 3개 → 1개(3:1) 네 곳, 정해진 자원 2개 → 1개(2:1) 다섯 곳.
 * 이웃한 교역로가 꼭짓점을 나눠 갖지 않도록 세 변 이상 띄운다.
 */
export const HARBORS: readonly Harbor[] = (() => {
  const coast = coastEdges();
  const kinds: (Resource | null)[] = [null, 'wool', null, 'stone', 'grain', null, 'brick', 'wood', null];
  return kinds.map((resource, i) => ({ edgeId: coast[Math.round((i * coast.length) / kinds.length + 1) % coast.length], resource }));
})();

/** 해상 교역로가 닿은 꼭짓점 두 곳 */
export function harborVertices(h: Harbor): [VertexId, VertexId] {
  const e = EDGE_MAP[h.edgeId];
  return [e.a, e.b];
}

/**
 * 숫자 토큰을 생산 칸에 무작위로 놓는다. 빨간 숫자(6·8)끼리는 이웃하지 않게 다시 섞는다.
 * random 은 [0, 1) 값을 돌려주는 함수 (서버 난수, 테스트에서는 고정 값).
 */
export function assignNumbers(random: () => number, tiles: readonly TileDef[] = TILES): Record<TileId, number> {
  const prod = tiles.filter((t) => t.kind !== 'plaza');
  const near = (a: TileDef, b: TileDef) => {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
  };
  const tokens = [...NUMBER_TOKENS];
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
  }
  const map: Record<TileId, number> = {};
  prod.forEach((t, i) => (map[t.id] = tokens[i % tokens.length]));
  const isRed = (t: TileDef) => map[t.id] === 6 || map[t.id] === 8;
  // 이웃한 빨간 숫자가 있으면, 빨간 숫자와 닿지 않는 칸의 숫자와 하나씩 바꾼다.
  for (let step = 0; step < 60; step++) {
    const red = prod.filter(isRed);
    const a = red.find((x) => red.some((b) => b !== x && near(x, b)));
    if (!a) return map;
    const c = prod.find((x) => !isRed(x) && red.every((b) => b === a || !near(x, b)));
    if (!c) break;
    [map[a.id], map[c.id]] = [map[c.id], map[a.id]];
  }
  throw new Error('숫자 토큰을 놓지 못했습니다.');
}
