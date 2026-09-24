import {
  emptySockets, groupCards, isLocked, isOffhandWeapon, isTwoHanded, maxRefine, rollTableFor,
  SLOTS, socketsOf, swapHands, tableForSlot,
  type Build, type Dataset, type RollPick, type SlotDef,
} from '@sim';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';
import { RollEditor } from './RollEditor';

interface Props {
  dataset: Dataset;
  build: Build;
  onOpenItem: (slot: SlotDef) => void;
  onOpenCard: (slot: SlotDef, socket: number) => void;
  onClear: (slotKey: string) => void;
  onClearCard: (slotKey: string, socket: number) => void;
  /** Put another copy of a card the piece already holds into a free socket. */
  onAddCard: (slotKey: string, socket: number, cardId: number) => void;
  onRefine: (slotKey: string, refine: number) => void;
  onRoll: (slotKey: string, rollKey: string, pick: RollPick | null) => void;
  /** Read this slot's rolls from a screenshot of the item's tooltip. */
  onImportRolls: (slot: SlotDef) => void;
  onSwapHands: () => void;
  /** Settle this slot, so no suggestion touches its piece, cards or rolls. */
  onToggleLock: (slotKey: string, locked: boolean) => void;
  /** Show where this slot's piece, cards and refine materials come from. */
  onSources: (slot: SlotDef) => void;
}

const GROUPS: { key: SlotDef['group']; label: string }[] = [
  { key: 'gear', label: 'Equipment' },
  { key: 'shadow', label: 'Shadow Gear' },
  { key: 'costume', label: 'Costume' },
];

