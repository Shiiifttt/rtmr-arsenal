import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type HTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import {
  effectLine, effectTone, HALVED_OFFHAND, isRefineable, jobLimitFix, jobLimitOf,
  skillTone, statTone,
} from '@sim';
import type {
  Dataset, Effect, Item, RefineGroup, SetRecord, StatTotal, Totals,
} from '@sim';
import { iconUrl } from '../data';

/**
 * The MMO-style item tooltip.
 *
 * One tooltip exists for the whole page, driven by a tiny module-level store
 * rather than by state per trigger. Only one can ever be visible, and the
 * triggers are ordinary buttons and rows in scrolling lists -- giving each of
 * them its own portal and position state would cost a render per row for a
 * thing that is almost never shown.
 */

interface Rect { x: number; y: number; w: number; h: number }

export interface ItemTarget {
  kind: 'item';
  item: Item;
  /** Refine of the equipped piece, so per-refine lines can show real numbers. */
  refine?: number;
  /**
   * For a card: the refine of the piece it is compounded into.
   *
   * A card has no refine of its own, but "ATK+1 per 2 refines" on a card
   * counts the host's. Without this the lines render as if unrefined, which
   * is the opposite of what the totals do.
   */
  hostRefine?: number;
  /** Cards compounded into it, listed under the item's own effects. */
  cards?: (Item | null)[];
  /**
   * Worn as a weapon in the off hand, where race and size damage counts at
   * half. For a card, that its host is.
   */
  offhand?: boolean;
  /** For a card hovered on its own: how many copies the piece holds. */
  count?: number;
}

export interface SetTarget {
  kind: 'set';
  progress: Totals['setProgress'][number];
}

/**
 * One row of the totals, and everything that fed it.
 *
 * The totals are a sum, and a sum is the one thing in this app you cannot
 * check by looking at it. Every contribution is already carried on the
 * total as it is added up; this is what puts it back on screen.
 */
export interface StatTarget {
  kind: 'stat';
  /** The stat's name as the panel writes it. */
  name: string;
  /**
   * Null for a flag, which has a count rather than an amount, and for a
   * skill modifier, whose direction reads by `metric` instead.
   */
  statKey: string | null;
  /** Set for a skill modifier: "damage", "cooldown", "sp cost". */
  metric?: string;
  sources: StatTotal['sources'];
  flat: number;
  percent: number;
}

export type TooltipTarget = ItemTarget | SetTarget | StatTarget;

interface Active {
  target: TooltipTarget;
  anchor: Rect;
  /** The element hovered, watched so the tooltip leaves with it. */
  el: Element;
}

// ---- store ---------------------------------------------------------------

let active: Active | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Long enough that sweeping the cursor down a list stays quiet. */
const SHOW_DELAY = 120;

function publish(next: Active | null) {
  active = next;
  for (const listener of listeners) listener();
}

function show(target: TooltipTarget, anchor: Rect, el: Element, delay = SHOW_DELAY) {
  clearTimeout(timer);
  // Moving between two triggers while one is already open swaps straight
  // over: the delay is there to ignore a cursor passing through, and it has
  // already been paid once.
  if (active) publish({ target, anchor, el });
  else timer = setTimeout(() => publish({ target, anchor, el }), delay);
}

