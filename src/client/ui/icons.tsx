import type { Resource, TileKind } from '../../shared/types';
import { EMBLEMS, playerColor } from '../theme';

interface IconProps {
  size?: number;
  title?: string;
  className?: string;
}

/** 자원 아이콘. 색뿐 아니라 모양(통나무·이삭·양·벽돌·돌)으로도 구분된다. */
export function ResourceIcon({ kind, size = 20, title, className }: IconProps & { kind: TileKind }) {
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
      {kind === 'wood' && <WoodGlyph />}
      {kind === 'grain' && <GrainGlyph />}
      {kind === 'wool' && <WoolGlyph />}
      {kind === 'brick' && <BrickGlyph />}
      {kind === 'stone' && <StoneGlyph />}
      {kind === 'plaza' && <PlazaGlyph />}
    </svg>
  );
}

function WoodGlyph() {
  return (
    <g>
      <rect x="3" y="12" width="17" height="7" rx="3.5" fill="#9a6532" stroke="#4a2c12" strokeWidth="1.2" />
      <rect x="5" y="5" width="15" height="7" rx="3.5" fill="#b07a42" stroke="#4a2c12" strokeWidth="1.2" />
      <circle cx="6.5" cy="15.5" r="3" fill="#e2b98a" stroke="#4a2c12" strokeWidth="1.1" />
      <circle cx="6.5" cy="15.5" r="1.2" fill="none" stroke="#9a6532" strokeWidth="0.9" />
      <circle cx="8.5" cy="8.5" r="3" fill="#ecc89c" stroke="#4a2c12" strokeWidth="1.1" />
      <circle cx="8.5" cy="8.5" r="1.2" fill="none" stroke="#a8743c" strokeWidth="0.9" />
    </g>
  );
}

function GrainGlyph() {
  return (
    <g>
      <path d="M12 22 C12 16 12 10 12 4" stroke="#7a5a12" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <ellipse cx="9.2" cy={7 + i * 3.3} rx="2.1" ry="1.3" transform={`rotate(-35 9.2 ${7 + i * 3.3})`} fill="#e7b52c" stroke="#7a5a12" strokeWidth="0.9" />
          <ellipse cx="14.8" cy={7 + i * 3.3} rx="2.1" ry="1.3" transform={`rotate(35 14.8 ${7 + i * 3.3})`} fill="#f0c544" stroke="#7a5a12" strokeWidth="0.9" />
        </g>
      ))}
      <ellipse cx="12" cy="4.2" rx="1.3" ry="2" fill="#f0c544" stroke="#7a5a12" strokeWidth="0.9" />
    </g>
  );
}

function StoneGlyph() {
  return (
    <g>
      <path d="M3 18 L6 9 L12 5 L19 8 L21 16 L15 20 L7 20 Z" fill="#8e98a5" stroke="#343b44" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 9 L12 5 L13 11 L7.5 13 Z" fill="#b8c1cc" />
      <path d="M13 11 L19 8 L21 16 L15 14 Z" fill="#a3adb9" />
      <path d="M7.5 13 L13 11 L15 14 L15 20 L7 20 Z" fill="#79838f" />
    </g>
  );
}

function WoolGlyph() {
  return (
    <g>
      <path d="M8.5 17.5 V21 M11.5 18.2 V21.6 M15.5 18.2 V21.6 M18.5 17.5 V21" stroke="#3b3029" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M7.4 12.4 C6.4 9.4 9.2 7.4 11.2 8.4 C12.2 6.4 15.6 6.4 16.6 8.4 C18.8 7.6 21.4 9.6 20.5 12.2 C22 13.6 21 17 18.8 17.2 C17.8 19 14.8 19.2 13.6 17.8 C12.2 19.2 9.2 19 8.4 17.2 C6.2 17 5.6 13.9 7.4 12.4 Z"
        fill="#f3ecda"
        stroke="#4a3b2c"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <ellipse cx="5.4" cy="11.6" rx="2.6" ry="3.2" transform="rotate(-22 5.4 11.6)" fill="#3b3029" />
      <ellipse cx="4.2" cy="9.2" rx="1.5" ry="0.8" transform="rotate(-35 4.2 9.2)" fill="#3b3029" />
      <circle cx="4.7" cy="11.1" r="0.5" fill="#f3ecda" />
    </g>
  );
}

function BrickGlyph() {
  const brick = (x: number, y: number, fill: string) => (
    <rect key={`${x}-${y}`} x={x} y={y} width="7" height="4.2" rx="0.6" fill={fill} stroke="#5a2414" strokeWidth="1.1" />
  );
  return (
    <g>
      {brick(1.5, 16.3, '#b4553a')}
      {brick(8.5, 16.3, '#c4643f')}
      {brick(15.5, 16.3, '#a94d33')}
      {brick(5, 12.1, '#c96a45')}
      {brick(12, 12.1, '#b4553a')}
      {brick(8.5, 7.9, '#d07650')}
      <path d="M3 17.4 H7 M10 17.4 H14 M17 17.4 H21 M6.5 13.2 H10.5 M13.5 13.2 H17.5 M10 9 H14" stroke="#f0b08a" strokeWidth="0.7" strokeLinecap="round" />
    </g>
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