export function SlotGrid(props: Props) {
  const { dataset, build } = props;
  const weapon = build.slots.weapon?.itemId
    ? dataset.items.get(build.slots.weapon.itemId!)
    : null;
  // A two-handed weapon takes the off-hand with it.
  const offhandBlocked = isTwoHanded(weapon);
  // Offered whenever it would do something: the equipment window is laid out
  // as the character faces you, so which weapon is in which hand is the one
  // thing about a dual-wielded pair that is easy to get backwards.
  const canSwap = swapHands(build, dataset) !== null;

  return (
    <>
      {GROUPS.map((group) => (
        <div className="panel" key={group.key}>
          <div className="panel-head">
            <h2>{group.label}</h2>
            {group.key === 'gear' && (
              <button
                className="swap-hands"
                disabled={!canSwap}
                onClick={props.onSwapHands}
                title={canSwap
                  ? 'Move the main hand to the off hand and back'
                  : 'Nothing to swap: a shield cannot go in the main hand, and a '
                    + 'two-handed weapon uses both'}
              >
                Swap hands
              </button>
            )}
          </div>
          <div className="slot-grid">
            {SLOTS.filter((s) => s.group === group.key).map((slot) => (
              <Slot
                key={slot.key}
                slot={slot}
                disabled={slot.key === 'offhand' && offhandBlocked}
                {...props}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Slot({
  slot, dataset, build, disabled,
  onOpenItem, onOpenCard, onClear, onClearCard, onAddCard, onRefine, onRoll,
  onImportRolls, onToggleLock, onSources,
}: Props & { slot: SlotDef; disabled: boolean }) {
  const state = build.slots[slot.key];
  const locked = isLocked(build, slot.key);
  const item = state?.itemId ? dataset.items.get(state.itemId) ?? null : null;
  const limit = maxRefine(item);
  const rollTable = rollTableFor(dataset.rolls, slot.key, item);
  // The slot rolls, but this piece does not. Said out loud, because an
  // editor that is simply absent reads as a bug rather than as a rule.
  const rollsBarred = !!item && !rollTable && !!tableForSlot(dataset.rolls, slot.key);
  // What the tooltip shows for this piece: the refine as set, and the cards
  // in it, so the numbers match what this build actually equips.
  const sockets = item ? socketsOf(item, state.cards) : [];
  const cards = sockets.map((id) => (id ? dataset.items.get(id) ?? null : null));
  // Where another copy of an already-slotted card would go. Undefined once
  // the piece is full, which is what hides the "+".
  const freeSockets = emptySockets(sockets);
  const firstFree = freeSockets[0];
  // A weapon carried in the off hand counts race and size damage at half,
  // and its hover says so rather than showing the full figure.
  const offhand = isOffhandWeapon(slot, item);

  return (
    <div className={`slot ${item ? 'filled' : ''} ${disabled ? 'disabled' : ''}`
      + `${locked ? ' locked' : ''}`}>
      <div className="slot-head">
        <span className="slot-label">{slot.label}</span>
        {/* Offered on an empty slot too: "leave this one alone" is a thing
            to say about a slot you have not filled yet. */}
        <button
          className={`lock ${locked ? 'on' : ''}`}
          onClick={() => onToggleLock(slot.key, !locked)}
          title={locked
            ? `${slot.label} is locked: no suggestion will change its piece, cards or rolls`
            : `Lock ${slot.label}, so suggestions leave it alone and work on the rest`}
          aria-label={locked ? `Unlock ${slot.label}` : `Lock ${slot.label}`}
          aria-pressed={locked}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path
              fill="currentColor"
              d={locked
                ? 'M4 7V5a4 4 0 0 1 8 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 '
                  + '1-1-1V8a1 1 0 0 1 1-1H4Zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2Z'
                : 'M10.5 7V5a2.5 2.5 0 0 0-5 0v.5H4V5a4 4 0 0 1 8 0v2h.5a1 1 0 0 1 1 1v6a1 '
                  + '1 0 0 1-1 1h-9a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h7Z'}
            />
          </svg>
        </button>
        {item && rollTable && (
          <button
            className="shot"
            onClick={() => onImportRolls(slot)}
            title={`Read ${item.name}'s rolls from a screenshot of its tooltip`}
            aria-label={`Read rolls for ${slot.label} from a screenshot`}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                fill="currentColor"
                d="M5.5 2h5l1 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0
                   0 1-1-1V4.5a1 1 0 0 1 1-1h2.5L5.5 2Zm2.5 3.5a3.25 3.25 0 1 0 0
                   6.5 3.25 3.25 0 0 0 0-6.5Zm0 1.5a1.75 1.75 0 1 1 0 3.5 1.75
                   1.75 0 0 1 0-3.5Z"
              />
            </svg>
          </button>
        )}
        {item && (
          <button
            className="find"
            onClick={() => onSources(slot)}
            title={`Where ${item.name}, its cards and its refine materials drop`}
            aria-label={`Where ${item.name} comes from`}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6.5 1a5.5 5.5 0 0 1 4.38 8.82l3.65 3.65-1.06 1.06-3.65-3.65A5.5 5.5 0 1 1
                   6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
              />
            </svg>
          </button>
        )}
        {item && (
          <button
            className="x"
            onClick={() => onClear(slot.key)}
            title={`Remove ${item.name}`}
            aria-label={`Remove ${item.name} from ${slot.label}`}
          >×</button>
        )}
      </div>

      <div className="slot-main">
        <button
          onClick={() => !disabled && onOpenItem(slot)}
          disabled={disabled}
          title={disabled ? 'Taken by a two-handed weapon' : 'Choose an item'}
          {...(item && !disabled
            ? tooltipProps({ kind: 'item', item, refine: state.refine, cards, offhand })
            : {})}
        >
          {item ? <Icon item={item} /> : <div className="icon ph">+</div>}
          <span className={`slot-name ${item ? '' : 'empty'}`}>
            {disabled ? 'Two-handed' : item?.name ?? 'Empty'}
          </span>
        </button>
      </div>

      {item && (
        <div className="slot-controls">
          {limit > 0 && (
            <label className="refine">
              +
              <input
                type="number"
                min={0}
                max={limit}
                value={state.refine}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onRefine(slot.key, Number.isFinite(n)
                    ? Math.max(0, Math.min(limit, Math.trunc(n))) : 0);
                }}
              />
            </label>
          )}

          {/* One entry per distinct card, counted, rather than the same name
              repeated across four sockets. */}
          {groupCards(sockets).map((group) => {
            const card = dataset.items.get(group.cardId);
            if (!card) return null;
            const name = card.name.replace(/ Card$/, '');
            return (
              <span
                key={group.cardId}
                className="card-slot set"
                {...tooltipProps({
                  kind: 'item', item: card, hostRefine: state.refine,
                  count: group.count, offhand,
                })}
              >
                <button
                  className="t"
                  onClick={() => onOpenCard(slot, group.sockets[0])}
                >
                  {name}
                  {group.count > 1 && <em className="card-count">×{group.count}</em>}
                </button>
                {firstFree !== undefined && (
                  <button
                    className="plus"
                    onClick={() => onAddCard(slot.key, firstFree, card.id)}
                    title={`Slot another ${name}`}
                    aria-label={`Add another ${name}`}
                  >+</button>
                )}
                <button
                  className="x"
                  onClick={() => onClearCard(slot.key, group.sockets[group.count - 1])}
                  title={group.count > 1
                    ? `Remove one ${name} (${group.count} slotted)`
                    : `Remove ${name}`}
                  aria-label={`Remove one ${name}`}
                >×</button>
              </span>
            );
          })}

          {freeSockets.map((socket) => (
            <span className="card-slot" key={`empty-${socket}`}>
              <button className="t" onClick={() => onOpenCard(slot, socket)}>
                Empty
              </button>
            </span>
          ))}
        </div>
      )}

      {item && rollTable && (
        <RollEditor
          table={rollTable}
          picks={state.rolls}
          onChange={(rollKey, pick) => onRoll(slot.key, rollKey, pick)}
        />
      )}

      {rollsBarred && (
        <div className="rolls-barred" title="Only monster drops roll here">
          No rolls — not a monster drop
        </div>
      )}
    </div>
  );
}
