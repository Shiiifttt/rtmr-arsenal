import { useCallback, useEffect, useState } from 'react';
import type { Build, Dataset } from '@sim';
import {
  applyReadings, diagnose, loadAssets, recognise, type Applied, type Reading,
} from '../recognition';
import { iconUrl } from '../data';
import { tooltipProps } from './ItemTooltip';

interface Props {
  dataset: Dataset;
  build: Build;
  onApply: (build: Build) => void;
  onClose: () => void;
}

type State =
  | { phase: 'waiting' }
  | { phase: 'reading' }
  | { phase: 'done'; readings: Reading[]; applied: Applied }
  | { phase: 'failed'; message: string };

/**
 * Fill a build in from a screenshot.
 *
 * Nothing is applied until the reader has seen what came back. The
 * recogniser is accurate but it is not infallible -- an item added to the
 * server since the last crawl has no icon to match, and the two tabs of the
 * equipment window have to be pasted separately -- so this shows what it
 * found, and what it could not place, before anything overwrites the build.
 */
export function ImportPanel({ dataset, build, onApply, onClose }: Props) {
  const [state, setState] = useState<State>({ phase: 'waiting' });

  const read = useCallback(async (blob: Blob) => {
    setState({ phase: 'reading' });
    try {
      const image = await toImageData(blob);
      const readings = await recognise(image, dataset);
      if (!readings.length) {
        const { font } = await loadAssets();
        setState({ phase: 'failed', message: diagnose(image, font) });
        return;
      }
      setState({ phase: 'done', readings, applied: applyReadings(readings, dataset, build) });
    } catch (error) {
      setState({ phase: 'failed', message: String(error) });
    }
  }, [dataset, build]);

  // Pasting is how most people will use this: screenshot, alt-tab, Ctrl+V.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.items ?? [])]
        .find((item) => item.type.startsWith('image/'))?.getAsFile();
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

  return (
    <div className="overlay" onClick={onClose}>
      <div className="picker import" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>Read a screenshot</strong>
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
            : 'Paste a screenshot, or drop a PNG here.'}
          <div className="empty-note">
            Equipment, Status and Basic Information. The equipment window has two
            tabs; paste each one to fill both. An item's own tooltip adds the
            random rolls it dropped with, once that item is equipped here.
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
          <Result state={state} onApply={onApply} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function Result({ state, onApply, onClose }: {
  state: Extract<State, { phase: 'done' }>;
  onApply: (build: Build) => void;
  onClose: () => void;
}) {
  const { readings, applied } = state;
  const stats = readings.find((r) => r.stats && Object.keys(r.stats).length)?.stats;
  const levels = readings.find((r) => r.levels?.base)?.levels;

  return (
    <>
      <div className="picker-list">
        {applied.placed.map(({ slot, item, refine, cards, unread }) => (
          <div className="picker-row" key={slot.key} {...tooltipProps({ kind: 'item', item, refine, cards })}>
            <img className="icon" src={iconUrl(item) ?? ''} alt="" />
            <div>
              <div>
                {refine > 0 && <span className="pill">+{refine}</span>} {item.name}
              </div>
              <div className="empty-note">
                {slot.label}
                {cards.length > 0 && ` — ${cards.map((c) => c.name).join(', ')}`}
              </div>
              {unread.length > 0 && (
                <div className="empty-note">
                  Some of the name did not read; there may be a card here that
                  was not picked up.
                </div>
              )}
            </div>
          </div>
        ))}

        {stats && (
          <div className="picker-row">
            <div>
              <div>
                Stats {Object.entries(stats)
                  .map(([key, value]) => `${key.toUpperCase()} ${value.base}`)
                  .join('  ')}
              </div>
              {levels?.base && (
                <div className="empty-note">
                  Base level {levels.base}
                  {levels.job ? `, job level ${levels.job}` : ''} — for reference;
                  the planner does not use levels yet.
                </div>
              )}
            </div>
          </div>
        )}

        {applied.rolls.map(({ item, slot, matched }) => (
          <div className="picker-row" key={`roll-${slot.key}`}>
            <img className="icon" src={iconUrl(item) ?? ''} alt="" />
            <div>
              <div>{item.name} — rolls</div>
              {matched.map((roll, i) => (
                <div className="empty-note" key={i}>
                  {roll.label
                    ? `${roll.label} ${roll.values.join(' / ')}`
                    : roll.ambiguous.length
                      ? `${roll.text} — could be ${roll.ambiguous.join(' or ')}; `
                        + 'set it on the slot'
                      : `${roll.text} — not recognised`}
                </div>
              ))}
            </div>
          </div>
        ))}

        {applied.skipped.map((row, index) => (
          <div className="picker-row skipped" key={index}>
            <div>
              <div>{row.text || '(unreadable)'}</div>
              <div className="empty-note">{row.reason}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="picker-foot">
        <span className="empty-note">
          {applied.placed.length} to fill
          {applied.rolls.length > 0 && `, rolls for ${applied.rolls.length}`}
          {applied.skipped.length > 0 && `, ${applied.skipped.length} left out`}
          {' — applying replaces those slots.'}
        </span>
        <div className="spacer" />
        <button
          disabled={!applied.placed.length && !stats && !applied.rolls.length}
          onClick={() => { onApply(applied.build); onClose(); }}
        >
          Apply
        </button>
      </div>
    </>
  );
}

/** Decode whatever was pasted or dropped into pixels. */
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
