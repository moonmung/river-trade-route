import { CONTRACTS, RESOURCES } from '../../shared/constants';
import { ResourceIcon } from './icons';

export function RulesSummary({ open = false }: { open?: boolean }) {
  return (
    <details className="card rules" open={open}>
      <summary>규칙 요약</summary>
      <ul>
        <li>19칸 육각 보드의 목재·곡물·석재 칸에 거점을 두고 자원을 모아, 공개 계약에 납품해 점수를 얻습니다. 가운데 칸은 공동 시장입니다.</li>
        <li>
          시작: 순서를 섞은 뒤 <b>마지막 자리부터 역순</b>으로 빈 생산 칸에 시작 거점을 하나씩 놓습니다. 모두 목재·곡물·석재 1개씩으로
          시작합니다.
        </li>
        <li>
          라운드 시작마다 모든 거점이 그 칸의 자원을 1개 생산하고, <b>예보와 같은 종류</b>면 1개를 더 생산합니다. 예보: 목재 → 곡물 →
          석재 → 목재 → 곡물 → 석재.
        </li>
        <li>자기 턴에는 행동을 최대 2회 합니다. 같은 행동을 반복하거나 일찍 턴을 끝낼 수 있습니다.</li>
        <li>
          <b>거점 건설</b>: 목재 1 + 석재 1, 내 거점과 변을 맞댄 빈 생산 칸, 최대 3개. 새 거점은 다음 라운드부터 생산합니다.
        </li>
        <li>
          <b>시장 교환</b>: 같은 종류 2개 → 다른 종류 1개. <b>플레이어 교환</b>: 차례인 사람이 상대 한 명에게 제안하고, 수락되면 행동
          1회를 씁니다.
        </li>
        <li>
          <b>납품</b>: 라운드마다 4종 계약이 1건씩 열리고, 먼저 완료한 사람이 2점을 얻습니다.
          <span className="contract-mini">
            {CONTRACTS.map((c) => (
              <span key={c.id}>
                {c.name}{' '}
                {RESOURCES.filter((r) => c.cost[r] > 0).map((r) => (
                  <span key={r} className="cost-inline">
                    <ResourceIcon kind={r} size={14} />×{c.cost[r]}
                  </span>
                ))}
              </span>
            ))}
          </span>
        </li>
        <li>6라운드가 끝나면 납품 점수가 가장 높은 사람이 이깁니다. 동점이면 남은 자원이 많은 사람, 그래도 같으면 공동 승리입니다.</li>
      </ul>
    </details>
  );
}
