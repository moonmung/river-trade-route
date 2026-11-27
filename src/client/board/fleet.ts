// 섬 맵의 항로: 한 사람이 이어 띄운 배들을 항로 하나로 묶는다.
// 보드에는 배를 변마다 그리지 않고 항로를 그 사람 색 뱃길로 칠한 뒤, 섬에 닿은 쪽에서 출발하는 배 한 척만 그 길을 오가게 그린다.

export interface FleetShip {
  edgeId: string;
  owner: string;
  colorIndex: number;
}

export interface FleetRoute {
  owner: string;
  colorIndex: number;
  /** 배가 오가는 길: 섬(내 마을·도시나 바닷가)에 닿은 꼭짓점에서 시작해 가장 멀리 이어진 꼭짓점들 */
  vertices: string[];
  /** vertices 사이의 변 (vertices.length - 1 개) */
  edges: string[];
  /** 이 항로에 묶인 배가 떠 있는 변 전부 (갈래가 있으면 edges 보다 많다) */
  all: string[];
}

export interface FleetLookup {
  /** 변의 두 꼭짓점 */
  ends: (edgeId: string) => { a: string; b: string } | null;
  /** 땅에 닿은 꼭짓점 (바닷가) */
  isCoast: (vertexId: string) => boolean;
  /** 그 사람의 마을·도시가 선 꼭짓점 */
  ownsBuilding: (vertexId: string, owner: string) => boolean;
}

/** 길이 한 줄로 이어지지 않는 큰 갈래에서도 오래 걸리지 않게 둘러보는 걸음 수를 묶는다. */
const SEARCH_LIMIT = 4000;

/**
 * 사람마다 이어진 배를 묶어 항로로 만든다. 항로의 출발점은 내 마을·도시가 선 꼭짓점, 없으면 바닷가 꼭짓점,
 * 그것도 없으면 끝에 있는 꼭짓점이다. 출발점에서 가장 길게 이어지는 길을 배가 오가는 길로 쓴다.
 */
export function shipRoutes(ships: readonly FleetShip[], look: FleetLookup): FleetRoute[] {
  const owners = [...new Set(ships.map((s) => s.owner))];
  const routes: FleetRoute[] = [];
  for (const owner of owners) {
    const mine = ships.filter((s) => s.owner === owner);
    const colorIndex = mine[0].colorIndex;
    const ends = new Map<string, { a: string; b: string }>();
    const at = new Map<string, string[]>();
    for (const s of mine) {
      const e = look.ends(s.edgeId);
      if (!e) continue;
      ends.set(s.edgeId, e);
      for (const v of [e.a, e.b]) at.set(v, [...(at.get(v) ?? []), s.edgeId]);
    }
    const seen = new Set<string>();
    for (const first of [...ends.keys()].sort()) {
      if (seen.has(first)) continue;
      // 꼭짓점을 함께 쓰는 배끼리 한 무리
      const group: string[] = [];
      const stack = [first];
      seen.add(first);
      while (stack.length) {
        const id = stack.pop()!;
        group.push(id);
        const e = ends.get(id)!;
        for (const v of [e.a, e.b]) {
          for (const next of at.get(v) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            stack.push(next);
          }
        }
      }
      const vertices = [...new Set(group.flatMap((id) => [ends.get(id)!.a, ends.get(id)!.b]))].sort();
      const degree = (v: string) => (at.get(v) ?? []).filter((id) => group.includes(id)).length;
      const start =
        vertices.find((v) => look.ownsBuilding(v, owner)) ??
        vertices.find((v) => look.isCoast(v) && degree(v) === 1) ??
        vertices.find((v) => look.isCoast(v)) ??
        vertices.find((v) => degree(v) === 1) ??
        vertices[0];
      const path = longestFrom(start, group, ends, at);
      routes.push({ owner, colorIndex, vertices: path.vertices, edges: path.edges, all: group.sort() });
    }
  }
  return routes;
}

function longestFrom(
  start: string,
  group: readonly string[],
  ends: Map<string, { a: string; b: string }>,
  at: Map<string, string[]>,
): { vertices: string[]; edges: string[] } {
  const inGroup = new Set(group);
  let best = { vertices: [start], edges: [] as string[] };
  let steps = 0;
  const walk = (v: string, vs: string[], es: string[], used: Set<string>) => {
    if (++steps > SEARCH_LIMIT) return;
    if (es.length > best.edges.length) best = { vertices: [...vs], edges: [...es] };
    for (const id of [...(at.get(v) ?? [])].sort()) {
      if (!inGroup.has(id) || used.has(id)) continue;
      const e = ends.get(id)!;
      const next = e.a === v ? e.b : e.a;
      if (vs.includes(next)) continue;
      used.add(id);
      walk(next, [...vs, next], [...es, id], used);
      used.delete(id);
    }
  };
  walk(start, [start], [], new Set());
  return best;
}
