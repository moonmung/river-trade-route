// 교환 창과 열린 교환 제안.
// 교환 창은 손에 든 카드 바로 위에 붙어 열리고 "낼 것"과 "받을 것" 두 줄에서 카드를 눌러 고른다.
// 은행·교역로 탭은 내 비율(4:1, 교역로 3:1·2:1)만큼 한 묶음씩 고르고 플레이어 탭은 한 장씩 골라 모두에게 제안한다.
// 열린 제안은 모두에게 보이며 받은 사람은 수락·거절하고 제안한 사람이 수락한 사람 중 한 명을 골라 확정한다.
import type { CSSProperties, ReactNode } from 'react';
import { harborVertices } from '../../shared/board';
import { BANK_RATIO, MAX_TRADE_AMOUNT, RESOURCES, RESOURCE_LABEL, bundleTotal, emptyBundle } from '../../shared/constants';
import type { RoomView, TradeView } from '../../shared/protocol';
import { bankTradeProblem, bankUnits, validateTradeBundles } from '../../shared/rules';
import type { Bundle, Resource } from '../../shared/types';
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
 * 위 줄은 내가 낼 카드(내 손에서 고른다), 아래 줄은 받을 카드. 고른 내용으로 은행과 바로 바꾸거나 모두에게 제안한다.
 */
export function TradePanel({
  view,
  draft,
  onDraft,
  onClose,
}: {
  view: RoomView;
  draft: TradeDraft;
  onDraft: (d: TradeDraft) => void;
  onClose: () => void;
}) {
  const g = view.game!;
  const mine = g.myResources;
  const ratio = g.myTradeRatios;
  const bank = draft.mode === 'bank';
  const myOffer = g.trade && g.trade.from === view.you ? g.trade : null;
  const myHarbors = g.harbors.filter((h) => harborVertices(h).some((v) => g.buildings.some((b) => b.vertexId === v && b.owner === view.you)));

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
  const bankProblem = bankTradeProblem(draft.give, draft.get, ratio, mine);
  const playerProblem = tradeBlocker(view) ?? validateTradeBundles(draft.give, draft.get);
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
      label={myOffer ? '제안 바꿔 다시 보내기' : '모두에게 제안'}
      blocker={playerProblem}
      onClick={async () => {
        if (myOffer && !(await sendAction({ type: 'trade_cancel', tradeId: myOffer.id }))) return;
        if (await sendAction({ type: 'trade_propose', give: draft.give, get: draft.get })) {
          showToast('모두에게 교환을 제안했습니다. 수락한 사람 중에서 고르세요.', 'good');
          onClose();
        }
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

      <CardRow label="낼 것" side="give" hint={bank ? '비율만큼 한 묶음씩' : '내 카드에서 고르세요'} slots={giveSlots} />
      <div className="trade-arrow" aria-hidden>
        <span>⇅</span>
      </div>
      <CardRow
        label="받을 것"
        side="get"
        hint={bank ? (units > 0 ? `${units}장 고를 수 있음` : '낼 묶음 수만큼') : '원하는 카드를 고르세요'}
        slots={getSlots}
      />

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
        ) : (
          <>모두에게 한 번에 제안합니다. 각자 수락·거절하고 수락한 사람 중 한 명을 골라 확정하면 그때 카드가 옮겨집니다.</>
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
        <ResourceAmount key={r} resource={r} amount={bundle[r]} size={18} />
      ))}
    </span>
  );
}

const RESP_LABEL = { pending: '생각 중', accepted: '수락', rejected: '거절' } as const;

/**
 * 열린 교환 제안. 모두에게 보인다.
 * 받은 사람: 수락·거절 (수락 뒤에도 거절로 바꿀 수 있다). 제안한 사람: 수락한 사람을 눌러 확정하거나 제안을 취소한다.
 */
