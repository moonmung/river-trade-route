// 손에 든 카드. 하스스톤처럼 화면 아래에서 부채꼴로 펼쳐 들고 있는 모습으로 보여 준다.
// 자원 카드는 종류마다 한 장을 앞에 두고 뒤에 겹친 카드 두께와 숫자로 장수를 나타낸다. 발전 카드는 한 장씩 펼친다.
// 다른 사람의 손은 뒷면 카드 몇 장을 작게 펼쳐 장수만 보여 준다 (종류는 비공개).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEV_LABEL, RESOURCES, RESOURCE_LABEL } from '../../shared/constants';
import type { Bundle, DevKind, Resource } from '../../shared/types';
import { ResourceIcon } from '../ui/icons';

/** 발전 카드 그림: 기사(투구와 칼), 승점(왕관), 길 건설(갈래 길), 풍년(이삭 바구니), 독점(움켜쥔 손 대신 저울) */
export function DevIcon({ kind, size = 28 }: { kind: DevKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="dev-icon">
      <g stroke="#1d1a16" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round">
        {kind === 'knight' && (
          <>
            <path d="M6 21 L18 3" stroke="#e4e8ee" strokeWidth="2.2" />
            <path d="M14.5 6.5 L17.5 9.5" stroke="#d0a83c" strokeWidth="2.2" />
            <path d="M5 10 C5 5 9 3 12 3 C15 3 19 5 19 10 V15 H5 Z" fill="#a3aab3" />
            <path d="M7 10 H17" stroke="#1d1a16" strokeWidth="1.6" />
            <path d="M12 3 C11 1.6 13 1.2 13.4 2.4" fill="#c23a2e" />
          </>
        )}
        {kind === 'victory' && (
          <>
            <path d="M3 17 L4.5 7 L9 11 L12 4.5 L15 11 L19.5 7 L21 17 Z" fill="#e3b23c" />
            <rect x="3" y="17" width="18" height="3" rx="1" fill="#c9952a" />
            <circle cx="12" cy="13" r="1.6" fill="#c23a2e" />
          </>
        )}
        {kind === 'road_building' && (
          <>
            <path d="M4 21 C8 16 8 11 12 9 C15 7 17 5 20 3" stroke="#5e3f22" strokeWidth="4.6" fill="none" />
            <path d="M4 21 C8 16 8 11 12 9 C15 7 17 5 20 3" stroke="#e2bf8a" strokeWidth="2.4" fill="none" strokeDasharray="2.4 1.6" />
            <path d="M12 9 C15 11 18 13 21 17" stroke="#5e3f22" strokeWidth="4.6" fill="none" />
            <path d="M12 9 C15 11 18 13 21 17" stroke="#e2bf8a" strokeWidth="2.4" fill="none" strokeDasharray="2.4 1.6" />
          </>
        )}
        {kind === 'year_of_plenty' && (
          <>
            <path d="M4 12 H20 L18 20 H6 Z" fill="#b07a42" />
            <path d="M5 15 H19" stroke="#7a5532" />
            <ellipse cx="8.5" cy="9" rx="2" ry="3.4" fill="#f0c544" />
            <ellipse cx="12" cy="7.6" rx="2" ry="4" fill="#e7b52c" />
            <ellipse cx="15.5" cy="9" rx="2" ry="3.4" fill="#f0c544" />
          </>
        )}
        {kind === 'monopoly' && (
          <>
            <path d="M12 3 V20 M7 20 H17" stroke="#d0a83c" strokeWidth="1.8" />
            <path d="M4 7 H20" stroke="#d0a83c" strokeWidth="1.8" />
            <path d="M4 7 L1.8 13 H6.2 Z M20 7 L17.8 13 H22.2 Z" fill="#e3b23c" />
            <circle cx="12" cy="4" r="1.6" fill="#e3b23c" />
          </>
        )}
      </g>
    </svg>
  );
}

/** 카드 그림을 먹으로 찍은 듯 가장자리를 살짝 번지게 하는 SVG 필터 (카드 CSS 의 filter: url(#hcard-ink)) */
function InkFilter() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <filter id="hcard-ink" x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

/** 카드를 부채꼴로 펼칠 때 i 번째 카드의 기울기·높이. flat 이면 기울이지 않고 한 줄로 나란히 놓는다. */
function fan(i: number, n: number, flat = false): CSSProperties {
  if (flat) return { zIndex: i + 1 };
  const d = i - (n - 1) / 2;
  const spread = Math.min(7, 44 / Math.max(1, n));
  // 양 끝 카드가 조금 내려가 부채꼴이 되지만, 카드가 많아도 가장 끝이 10px 넘게 내려가지 않는다.
  const edge = Math.max(1, (n - 1) / 2);
  const drop = Math.min(10, edge * edge * 1.3);
  return {
    ['--rot' as string]: `${(d * spread).toFixed(2)}deg`,
    ['--lift' as string]: `${((d / edge) * (d / edge) * drop).toFixed(1)}px`,
    zIndex: i + 1,
  } as CSSProperties;
}

export interface HandProps {
  resources: Bundle;
  /** 자원별 교환 비율 (교역로에 닿으면 3·2) */
  ratios?: Record<Resource, number>;
  devCards: { kind: DevKind; fresh: boolean }[];
  /** 지금 쓸 수 있는 발전 카드인지 */
  devPlayable?: (kind: DevKind) => boolean;
  onResource?: (r: Resource) => void;
  onDev?: (kind: DevKind) => void;
  /** 부채꼴 대신 일자로 나란히 (장면 테스트 미리보기) */
  flat?: boolean;
}

