// 카드·버튼에 쓰는 수채화 그림 (public/art/cards/*.webp, 256px 정사각 · 투명 바탕).
// 자원 다섯 가지, 발전 카드 다섯 가지와 발전 카드 뒷면, 길·마을·도시 그림이다.
import type { DevKind, PieceKind, Resource } from '../../shared/types';

const BASE = '/art/cards/';

export const RESOURCE_ART: Record<Resource, string> = {
  wood: `${BASE}wood.webp`,
  grain: `${BASE}grain.webp`,
  wool: `${BASE}wool.webp`,
  brick: `${BASE}brick.webp`,
  stone: `${BASE}stone.webp`,
};

export const DEV_ART: Record<DevKind, string> = {
  knight: `${BASE}dev_knight.webp`,
  victory: `${BASE}dev_victory.webp`,
  road_building: `${BASE}dev_road_building.webp`,
  year_of_plenty: `${BASE}dev_year_of_plenty.webp`,
  monopoly: `${BASE}dev_monopoly.webp`,
};

/**
 * 배: 물결 위의 작은 돛배 (섬 맵). 그림 파일 대신 SVG 를 바로 넣는다.
 * 다른 카드 그림처럼 투명 바탕에 옅은 물감 번짐과 갈색 먹선으로 그린다.
 */
const SHIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<ellipse cx="128" cy="206" rx="104" ry="20" fill="#8cc7cf" opacity=".55"/>
<path d="M30 204c16-8 30-8 46 0s30 8 46 0 30-8 46 0 30 8 46 0 24-6 34-2" fill="none" stroke="#5f9fb2" stroke-width="7" stroke-linecap="round"/>
<path d="M44 152h170l-22 40c-3 6-9 9-16 9H86c-7 0-13-3-17-9z" fill="#9a6a3c" stroke="#4a3020" stroke-width="6" stroke-linejoin="round"/>
<path d="M56 166h148" stroke="#c9975f" stroke-width="7" stroke-linecap="round"/>
<path d="M124 40v114" stroke="#5a3b22" stroke-width="8" stroke-linecap="round"/>
<path d="M132 52c36 14 58 46 62 92h-62z" fill="#f4e7c8" stroke="#4a3020" stroke-width="6" stroke-linejoin="round"/>
<path d="M116 64c-26 16-42 44-46 80h46z" fill="#e8d6ad" stroke="#4a3020" stroke-width="6" stroke-linejoin="round"/>
<path d="M136 96c20 8 34 22 42 40" fill="none" stroke="#c9a46a" stroke-width="5" stroke-linecap="round"/>
<path d="M124 40l34 10-34 10z" fill="#c4543a" stroke="#4a3020" stroke-width="5" stroke-linejoin="round"/>
</svg>`;
export const SHIP_ART = `data:image/svg+xml,${encodeURIComponent(SHIP_SVG)}`;

/** 금광 (섬 맵): 반짝이는 금덩이 셋. 다른 카드 그림처럼 투명 바탕에 갈색 먹선으로 그린다. */
const GOLD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<ellipse cx="128" cy="200" rx="92" ry="18" fill="#b9975a" opacity=".35"/>
<path d="M44 188l22-62 54-12 26 52-18 34z" fill="#e8b93a" stroke="#4a3020" stroke-width="7" stroke-linejoin="round"/>
<path d="M66 126l20 26 34-38" fill="none" stroke="#f8de7e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M128 196l14-58 48-18 32 44-14 38z" fill="#d9a62c" stroke="#4a3020" stroke-width="7" stroke-linejoin="round"/>
<path d="M142 138l26 22 22-40" fill="none" stroke="#f3cf62" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M96 112l12-46 44-10 22 40-12 30-46 8z" fill="#f2c84b" stroke="#4a3020" stroke-width="7" stroke-linejoin="round"/>
<path d="M108 66l18 24 26-34" fill="none" stroke="#fff0a8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M200 54l6 16 16 6-16 6-6 16-6-16-16-6 16-6z" fill="#fff6c8" stroke="#a8802a" stroke-width="3" stroke-linejoin="round"/>
<path d="M58 70l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#fff6c8" stroke="#a8802a" stroke-width="3" stroke-linejoin="round"/>
</svg>`;
export const GOLD_ART = `data:image/svg+xml,${encodeURIComponent(GOLD_SVG)}`;

/** 길은 판자 길 한 조각, 마을은 작은 집, 도시는 성벽 두른 마을, 배는 작은 돛배 (길 건설 카드는 판자 길 두 조각에 ×2 딱지) */
export const PIECE_ART: Record<PieceKind, string> = {
  road: `${BASE}road.webp`,
  village: `${BASE}village.webp`,
  city: `${BASE}city.webp`,
  ship: SHIP_ART,
};

/** 발전 카드 뒷면 (탑과 월계수) */
export const DEV_BACK_ART = `${BASE}dev.webp`;

export function ArtImg({ src, size = 24, title, className }: { src: string; size?: number; title?: string; className?: string }) {
  return (
    <img
      className={`art-img${className ? ` ${className}` : ''}`}
      src={src}
      width={size}
      height={size}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      draggable={false}
      decoding="async"
    />
  );
}

/** 처음 화면에서 미리 받아 두어 카드가 뜰 때 그림이 늦게 차오르지 않게 한다. */
export function preloadCardArt(): void {
  for (const src of [...Object.values(RESOURCE_ART), ...Object.values(DEV_ART), ...Object.values(PIECE_ART), DEV_BACK_ART]) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}
