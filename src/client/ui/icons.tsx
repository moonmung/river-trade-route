import type { Resource, TileKind } from '../../shared/types';
import { playerColor } from '../theme';
import { ArtImg, GOLD_ART, RESOURCE_ART } from './art';

interface IconProps {
  size?: number;
  title?: string;
  className?: string;
}

/** 자원 아이콘: 사용자가 준 수채화 그림(통나무·볏단·양·벽돌 더미·돌덩이). 광장은 기사단 동상, 금광은 금덩이 선화로 그린다. */
export function ResourceIcon({ kind, size = 20, title, className }: IconProps & { kind: TileKind }) {
  if (kind === 'gold') return <ArtImg src={GOLD_ART} size={size} title={title} className={`res-art${className ? ` ${className}` : ''}`} />;
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

/** 플레이어 아이콘: 사람 모양(머리와 어깨)을 그 사람 색으로 칠하고 먹선을 두른다. 이름 앞, 증서, 대화, 대기실 자리 등 사람을 가리키는 곳마다 쓴다. */
export function PersonIcon({ colorIndex, size = 22, title }: { colorIndex: number; size?: number; title?: string }) {
  const color = playerColor(colorIndex);
  const common = { fill: color.hex, stroke: '#1d1a16', strokeWidth: 1.5, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title} aria-hidden={title ? undefined : true} className="emblem person-icon">
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="7.4" r="4.5" {...common} />
      <path d="M3.4 21.4c0-5.1 3.9-8.4 8.6-8.4s8.6 3.3 8.6 8.4z" {...common} />
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