/** 내 손: 자원 카드(종류별 묶음)와 발전 카드를 아래에서 부채꼴로 들고 있다. 새로 받은 카드는 위에서 내려와 빛난다. */
export function Hand({ resources, ratios, devCards, devPlayable, onResource, onDev, flat = false }: HandProps) {
  const prev = useRef<Bundle>(resources);
  const [flash, setFlash] = useState<Partial<Record<Resource, 'gain' | 'spend'>>>({});
  // 장수가 실제로 바뀔 때만 연출한다 (화면 정보가 새로 와도 장수가 같으면 그대로 둔다).
  const counts = RESOURCES.map((r) => resources[r]).join(',');
  useEffect(() => {
    const next: Partial<Record<Resource, 'gain' | 'spend'>> = {};
    for (const r of RESOURCES) {
      if (resources[r] > prev.current[r]) next[r] = 'gain';
      else if (resources[r] < prev.current[r]) next[r] = 'spend';
    }
    prev.current = resources;
    if (!Object.keys(next).length) return;
    setFlash(next);
    const t = window.setTimeout(() => setFlash({}), 950);
    return () => window.clearTimeout(t);
  }, [counts]);

  const res = RESOURCES.filter((r) => resources[r] > 0);
  const n = res.length + devCards.length;
  const total = RESOURCES.reduce((a, r) => a + resources[r], 0);
  // 카드가 많거나 자리가 좁으면 더 겹쳐 쥐어 손이 칸 밖으로 넘치지 않게 한다.
  const handRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const cw = handRef.current ? parseFloat(getComputedStyle(handRef.current).getPropertyValue('--cw')) || 52 : 52;
  // 일자 배치는 카드 사이를 조금 띄우고, 자리가 모자랄 때만 겹친다.
  const room = n > 1 && width ? Math.floor((width - 28 - n * cw) / (n - 1)) : 0;
  const ov = n > 1 && width ? Math.max(-(cw - 16), Math.min(flat ? 6 : -6, room)) : flat ? 6 : -6;
  return (
    <div ref={handRef} className={`hand ${flat ? 'hand-flat' : ''}`} style={{ ['--ov' as string]: `${ov}px` } as CSSProperties} aria-label={`내 손: 자원 ${total}장, 발전 카드 ${devCards.length}장`}>
      <InkFilter />
      {n === 0 && <div className="hand-empty">손에 든 카드가 없습니다</div>}
      {res.map((r, i) => {
        const count = resources[r];
        return (
          <button
            key={r}
            type="button"
            className={`hcard hcard-res hcard-${r} ${flash[r] ? `hcard-${flash[r]}` : ''}`}
            style={fan(i, n, flat)}
            data-depth={Math.min(2, count - 1)}
            onClick={() => onResource?.(r)}
            title={`${RESOURCE_LABEL[r]} ${count}장${ratios && ratios[r] < 4 ? ` · 교역로 ${ratios[r]}:1` : ''}`}
          >
            <span className="hcard-face">
              <span className="hcard-art">
                <ResourceIcon kind={r} size={28} />
              </span>
              <span className="hcard-name">{RESOURCE_LABEL[r]}</span>
            </span>
            <b className="hcard-count">{count}</b>
            {ratios && ratios[r] < 4 && <em className="hcard-ratio">{ratios[r]}:1</em>}
          </button>
        );
      })}
      {devCards.map((c, j) => {
        const i = res.length + j;
        const playable = !c.fresh && !!devPlayable?.(c.kind);
        return (
          <button
            key={`${c.kind}-${j}`}
            type="button"
            className={`hcard hcard-dev ${c.fresh ? 'hcard-fresh' : ''} ${playable ? 'hcard-playable' : ''}`}
            style={fan(i, n, flat)}
            onClick={() => onDev?.(c.kind)}
            title={`${DEV_LABEL[c.kind]}${c.fresh ? ' · 이번 턴에 산 카드라 다음 턴부터 쓸 수 있습니다' : playable ? ' · 지금 쓸 수 있습니다' : ''}`}
          >
            <span className="hcard-face">
              <span className="hcard-art">
                <DevIcon kind={c.kind} size={28} />
              </span>
              <span className="hcard-name">{DEV_LABEL[c.kind]}</span>
            </span>
            {c.fresh && <em className="hcard-new">새 카드</em>}
          </button>
        );
      })}
    </div>
  );
}

/** 다른 사람의 손: 뒷면 카드를 작게 펼쳐 장수만 보여 준다. */
export function MiniHand({ count, kind, title }: { count: number; kind: 'res' | 'dev'; title: string }) {
  const shown = Math.min(count, 5);
  return (
    <span className={`mini-hand mini-${kind} ${count === 0 ? 'mini-empty' : ''}`} title={title} aria-label={title}>
      <span className="mini-fan" aria-hidden>
        {Array.from({ length: Math.max(1, shown) }, (_, i) => (
          <i key={i} style={{ ['--r' as string]: `${((i - (shown - 1) / 2) * 11).toFixed(1)}deg` } as CSSProperties} />
        ))}
      </span>
      <b>{count}</b>
    </span>
  );
}
