// 교환 창과 교환 증서.
// 교환 창은 손에 든 카드 바로 위에 붙어 열리고 위 줄 "받을 것"과 손 쪽 아래 줄 "낼 것"에서 카드를 눌러 고른다.
// 은행·교역로 탭은 내 비율(4:1, 교역로 3:1·2:1)만큼 한 묶음씩 고르고 플레이어 탭은 한 장씩 골라 모두에게(또는 한 사람에게) 제안한다.
// 열린 제안은 화면 왼쪽 위에 중세 거래 증서처럼 쌓이고 모두에게 보인다 (차례인 사람이 동시에 3개까지).
// 교환 창과 증서 모두 보는 사람 기준으로 내 쪽(내가 줄 것)을 아래, 상대 쪽(내가 받을 것)을 위에 둔다.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { boardOf, harborVertices } from '../../shared/board';
import { BANK_RATIO, MAX_OPEN_TRADES, MAX_TRADE_AMOUNT, RESOURCES, RESOURCE_LABEL, bundleTotal, emptyBundle } from '../../shared/constants';
import type { RoomView, TradeView } from '../../shared/protocol';
import { bankTradeProblem, bankUnits, validateTradeBundles } from '../../shared/rules';
import type { Bundle, Resource, TradeCloseReason } from '../../shared/types';
import { playerColor } from '../theme';
import { AnyResourceIcon, Emblem, ResourceIcon } from '../ui/icons';
import { josa } from '../ui/josa';
import { showToast } from '../ui/toast';
import { bundleText, isMyTurn, tradeBlocker, turnBlocker, type PlayerInfo } from './derive';
import { ActionButton, ResourceAmount, sendAction } from './ui';

type Players = Map<string, PlayerInfo>;

export type TradeMode = 'bank' | 'player';

/** 교환 창에서 고르는 중인 카드 */
export interface TradeDraft {
  mode: TradeMode;
  give: Bundle;
  get: Bundle;
  /** 플레이어 거래에서 한 사람에게만 제안할 때 그 사람 (없으면 모두에게) */
  to?: string;
}

/** 은행 교환이 되는 자원이 하나라도 있으면 은행 탭으로, 아니면 플레이어 탭으로 연다. */
export function newDraft(view: RoomView, mode?: TradeMode): TradeDraft {
  const g = view.game!;
  const bankable = RESOURCES.some((r) => g.myResources[r] >= g.myTradeRatios[r]);
  return { mode: mode ?? (bankable ? 'bank' : 'player'), give: emptyBundle(), get: emptyBundle() };
}

/** 낼 것에 한 번 더 (은행은 내 비율만큼 한 묶음, 플레이어는 한 장). 더 낼 수 없으면 그대로. */
export function draftAddGive(d: TradeDraft, r: Resource, view: RoomView): TradeDraft {
  const g = view.game!;
  const step = d.mode === 'bank' ? g.myTradeRatios[r] : 1;
  const cap = d.mode === 'bank' ? g.myResources[r] : Math.min(g.myResources[r], MAX_TRADE_AMOUNT);
  if (d.give[r] + step > cap) return d;
  return { ...d, give: { ...d.give, [r]: d.give[r] + step }, get: { ...d.get, [r]: 0 } };
}

export function draftRemoveGive(d: TradeDraft, r: Resource, view: RoomView): TradeDraft {
  const step = d.mode === 'bank' ? view.game!.myTradeRatios[r] : 1;
  return { ...d, give: { ...d.give, [r]: Math.max(0, d.give[r] - step) } };
}

/** 받을 것에 한 장. 은행은 낸 묶음 수만큼만 받으므로, 다 찼으면 다른 자원 한 장을 이 자원으로 바꾼다. */
export function draftAddGet(d: TradeDraft, r: Resource, view: RoomView): TradeDraft {
  const g = view.game!;
  if (d.give[r] > 0) return d;
  const get = { ...d.get };
  const total = bundleTotal(get);
  if (d.mode === 'bank') {
    const units = bankUnits(d.give, g.myTradeRatios) ?? 0;
    if (units >= 1 && total >= units) {
      const other = RESOURCES.find((x) => x !== r && get[x] > 0);
      if (!other) return d;
      get[other] -= 1;
    } else if (total >= MAX_TRADE_AMOUNT) return d;
  } else if (get[r] >= MAX_TRADE_AMOUNT) return d;
  get[r] += 1;
  return { ...d, get };
}

