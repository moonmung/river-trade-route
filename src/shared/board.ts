// 보드의 꼭짓점(마을·도시 자리)과 변(길 자리).
// 타일 좌표에서 꼭짓점과 변을 계산한다 (표준 육각 19칸이면 꼭짓점 54개, 변 72개). 서버와 화면이 같은 ID 를 쓴다.
// 맵 모양은 게임마다 다를 수 있어서, 게임 상태에 실린 타일 묶음으로 보드를 만들어 쓴다 (boardOf).
// 좌표 단위: 타일 외접원 반지름 = 1. x 는 오른쪽, y 는 아래쪽(A 줄이 위)이며 타일 중심은 (√3·(q + r/2), 1.5·r) 이다.
import { NUMBER_TOKENS, TILES } from './constants';
import type { Harbor, Resource, SeaCell, TileDef, TileId } from './types';

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

// ───────────────────────── 바닷길 (배) ─────────────────────────

/** 배가 지나는 꼭짓점. 땅에 닿은 꼭짓점은 땅 보드와 같은 ID(v…)이고, 바다 한가운데 꼭짓점은 w… 다. */
export interface SeaVertexDef {
  id: VertexId;
  x: number;
  y: number;
  /** 이 꼭짓점에서 뻗은 바닷길 */
  edges: EdgeId[];
}

/** 배를 놓을 수 있는 변. 땅에 닿은 바닷가 변은 땅 보드와 같은 ID(e…)이고 길도 놓을 수 있다. 바다 한가운데 변은 s… 다. */
export interface SeaEdgeDef {
  id: EdgeId;
  a: VertexId;
  b: VertexId;
  /** 땅에 닿은 바닷가 변인지 */
  coast: boolean;
}

/** 바다 칸 하나를 가리키는 ID (바다 칸 목록 순서대로 c1, c2 …). 해적선이 이 칸에 선다. */
export type SeaCellId = string;

/** 바다 칸에서 계산한 바닷길: 바다 칸마다 여섯 변이 모두 배 자리다. */
export interface SeaNet {
  cells: readonly SeaCell[];
  edges: SeaEdgeDef[];
  edgeMap: Record<EdgeId, SeaEdgeDef>;
  vertexMap: Record<VertexId, SeaVertexDef>;
  /** 바다 칸 ID → 그 칸 (축 좌표) */
  cellMap: Record<SeaCellId, SeaCell>;
  /** 바다 칸 ID → 그 칸의 여섯 변 (해적선이 막는 바닷길) */
  cellEdges: Record<SeaCellId, EdgeId[]>;
}

/**
 * 바다 칸들의 바닷길. 땅 보드와 같은 자리의 꼭짓점·변은 땅 보드의 ID 를 그대로 쓰고(바닷가),
 * 새로 생긴 꼭짓점과 변은 위쪽 줄부터, 같은 줄은 왼쪽부터 w1·s1 … 로 번호를 매긴다.
 */
