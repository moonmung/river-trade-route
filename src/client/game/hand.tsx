// 손에 든 카드. 화면 아래 띠에 한 줄로 가지런히 든다.
// 자원 카드와 발전 카드는 종류마다 한 장을 앞에 두고 뒤에 겹친 카드 두께와 숫자로 장수를 나타낸다.
// 다른 사람의 손은 뒷면 카드 몇 장을 작게 펼쳐 장수만 보여 준다 (종류는 비공개).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEV_LABEL, RESOURCES, RESOURCE_LABEL } from '../../shared/constants';
import type { Bundle, DevKind, Resource } from '../../shared/types';
import { ArtImg, DEV_ART } from '../ui/art';
import { ResourceIcon } from '../ui/icons';

/** 발전 카드 그림: 기사(투구와 칼), 승점(왕관), 길 건설(엇갈린 판자), 풍년(곡식 바구니), 독점(저울) */
export function DevIcon({ kind, size = 28 }: { kind: DevKind; size?: number }) {
  return <ArtImg src={DEV_ART[kind]} size={size} className="dev-art" />;
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

export interface HandProps {
  resources: Bundle;
  /** 자원별 교환 비율 (교역로에 닿으면 3·2) */
  ratios?: Record<Resource, number>;
  devCards: { kind: DevKind; fresh: boolean }[];
  /** 지금 쓸 수 있는 발전 카드인지 */
  devPlayable?: (kind: DevKind) => boolean;
  onResource?: (r: Resource) => void;
  onDev?: (kind: DevKind) => void;
  /** 쓰기 창을 열어 둔 발전 카드 */
  activeDev?: DevKind | null;
  /** 장면 테스트 미리보기용 (예전 부채꼴 배치 이름을 그대로 받는다. 지금은 늘 한 줄로 놓는다) */
  flat?: boolean;
}

const DEV_ORDER: DevKind[] = ['knight', 'road_building', 'year_of_plenty', 'monopoly', 'victory'];

/**
 * 내 손: 자원 카드(종류별 한 묶음)와 발전 카드(종류별 한 묶음)를 화면 아래에 한 줄로 가지런히 든다.
 * 묶음 장수는 카드 오른쪽 위 숫자와 뒤에 겹친 종이 두께로 보여 준다. 새로 받은 카드는 위에서 내려와 빛난다.
 */
export function Hand({ resources, ratios, devCards, devPlayable, onResource, onDev, activeDev = null }: HandProps) {
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
  const devs = DEV_ORDER.map((kind) => {
    const mine = devCards.filter((c) => c.kind === kind);
    return { kind, count: mine.length, fresh: mine.filter((c) => c.fresh).length };
  }).filter((d) => d.count > 0);
  const n = res.length + devs.length;
  const total = RESOURCES.reduce((a, r) => a + resources[r], 0);
  // 자리가 모자라면 카드를 조금씩 겹쳐 손이 칸 밖으로 넘치지 않게 한다.
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
  const cw = handRef.current ? parseFloat(getComputedStyle(handRef.current).getPropertyValue('--cw')) || 60 : 60;
  const groupGap = res.length && devs.length ? 14 : 0;
  const room = n > 1 && width ? Math.floor((width - 16 - groupGap - n * cw) / (n - 1)) : 6;
  const ov = Math.max(-(cw - 18), Math.min(6, room));
  return (
    <div
      ref={handRef}
      className="hand"
      data-fly="hand"
      style={{ ['--ov' as string]: `${ov}px` } as CSSProperties}
      aria-label={`내 손: 자원 ${total}장, 발전 카드 ${devCards.length}장`}
    >
      <InkFilter />
      {n === 0 && <div className="hand-empty">손에 든 카드가 없습니다</div>}
      {res.map((r, i) => {
        const count = resources[r];
        return (
          <button
            key={r}
            type="button"
            className={`hcard hcard-res hcard-${r} ${flash[r] ? `hcard-${flash[r]}` : ''}`}
            data-fly={`res-${r}`}
            style={{ zIndex: i + 1 }}
            data-depth={Math.min(2, count - 1)}
            onClick={() => onResource?.(r)}
            title={`${RESOURCE_LABEL[r]} ${count}장${ratios && ratios[r] < 4 ? ` · 교역로 ${ratios[r]}:1` : ''} · 눌러서 교환에 넣기`}
          >
            <span className="hcard-face">
              <span className="hcard-art">
                <ResourceIcon kind={r} size={30} />
              </span>
              <span className="hcard-name">{RESOURCE_LABEL[r]}</span>
            </span>
            <b className="hcard-count">{count}</b>
            {ratios && ratios[r] < 4 && <em className="hcard-ratio">{ratios[r]}:1</em>}
          </button>
        );
      })}
      {devs.map((d, j) => {
        const playable = d.count > d.fresh && !!devPlayable?.(d.kind);
        const allFresh = d.fresh === d.count;
        return (
          <button
            key={d.kind}
            type="button"
            className={`hcard hcard-dev ${j === 0 && res.length ? 'hcard-group' : ''} ${allFresh ? 'hcard-fresh' : ''} ${playable ? 'hcard-playable' : ''} ${activeDev === d.kind ? 'hcard-active' : ''}`}
            style={{ zIndex: res.length + j + 1 }}
            data-depth={Math.min(2, d.count - 1)}
            aria-pressed={activeDev === d.kind}
            onClick={() => onDev?.(d.kind)}
            title={`${DEV_LABEL[d.kind]} ${d.count}장${allFresh ? ' · 이번 턴에 산 카드라 다음 턴부터 쓸 수 있습니다' : playable ? ' · 눌러서 쓰기' : ''}`}
          >
            <span className="hcard-face">
              <span className="hcard-art">
                <DevIcon kind={d.kind} size={30} />
              </span>
              <span className="hcard-name">{DEV_LABEL[d.kind]}</span>
            </span>
            {d.count > 1 && <b className="hcard-count">{d.count}</b>}
            {d.fresh > 0 && <em className="hcard-new">새 카드</em>}
          </button>
        );
      })}
    </div>
  );
}

/** 다른 사람의 손: 뒷면 카드를 작게 펼쳐 장수만 보여 준다. */
export function MiniHand({ count, kind, title, fly }: { count: number; kind: 'res' | 'dev'; title: string; fly?: string }) {
  const shown = Math.min(count, 5);
  return (
    <span className={`mini-hand mini-${kind} ${count === 0 ? 'mini-empty' : ''}`} title={title} aria-label={title} data-fly={fly}>
      <span className="mini-fan" aria-hidden>
        {Array.from({ length: Math.max(1, shown) }, (_, i) => (
          <i key={i} style={{ ['--r' as string]: `${((i - (shown - 1) / 2) * 11).toFixed(1)}deg` } as CSSProperties} />
        ))}
      </span>
      <b>{count}</b>
    </span>
  );
}
