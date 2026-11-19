import type { Resource, TileKind } from '../../shared/types';
import { EMBLEMS, playerColor } from '../theme';

interface IconProps {
  size?: number;
  title?: string;
  className?: string;
}

/** 자원 아이콘. 색뿐 아니라 모양(통나무·이삭·돌)으로도 구분된다. */
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
      {kind === 'stone' && <StoneGlyph />}
      {kind === 'market' && <MarketGlyph />}
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

function MarketGlyph() {
  return (
    <g>
      <path d="M2.5 11 L12 3.5 L21.5 11 Z" fill="#c4553f" stroke="#5e2216" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8.8 6 L7.5 11 M15.2 6 L16.5 11 M12 3.5 V11" stroke="#f3e2c4" strokeWidth="1.4" />
      <rect x="5" y="11" width="14" height="9" fill="#e9d6b0" stroke="#5e2216" strokeWidth="1.2" />
      <rect x="7" y="14" width="4" height="4" fill="#9a6532" stroke="#4a2c12" strokeWidth="0.8" />
      <rect x="13" y="14" width="4" height="4" fill="#9a6532" stroke="#4a2c12" strokeWidth="0.8" />
    </g>
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
