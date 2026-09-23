import { useEffect, useRef, useState } from 'react';
import type { Build, Dataset } from '@sim';
import { reconcile } from '../build';
import { fileName, loadSaves, putSave, writeSaves, type SavedBuild } from '../saves';
import { shareUrl } from '../share';

interface Props {
  dataset: Dataset;
  build: Build;
  /** Load a build over the one on screen. Already reconciled. */
  onLoad: (build: Build) => void;
  onClose: () => void;
}

/**
 * Keeping, moving and passing on a build.
 *
 * Four things that are really one thing -- a build you can get back to --
 * so they sit together rather than as four buttons in the toolbar. A named
 * save is for coming back next week, a file is for a backup or another
 * machine, and a link is for showing someone.
 */
export function BuildsPanel({ dataset, build, onLoad, onClose }: Props) {
  const [saves, setSaves] = useState<SavedBuild[]>(loadSaves);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commit = (next: SavedBuild[], said: string) => {
    const failed = writeSaves(next);
    setSaves(failed ? loadSaves() : next);
    setNote(failed ?? said);
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const replacing = saves.some((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    commit(putSave(saves, trimmed, build),
      replacing ? `Replaced “${trimmed}”.` : `Saved as “${trimmed}”.`);
    setName('');
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(build, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(name || 'build');
    a.click();
    URL.revokeObjectURL(url);
    setNote('Exported.');
  };

  const read = async (chosen: File) => {
    try {
      const parsed = JSON.parse(await chosen.text());
      if (!parsed || typeof parsed !== 'object' || !parsed.slots) {
        setNote('That file is not a build.');
        return;
      }
      onLoad(reconcile(parsed as Build, dataset));
      setNote(`Loaded ${chosen.name}.`);
    } catch {
      setNote('Could not read that file.');
    }
  };

  const share = async () => {
    const url = await shareUrl(build);
    setLink(url);
    try {
      await navigator.clipboard.writeText(url);
      setNote('Link copied. It carries the whole build — nothing is uploaded.');
    } catch {
      // Denied permission, or an insecure origin. The link is on screen
      // either way, which is the part that matters.
      setNote('Link ready — copy it from the box below.');
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="picker builds" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>Builds</strong>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="builds-body">
          <div className="builds-row">
            <input
              placeholder="Name this build"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              style={{ flex: 1 }}
            />
            <button onClick={save} disabled={!name.trim()}>Save</button>
            <button onClick={download} title="Download this build as a .json file">
              Export
            </button>
            <button onClick={() => file.current?.click()} title="Load a .json build file">
              Import
            </button>
            <button onClick={() => void share()} title="A link carrying this whole build">
              Share link
            </button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                // Cleared so choosing the same file twice fires again.
                e.target.value = '';
                if (chosen) void read(chosen);
              }}
            />
          </div>

          {note && <p className="builds-note">{note}</p>}

          {link && (
            <input
              className="share-link"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}

          {saves.length === 0 ? (
            <p className="empty-note">
              No saved builds yet. The build on screen is kept as you work on it;
              a name here is how you keep more than one.
            </p>
          ) : (
            <div className="save-list">
              {saves.map((saved) => (
                <div className="save-row" key={saved.id}>
                  <span className="save-name">{saved.name}</span>
                  <span className="save-when">{when(saved.savedAt)}</span>
                  <button onClick={() => {
                    onLoad(reconcile(saved.build, dataset));
                    setNote(`Loaded “${saved.name}”.`);
                  }}>Load</button>
                  <button
                    className="x"
                    title={`Delete “${saved.name}”`}
                    aria-label={`Delete ${saved.name}`}
                    onClick={() => commit(saves.filter((s) => s.id !== saved.id),
                      `Deleted “${saved.name}”.`)}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function when(at: number): string {
  if (!at) return '';
  return new Date(at).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric' });
}
