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

/** 길은 엇갈린 판자, 마을은 작은 집, 도시는 성벽 두른 마을 */
export const PIECE_ART: Record<PieceKind, string> = {
  road: `${BASE}dev_road_building.webp`,
  village: `${BASE}village.webp`,
  city: `${BASE}city.webp`,
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