export function seaNet(land: BoardGeometry, cells: readonly SeaCell[]): SeaNet {
  const landV = new Map(land.vertices.map((v) => [key(v), v.id]));
  const edgeKey = (ka: string, kb: string) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
  const landE = new Map(land.edges.map((e) => [edgeKey(key(land.vertexMap[e.a]), key(land.vertexMap[e.b])), e.id]));
  const pts = new Map<string, { x: number; y: number }>();
  const emap = new Map<string, { a: string; b: string }>();
  for (const c of cells) {
    const cs = cornersOf(c);
    for (const p of cs) if (!pts.has(key(p))) pts.set(key(p), p);
    for (let i = 0; i < 6; i++) {
      const ka = key(cs[i]);
      const kb = key(cs[(i + 1) % 6]);
      const ek = edgeKey(ka, kb);
      if (!emap.has(ek)) emap.set(ek, { a: ka, b: kb });
    }
  }
  const byRow = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.round(p.y * 100) - Math.round(q.y * 100) || p.x - q.x;
  const vid = new Map(landV);
  [...pts.keys()]
    .filter((k) => !landV.has(k))
    .sort((a, b) => byRow(pts.get(a)!, pts.get(b)!))
    .forEach((k, i) => vid.set(k, `w${i + 1}`));
  const mid = (e: { a: string; b: string }) => ({ x: (pts.get(e.a)!.x + pts.get(e.b)!.x) / 2, y: (pts.get(e.a)!.y + pts.get(e.b)!.y) / 2 });
  const eid = new Map<string, EdgeId>();
  [...emap.keys()]
    .filter((k) => !landE.has(k))
    .sort((a, b) => byRow(mid(emap.get(a)!), mid(emap.get(b)!)))
    .forEach((k, i) => eid.set(k, `s${i + 1}`));
  const edges: SeaEdgeDef[] = [...emap.entries()].map(([k, e]) => {
    const landId = landE.get(k);
    // 바닷가 변은 땅 보드와 양 끝 순서까지 같게 둔다.
    if (landId) return { id: landId, a: land.edgeMap[landId].a, b: land.edgeMap[landId].b, coast: true };
    return { id: eid.get(k)!, a: vid.get(e.a)!, b: vid.get(e.b)!, coast: false };
  });
  const vertexMap: Record<VertexId, SeaVertexDef> = {};
  for (const [k, p] of pts) {
    const id = vid.get(k)!;
    const v = land.vertexMap[id];
    vertexMap[id] = { id, x: v ? v.x : p.x, y: v ? v.y : p.y, edges: [] };
  }
  for (const e of edges) {
    vertexMap[e.a].edges.push(e.id);
    vertexMap[e.b].edges.push(e.id);
  }
  const idOfKey = (k: string) => landE.get(k) ?? eid.get(k)!;
  const cellMap: Record<SeaCellId, SeaCell> = {};
  const cellEdges: Record<SeaCellId, EdgeId[]> = {};
  cells.forEach((c, i) => {
    const cs = cornersOf(c).map(key);
    cellMap[`c${i + 1}`] = c;
    cellEdges[`c${i + 1}`] = cs.map((ka, k) => idOfKey(edgeKey(ka, cs[(k + 1) % 6])));
  });
  return { cells, edges, edgeMap: Object.fromEntries(edges.map((e) => [e.id, e])), vertexMap, cellMap, cellEdges };
}

/** 바다 칸 ID (바다 칸 목록에서의 순서). 목록에 없으면 null. */
export function seaCellId(cells: readonly SeaCell[], c: SeaCell): SeaCellId | null {
  const i = cells.findIndex((x) => x.q === c.q && x.r === c.r);
  return i < 0 ? null : `c${i + 1}`;
}

// ───────────────────────── 섬 ─────────────────────────

/** 작은 섬: 땅이 이 칸 수 이하인 섬. 섬 맵에서 시작 마을을 짓지 못하고, 사람마다 처음 마을을 지으면 새 섬 보너스를 받는다. */
export const SMALL_ISLAND_MAX = 4;

/** 맞닿은 땅끼리 묶은 섬 번호 (칸 ID → 섬 번호)와 섬마다 칸 수. 섬 번호는 타일 목록 순서로 처음 만난 섬부터 0, 1 … */
function islandsOf(tiles: readonly TileDef[]): { of: Record<TileId, number>; sizes: number[] } {
  const of: Record<TileId, number> = {};
  const sizes: number[] = [];
  const near = (a: TileDef, b: TileDef) => {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
  };
  for (const t of tiles) {
    if (of[t.id] !== undefined) continue;
    const n = sizes.length;
    sizes.push(0);
    const stack = [t];
    of[t.id] = n;
    while (stack.length) {
      const cur = stack.pop()!;
      sizes[n] += 1;
      for (const o of tiles) {
        if (of[o.id] === undefined && near(cur, o)) {
          of[o.id] = n;
          stack.push(o);
        }
      }
    }
  }
  return { of, sizes };
}

/**
 * 한 게임의 보드: 타일 묶음과 거기서 계산한 꼭짓점·변. 게임마다 맵 모양과 땅 배치가 다를 수 있어 규칙 함수는 이 값을 받아 쓴다.
 * 섬 맵처럼 배를 쓰는 맵이면 sea 에 바닷길이 있다 (없으면 null).
 */
