import {
  AWARD_POINTS,
  BANK_RATIO,
  DEV_COST,
  DEV_DECK,
  DEV_LABEL,
  DISCARD_LIMIT,
  GENERIC_HARBOR_RATIO,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
  PIECE_COST,
  PIECE_LABEL,
  PIECE_LIMIT,
  RESOURCES,
  RESOURCE_LABEL,
  SPECIAL_HARBOR_RATIO,
  WIN_POINTS,
} from '../../shared/constants';
import type { Bundle, DevKind, PieceKind } from '../../shared/types';
import { ResourceIcon } from './icons';

// 숫자(비용, 승점, 비율, 카드 장수)는 shared/constants.ts 에서 읽어 와서 규칙을 바꾸면 이 요약도 따라간다.
const RESOURCE_LIST = RESOURCES.map((r) => RESOURCE_LABEL[r]).join('·');
const DEV_LIST = (Object.keys(DEV_DECK) as DevKind[]).map((k) => `${DEV_LABEL[k]} ${DEV_DECK[k]}`).join(', ');

function CostOf({ name, cost }: { name: string; cost: Bundle }) {
  return (
    <span className="contract-mini">
      <span>
        <b>{name}</b>{' '}
        {RESOURCES.filter((r) => cost[r] > 0).map((r) => (
          <span key={r} className="cost-inline">
            <ResourceIcon kind={r} size={14} />×{cost[r]}
          </span>
        ))}
      </span>
    </span>
  );
}

const Cost = ({ kind }: { kind: PieceKind }) => <CostOf name={PIECE_LABEL[kind]} cost={PIECE_COST[kind]} />;

export function RulesSummary({ open = false }: { open?: boolean }) {
  return (
    <details className="card rules" open={open}>
      <summary>규칙 요약 (카탄 기본 규칙)</summary>
      <ul>
        <li>
          19칸 육각 보드에서 숲·밭·목초지·점토 구덩이·채석장이 {RESOURCE_LIST}를 냅니다. 가운데 마을 광장은 자원이 나지 않는 빈 땅이고 기사단
          동상이 처음 서 있는 곳입니다. 칸마다 2~12 숫자 패가 놓이며 빨간 6·8이 가장 자주 나옵니다.
        </li>
        <li>
          시작: 순서대로 한 바퀴, 거꾸로 한 바퀴 돌며 각자 마을 하나와 거기 붙은 길 하나를 놓습니다. 두 번째 마을은 닿은 칸마다 자원 1장을 바로
          받습니다.
        </li>
        <li>
          차례가 오면 주사위 두 개를 굴립니다. 합과 같은 숫자의 칸에 닿은 마을은 1장, 도시는 2장을 받습니다 (차례가 아닌 사람도 받습니다). 그
          뒤로는 짓기·교환·발전 카드를 횟수 제한 없이 하고 턴을 끝냅니다.
        </li>
        <li>
          <b>7이 나오면</b> 아무 칸도 생산하지 않습니다. 자원이 {DISCARD_LIMIT}장보다 많은 사람은 절반(내림)을 버리고, 굴린 사람은 기사단 동상을
          다른 칸으로 옮긴 뒤 그 칸에 닿은 사람 한 명에게서 자원 1장을 무작위로 빼앗습니다. 동상이 선 칸은 동상이 떠날 때까지 잠겨 생산하지
          않습니다.
        </li>
        <li>
          <b>거리 규칙</b>: 마을·도시 바로 옆 꼭짓점에는 누구도 마을을 지을 수 없습니다. 시작 배치가 끝나면 마을은 내 길이 닿은 꼭짓점에만,
          길은 내 마을·도시나 내 길에 이어서만 놓습니다. 도시는 새 자리에 지을 수 없고 내 마을을 올려서만 짓습니다.
        </li>
        <li>
          <b>건설</b>: <Cost kind="road" /> <Cost kind="village" /> <Cost kind="city" /> 한 사람이 길 {PIECE_LIMIT.road}개, 마을{' '}
          {PIECE_LIMIT.village}개, 도시 {PIECE_LIMIT.city}개까지 가집니다. 마을을 도시로 올리면 그 마을 조각은 다시 쓸 수 있습니다.
        </li>
        <li>
          <b>교환</b>: 은행에는 같은 자원 {BANK_RATIO}장을 내고 원하는 자원 1장을 받습니다. 바닷가 해상 교역로에 마을·도시가 닿아 있으면 아무
          자원 {GENERIC_HARBOR_RATIO}장(3:1 교역로)이나 그려진 자원 {SPECIAL_HARBOR_RATIO}장(2:1 교역로)으로 바꿀 수 있습니다. 차례인 사람은 다른
          플레이어와도 교환할 수 있습니다.
        </li>
        <li>
          <b>발전 카드</b>: <CostOf name="한 장" cost={DEV_COST} /> 덱 구성은 {DEV_LIST}장입니다. 산 턴에는 쓸 수 없고 한 턴에 한 장만 씁니다.
          기사는 주사위를 굴리기 전에도 써서 동상을 옮길 수 있고, 승점 카드는 숨겨 두었다가 10점에 닿을 때 셉니다.
        </li>
        <li>
          <b>최장 교역로</b>: 끊기지 않고 이어진 길이 {LONGEST_ROAD_MIN}개 이상으로 가장 긴 사람이 {AWARD_POINTS}점을 받습니다. 남의 마을·도시가
          중간에 서면 길이 끊깁니다. <b>최강 기사단</b>: 기사 카드를 {LARGEST_ARMY_MIN}장 이상 가장 많이 쓴 사람이 {AWARD_POINTS}점을
          받습니다. 둘 다 더 앞선 사람이 나오면 넘어갑니다.
        </li>
        <li>
          마을 1점, 도시 2점에 달성과 승점 카드를 더해 자기 차례에 먼저 <b>{WIN_POINTS}점</b>에 닿은 사람이 이깁니다.
        </li>
      </ul>
    </details>
  );
}
