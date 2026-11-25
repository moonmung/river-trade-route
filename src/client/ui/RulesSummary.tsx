import {
  AWARD_POINTS,
  BANK_RATIO,
  DEV_COST,
  DEV_CARDS,
  DEV_DECK,
  RESOURCE_CARDS,
  DEV_LABEL,
  DISCARD_LIMIT,
  GENERIC_HARBOR_RATIO,
  HAND_LIMIT_MAX,
  HAND_LIMIT_MIN,
  TURN_SECONDS,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
  PIECE_COST,
  PIECE_LABEL,
  PIECE_LIMIT,
  RESOURCES,
  RESOURCE_LABEL,
  SPECIAL_HARBOR_RATIO,
  WIN_POINTS,
  WIN_POINTS_MAX,
  WIN_POINTS_MIN,
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
          자리 순서: 게임을 시작하면 모두 동시에 주사위를 굴려 높은 사람부터 자리를 잡습니다. 가장 낮은 사람이 마지막이고, 같은 수가 나온 사람끼리는
          다시 굴립니다.
        </li>
        <li>
          시작: 순서대로 한 바퀴, 거꾸로 한 바퀴 돌며 각자 마을을 하나 짓고(자리를 고른 뒤 ✓) 그 마을에 붙여 길을 하나 놓습니다(변을 고른 뒤 ✓). 두
          번째 마을은 닿은 칸마다 자원 1장을 바로 받습니다.
        </li>
        <li>
          차례가 오면 주사위 두 개를 굴립니다. 합과 같은 숫자의 칸에 닿은 마을은 1장, 도시는 2장을 받습니다 (차례가 아닌 사람도 받습니다). 그
          뒤로는 짓기·교환·발전 카드를 횟수 제한 없이 하고 턴을 끝냅니다.
        </li>
        <li>
          <b>7이 나오면</b> 아무 칸도 생산하지 않습니다. 자원이 보유 한도(기본 {DISCARD_LIMIT}장, 방장이 {HAND_LIMIT_MIN}~{HAND_LIMIT_MAX}장으로 정함)보다 많은 사람은 절반(내림)을 버리고(방장이 7 버리기를 없음으로 하면 버리지 않습니다), 굴린 사람은 기사단 동상을
          다른 칸으로 옮긴 뒤 그 칸에 닿은 사람 한 명에게서 자원 1장을 무작위로 빼앗습니다. 동상이 선 칸은 동상이 떠날 때까지 잠겨 생산하지
          않습니다.
        </li>
        <li>
          <b>거리 규칙</b>: 마을·도시 바로 옆 꼭짓점에는 누구도 마을을 지을 수 없습니다. 시작 배치가 끝나면 마을은 내 길이 닿은 꼭짓점에만,
          길은 내 마을·도시나 내 길에 이어서만 놓습니다. 도시는 새 자리에 지을 수 없고 내 마을을 올려서만 짓습니다.
        </li>
        <li>
          <b>건설</b>: <Cost kind="road" /> <Cost kind="village" /> <Cost kind="city" /> 한 사람이 길 {PIECE_LIMIT.road}개, 마을{' '}
          {PIECE_LIMIT.village}개, 도시 {PIECE_LIMIT.city}개까지 가집니다(방장이 대기실에서 개수를 바꿀 수 있습니다). 마을을 도시로 업그레이드하면 그 마을 조각은 다시 쓸 수 있습니다. 방장이 개수 제한을 없음으로 고르면 몇 개든 짓고 발전 카드도 떨어지지 않습니다.
        </li>
        <li>
          <b>교환</b>: 은행에는 같은 자원 {BANK_RATIO}장을 내고 원하는 자원 1장을 받습니다. 바닷가 해상 교역로에 마을·도시가 닿아 있으면 아무
          자원 {GENERIC_HARBOR_RATIO}장(3:1 교역로)이나 그려진 자원 {SPECIAL_HARBOR_RATIO}장(2:1 교역로)으로 바꿀 수 있습니다. 차례인 사람은 다른
          플레이어 모두에게 교환을 제안할 수 있고 수락한 사람 중 한 명을 골라 교환을 확정합니다.
        </li>
        <li>
          <b>은행 자원 카드</b>: 은행에는 자원마다 방장이 정한 장수(기본 {RESOURCE_CARDS}장)만 있어서 다 떨어진 자원은 생산·은행 교환·풍년으로 받을
          수 없습니다. 한 자원을 여러 사람이 받아야 하는데 은행에 모자라면 그 자원은 아무도 받지 못하고 받을 사람이 한 명이면 남은 만큼만 받습니다.
        </li>
        <li>
          <b>발전 카드</b>: <CostOf name="한 장" cost={DEV_COST} /> 기본 덱은 {DEV_LIST}장으로 모두 {DEV_CARDS}장이고 방장이 총 장수를 바꾸면 같은
          비율로 나누고, 종류마다 장수를 따로 정할 수도 있습니다. 산 턴에는 쓸 수 없고 한 턴에 한 장만 씁니다. 기사는 내 차례라면 주사위를 굴리기 전에도 굴린 뒤에도 써서 동상을 옮길 수 있고
          승점 카드는 숨겨 두었다가 승리 점수에 닿을 때 셉니다.
        </li>
        <li>
          <b>최장 교역로</b>: 끊기지 않고 이어진 길이 {LONGEST_ROAD_MIN}개 이상으로 가장 긴 사람이 {AWARD_POINTS}점을 받습니다. 남의 마을·도시가
          중간에 서면 길이 끊깁니다. <b>최강 기사단</b>: 기사 카드를 {LARGEST_ARMY_MIN}장 이상 가장 많이 쓴 사람이 {AWARD_POINTS}점을
          받습니다. 둘 다 더 앞선 사람이 나오면 넘어갑니다.
        </li>
        <li>
          마을 1점, 도시 2점에 달성과 승점 카드를 더해 자기 차례에 먼저 <b>승리 점수</b>(기본 {WIN_POINTS}점, 방장이 방을 만들 때 {WIN_POINTS_MIN}~{WIN_POINTS_MAX}점으로 정함)에 닿은 사람이 이깁니다. 2명이면 같은 규칙으로 일대일 대결을 합니다.
        </li>
        <li>
          <b>차례 시간</b>: 한 차례는 기본 {TURN_SECONDS}초입니다(방장이 바꿀 수 있음). 시간이 다 되면 주사위·동상·버리기는 무작위로 대신 하고
          턴을 넘깁니다.
        </li>
      </ul>
    </details>
  );
}