export interface Board extends BoardGeometry {
  tiles: readonly TileDef[];
  tileMap: Readonly<Record<TileId, TileDef>>;
  sea: SeaNet | null;
  /** 칸 ID → 섬 번호 (맞닿은 땅끼리 한 섬) */
  islandOf: Readonly<Record<TileId, number>>;
  /** 섬마다 땅 칸 수 */
  islandSizes: readonly number[];
}

/** 섬 맵에서 이 꼭짓점이 작은 섬에 있으면 그 섬 번호 (아니면 null). 섬끼리는 떨어져 있어 한 꼭짓점은 한 섬에만 닿는다. */
export function smallIslandAt(board: Board, vertexId: VertexId): number | null {
  if (!board.sea) return null;
  const t = board.vertexMap[vertexId]?.tiles[0];
  if (t === undefined) return null;
  const n = board.islandOf[t];
  return board.islandSizes[n] <= SMALL_ISLAND_MAX ? n : null;
}

const NO_SEA: readonly SeaCell[] = [];
const boardCache = new Map<string, Board>();
const boardByTiles = new WeakMap<readonly TileDef[], Board>();

function sameSea(board: Board, sea: readonly SeaCell[]): boolean {
  const cells = board.sea?.cells ?? NO_SEA;
  if (cells === sea) return true;
  return cells.length === sea.length && cells.every((c, i) => c.q === sea[i].q && c.r === sea[i].r);
}

/** 타일 묶음(과 바다 칸)의 보드. 같은 자리·같은 땅이면 한 번 계산한 값을 다시 쓴다 (게임 상태를 복사해도 다시 계산하지 않는다). */
export function boardFor(tiles: readonly TileDef[], sea: readonly SeaCell[] = NO_SEA): Board {
  const hit = boardByTiles.get(tiles);
  if (hit && sameSea(hit, sea)) return hit;
  const sig = tiles.map((t) => `${t.id}:${t.q},${t.r}:${t.kind}`).join('|') + (sea.length ? `#${sea.map((c) => `${c.q},${c.r}`).join('|')}` : '');
  let board = boardCache.get(sig);
  if (!board) {
    const geo = boardGeometry(tiles);
    const islands = islandsOf(tiles);
    board = {
      ...geo,
      tiles,
      tileMap: Object.fromEntries(tiles.map((t) => [t.id, t])),
      sea: sea.length ? seaNet(geo, sea) : null,
      islandOf: islands.of,
      islandSizes: islands.sizes,
    };
    if (boardCache.size > 64) boardCache.clear();
    boardCache.set(sig, board);
  }
  boardByTiles.set(tiles, board);
  return board;
}

/** 게임 상태(또는 화면 정보)에 실린 타일 묶음(과 바다 칸)의 보드 */
export function boardOf(s: { tiles: readonly TileDef[]; sea?: readonly SeaCell[] }): Board {
  return boardFor(s.tiles, s.sea ?? NO_SEA);
}

/** 바닷길 변의 이름 (바닷가 변은 땅 보드 이름, 바다 한가운데는 "바다") */
export function seaEdgeLabel(board: Board, id: EdgeId): string {
  if (board.edgeMap[id]) return edgeLabel(board, id);
  return board.sea?.edgeMap[id] ? '바다' : id;
}

/** 표준 육각 보드 (황금 배치의 땅). 테스트와 실험실 장면에서 쓴다. 게임 규칙은 그 게임의 보드(boardOf)를 쓴다. */
export const STANDARD_BOARD: Board = boardFor(TILES);
export const VERTICES: readonly VertexDef[] = STANDARD_BOARD.vertices;
export const EDGES: readonly EdgeDef[] = STANDARD_BOARD.edges;
export const VERTEX_MAP: Readonly<Record<VertexId, VertexDef>> = STANDARD_BOARD.vertexMap;
export const EDGE_MAP: Readonly<Record<EdgeId, EdgeDef>> = STANDARD_BOARD.edgeMap;

