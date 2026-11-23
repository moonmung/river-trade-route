import type { Resource, TileKind } from '../shared/types';

/** 플레이어 색. 사람 아이콘(PersonIcon), 지붕, 길 판자, 상태 창 띠를 이 색으로 칠한다. */
export const PLAYER_COLORS = [
  { name: '붉은', hex: '#d1453b', soft: '#f7d6d2', ink: '#7d1f18' },
  { name: '푸른', hex: '#2f6fc4', soft: '#d5e3f7', ink: '#173f75' },
  { name: '주황', hex: '#e8901f', soft: '#fbe6c8', ink: '#7a4608' },
  { name: '보라', hex: '#8a4fbd', soft: '#e8daf4', ink: '#4c2470' },
  // 대형 맵(8인)에서 다섯 번째 사람부터 쓰는 색. 목재·곡물 같은 땅 색과 헷갈리지 않는 색으로 골랐다.
  { name: '초록', hex: '#3f9a48', soft: '#d6eed8', ink: '#1d5424' },
  { name: '분홍', hex: '#d24f8f', soft: '#f6d6e6', ink: '#76204d' },
  { name: '청록', hex: '#1a9aa3', soft: '#cdeef0', ink: '#0b5257' },
  { name: '검은', hex: '#3d3f47', soft: '#dcdde2', ink: '#16171b' },
] as const;

export function playerColor(index: number) {
  return PLAYER_COLORS[((index % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/** 사람 아이콘(머리와 어깨) SVG 문자열. React 밖(3D 보드 위 마을·도시 주인 표식)에서 쓴다. ui/icons.tsx 의 PersonIcon 과 같은 그림. */
export function personSvgMarkup(colorIndex: number, size = 18): string {
  const color = playerColor(colorIndex).hex;
  const attrs = `fill="${color}" stroke="#1d1a16" stroke-width="1.5" stroke-linejoin="round"`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.4" r="4.5" ${attrs}/><path d="M3.4 21.4c0-5.1 3.9-8.4 8.6-8.4s8.6 3.3 8.6 8.4z" ${attrs}/></svg>`;
}

export const RESOURCE_COLOR: Record<Resource, string> = {
  wood: '#8a5a2b',
  grain: '#d9a521',
  wool: '#e6dcc2',
  brick: '#b85c3c',
  stone: '#7d8794',
};

export const TILE_COLOR: Record<TileKind, string> = {
  ...RESOURCE_COLOR,
  plaza: '#b0533c',
};