export function TradeOffer({ view, players, trade }: { view: RoomView; players: Players; trade: TradeView }) {
  const g = view.game!;
  const t = trade;
  const me = view.you;
  const from = players.get(t.from);
  const mineOffer = t.from === me;
  const targeted = t.to.includes(me);
  const myResp = targeted ? t.responses[me] : null;
  const name = (id: string) => (id === me ? '나' : (players.get(id)?.nickname ?? '?'));
  const lacking = targeted ? RESOURCES.filter((r) => g.myResources[r] < t.get[r]) : [];
  const accepted = t.to.filter((id) => t.responses[id] === 'accepted');
  const fromName = from?.nickname ?? '?';

  // 화면 주인 기준으로 주고받는 쪽을 바꿔 적는다.
  const [leftLabel, leftBundle, rightLabel, rightBundle] = mineOffer
    ? ['내가 줌', t.give, '내가 받음', t.get]
    : targeted
      ? ['내가 받음', t.give, '내가 줌', t.get]
      : [`${fromName} 줌`, t.give, `${fromName} 받음`, t.get];

  return (
    <div
      className={`trade-banner trade-offer ${targeted && myResp === 'pending' ? 'trade-incoming' : ''} ${mineOffer ? 'trade-outgoing' : ''}`}
      role={targeted && myResp === 'pending' ? 'alertdialog' : 'region'}
      aria-label="교환 제안"
      style={{ ['--pc' as string]: playerColor(from?.colorIndex ?? 0).hex } as CSSProperties}
    >
      <div className="trade-title">
        <Emblem colorIndex={from?.colorIndex ?? 0} size={16} />
        {mineOffer ? '내 교환 제안' : `${fromName}의 교환 제안`}
        <span className="muted small">· {t.to.length > 1 ? '모두에게' : `${name(t.to[0])}에게`}</span>
      </div>
      <div className="offer-lines">
        <div className="offer-side">
          <span className="offer-label">{leftLabel}</span>
          <BundleChips bundle={leftBundle} />
        </div>
        <span className="offer-swap" aria-hidden>
          ⇄
        </span>
        <div className="offer-side">
          <span className="offer-label">{rightLabel}</span>
          <BundleChips bundle={rightBundle} />
        </div>
      </div>

      <ul className="offer-resps" aria-label="응답">
        {t.to.map((id) => {
          const p = players.get(id);
          const resp = t.responses[id];
          const canPick = mineOffer && resp === 'accepted';
          const body = (
            <>
              <Emblem colorIndex={p?.colorIndex ?? 0} size={13} />
              {name(id)}
              <i className={`resp-mark resp-${resp}`}>{resp === 'accepted' ? '✓' : resp === 'rejected' ? '✕' : '…'}</i>
              <span className="resp-text">{canPick ? '이 사람과 교환' : RESP_LABEL[resp]}</span>
            </>
          );
          return (
            <li key={id} className={`offer-resp offer-resp-${resp}`}>
              {canPick ? (
                <ActionButton
                  className="btn btn-small btn-primary offer-pick"
                  label={body}
                  blocker={null}
                  onClick={() => sendAction({ type: 'trade_confirm', tradeId: t.id, with: id })}
                />
              ) : (
                <span className="offer-chip">{body}</span>
              )}
            </li>
          );
        })}
      </ul>

      {mineOffer && (
        <div className="row-buttons">
          <span className="small muted offer-hint">
            {accepted.length ? '수락한 사람을 눌러 교환을 확정하세요.' : '응답을 기다리는 중입니다.'}
          </span>
          <ActionButton className="btn btn-small" label="제안 취소" blocker={null} onClick={() => sendAction({ type: 'trade_cancel', tradeId: t.id })} />
        </div>
      )}
      {targeted && (
        <>
          {myResp !== 'accepted' && lacking.length > 0 && (
            <div className="warn-text small">{lacking.map((r) => RESOURCE_LABEL[r]).join(', ')}이(가) 모자라 수락할 수 없습니다.</div>
          )}
          <div className="row-buttons">
            {myResp === 'accepted' ? (
              <>
                <span className="small offer-hint">수락했습니다 · {josa(fromName, '이/가')} 고르는 중</span>
                <ActionButton className="btn btn-small" label="수락 취소" blocker={null} onClick={() => sendAction({ type: 'trade_reject', tradeId: t.id })} />
              </>
            ) : (
              <>
                <ActionButton
                  className="btn btn-primary"
                  label={myResp === 'rejected' ? '다시 수락' : '수락'}
                  blocker={lacking.length ? '요청받은 자원이 모자랍니다.' : null}
                  onClick={() => sendAction({ type: 'trade_accept', tradeId: t.id })}
                />
                {myResp === 'pending' && (
                  <ActionButton className="btn" label="거절" blocker={null} onClick={() => sendAction({ type: 'trade_reject', tradeId: t.id })} />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 열린 제안이 있으면 보여 준다 (배너 자리) */
export function TradeBanner({ view, players }: { view: RoomView; players: Players }) {
  const t = view.game?.trade;
  if (!t) return null;
  return <TradeOffer key={t.id} view={view} players={players} trade={t} />;
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

