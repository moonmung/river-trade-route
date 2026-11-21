// 해상 교역로 교환을 어느 부두에서 했는지 고른다 (배 연출용).
// 게임 기록의 bank_trade 는 낸 묶음·받은 묶음만 남기므로, 낸 자원마다 그 사람이 쓸 수 있는 가장 좋은 비율의 교역로를 찾는다.
import { RESOURCES, GENERIC_HARBOR_RATIO, SPECIAL_HARBOR_RATIO } from '../../shared/constants';
import type { Bundle, Harbor, Resource } from '../../shared/types';

/** 교역로 하나에서 오간 짐: 낸 자원(낸 장수만큼)과 그 몫으로 받은 자원 */
export interface HarborLeg {
  edgeId: string;
  ratio: number;
  give: Resource[];
  get: Resource[];
}

/**
 * 낸 자원마다 그 사람의 마을·도시가 닿은 교역로 가운데 비율이 맞는 곳을 고른다.
 * 그 자원 전용 교역로(2:1)가 있으면 그곳, 없으면 아무 자원 교역로(3:1)다. 둘 다 없으면 은행(4:1)과 바꾼 몫이라 뺀다.
 * 받은 자원은 교역로마다 낸 묶음 수만큼 차례로 나눠 준다. owns(edgeId) 는 그 교역로 변 끝에 그 사람의 마을·도시가 있는지.
 */
export function harborLegs(harbors: readonly Harbor[], owns: (edgeId: string) => boolean, give: Bundle, get: Bundle): HarborLeg[] {
  const mine = harbors.filter((h) => owns(h.edgeId));
  const legs = new Map<string, HarborLeg>();
  const received = RESOURCES.flatMap((r) => Array<Resource>(Math.max(0, get[r] ?? 0)).fill(r));
  let next = 0;
  for (const r of RESOURCES) {
    const n = give[r] ?? 0;
    if (n <= 0) continue;
    const special = mine.find((h) => h.resource === r);
    const harbor = special ?? mine.find((h) => h.resource === null);
    if (!harbor) continue;
    const ratio = special ? SPECIAL_HARBOR_RATIO : GENERIC_HARBOR_RATIO;
    let leg = legs.get(harbor.edgeId);
    if (!leg) {
      leg = { edgeId: harbor.edgeId, ratio, give: [], get: [] };
      legs.set(harbor.edgeId, leg);
    }
    for (let i = 0; i < n; i++) leg.give.push(r);
    const units = Math.floor(n / ratio);
    for (let i = 0; i < units && next < received.length; i++) leg.get.push(received[next++]);
  }
  return [...legs.values()];
}