/** 꼭짓점 a, b 를 잇는 변 (없으면 null) */
export function edgeBetween(a: VertexId, b: VertexId, board: BoardGeometry = STANDARD_BOARD): EdgeId | null {
  return board.vertexMap[a]?.edges.find((id) => {
    const e = board.edgeMap[id];
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
function directionFrom(board: Board, tile: TileId, x: number, y: number, names: [number, string][]): string {
  const c = tileCenterUnit(board.tileMap[tile]);
  const deg = (Math.atan2(y - c.y, x - c.x) * 180) / Math.PI; // 0 = 오른쪽, 90 = 아래
  let best = names[0];
  for (const n of names) {
    const d = Math.abs(((deg - n[0] + 540) % 360) - 180);
    if (d < Math.abs(((deg - best[0] + 540) % 360) - 180)) best = n;
  }
  return best[1];
}

/** 화면 표시용 이름: 안쪽 꼭짓점은 "A1·B1·B2", 바닷가 꼭짓점은 "A1 왼쪽 위" 처럼 쓴다. */
export function vertexLabel(board: Board, id: VertexId): string {
  const v = board.vertexMap[id];
  if (!v) return id;
  return v.tiles.length === 1 ? `${v.tiles[0]} ${directionFrom(board, v.tiles[0], v.x, v.y, CORNER_NAMES)}` : v.tiles.join('·');
}

export function edgeLabel(board: Board, id: EdgeId): string {
  const e = board.edgeMap[id];
  if (!e) return id;
  if (e.tiles.length > 1) return `${e.tiles.join('·')} 사이`;
  const a = board.vertexMap[e.a];
  const b = board.vertexMap[e.b];
  return `${e.tiles[0]} ${directionFrom(board, e.tiles[0], (a.x + b.x) / 2, (a.y + b.y) / 2, SIDE_NAMES)} 바닷가`;
}

// ───────────────────────── 해상 교역로와 숫자 토큰 ─────────────────────────

/** 바닷가 변(타일 한 칸에만 닿은 변)을 보드 둘레를 따라 한 바퀴 순서로 늘어놓는다 (보드 가운데에서 본 위쪽에서 시작해 시계 방향). */
export function coastEdges(board: BoardGeometry = STANDARD_BOARD): EdgeId[] {
  const vs = board.vertices;
  const cx = vs.reduce((n, v) => n + v.x, 0) / vs.length;
  const cy = vs.reduce((n, v) => n + v.y, 0) / vs.length;
  const mid = (e: EdgeDef) => {
    const a = board.vertexMap[e.a];
    const b = board.vertexMap[e.b];
    return { x: (a.x + b.x) / 2 - cx, y: (a.y + b.y) / 2 - cy };
  };
  return board.edges
    .filter((e) => e.tiles.length === 1)
    .map((e) => {
      const m = mid(e);
      // 위쪽(-y)을 0으로 두고 시계 방향으로 커지는 각도. 소수점 끝자리 차이로 순서가 흔들리지 않게 반올림한다.
      return { id: e.id, a: Math.round(((Math.atan2(m.x, -m.y) + Math.PI * 2) % (Math.PI * 2)) * 1e6) };
    })
    .sort((p, q) => p.a - q.a)
    .map((p) => p.id);
}

/** 황금 배치의 교역로 자원 (바닷가를 한 바퀴 도는 순서). null 은 아무 자원 3개 → 1개(3:1) */
export const HARBOR_KINDS: readonly (Resource | null)[] = [null, 'wool', null, 'stone', 'grain', null, 'brick', 'wood', null];

/**
 * 해상 교역로를 바닷가 변에 고르게 나눠 놓는다. 아무 자원 3개 → 1개(3:1) 네 곳, 정해진 자원 2개 → 1개(2:1) 다섯 곳.
 * 바닷가 변이 30개면 세 변 이상 떨어져 이웃한 교역로가 꼭짓점을 나눠 갖지 않는다.
 */
export function harborsFor(board: BoardGeometry, kinds: readonly (Resource | null)[] = HARBOR_KINDS): Harbor[] {
  const coast = coastEdges(board);
  return kinds.map((resource, i) => ({ edgeId: coast[Math.round((i * coast.length) / kinds.length + 1) % coast.length], resource }));
}

/**
 * 가운데가 바다인 판에서 안쪽 바다에 닿은 바닷가 변 (보드 가운데에서 본 위쪽에서 시작해 시계 방향).
 * 바닷가 변은 꼭짓점으로 이어진 고리 몇 개로 나뉘는데, 보드 가운데에서 가장 먼 변이 든 고리가 바깥 둘레이고 나머지가 안쪽 바다다.
 * 가운데 바다가 없는 판이면 빈 목록.
 */
export function innerCoastEdges(board: BoardGeometry): EdgeId[] {
  const coast = coastEdges(board);
  if (!coast.length) return [];
  // 꼭짓점을 나눠 가진 바닷가 변끼리 한 고리로 묶는다.
  const group = new Map<EdgeId, number>();
  let groups = 0;
  for (const start of coast) {
    if (group.has(start)) continue;
    const g = groups++;
    const stack = [start];
    group.set(start, g);
    while (stack.length) {
      const e = board.edgeMap[stack.pop()!];
      for (const v of [e.a, e.b]) {
        for (const next of board.vertexMap[v].edges) {
          if (!group.has(next) && board.edgeMap[next].tiles.length === 1) {
            group.set(next, g);
            stack.push(next);
          }
        }
      }
    }
  }
  if (groups < 2) return [];
  const vs = board.vertices;
  const cx = vs.reduce((n, v) => n + v.x, 0) / vs.length;
  const cy = vs.reduce((n, v) => n + v.y, 0) / vs.length;
  const far = (id: EdgeId) => {
    const e = board.edgeMap[id];
    const a = board.vertexMap[e.a];
    const b = board.vertexMap[e.b];
    return Math.hypot((a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy);
  };
  const outer = group.get(coast.reduce((a, b) => (far(b) > far(a) ? b : a)));
  return coast.filter((id) => group.get(id) !== outer);
}

/** 가운데 바다 둘레 교역로 10곳 (대형 맵): 3:1 다섯 곳과 자원마다 2:1 한 곳씩, 번갈아 놓는다. */
export const INNER_HARBOR_KINDS: readonly (Resource | null)[] = [null, 'wool', null, 'stone', null, 'grain', null, 'brick', null, 'wood'];

/**
 * 가운데 바다 둘레에 교역로를 고르게 나눠 놓는다. 안쪽 바닷가가 30변이면 세 변마다 하나라 이웃한 교역로가 꼭짓점을 나눠 갖지 않는다.
 * 고르게 놓는 출발점 몇 가지 중 광장(아무것도 나지 않는 땅)에 붙는 교역로가 가장 적은 것을 쓴다.
 */
export function innerHarborsFor(board: Board, kinds: readonly (Resource | null)[] = INNER_HARBOR_KINDS): Harbor[] {
  const coast = innerCoastEdges(board);
  const step = coast.length / kinds.length;
  const onPlaza = (id: EdgeId) => board.edgeMap[id].tiles.some((t) => board.tileMap[t]?.kind === 'plaza');
  let best: EdgeId[] = [];
  let bestBad = Infinity;
  for (let start = 0; start < Math.max(1, Math.floor(step)); start++) {
    const edges = kinds.map((_, i) => coast[Math.round(i * step + start) % coast.length]);
    const bad = edges.filter(onPlaza).length;
    if (bad < bestBad) {
      best = edges;
      bestBad = bad;
    }
  }
  return kinds.map((resource, i) => ({ edgeId: best[i], resource }));
}

/** 표준 육각 보드의 황금 배치 교역로 9곳 */
export const HARBORS: readonly Harbor[] = harborsFor(STANDARD_BOARD);

/** 해상 교역로가 닿은 꼭짓점 두 곳 */
export function harborVertices(board: BoardGeometry, h: Harbor): [VertexId, VertexId] {
  const e = board.edgeMap[h.edgeId];
  return e ? [e.a, e.b] : ['', ''];
}

/**
 * 숫자 토큰을 생산 칸에 무작위로 놓는다. 빨간 숫자(6·8)끼리는 이웃하지 않게 다시 섞는다.
 * random 은 [0, 1) 값을 돌려주는 함수 (서버 난수, 테스트에서는 고정 값).
 */
export function assignNumbers(
  random: () => number,
  tiles: readonly TileDef[] = TILES,
  numberTokens: readonly number[] = NUMBER_TOKENS,
): Record<TileId, number> {
  const prod = tiles.filter((t) => t.kind !== 'plaza');
  const near = (a: TileDef, b: TileDef) => {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
  };
  const tokens = [...numberTokens];
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
