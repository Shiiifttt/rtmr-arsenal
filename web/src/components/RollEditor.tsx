import {
  clampRoll, defaultValues, optionOf,
  type RollGrant, type RollOption, type RollPick, type RollTable,
} from '@sim';

interface Props {
  table: RollTable;
  picks: Record<string, RollPick> | undefined;
  onChange: (rollKey: string, pick: RollPick | null) => void;
}

/**
 * The random bonuses this copy of the item dropped with.
 *
 * Every item rolls, but no two copies roll the same, so these cannot come
 * from the database -- the player reads them off their own item and types
 * them in. The dropdown is what the table allows; the number is what they
 * actually got.
 *
 * The value comes first because that is the order the game writes it
 * ("AGI +2" reads as the line does), and every value control is the same
 * width -- sign, box and unit each reserved whether or not they are used --
 * so the dropdowns line up down the card instead of stepping in and out
 * with the presence of a percent sign. A roll that grants two stats at once
 * is the exception and is left to run wide.
 *
 * Rolls worded as reductions ("physical damage reduced") take the magnitude
 * as shown in game and are stored with the sign the stat needs, so the
 * player never has to work out which way round to enter it.
 */
export function RollEditor({ table, picks, onChange }: Props) {
  return (
    <div className="rolls">
      {table.rolls.map((roll) => {
        const pick = picks?.[roll.key];
        const option = optionOf(table, roll.key, pick?.option ?? null);

        const setValue = (i: number, n: number) => {
          const values = [...(pick?.values ?? defaultValues(option!))];
          values[i] = n;
          onChange(roll.key, { ...pick!, option: option!.key, values });
        };

        return (
          <div className="roll" key={roll.key}>
            {option
              // Nothing picked yet still reserves the space, so the row below
              // does not sit half a control to the left of the one above.
              ? option.grants.map((grant, i) => (
                <RollValue
                  key={i}
                  grant={grant}
                  value={pick?.values[i] ?? grant.min}
                  onValue={(n) => setValue(i, n)}
                />
              ))
              : <span className="roll-value ph" aria-hidden="true" />}

            <select
              className="roll-option"
              value={pick?.option ?? ''}
              title={option?.note ?? `${roll.label} roll`}
              onChange={(e) => {
                const next = optionOf(table, roll.key, e.target.value || null);
                onChange(roll.key, next
                  ? { option: next.key, values: defaultValues(next) }
                  : null);
              }}
            >
              <option value="">{roll.label} —</option>
              {roll.options.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>

            {option && <SkillName
              option={option}
              skill={pick?.skill ?? ''}
              onSkill={(name) => onChange(roll.key, {
                ...pick!, option: option.key,
                values: pick?.values ?? defaultValues(option),
                skill: name,
              })}
            />}
          </div>
        );
      })}
    </div>
  );
}

function RollValue({ grant, value, onValue }: {
  grant: RollGrant;
  value: number;
  onValue: (n: number) => void;
}) {
  // A null max is "nobody has established the ceiling", not "no ceiling", so
  // the input stays open and the hint says as much.
  const range = grant.max === null || grant.max === undefined
    ? `${grant.min}+ (upper end unconfirmed)`
    : grant.min === grant.max ? `${grant.min}` : `${grant.min}–${grant.max}`;

  return (
    <label className="roll-value" title={`Range ${range}`}>
      <span className="roll-sign">{(grant.sign ?? 1) < 0 ? '−' : '+'}</span>
      <input
        type="number"
        min={grant.min}
        max={grant.max ?? undefined}
        step={grant.step ?? 1}
        value={value}
        onChange={(e) => onValue(clampRoll(grant, Number(e.target.value)))}
      />
      <span className="roll-unit">{grant.unit ?? ''}</span>
    </label>
  );
}

/** Which skill a skill-modifier roll names. Only shadow gear rolls these. */
function SkillName({ option, skill, onSkill }: {
  option: RollOption;
  skill: string;
  onSkill: (name: string) => void;
}) {
  // A roll that always names the same skill has nothing to ask.
  if (!option.grants.some((g) => g.skill && !g.skill_name)) return null;
  return (
    <input
      className="roll-skill"
      type="text"
      placeholder="skill"
      value={skill}
      title="Which skill the item names"
      onChange={(e) => onSkill(e.target.value)}
    />
  );
}
