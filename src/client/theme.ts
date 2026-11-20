import type { Resource, TileKind } from '../shared/types';

/** 플레이어 깃발 색. 색만으로 구분하지 않도록 문양(EMBLEMS)을 함께 쓴다. */
export const PLAYER_COLORS = [
  { name: '붉은', hex: '#d1453b', soft: '#f7d6d2', ink: '#7d1f18' },
  { name: '푸른', hex: '#2f6fc4', soft: '#d5e3f7', ink: '#173f75' },
  { name: '주황', hex: '#e8901f', soft: '#fbe6c8', ink: '#7a4608' },
  { name: '보라', hex: '#8a4fbd', soft: '#e8daf4', ink: '#4c2470' },
] as const;

export type EmblemShape = 'circle' | 'triangle' | 'square' | 'diamond';
export const EMBLEMS: readonly EmblemShape[] = ['circle', 'triangle', 'square', 'diamond'];
export const EMBLEM_LABEL: Record<EmblemShape, string> = {
  circle: '원',
  triangle: '삼각',
  square: '사각',
  diamond: '마름모',
};

export function playerColor(index: number) {
  return PLAYER_COLORS[((index % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/** React 밖(3D 보드 위 HTML 표식)에서 쓰는 문양 SVG 문자열 */
export function emblemSvgMarkup(colorIndex: number, size = 18): string {
  const color = playerColor(colorIndex).hex;
  const shape = EMBLEMS[((colorIndex % EMBLEMS.length) + EMBLEMS.length) % EMBLEMS.length];
  const attrs = `fill="${color}" stroke="#1d1a16" stroke-width="1.6" stroke-linejoin="round"`;
  const body =
    shape === 'circle'
      ? `<circle cx="10" cy="10" r="7.6" ${attrs}/>`
      : shape === 'triangle'
        ? `<path d="M10 2.2 L18.2 17 L1.8 17 Z" ${attrs}/>`
        : shape === 'square'
          ? `<rect x="2.8" y="2.8" width="14.4" height="14.4" rx="1.5" ${attrs}/>`
          : `<path d="M10 1.5 L18.5 10 L10 18.5 L1.5 10 Z" ${attrs}/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
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
