import { useEffect, useState } from 'react';
import {
  acquisitionOf, groupCards, maxRefine, refineMaterials, respawnText, socketsOf,
  type Dataset, type Item, type MobInfo, type SlotDef, type SlotState,
} from '@sim';
import { loadSpawns } from '../data';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';

/** Drops shown before "more": materials drop off dozens of monsters. */
const SHOWN = 6;

/**
 * Where everything in one slot comes from: the piece, each card in it, and
 * the refine materials it went through to reach its refine.
 *
 * Drops are ranked by how many you can expect from one sweep of the best
 * map -- the chance times how many of the monster live there -- rather than
 * by chance alone, since 2% off seventy Porings beats 5% off one boss.
 */
export function SourcesPanel({ dataset, slot, state, onClose }: {
  dataset: Dataset;
  slot: SlotDef;
  state: SlotState;
  onClose: () => void;
}) {
  const [mobs, setMobs] = useState<Map<number, MobInfo> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadSpawns().then((m) => { if (live) setMobs(m); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const item = state.itemId ? dataset.items.get(state.itemId) ?? null : null;
  if (!item) return null;
  const cards = groupCards(socketsOf(item, state.cards))
    .map((g) => ({ card: dataset.items.get(g.cardId), count: g.count }))
    .filter((c): c is { card: Item; count: number } => !!c.card);
  const steps = refineMaterials(item, state.refine, maxRefine(item), slot.group === 'shadow');

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker sources" role="dialog" aria-modal="true"
        aria-label={`Where ${item.name} comes from`}>
        <div className="picker-head">
          <h3>Where it comes from</h3>
          <span className="focus-sub">{slot.label}</span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-list">
          {failed && <div className="empty-note">Could not load where monsters spawn.</div>}
          <Source item={item} role={state.refine > 0 ? `+${state.refine}` : 'Item'}
            mobs={mobs} />
          {cards.map(({ card, count }) => (
            <Source key={card.id} item={card} role={count > 1 ? `Card ×${count}` : 'Card'}
              mobs={mobs} />
          ))}
          {steps.map((step) => {
            const material = dataset.items.get(step.itemId);
            if (!material) return null;
            const [from, to] = step.range;
            const range = from === to ? `+${to}` : `+${from} to +${to}`;
            return (
              <Source key={step.itemId} item={material} mobs={mobs}
                role={step.next ? `Next: ${range}` : `Refine ${range}`} dim={step.next}
                note={step.note} />
            );
          })}
          {slot.group === 'shadow' && item.refineable && steps.length === 0 && (
            <p className="empty-note">
              Shadow gear refines with materials the database does not name, so
              none are listed.
            </p>
          )}
        </div>

        <div className="picker-foot">
          <span>Drops ranked by chance × how many spawn on the best map.</span>
          <span>Counts and respawn times are per map, from the database.</span>
        </div>
      </div>
    </div>
  );
}

function Source({ item, role, mobs, dim, note }: {
  item: Item;
  role: string;
  mobs: Map<number, MobInfo> | null;
  /** Said under the name: why this material, for a refine step. */
  note?: string;
  /** The refine tier the piece has not reached yet. */
  dim?: boolean;
}) {
  const [all, setAll] = useState(false);
  const how = acquisitionOf(item);
  const boxes = (item.containers ?? []).map((c) => c.container).filter(Boolean) as string[];

  const drops = (item.drops ?? []).map((d) => {
    const info = mobs?.get(d.mob_id);
    const most = Math.max(0, ...(info?.spawns ?? []).map((s) => s.count));
    return { d, info, yieldPerSweep: d.chance_percent * most };
  }).sort((a, b) => b.yieldPerSweep - a.yieldPerSweep || b.d.chance_percent - a.d.chance_percent);
  const shown = all ? drops : drops.slice(0, SHOWN);
  const nothing = drops.length === 0 && !how && boxes.length === 0;

  return (
    <section className={`src ${dim ? 'dim' : ''}`}>
      <div className="src-head">
        <span {...tooltipProps({ kind: 'item', item })}><Icon item={item} /></span>
        <span className="src-name">{item.name}</span>
        <span className="src-role">{role}</span>
      </div>
      {note && <div className="src-note">{note}</div>}

      {nothing && <div className="src-none">No source in the database.</div>}

      {how && (
        <div className="src-how">
          <span className="src-tag">{how.sold ? 'Sold' : how.costs.length ? 'Exchange' : 'NPC'}</span>
          {how.where}
          {how.costs.length > 0 && (
            <span className="src-costs">
              {' · '}{how.costs.map((c) => `${c.qty.toLocaleString()} ${c.name}`).join(', ')}
            </span>
          )}
          {how.note && <div className="src-note">{how.note}</div>}
          {how.guide && <div className="src-note">{how.guide}</div>}
        </div>
      )}

      {shown.length > 0 && (
        <table className="src-drops">
          <tbody>
            {shown.map(({ d, info }, i) => (
              <tr key={`${d.mob_id}-${i}`}>
                <td className="src-rate">{d.chance_percent}%</td>
                <td>
                  <span className="src-mob">{d.mob}</span>
                  <span className="src-lv"> Lv {d.mob_level}</span>
                  {(info?.mvp || d.mvp_reward) && (
                    <span className="src-mvp" title={d.mvp_reward
                      ? 'Given to the player who earns the MVP'
                      : 'An MVP boss'}>{d.mvp_reward ? 'MVP reward' : 'MVP'}</span>
                  )}
                  <div className="src-maps">
                    {info && info.spawns.length > 0
                      ? info.spawns.map((s, j) => (
                        <span key={j}>
                          {j > 0 && ' · '}
                          {s.map} ×{s.count}
                          <span className="src-respawn"> ({respawnText(s.respawn)})</span>
                        </span>
                      ))
                      : mobs ? `${d.zone} · no fixed spawn` : d.zone}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {drops.length > SHOWN && (
        <button className="more" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `${drops.length - SHOWN} more monsters`}
        </button>
      )}

      {boxes.length > 0 && (
        <div className="src-how">
          <span className="src-tag">Box</span>
          {[...new Set(boxes)].join(', ')}
        </div>
      )}
    </section>
  );
}
