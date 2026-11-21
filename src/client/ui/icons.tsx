import type { Resource, TileKind } from '../../shared/types';
import { EMBLEMS, playerColor } from '../theme';
import { ArtImg, RESOURCE_ART } from './art';

interface IconProps {
  size?: number;
  title?: string;
  className?: string;
}

/** 자원 아이콘: 사용자가 준 수채화 그림(통나무·볏단·양·벽돌 더미·돌덩이). 광장은 기사단 동상 선화로 그린다. */
export function ResourceIcon({ kind, size = 20, title, className }: IconProps & { kind: TileKind }) {
  if (kind !== 'plaza') return <ArtImg src={RESOURCE_ART[kind]} size={size} title={title} className={`res-art${className ? ` ${className}` : ''}`} />;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <PlazaGlyph />
    </svg>
  );
}

/** 광장: 받침돌 위 기사단 동상 */
function PlazaGlyph() {
  return (
    <g stroke="#3a2a1f" strokeWidth="1.1" strokeLinejoin="round">
      <rect x="5" y="18" width="14" height="4" rx="0.8" fill="#bbb09c" />
      <rect x="7.5" y="15" width="9" height="3" fill="#cfc6b4" />
      <circle cx="12" cy="5" r="2.4" fill="#8f9aa4" />
      <path d="M9 8 H15 L14.5 15 H9.5 Z" fill="#7f8a95" />
      <path d="M8 9 C6 10 6 13 8 14 L10 13 V9 Z" fill="#a8402c" />
      <path d="M16.5 3 V14" stroke="#5b646d" strokeWidth="1.4" />
    </g>
  );
}

/** 아무 자원 (3:1 해상 교역로): 물음표 */
export function AnyResourceIcon({ size = 20, title, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="9.6" fill="#e3edf1" stroke="#3a2a1f" strokeWidth="1.3" />
      <path d="M9.1 9.4a2.95 2.95 0 1 1 4.4 2.6c-1 .55-1.5 1.1-1.5 2.3v.5" fill="none" stroke="#2c4a5a" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="12" cy="17.7" r="1.35" fill="#2c4a5a" />
    </svg>
  );
}

/** 플레이어 문양: 색 + 모양 */
export function Emblem({ colorIndex, size = 18, title }: { colorIndex: number; size?: number; title?: string }) {
  const color = playerColor(colorIndex);
  const shape = EMBLEMS[((colorIndex % EMBLEMS.length) + EMBLEMS.length) % EMBLEMS.length];
  const common = { fill: color.hex, stroke: '#1d1a16', strokeWidth: 1.6, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" role="img" aria-label={title} aria-hidden={title ? undefined : true} className="emblem">
      {title ? <title>{title}</title> : null}
      {shape === 'circle' && <circle cx="10" cy="10" r="7.6" {...common} />}
      {shape === 'triangle' && <path d="M10 2.2 L18.2 17 L1.8 17 Z" {...common} />}
      {shape === 'square' && <rect x="2.8" y="2.8" width="14.4" height="14.4" rx="1.5" {...common} />}
      {shape === 'diamond' && <path d="M10 1.5 L18.5 10 L10 18.5 L1.5 10 Z" {...common} />}
    </svg>
  );
}

export function CrownIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M3 18 L4.5 7 L9 11.5 L12 5 L15 11.5 L19.5 7 L21 18 Z" fill="#e3b23c" stroke="#6b4b0b" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="3" y="18" width="18" height="2.6" rx="1" fill="#c9952a" stroke="#6b4b0b" strokeWidth="1.2" />
    </svg>
  );
}

export function ResourceLabel({ resource, amount, size = 18 }: { resource: Resource; amount?: number; size?: number }) {
  return (
    <span className={`res-chip res-${resource}`}>
      <ResourceIcon kind={resource} size={size} />
      {amount !== undefined && <b>{amount}</b>}
    </span>
  );
}