function hide() {
  clearTimeout(timer);
  if (active) publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Event handlers to spread onto whatever should show `target` on hover.
 *
 * A plain function, not a hook: it is called inside list `map`s where the
 * number of calls changes between renders.
 */
export function tooltipProps(
  target: TooltipTarget | null,
): HTMLAttributes<HTMLElement> {
  if (!target) return {};
  return {
    onMouseEnter: (e) => show(target, cursorRect(e.clientX, e.clientY), e.currentTarget),
    onMouseLeave: hide,
    // A click is about to pick, clear or open something; leaving the tooltip
    // floating over the result looks stuck.
    onMouseDown: hide,
    onFocus: (e) => show(target, boxOf(e.currentTarget), e.currentTarget, 0),
    onBlur: hide,
  };
}

// ---- the layer -----------------------------------------------------------

/** Rendered once, near the root. */
export function ItemTooltipLayer({ dataset, totals }: {
  dataset: Dataset;
  /** The build as it stands, so an item hover can mark set pieces worn. */
  totals?: Totals;
}) {
  const target = useSyncExternalStore(subscribe, () => active, () => null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ for: Active; left: number; top: number } | null>(null);

  // Measure after paint: where it goes depends on how tall the content is.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!target || !node) return;
    const { left, top } = place(target.anchor, node.getBoundingClientRect());
    setPos({ for: target, left, top });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    // Anchored to a viewport position, so anything that moves the page
    // underneath it invalidates the placement. Dismissing beats chasing.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);

    // A trigger that is unmounted while hovered never fires mouseleave, so
    // the tooltip would sit there describing a row that is gone -- which is
    // what happens when a keystroke re-filters the picker list underneath
    // the cursor, or the picker closes outright. Watching the DOM catches
    // every such case, including ones no handler is attached to. It only
    // runs while a tooltip is actually open.
    const observer = new MutationObserver(() => {
      if (!target.el.isConnected) hide();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
      observer.disconnect();
    };
  }, [target]);

  if (!target) return null;
  const ready = pos?.for === target;

  return createPortal(
    <div
      ref={ref}
      className="tip"
      role="tooltip"
      style={ready
        ? { left: pos.left, top: pos.top }
        : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {target.target.kind === 'item'
        ? <ItemCard {...target.target} dataset={dataset}
            progress={totals?.setProgress} />
        : target.target.kind === 'set'
          ? <SetCard {...target.target} />
          : <StatCard {...target.target} />}
    </div>,
    document.body,
  );
}

// ---- contents ------------------------------------------------------------

// Exported so it can be rendered on its own in tests: the layer around it
// goes through a portal, which does not exist outside a browser.
export function ItemCard({
  item, refine = 0, hostRefine = 0, cards, dataset, progress, offhand = false, count: own = 1,
}: ItemTarget & { dataset: Dataset; progress?: Totals['setProgress'] }) {
  // The same categories the aggregator halves: race and size damage only.
  const halves = (eff: Effect) => offhand && (eff.stat_ids?.length ?? 0) > 0
    && eff.stat_ids!.every((id) => HALVED_OFFHAND.has(dataset.statById.get(id)?.category ?? ''));
  const line = (eff: Effect, key: string | number, count = own) =>
    <Stacked key={key} eff={eff} count={count} half={halves(eff)} />;
  const url = iconUrl(item);
  // A card scales off its host's refine; everything else off its own. The
  // card itself is never refined, so the number drives its per-refine lines
  // but must not appear as a "+N" on its name -- that refine belongs to the
  // piece it sits in, and the piece's own hover already shows it.
  const jobFix = jobLimitFix(item, dataset.classRules);
  const isCard = item.kind === 'Card';
  const steps = isCard ? hostRefine : (isRefineable(item) ? refine : 0);
  const compounded = (cards ?? []).filter((c): c is Item => !!c);
  const sets = item.sets.map((i) => dataset.sets[i]).filter(Boolean);
  const progressOf = (index: number) =>
    progress?.find((p) => p.set.index === index);

  return (
    <>
      <div className="tip-head">
        {url
          ? <img className="tip-art" src={url} alt="" />
          : <div className="tip-art ph">?</div>}
        <div style={{ minWidth: 0 }}>
          <div className="tip-name">
            {!isCard && steps > 0 && <em>+{steps} </em>}
            {item.name}
          </div>
          <div className="tip-sub">
            {[
              item.type ?? item.kind,
              item.weapon_level ? `Lv ${item.weapon_level} weapon` : null,
              item.element,
              item.card_slots > 0
                ? `${item.card_slots} slot${item.card_slots > 1 ? 's' : ''}`
                : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      {/* A ternary, not `&&`: with every figure at zero the `||` chain is
          itself 0, and React renders that 0 as a stray digit under the icon. */}
      {(item.atk || item.matk || item.def || item.mdef) ? (
        <div className="tip-nums">
          {item.atk ? <span>ATK <b>{item.atk}</b></span> : null}
          {item.matk ? <span>MATK <b>{item.matk}</b></span> : null}
          {item.def ? <span>DEF <b>{item.def}</b></span> : null}
          {item.mdef ? <span>MDEF <b>{item.mdef}</b></span> : null}
        </div>
      ) : null}

      {/* A card is not worn, so it has no level of its own -- the piece it
          goes into carries that. Saying "No level requirement" on one reads
          as a property of the card rather than as a category that does not
          apply. Its weight is real and stays. */}
      {(!isCard || item.weight > 0) && (
        <div className="tip-req">
          {isCard ? '' : (item.required_level > 0
            ? `Requires level ${item.required_level}`
            : 'No level requirement')}
          {item.weight > 0 && `${isCard ? '' : ' · '}Weight ${item.weight}`}
        </div>
      )}

      {item.enchant && (
        // Not a bonus, so it is not in the effects any more -- but it is
        // still something the player needs to see on the item.
        <div className="tip-req">
          {item.enchant.system} enchants available
          {item.enchant.refining && ', refining available'}
        </div>
      )}

      {item.card_affix && (
        <Section title="Compounds as">
          <Line>
            {item.card_affix.position === 'prefix'
              ? `${item.card_affix.word} <item>`
              : `<item> ${item.card_affix.word}`}
          </Line>
        </Section>
      )}

      {item.effects.length > 0 && (
        <Section>
          {item.effects.map((eff, i) => line(eff, i))}
        </Section>
      )}

      {item.piece_bonus.length > 0 && (
        <Section title="Set piece bonus">
          {item.piece_bonus.map((eff, i) => line(eff, i))}
        </Section>
      )}

      {item.refine.per_refine.map((group, i) => {
        const per = group.per ?? 1;
        const times = Math.floor(steps / per);
        return (
          <Section
            key={`p${i}`}
            title={isCard
              ? (per > 1 ? `Per ${per} refines of the piece` : 'Per refine of the piece')
              : (per > 1 ? `Per ${per} refines` : 'Per refine')}
            met={times > 0}
            note={times > 0 ? `×${times}` : 'unrefined'}
          >
            <Scaled group={group} steps={times} count={own} halves={halves} />
          </Section>
        );
      })}

      {item.refine.thresholds.flatMap((group, i) =>
        (group.at ?? []).map((at) => (
          <Section
            key={`t${i}-${at}`}
            title={`At +${at}`}
            met={steps >= at}
            note={steps >= at ? 'active' : `+${at - steps} refine short`}
          >
            {group.effects.map((eff, j) => line(eff, j))}
          </Section>
        )))}

      {item.conditional.map((cond, i) => (
        <Section key={`c${i}`} title={cond.condition} conditional>
          {cond.effects.map((eff, j) => line(eff, j))}
        </Section>
      ))}

      {compounded.length > 0 && (
        <Section title="Cards">
          {/* One entry per distinct card: four copies of the same card read
              better as "×4" than as the same block four times over. */}
          {groupById(compounded).map(({ card, count }) => (
            <div key={card.id} className="tip-card">
              <div className="tip-card-name">
                {card.name}
                {count > 1 && <em className="card-count">×{count}</em>}
              </div>
              {card.effects.map((eff, i) => line(eff, i, count))}
              {card.piece_bonus.map((eff, i) => line(eff, `pb${i}`, count))}
              {/* Counted off this piece's refine, not the card's own. */}
              {card.refine.per_refine.map((group, i) => {
                const per = group.per ?? 1;
                const times = Math.floor(steps / per);
                return (
                  <Section
                    key={`cp${i}`}
                    title={per > 1 ? `Per ${per} refines of this piece` : 'Per refine of this piece'}
                    met={times > 0}
                    note={times > 0 ? `x${times}` : 'unrefined'}
                  >
                    <Scaled group={group} steps={times} count={count} halves={halves} />
                  </Section>
                );
              })}
              {card.refine.thresholds.flatMap((group, i) =>
                (group.at ?? []).map((at) => (
                  <Section
                    key={`ct${i}-${at}`}
                    title={`At +${at} on this piece`}
                    met={steps >= at}
                    note={steps >= at ? 'active' : `+${at - steps} refine short`}
                  >
                    {group.effects.map((eff, j) => line(eff, j, count))}
                  </Section>
                )))}
              {/* A card whose whole effect is conditional ("Hell Poodle")
                  would otherwise show as a bare name. */}
              {card.conditional.map((cond, i) => (
                <Section key={`cc${i}`} title={cond.condition} conditional>
                  {cond.effects.map((eff, j) => line(eff, j, count))}
                </Section>
              ))}
            </div>
          ))}
        </Section>
      )}

      {sets.map((set) => {
        const p = progressOf(set.index);
        // With the build in hand the hover says the same thing the Sets
        // panel does -- which pieces are on, and whether the bonus is
        // live. Without it, the same blocks read as the set's rules.
        const missing = p ? p.total - p.worn : 0;
        const gap = `needs ${missing} more piece${missing === 1 ? '' : 's'}`;
        const equipped = new Set(p?.wornIds ?? []);
        return (
          <div key={set.index}>
            <Section
              title={`${set.name} set`}
              met={p?.complete}
              note={p ? (p.complete ? 'active' : gap) : undefined}
            >
              <SetPieces set={set} equipped={equipped} known={!!p} />
              {set.set_bonus.map((eff, i) => <Line key={i} eff={eff}>{effectLine(eff)}</Line>)}
            </Section>
            <SetRefineBlocks
              set={set}
              state={p ? {
                refine: p.complete ? p.setRefine : 0,
                setRefine: p.setRefine, complete: p.complete, gap,
              } : undefined}
            />
          </div>
        );
      })}

      {jobLimitOf(item, dataset.classRules) && (
        <div className="tip-classes">
          {jobLimitOf(item, dataset.classRules)}
          {jobFix && (
            <span
              className={`pill ${jobFix.status === 'verified' ? '' : 'unverified'}`}
              title={`${jobFix.status === 'verified'
                ? 'Hand-corrected, checked in game'
                : 'Hand-corrected, not yet checked in game'}\n\nThe site says: ${
                jobFix.was ?? 'no restriction'}\n\n${jobFix.reason}`}
            >
              {jobFix.status === 'verified' ? 'corrected' : 'unverified'}
            </span>
          )}
        </div>
      )}

      {item.lore && <div className="tip-lore">{item.lore}</div>}
    </>
  );
}

/**
 * A set as the build currently stands: which pieces are on, which are not,
 * and what the bonus is worth.
 *
 * The bonus is shown whether or not the set is complete. Half the point of
 * the panel is deciding whether finishing a set is worth it, and that cannot
 * be judged from a `2/4` counter alone -- but an inactive bonus is dimmed so
 * it is never mistaken for one already counted in the totals.
 */
/**
 * Where one row of the totals came from.
 *
 * Every line the aggregator added is listed, named the way it was added --
 * the piece, the card, the set, the refine block, the roll. Identical lines
 * from the same source are collapsed with a count, because four copies of a
 * card is one fact about the build, not four.
 *
 * This exists because a total is the one number in the app that cannot be
 * checked by looking at it. "Where is that coming from?" was previously a
 * question you answered by taking gear off one piece at a time.
 */
export function StatCard({ name, statKey, metric, sources, flat, percent }: StatTarget) {
  // A flag has no amount to show; everything else does, coloured by whichever
  // notion of "better" applies to it.
  const amounts = statKey !== null || metric !== undefined;
  const toneOf = (v: number) =>
    (metric !== undefined ? skillTone(metric, v) : statKey ? statTone(statKey, v) : null);
  const grouped: { label: string; value: number; unit: string | null; count: number }[] = [];
  for (const source of sources) {
    const prior = grouped.find((g) => g.label === source.label && g.unit === source.unit);
    if (prior) {
      prior.value += source.value;
      prior.count += 1;
    } else {
      grouped.push({ ...source, count: 1 });
    }
  }
  // Biggest contribution first: on a stat with a dozen sources, the one
  // worth arguing with is almost always the largest.
  grouped.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const amount = (value: number, unit: string | null) =>
    `${value > 0 ? '+' : ''}${Math.round(value * 100) / 100}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;

  return (
    <>
      <div className="tip-head">
        <div style={{ minWidth: 0 }}>
          <div className="tip-name">{name}</div>
          <div className="tip-sub">
            {!amounts
              ? `granted by ${sources.length} ${sources.length === 1 ? 'piece' : 'pieces'}`
              : [flat !== 0 ? amount(flat, null) : null,
                percent !== 0 ? amount(percent, '%') : null]
                .filter(Boolean).join(' and ')}
            {` · ${grouped.length} source${grouped.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>

      <Section title="From">
        {grouped.map((g, i) => (
          <div className="tip-src" key={i}>
            <span className="tip-src-label">
              {g.label}{g.count > 1 && <em className="tip-src-count"> ×{g.count}</em>}
            </span>
            {amounts && (
              <span className={`tip-src-value ${toneOf(g.value) ?? ''}`}>
                {amount(g.value, g.unit)}
              </span>
            )}
          </div>
        ))}
      </Section>

      {amounts && flat !== 0 && percent !== 0 && (
        <div className="tip-note">
          Flat and percent are totalled apart, and are not combined here —
          how they stack is the damage model's job.
        </div>
      )}
    </>
  );
}

function SetCard({ progress }: SetTarget) {
  const { set, worn, total, complete, setRefine, wornIds } = progress;
  const equipped = new Set(wornIds);
  // An incomplete set earns nothing, however refined its pieces are, so the
  // scaling is computed against zero rather than against a refine that is
  // not being paid out.
  const refine = complete ? setRefine : 0;
  const missing = total - worn;
  const gap = `needs ${missing} more piece${missing === 1 ? '' : 's'}`;

  return (
    <>
      <div className="tip-head">
        <div style={{ minWidth: 0 }}>
          <div className="tip-name">{set.name}</div>
          <div className="tip-sub">
            {worn}/{total} pieces
            {complete
              ? ` · bonus active${setRefine > 0 ? ` · set refine +${setRefine}` : ''}`
              : ` · ${total - worn} missing`}
          </div>
        </div>
      </div>

      <Section title="Pieces">
        <SetPieces set={set} equipped={equipped} known />
      </Section>

      {set.set_bonus.length > 0 && (
        <Section title="Set bonus" met={complete} note={complete ? 'active' : gap}>
          {set.set_bonus.map((eff, i) => <Line key={i} eff={eff}>{effectLine(eff)}</Line>)}
        </Section>
      )}

      <SetRefineBlocks set={set} state={{ refine, setRefine, complete, gap }} />

      {set.piece_bonus_note && (
        <div className="tip-lore">{set.piece_bonus_note}</div>
      )}
    </>
  );
}

/**
 * A set's pieces, one per line, ticked where the build already wears one.
 *
 * `known` is false when there is no build context -- the item picker, where
 * nothing is equipped in the sense this means. There the list is still worth
 * showing, but ticking every piece as absent would be a claim, so the marks
 * are left off entirely.
 */
function SetPieces({ set, equipped, known }: {
  set: SetRecord;
  equipped: Set<number>;
  known: boolean;
}) {
  return (
    <>
      {set.members.map((member) => {
        const on = known && equipped.has(member.id);
        return (
          <div key={member.id} className={`tip-member ${on ? 'on' : ''}`}>
            <span className="tip-tick">{known ? (on ? '✓' : '·') : '·'}</span>
            {member.name}
          </div>
        );
      })}
    </>
  );
}

/**
 * A set's refine scaling.
 *
 * Shared by the set card, which knows the build and can say how far off each
 * step is, and the item tooltip, which does not. For shadow gear this is
 * nearly the whole set -- "All Stats +4" is the small half and the thresholds
 * at +9/+18/+36 are the rest -- so leaving it out of the item hover made
 * those pieces look almost bonus-free.
 */
function SetRefineBlocks({ set, state }: {
  set: SetRecord;
  state?: { refine: number; setRefine: number; complete: boolean; gap: string };
}) {
  return (
    <>
      {set.set_refine.per_set_refine.map((group, i) => {
        const per = group.per ?? 1;
        const steps = state ? Math.floor(state.refine / per) : 0;
        return (
          <Section
            key={`p${i}`}
            title={per > 1 ? `Per ${per} set refines` : 'Per set refine'}
            met={state ? steps > 0 : undefined}
            note={state
              ? (steps > 0 ? `×${steps}`
                : state.complete ? 'no set refine yet' : state.gap)
              : undefined}
          >
            <Scaled group={group} steps={steps} />
          </Section>
        );
      })}

      {set.set_refine.thresholds.flatMap((group, i) =>
        (group.at ?? []).map((at) => {
          const met = state ? state.complete && state.setRefine >= at : undefined;
          return (
            <Section
              key={`t${i}-${at}`}
              title={`At set refine +${at}`}
              met={met}
              note={!state ? undefined
                : met ? 'active'
                : state.complete ? `+${at - state.setRefine} refine short`
                : state.gap}
            >
              {group.effects.map((eff, j) => <Line key={j} eff={eff}>{effectLine(eff)}</Line>)}
            </Section>
          );
        }))}
    </>
  );
}

/**
 * A titled block of effect lines.
 *
 * `met` is what separates a bonus the build already has from one it only
 * would have: an unmet block dims its own lines rather than being left to
 * look like everything around it. `note` carries the short reason -- how much
 * refine is short, how many pieces are missing -- because "At set refine +18"
 * on its own does not say how far away that is.
 */
/** Cards in socket order, one entry per distinct card with its count. */
function groupById(cards: Item[]): { card: Item; count: number }[] {
  const out: { card: Item; count: number }[] = [];
  for (const card of cards) {
    const seen = out.find((g) => g.card.id === card.id);
    if (seen) seen.count += 1;
    else out.push({ card, count: 1 });
  }
  return out;
}

function Section({ title, children, met, note, conditional }: {
  title?: string;
  children: React.ReactNode;
  met?: boolean;
  note?: string;
  conditional?: boolean;
}) {
  return (
    <div className={`tip-sec ${conditional ? 'cond' : ''} ${met === false ? 'off' : ''}`}>
      {title && (
        <div className={`tip-sec-title ${met === true ? 'met' : ''} ${met === false ? 'unmet' : ''}`}>
          {title}
          {note && <span className="tip-note"> · {note}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * One effect line. Given the effect, it is coloured by what it does to the
 * wearer rather than by its sign: "SP Cost -10%" is a bonus and reads as one.
 */
function Line({ children, eff }: { children: React.ReactNode; eff?: Effect }) {
  const tone = eff ? effectTone(eff) : null;
  return <div className={`tip-line ${tone ?? ''}`}>{children}</div>;
}

/**
 * An effect at what it actually adds here: times the copies stacked (four
 * of one card is four times the card), and halved where the off-hand rule
 * applies. The single figure travels alongside so the arithmetic can be
 * checked. Matches the aggregator, which counts each socket and halves the
 * same categories.
 */
function Stacked({ eff, count = 1, half = false, steps = 1, inScaled = false }: {
  eff: Effect; count?: number; half?: boolean; steps?: number; inScaled?: boolean;
}) {
  const factor = steps * count * (half ? 0.5 : 1);
  const readable = eff.parsed && eff.value !== undefined && !eff.flag;
  const notes = [
    count > 1 || steps > 1 ? 'each' : null,
    half ? 'halved in the off hand' : null,
  ].filter(Boolean).join(', ');
  if (!readable) {
    return <Line eff={eff}>{effectLine(eff)}{count > 1 && <span className="tip-dim"> ×{count}</span>}</Line>;
  }
  // Keyed on what happened, not the product: two cards halved is a factor
  // of 1, and still needs saying.
  if (count === 1 && steps === 1 && !half) {
    return <Line eff={eff}>{effectLine(eff, 1, inScaled)}</Line>;
  }
  return (
    <Line eff={eff}>
      {effectLine(eff, factor, inScaled)}
      <span className="tip-dim"> ({effectLine(eff, 1, inScaled)}{notes ? ` ${notes}` : ''})</span>
    </Line>
  );
}

/**
 * Per-refine effects at the value the current refine actually gives, with the
 * per-step figure alongside. Showing only "+1% per refine" on a +7 piece
 * leaves the reader doing the multiplication the tool exists to do.
 */
function Scaled({ group, steps, count = 1, halves }: {
  group: RefineGroup; steps: number; count?: number; halves?: (eff: Effect) => boolean;
}) {
  return (
    <>
      {group.effects.map((eff, i) => (
        <Stacked
          key={i} eff={eff} inScaled
          // Unrefined, the per-step figure is what there is to show.
          steps={Math.max(1, steps)} count={steps > 0 ? count : 1}
          half={!!halves?.(eff)}
        />
      ))}
      {group.note && <div className="tip-dim">{group.note}</div>}
    </>
  );
}

// effectLine now lives in the sim package: it is string formatting over the
// dataset's own shapes, with no React in it, and it is worth a test.

// ---- placement -----------------------------------------------------------

function cursorRect(x: number, y: number): Rect {
  return { x, y, w: 0, h: 0 };
}

function boxOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Right of the anchor by default, flipped left and clamped to stay on screen. */
function place(anchor: Rect, tip: DOMRect) {
  const pad = 10;
  const gap = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor.x + anchor.w + gap;
  if (left + tip.width > vw - pad) {
    const flipped = anchor.x - tip.width - gap;
    left = flipped >= pad ? flipped : Math.max(pad, vw - pad - tip.width);
  }

  let top = anchor.y;
  if (top + tip.height > vh - pad) top = vh - pad - tip.height;
  if (top < pad) top = pad;

  return { left, top };
}
