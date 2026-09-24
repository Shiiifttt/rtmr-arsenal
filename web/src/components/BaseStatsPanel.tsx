import {
  BASE_LEVEL_MAX, BASE_LEVEL_MIN, BASE_STAT_KEYS, BASE_STAT_MAX, BASE_STAT_MIN,
  clampBaseLevel, clampBaseStat,
  type BaseStats, type Dataset, type DerivedStat, type Totals,
} from '@sim';

interface Props {
  baseStats: BaseStats;
  baseLevel: number;
  totals: Totals;
  dataset: Dataset;
  onChange: (key: keyof BaseStats, value: number) => void;
  onLevelChange: (value: number) => void;
  onManualChange: (key: string, value: number) => void;
}

/**
 * The character's own stat points.
 *
 * Each row shows the points, what the gear adds, and the resulting total,
 * because the two are not interchangeable: bonuses written "per 10 base
 * STR" count only the left-hand column. Showing them side by side makes it
 * obvious which number those bonuses are reading.
 */
export function BaseStatsPanel({
  baseStats, baseLevel, totals, dataset, onChange, onLevelChange, onManualChange,
}: Props) {
  const idOf = (key: string) => dataset.stats.find((s) => s.key === key)?.id;

  return (
    <div className="panel">
      <h2>Character</h2>
      <div className="base-grid">
        <label className="base-row">
          <span className="base-name">LEVEL</span>
          <input
            type="number"
            min={BASE_LEVEL_MIN}
            max={BASE_LEVEL_MAX}
            value={baseLevel}
            onChange={(e) => onLevelChange(clampBaseLevel(Number(e.target.value)))}
          />
          <span className="base-bonus" />
          <span className="base-total" />
        </label>
      </div>
      <div className="base-grid" style={{ marginTop: 8 }}>
        {BASE_STAT_KEYS.map((key) => {
          const statId = idOf(key);
          const total = statId !== undefined ? totals.byStat.get(statId) : undefined;
          const flat = total?.flat ?? 0;
          const percent = total?.percent ?? 0;
          const points = baseStats[key];

          return (
            <label className="base-row" key={key}>
              <span className="base-name">{key.toUpperCase()}</span>
              <input
                type="number"
                min={BASE_STAT_MIN}
                max={BASE_STAT_MAX}
                value={points}
                onChange={(e) => onChange(key, clampBaseStat(Number(e.target.value)))}
              />
              {/* Signed from the value: a gem's "All Stats -5" used to print
                  as "+-5", and in the bonus green. */}
              <span className={`base-bonus ${flat < 0 ? 'bad' : ''}`}>
                {flat ? `${flat > 0 ? '+' : ''}${round(flat)}` : ''}
              </span>
              <span className="base-total">
                {round(points + flat)}
                {percent ? (
                  <em className={percent < 0 ? 'bad' : ''}>
                    {' '}{percent > 0 ? '+' : ''}{round(percent)}%
                  </em>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {totals.derived.length > 0 && (
        <>
          <div className="stat-cat" style={{ marginTop: 14 }}>Derived</div>
          <div className="base-grid">
            {totals.derived.map((d) => (
              <div className="base-row" key={d.key}>
                <span className="base-name">{d.label.toUpperCase()}</span>
                {/* Skills, which the planner does not model. Typed in rather
                    than guessed, so a figure that disagrees with the game can
                    be narrowed down to one of the four steps in the hover. */}
                <input
                  type="number"
                  className="derived-manual"
                  value={d.manual || ''}
                  placeholder="skills"
                  title={d.manualHint ?? 'Bonuses the planner does not model'}
                  onChange={(e) => onManualChange(d.key, Math.trunc(Number(e.target.value)) || 0)}
                />
                <span className={`base-bonus ${d.flat < 0 ? 'bad' : ''}`}>
                  {d.flat ? `${d.flat > 0 ? '+' : ''}${round(d.flat)}` : ''}
                  {d.percent ? (
                    <em className="derived-pct">
                      {' '}{d.percent > 0 ? '+' : ''}{round(d.percent)}%
                    </em>
                  ) : null}
                </span>
                <span
                  className={`base-total ${d.verified ? '' : 'unverified'}`}
                  title={derivationOf(d)}
                >{d.total}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="empty-note" style={{ margin: '10px 0 0', fontSize: 11 }}>
        Points ({BASE_STAT_MIN}–{BASE_STAT_MAX}) · gear · total. Bonuses written
        “per N base STAT” read the points column only; the total is uncapped.
        Derived values are formulas, not data — hover the total to see the
        working. The middle box takes flee from skills, which are not modelled.
      </p>
    </div>
  );
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * The arithmetic spelled out, for checking a figure against the game.
 *
 * If the planner and the character window disagree, this says which half is
 * wrong: the formula, the gear it found, or the order they combine in.
 */
function derivationOf(d: DerivedStat): string {
  const lines = [`${d.formula} = ${d.base}`];
  let running = d.base;
  if (d.flat) {
    running += d.flat;
    lines.push(`gear flat ${d.flat >= 0 ? '+' : ''}${round(d.flat)} -> ${running}`);
  }
  if (d.percent) {
    running = Math.floor(running * (1 + d.percent / 100));
    // Compounding percents are listed one by one, so +16% on the gear does
    // not look like a mistake beside the +16.87% actually applied.
    const how = d.percentParts
      ? ` (${d.percentParts.map((p) => `${p >= 0 ? '+' : ''}${p}%`).join(' x ')})`
      : '';
    lines.push(`then ${d.percent >= 0 ? '+' : ''}${round(d.percent)}%${how} -> ${running}`);
  }
  // Skills come last, outside the percent -- see derivedStats.
  if (d.manual) {
    running += d.manual;
    lines.push(`skills ${d.manual >= 0 ? '+' : ''}${d.manual} -> ${running}`);
  }
  if (!d.flat && !d.percent && !d.manual) lines.push('no bonuses');
  lines.push(`total ${d.total}`);
  if (!d.verified) lines.push('', 'Formula not yet confirmed in game.');
  return lines.join('\n');
}
