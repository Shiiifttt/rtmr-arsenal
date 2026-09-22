import { useCallback, useEffect, useState } from 'react';
import type { Item, RollPick, RollTable, SlotDef } from '@sim';
import { picksFrom, readSlotRolls, type RollMatch } from '../recognition';

interface Props {
  slot: SlotDef;
  item: Item;
  table: RollTable;
  onApply: (picks: Record<string, RollPick>) => void;
  onClose: () => void;
}

type State =
  | { phase: 'waiting' }
  | { phase: 'reading' }
  | { phase: 'done'; title: string; matched: RollMatch[] }
  | { phase: 'failed'; message: string };

/**
 * Read one slot's random rolls from a screenshot of the item's tooltip.
 *
 * Asked from the slot rather than from the import panel, which means the
 * table is already known: there is no need to work out from the picture
 * which piece it is or where it is worn, and a title the font reads badly
 * costs nothing. It is shown only to confirm the right item was captured.
 */
export function RollImport({ slot, item, table, onApply, onClose }: Props) {
  const [state, setState] = useState<State>({ phase: 'waiting' });

  const read = useCallback(async (blob: Blob) => {
    setState({ phase: 'reading' });
    try {
      const found = await readSlotRolls(await toImageData(blob), table);
      if (!found) {
        setState({
          phase: 'failed',
          message: 'No item tooltip found. Capture the tooltip together with the '
            + 'boxes underneath it — those are the rolls — as a PNG at the game’s '
            + 'own resolution.',
        });
        return;
      }
      setState({ phase: 'done', title: found.title, matched: found.matched });
    } catch (error) {
      setState({ phase: 'failed', message: String(error) });
    }
  }, [table]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.items ?? [])]
        .find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (file) { event.preventDefault(); void read(file); }
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, [read, onClose]);

  const matched = state.phase === 'done' ? state.matched : [];
  const resolved = matched.filter((m) => m.optionKey);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="picker import" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>Rolls for {item.name}</strong>
          <span className="empty-note">{slot.label}</span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void read(file);
          }}
        >
          {state.phase === 'reading'
            ? 'Reading…'
            : 'Paste a screenshot of this item’s tooltip, or drop a PNG here.'}
          <div className="empty-note">
            Include the boxes below the tooltip — that is where the rolls are.
          </div>
          <input
            type="file"
            accept="image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
            }}
          />
        </div>

        {state.phase === 'failed' && (
          <p className="empty-note error">{state.message}</p>
        )}

        {state.phase === 'done' && (
          <>
            <div className="picker-list">
              {state.title && (
                <div className="picker-row">
                  <div>
                    <div>{state.title}</div>
                    <div className="empty-note">
                      Read from the tooltip’s title — check it is the right piece.
                    </div>
                  </div>
                </div>
              )}
              {matched.length === 0 && (
                <div className="picker-row">
                  <div className="empty-note">
                    No rolls in that screenshot. This item dropped without any.
                  </div>
                </div>
              )}
              {matched.map((roll, index) => (
                <div className={`picker-row ${roll.optionKey ? '' : 'skipped'}`} key={index}>
                  <div>
                    <div>
                      {roll.optionKey
                        ? `${roll.label} ${roll.values.join(' / ')}`
                        : roll.text}
                    </div>
                    <div className="empty-note">
                      {roll.optionKey
                        ? roll.text
                        : roll.ambiguous.length
                          ? `Could be ${roll.ambiguous.join(' or ')} — the client does `
                            + 'not say which. Set it below.'
                          : 'Not recognised. Set it below.'}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="picker-foot">
              <span className="empty-note">
                {resolved.length} of {matched.length} recognised
                {resolved.length > 0 && ' — applying replaces those rolls.'}
              </span>
              <div className="spacer" />
              <button
                disabled={!resolved.length}
                onClick={() => { onApply(picksFrom(matched, table)); onClose(); }}
              >
                Apply
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

async function toImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d canvas context');
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return image;
}