export function draftRemoveGet(d: TradeDraft, r: Resource): TradeDraft {
  return { ...d, get: { ...d.get, [r]: Math.max(0, d.get[r] - 1) } };
}

/** 교환 버튼에 붙는 표시: 은행과 바로 바꿀 수 있는 자원이 있는지 */
export function canBankNow(view: RoomView): boolean {
  const g = view.game;
  return !!g && !turnBlocker(view) && RESOURCES.some((r) => g.myResources[r] >= g.myTradeRatios[r]);
}

interface SlotSpec {
  r: Resource;
  count: number;
  /** 카드 아래 작은 글씨 */
  sub: ReactNode;
  /** 비율 도장 (은행 탭의 낼 것) */
  badge?: string;
  /** 고를 수 없는 이유 */
  off: string | null;
  onAdd: () => void;
  onRemove: () => void;
}

/** 낼 것·받을 것 한 줄: 자원 다섯 장. 누르면 하나 더, 왼쪽 위 − 로 하나 빼기 */
function CardRow({ label, hint, side, slots }: { label: string; hint?: ReactNode; side: 'give' | 'get'; slots: SlotSpec[] }) {
  return (
    <section className={`trade-side trade-side-${side}`} aria-label={label}>
      <div className="trade-side-label">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div className="tcards">
        {slots.map((s) => (
          <div key={s.r} className={`tslot ${s.count ? 'tslot-on' : ''}`}>
            <button
              type="button"
              className={`hcard tcard hcard-${s.r} ${s.off ? 'tcard-off' : ''} ${s.count ? 'tcard-picked' : ''}`}
              aria-disabled={!!s.off}
              aria-label={`${label}: ${RESOURCE_LABEL[s.r]}${s.count ? ` ${s.count}장 고름` : ''}${s.off ? ` (${s.off})` : ''}`}
              title={s.off ?? undefined}
              onClick={() => (s.off ? showToast(s.off, 'warn') : s.onAdd())}
            >
              <span className="hcard-face">
                <span className="hcard-art">
                  <ResourceIcon kind={s.r} size={24} />
                </span>
                <span className="hcard-name">{RESOURCE_LABEL[s.r]}</span>
              </span>
              {s.count > 0 && <b className="hcard-count">{s.count}</b>}
              {s.badge && <em className="hcard-ratio">{s.badge}</em>}
            </button>
            {s.count > 0 && (
              <button type="button" className="tslot-minus" onClick={s.onRemove} aria-label={`${label}에서 ${RESOURCE_LABEL[s.r]} 빼기`}>
                −
              </button>
            )}
            <span className="tslot-sub">{s.sub}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 교환 창. 손에 든 카드 위에 붙어 열린다.
 * 위 줄은 받을 카드, 손에 든 카드와 맞닿은 아래 줄은 내가 낼 카드(내 손에서 고른다). 고른 내용으로 은행과 바로 바꾸거나 모두에게 제안한다.
 */
export function TradePanel({
  view,
  players,
  draft,
  onDraft,
  onClose,
}: {
  view: RoomView;
  players: Players;
  draft: TradeDraft;
  onDraft: (d: TradeDraft) => void;
  onClose: () => void;
}) {
  const g = view.game!;
  const mine = g.myResources;
  const ratio = g.myTradeRatios;
  const bank = draft.mode === 'bank';
  const myOffers = g.trades.filter((t) => t.from === view.you).length;
  const others = g.order.filter((id) => id !== view.you);
  const myHarbors = g.harbors.filter((h) => harborVertices(boardOf(g), h).some((v) => g.buildings.some((b) => b.vertexId === v && b.owner === view.you)));

  const giveSlots: SlotSpec[] = RESOURCES.map((r) => {
    const left = mine[r] - draft.give[r];
    const off = bank
      ? left < ratio[r]
        ? mine[r] < ratio[r]
          ? `${RESOURCE_LABEL[r]}이(가) ${ratio[r]}장 있어야 은행에 낼 수 있습니다 (지금 ${mine[r]}장).`
          : `남은 ${RESOURCE_LABEL[r]}이(가) ${ratio[r]}장보다 적습니다.`
        : null
      : mine[r] === 0
        ? `${RESOURCE_LABEL[r]}이(가) 없습니다.`
        : left <= 0 || draft.give[r] >= MAX_TRADE_AMOUNT
          ? `${RESOURCE_LABEL[r]}을(를) 더 낼 수 없습니다.`
          : null;
    return {
      r,
      count: draft.give[r],
      sub: <>보유 {mine[r]}</>,
      badge: bank ? `${ratio[r]}:1` : undefined,
      off,
      onAdd: () => onDraft(draftAddGive(draft, r, view)),
      onRemove: () => onDraft(draftRemoveGive(draft, r, view)),
    };
  });
  const getSlots: SlotSpec[] = RESOURCES.map((r) => ({
    r,
    count: draft.get[r],
    sub: draft.give[r] > 0 ? '내는 중' : '',
    off: draft.give[r] > 0 ? '낼 자원과 같은 자원은 받을 수 없습니다.' : null,
    onAdd: () => onDraft(draftAddGet(draft, r, view)),
    onRemove: () => onDraft(draftRemoveGet(draft, r)),
  }));

  const turn = turnBlocker(view);
  const name = (id: string) => players.get(id)?.nickname ?? '?';
  const bankProblem = bankTradeProblem(draft.give, draft.get, ratio, mine);
  const playerProblem =
    tradeBlocker(view) ??
    (myOffers >= MAX_OPEN_TRADES ? `제안은 동시에 ${MAX_OPEN_TRADES}개까지 열 수 있습니다. 증서 하나를 취소하세요.` : null) ??
    validateTradeBundles(draft.give, draft.get);
  const units = bankUnits(draft.give, ratio) ?? 0;

  const submit = bank ? (
    <ActionButton
      className="btn btn-primary btn-wide trade-go"
      label={bankProblem ? '은행과 교환' : `은행과 교환 · ${bundleText(draft.give)} → ${bundleText(draft.get)}`}
      blocker={turn ?? bankProblem}
      onClick={async () => {
        if (await sendAction({ type: 'bank_trade', give: draft.give, get: draft.get })) {
          showToast(`교환했습니다 · ${bundleText(draft.get)} 받음`, 'good');
          onDraft({ ...draft, give: emptyBundle(), get: emptyBundle() });
        }
      }}
    />
  ) : (
    <ActionButton
      className="btn btn-primary btn-wide trade-go"
      label={`${draft.to ? `${name(draft.to)}에게` : others.length === 1 ? `${name(others[0])}에게` : '모두에게'} 제안 (${myOffers}/${MAX_OPEN_TRADES})`}
      blocker={playerProblem}
      onClick={async () => {
        const to = draft.to && others.includes(draft.to) ? draft.to : undefined;
        if (await sendAction({ type: 'trade_propose', ...(to ? { to } : {}), give: draft.give, get: draft.get })) onClose();
      }}
    />
  );

  return (
    <div className="trade-panel" role="dialog" aria-label="교환">
      <div className="trade-head">
        <div className="tabs trade-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={bank}
            className={`tab ${bank ? 'tab-on' : ''}`}
            onClick={() => onDraft({ mode: 'bank', give: emptyBundle(), get: emptyBundle() })}
          >
            은행·교역로
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!bank}
            className={`tab ${!bank ? 'tab-on' : ''}`}
            onClick={() => onDraft({ mode: 'player', give: draft.mode === 'player' ? draft.give : emptyBundle(), get: draft.mode === 'player' ? draft.get : emptyBundle() })}
          >
            플레이어와 거래
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="교환 창 닫기">
          ✕
        </button>
      </div>

      <CardRow
        label="받을 것"
        side="get"
        hint={bank ? (units > 0 ? `${units}장 고를 수 있음` : '낼 묶음 수만큼') : '원하는 카드를 고르세요'}
        slots={getSlots}
      />
      <div className="trade-arrow" aria-hidden>
        <span>⇅</span>
      </div>
      <CardRow label="낼 것" side="give" hint={bank ? '비율만큼 한 묶음씩' : '내 카드에서 고르세요'} slots={giveSlots} />

      <p className="trade-note small">
        {bank ? (
          <>
            교역로가 없어도 같은 자원 {BANK_RATIO}장이면 은행에서 1장으로 바꿉니다.{' '}
            {myHarbors.length > 0 ? (
              <>
                내 교역로:{' '}
                {myHarbors.map((h) => (
                  <span key={h.edgeId} className="cost-inline">
                    {h.resource ? <ResourceIcon kind={h.resource} size={14} /> : <AnyResourceIcon size={14} />}
                    {h.resource ? '2:1' : '3:1'}
                  </span>
                ))}
              </>
            ) : (
              '마을이 교역로에 닿으면 3:1·2:1이 됩니다.'
            )}
          </>
        ) : others.length === 1 ? (
          <>
            일대일 대결입니다. {josa(name(others[0]), '이/가')} 수락하면 확정할 때 카드가 옮겨집니다. 증서는 {MAX_OPEN_TRADES}장까지 함께 열 수 있습니다.
          </>
        ) : (
          <>
            <span className="trade-to" role="group" aria-label="제안할 상대">
              {[undefined, ...others].map((id) => (
                <button
                  key={id ?? 'all'}
                  type="button"
                  className={`chip ${draft.to === id ? 'chip-on' : ''}`}
                  aria-pressed={draft.to === id}
                  onClick={() => onDraft({ ...draft, to: id })}
                >
                  {id ? (
                    <>
                      <Emblem colorIndex={players.get(id)?.colorIndex ?? 0} size={12} /> {name(id)}
                    </>
                  ) : (
                    '모두'
                  )}
                </button>
              ))}
            </span>
            수락한 사람 중 한 명을 골라 확정하면 그때 카드가 옮겨집니다. 증서는 {MAX_OPEN_TRADES}장까지 함께 열 수 있습니다.
          </>
        )}
      </p>
      {submit}
    </div>
  );
}

/** 작은 자원 묶음 (아이콘 + 수) */
function BundleChips({ bundle }: { bundle: Bundle }) {
  const items = RESOURCES.filter((r) => bundle[r] > 0);
  return (
    <span className="bundle-chips">
      {items.map((r) => (
        <ResourceAmount key={r} resource={r} amount={bundle[r]} size={16} />
      ))}
    </span>
  );
}

/** 증서가 닫힌 까닭: 성사(체결), 또는 엔진이 닫은 이유 */
export type DeedOutcome = 'accepted' | TradeCloseReason;

export interface ClosedDeed {
  trade: TradeView;
  outcome: DeedOutcome;
  /** 성사된 상대 */
  partner?: string;
  /** 닫힌 기록 번호 (React key) */
  seq: number;
}

/** 닫힌 증서가 결과 글씨를 단 채 화면에 남아 있는 시간 (CSS 의 deed-out 과 같다) */
export const STAMP_MS = 2800;

/**
 * 막 닫힌 교환 제안. 열린 제안 목록에서 빠진 제안을 기록(trade_closed·trade_accepted)과 맞춰 결과 글씨를 단 채 잠깐 남긴다.
 * 처음 받은 화면(새로고침)에서는 지난 기록을 다시 보여 주지 않는다.
 */
export function useClosedDeeds(view: RoomView): ClosedDeed[] {
  const g = view.game;
  const known = useRef<Map<number, TradeView>>(new Map());
  const lastSeq = useRef<number | null>(null);
  const lastGame = useRef(view.gameNumber);
  const [closed, setClosed] = useState<ClosedDeed[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    if (!g) return;
    const maxSeq = g.events.length ? g.events[g.events.length - 1].seq : 0;
    if (lastSeq.current !== null && lastGame.current === view.gameNumber) {
      const fresh = g.events.filter((e) => e.seq > lastSeq.current!);
      const add: ClosedDeed[] = [];
      for (const e of fresh) {
        if (e.kind !== 'trade_closed' && e.kind !== 'trade_accepted') continue;
        let t = known.current.get(e.tradeId);
        if (!t) {
          // 열리자마자 닫힌 제안(같은 화면 정보 안에서): 제안 기록에서 내용을 찾는다.
          const p = g.events.find((x) => x.kind === 'trade_proposed' && x.tradeId === e.tradeId);
          if (p?.kind !== 'trade_proposed') continue;
          t = { id: p.tradeId, from: p.from, to: [...p.to], give: p.give, get: p.get, responses: Object.fromEntries(p.to.map((id) => [id, 'pending' as const])) };
        }
        const responses = { ...t.responses };
        for (const r of fresh) if (r.kind === 'trade_response' && r.tradeId === e.tradeId && r.seq < e.seq) responses[r.player] = r.response;
        add.push({ trade: { ...t, responses }, outcome: e.kind === 'trade_accepted' ? 'accepted' : e.reason, partner: e.kind === 'trade_accepted' ? e.to : undefined, seq: e.seq });
      }
      if (add.length) {
        setClosed((cur) => [...cur, ...add]);
        const done = new Set(add.map((d) => d.seq));
        timers.current.push(window.setTimeout(() => setClosed((cur) => cur.filter((d) => !done.has(d.seq))), STAMP_MS));
      }
    } else setClosed([]);
    lastSeq.current = maxSeq;
    lastGame.current = view.gameNumber;
    known.current = new Map(g.trades.map((t) => [t.id, t]));
  }, [g?.version, view.gameNumber]);
  return closed;
}

/** 닫힌 증서 가운데에 적는 결과 글씨 */
const STAMP_TEXT: Record<DeedOutcome, string> = {
  accepted: '체결',
  rejected: '거절됨',
  cancelled: '취소됨',
  turn_end: '기한 만료',
  unaffordable: '무효',
};

/** 장부 한 줄: 왼쪽에 제목, 오른쪽에 자원 그림 카드 (장수는 밀랍) */
function LedgerColumn({ title, bundle, side }: { title: string; bundle: Bundle; side: 'theirs' | 'mine' }) {
  const items = RESOURCES.filter((r) => bundle[r] > 0);
  return (
    <div className={`deed-col deed-col-${side}`}>
      <h4>{title}</h4>
      <div className="deed-cards">
        {items.map((r) => (
          <span key={r} className={`dcard dcard-${r}`} title={`${RESOURCE_LABEL[r]} ${bundle[r]}장`}>
            <ResourceIcon kind={r} size={34} title={RESOURCE_LABEL[r]} />
            <span className="dcard-name">{RESOURCE_LABEL[r]}</span>
            <b className="dcard-n">×{bundle[r]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

const RESP_LABEL = { pending: '생각 중', accepted: '수락', rejected: '거절' } as const;

/**
 * 교환 증서 한 장: 중세 상인의 거래 내역서처럼 번호·제안자·내놓는 것·받는 것을 장부에 적고, 아래 서명란에 상대별 응답을 적는다.
 * 장부는 위아래 두 줄로, 보는 사람 기준으로 위에는 상대에게서 받을 것, 아래에는 내가 줄 것을 적는다.
 * 받은 사람은 수락·거절(수락 뒤에도 거절로 바꿀 수 있다), 제안한 사람은 수락한 사람 옆 확정 버튼이나 취소를 누른다.
 * closed 가 있으면 결과 글씨(거절됨·취소됨·체결)를 단 채 움직이지 않고 잠깐 남았다가 옅어지며 사라진다.
 */
export function TradeDeed({
  view,
  players,
  trade,
  closed,
  compact = false,
}: {
  view: RoomView;
  players: Players;
  trade: TradeView;
  closed?: ClosedDeed;
  compact?: boolean;
}) {
  const g = view.game!;
  const t = trade;
  const me = view.you;
  const from = players.get(t.from);
  const mineOffer = t.from === me;
  const targeted = t.to.includes(me);
  const myResp = targeted ? t.responses[me] : null;
  const needsMe = !closed && targeted && myResp === 'pending';
  const [folded, setFolded] = useState(compact && !closed && !needsMe && !mineOffer);
  const name = (id: string) => (id === me ? '나' : (players.get(id)?.nickname ?? '?'));
  const lacking = targeted ? RESOURCES.filter((r) => g.myResources[r] < t.get[r]) : [];
  const accepted = t.to.filter((id) => t.responses[id] === 'accepted');
  const fromName = from?.nickname ?? '?';
  const outcome = closed?.outcome;

  // 화면 주인 기준으로 위에는 상대 쪽(받을 것), 아래에는 내 쪽(줄 것)을 적는다.
  // 받은 사람에게는 제안자가 내놓는 것(give)이 받을 것이다. 구경하는 사람은 제안한 사람 화면처럼 제안자가 내는 것을 아래에 둔다.
  const receiver = targeted && !mineOffer;
  const theirs = receiver
    ? { title: '내가 받을 것', bundle: t.give }
    : { title: mineOffer ? '내가 받을 것' : `${fromName} 받을 것`, bundle: t.get };
  const ours = receiver ? { title: '내가 줄 것', bundle: t.get } : { title: mineOffer ? '내가 줄 것' : `${fromName} 줄 것`, bundle: t.give };

  return (
    <article
      className={`deed ${needsMe ? 'deed-incoming' : ''} ${mineOffer ? 'deed-mine' : ''} ${closed ? `deed-closed deed-${outcome}` : ''} ${folded ? 'deed-folded' : ''}`}
      role={needsMe ? 'alertdialog' : 'region'}
      aria-label={`${fromName}의 교환 증서 제${t.id}호${closed ? ` (${STAMP_TEXT[closed.outcome]})` : ''}`}
      style={{ ['--pc' as string]: playerColor(from?.colorIndex ?? 0).hex } as CSSProperties}
    >
      <header className="deed-head">
        <button type="button" className="deed-title" onClick={() => setFolded((f) => !f)} aria-expanded={!folded}>
          <span className="deed-no">교역 증서 제{t.id}호</span>
          <span className="deed-from">
            <Emblem colorIndex={from?.colorIndex ?? 0} size={14} />
            {mineOffer ? '내 제안' : fromName}
            <span className="muted"> · {t.to.length > 1 ? '모두에게' : `${name(t.to[0])}에게`}</span>
          </span>
        </button>
        <span className="deed-seal" aria-hidden>
          <Emblem colorIndex={from?.colorIndex ?? 0} size={18} />
        </span>
      </header>

      {folded ? (
        <div className="deed-slip">
          <BundleChips bundle={theirs.bundle} /> <span aria-hidden>⇄</span> <BundleChips bundle={ours.bundle} />
        </div>
      ) : (
        <>
          <div className="deed-ledger">
            <LedgerColumn title={theirs.title} bundle={theirs.bundle} side="theirs" />
            <span className="deed-swap" aria-hidden>
              <span>⇅</span>
            </span>
            <LedgerColumn title={ours.title} bundle={ours.bundle} side="mine" />
          </div>

          <ol className="deed-signs" aria-label="응답">
            {t.to.map((id) => {
              const p = players.get(id);
              const resp = t.responses[id];
              const canPick = !closed && mineOffer && resp === 'accepted';
              const won = closed?.outcome === 'accepted' && closed.partner === id;
              return (
                <li key={id} className={`deed-sign sign-${resp} ${won ? 'sign-won' : ''}`}>
                  <Emblem colorIndex={p?.colorIndex ?? 0} size={13} />
                  <span className="sign-name">{name(id)}</span>
                  <i className="sign-line" aria-hidden />
                  {canPick ? (
                    <ActionButton
                      className="btn btn-small btn-primary deed-pick"
                      label="확정"
                      blocker={null}
                      onClick={() => sendAction({ type: 'trade_confirm', tradeId: t.id, with: id })}
                    />
                  ) : (
                    <span className="sign-mark">
                      {won ? '✓ 체결' : resp === 'accepted' ? '✓ 수락' : resp === 'rejected' ? RESP_LABEL.rejected : `… ${RESP_LABEL.pending}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          {!closed && mineOffer && (
            <div className="deed-actions">
              <span className="small muted">{accepted.length ? '확정할 상대를 고르세요' : '응답을 기다리는 중'}</span>
              <ActionButton className="btn btn-small" label="제안 취소" blocker={null} onClick={() => sendAction({ type: 'trade_cancel', tradeId: t.id })} />
            </div>
          )}
          {!closed && targeted && (
            <>
              {myResp !== 'accepted' && lacking.length > 0 && <div className="warn-text small">{lacking.map((r) => RESOURCE_LABEL[r]).join(', ')}이(가) 모자라 수락할 수 없습니다.</div>}
              <div className="deed-actions">
                {myResp === 'accepted' ? (
                  <>
                    <span className="small">{josa(fromName, '이/가')} 고르는 중</span>
                    <ActionButton className="btn btn-small" label="수락 취소" blocker={null} onClick={() => sendAction({ type: 'trade_reject', tradeId: t.id })} />
                  </>
                ) : (
                  <>
                    <ActionButton
                      className="btn btn-small btn-primary"
                      label={myResp === 'rejected' ? '다시 수락' : '수락'}
                      blocker={lacking.length ? '요청받은 자원이 모자랍니다.' : null}
                      onClick={() => sendAction({ type: 'trade_accept', tradeId: t.id })}
                    />
                    {myResp === 'pending' && <ActionButton className="btn btn-small" label="거절" blocker={null} onClick={() => sendAction({ type: 'trade_reject', tradeId: t.id })} />}
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}

      {closed && (
        <div className={`deed-stamp stamp-${closed.outcome}`} aria-hidden>
          <span className="stamp-word">
            {STAMP_TEXT[closed.outcome]}
            {closed.outcome === 'accepted' && closed.partner && <small>{name(closed.partner)}</small>}
          </span>
        </div>
      )}
    </article>
  );
}

/** 열린 교환 증서들과 막 닫힌 증서(결과 글씨를 단 채 잠깐 남는다). 화면 왼쪽 위에 쌓는다. */
export function TradeDeeds({ view, players, compact = false }: { view: RoomView; players: Players; compact?: boolean }) {
  const g = view.game;
  const closed = useClosedDeeds(view);
  if (!g || (!g.trades.length && !closed.length)) return null;
  const items = [
    ...g.trades.map((t) => ({ key: `open-${t.id}`, id: t.id, trade: t, closed: undefined as ClosedDeed | undefined })),
    ...closed.map((c) => ({ key: `closed-${c.seq}`, id: c.trade.id, trade: c.trade, closed: c })),
  ].sort((a, b) => a.id - b.id);
  return (
    <div className="deeds" aria-label="교환 증서">
      {items.map((it) => (
        <TradeDeed key={it.key} view={view} players={players} trade={it.trade} closed={it.closed} compact={compact} />
      ))}
    </div>
  );
}

/** 교환 버튼을 누를 수 없는 이유 (내 차례 main 단계이고 낼 카드가 있으면 된다) */
export function tradeButtonBlocker(view: RoomView): string | null {
  return turnBlocker(view) ?? (bundleTotal(view.game!.myResources) === 0 ? '낼 자원이 없습니다.' : null);
}

/** 손 카드를 눌렀을 때: 내 차례 main 단계면 교환 창을 열고 그 카드를 낼 것에 넣는다 */
export function handPickToDraft(view: RoomView, current: TradeDraft | null, r: Resource): TradeDraft | null {
  if (!isMyTurn(view) || view.game!.step !== 'main') return current;
  const g = view.game!;
  const base = current ?? newDraft(view, g.myResources[r] >= g.myTradeRatios[r] ? 'bank' : 'player');
  return draftAddGive(base, r, view);
}

