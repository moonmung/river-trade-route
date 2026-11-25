// 자랑하기 한마디: 누를 때마다 중세 영주·기사가 외칠 법한 말이 한 줄씩 바뀌어 뜬다 (자랑 종류마다 10가지).
// 고른 번호만 서버로 보내고 글은 화면마다 이 표에서 찾는다.
import { BRAG_LINE_COUNT } from '../../shared/constants';
import type { BragKind } from '../../shared/protocol';

export const BRAG_LINES: Record<BragKind, readonly string[]> = {
  victory: [
    '이 섬의 모든 길은 이제 나의 성문으로 이어지노라!',
    '깃발을 높이 올려라. 오늘 이 땅의 주인이 정해졌도다.',
    '음유시인들이여, 내 이름을 노래에 새기거라.',
    '승리의 종을 울려라! 오늘 축배는 내가 사겠노라.',
    '왕관이 조금 무겁구나. 허나 내 머리에 꼭 맞도다.',
    '그대들의 분투는 기억하리라. 다만 연대기의 첫 장은 내 것이로다.',
    '성벽은 높고 곳간은 가득하니 무엇을 더 바라겠는가.',
    '패자에게는 위로를, 나에게는 영광을!',
    '오늘 밤 성에서 잔치를 열겠노라. 모두 초대하마.',
    '이것이 바로 전설의 시작이니라.',
  ],
  longest_road: [
    '내 길은 바다 끝에서 다시 바다 끝까지 이어지노라.',
    '상인들이여, 통행세는 반값으로 해 주마.',
    '이 길을 걷는 자는 모두 나의 손님이로다.',
    '길이 길수록 소문도 멀리 가는 법이지.',
    '끊으려거든 끊어 보아라. 돌아가는 길도 내 것이니.',
    '마차 바퀴 소리가 그칠 날이 없겠구나.',
    '지도를 새로 그려라. 길이 또 늘었노라.',
    '모든 길은 결국 내 마을로 통하노라.',
    '판자 한 장 한 장에 내 땀이 배어 있도다.',
    '순례자들도 이 길을 칭송하리라.',
  ],
  largest_army: [
    '기사들이여, 창을 들어라! 이 땅은 우리가 지킨다.',
    '내 기사단 앞에서 도적들은 숲으로 숨는구나.',
    '갑옷은 반짝이고 군기는 드높도다.',
    '동상마저 내 기사들에게 경례를 하는구나.',
    '한 명의 기사는 열 사람의 용기와 같으니라.',
    '칼집에 칼을 꽂아라. 오늘은 싸울 필요도 없겠도다.',
    '기사도의 이름으로 이 영지를 수호하노라.',
    '북을 울려라! 사열을 시작하라!',
    '적들이여, 성문 앞에 나부끼는 내 깃발을 보라.',
    '명예와 충성, 그것이 우리 기사단의 전부이니라.',
  ],
};

/** 받은 번호의 한마디 (모르는 번호면 첫 줄) */
export function bragLine(kind: BragKind, line: number): string {
  const list = BRAG_LINES[kind];
  return list[line] ?? list[0];
}

/** 자랑 종류마다 섞어 둔 차례와 다음 자리. 한 바퀴를 다 돌면 다시 섞되 바로 앞 줄이 연달아 나오지 않게 한다. */
const decks = new Map<BragKind, { order: number[]; next: number }>();

function shuffled(avoidFirst: number | null): number[] {
  const order = Array.from({ length: BRAG_LINE_COUNT }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (avoidFirst !== null && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

/** 이번에 외칠 한마디 번호: 누를 때마다 다른 줄이 나온다 (10번 안에 같은 줄이 다시 나오지 않는다). */
export function nextBragLine(kind: BragKind): number {
  let deck = decks.get(kind);
  if (!deck || deck.next >= deck.order.length) {
    const last = deck ? deck.order[deck.order.length - 1] : null;
    deck = { order: shuffled(last), next: 0 };
    decks.set(kind, deck);
  }
  return deck.order[deck.next++];
}
