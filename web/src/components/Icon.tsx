import type { Item } from '@sim';
import { iconUrl } from '../data';

/**
 * An item's icon, at the one size everything uses.
 *
 * In its own module because everything that lists items wants it -- the slot
 * grid, the picker and the suggestion rows -- and the picker already imports
 * from the panel that holds those rows.
 *
 * A lot of items legitimately have no icon, so the placeholder is part of the
 * component rather than something every caller has to remember.
 */
export function Icon({ item }: { item: Item }) {
  const url = iconUrl(item);
  if (!url) return <div className="icon ph">?</div>;
  return <img className="icon" src={url} alt="" loading="lazy" />;
}
