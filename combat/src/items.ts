/**
 * Consumables: potions and the like, read from their descriptions in the
 * item data, so a re-crawl changes them with the rest.
 *
 *   Green Potion      "Heals Poison,Bleeding Silence, Blind, Burning and Confusion / 10 Seconds Cooldown"
 *   White Potion      "Heals 1500 Base HP / 15 Seconds Cooldown"
 *   Yggdrasil Berry   "Fully Heals HP and SP, 1 minute re-use cooldown."
 *   Kafra Elixir      "Recover 50% HP and SP. Cooldown is 5 seconds."
 *
 * A consumable is an action like a skill, but not one: silence does not
 * stop it and it costs no time, so the player drinks between swings. Each
 * says when it is worth drinking (`wanted`), and the engine drinks whatever
 * is wanted before the rotation picks its move -- the TAS never wastes a
 * potion on full HP, and never forgets one. Stacks are not counted: the
 * TAS is assumed to carry enough.
 */
import { plannerDataset } from './data.ts';
import { drop, has, heal_, type Action, type Fight } from './engine.ts';

export interface Consumable {
  name: string;
  hp: number;
  sp: number;
  /** Share of Max HP / SP restored: 1 for a Yggdrasil Berry. */
  hpShare: number;
  spShare: number;
  /** Status buffs it clears ("silenced"). */
  cures: string[];
  cooldownMs: number;
}

/** Tooltip status words -> the engine's buffs. Only silence is modelled on the player yet. */
const CURES: Record<string, string> = { silence: 'silenced' };

export function readConsumable(name: string): Consumable {
  const item = plannerDataset().itemList.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!item) throw new Error(`no item named "${name}"`);
  const d = item.description.replace(/\n/g, ' ');
  const n = (re: RegExp) => Number(re.exec(d)?.[1] ?? 0);
  const full = /fully heals hp and sp/i.test(d);
  const share = n(/recover (\d+)% hp and sp/i) / 100;
  const cureText = /(?:cure:|heals)\s+([a-z ,]+?)(?:\s*$|\s{2,}|\s\d)/i.exec(d)?.[1] ?? '';
  const cures = Object.entries(CURES)
    .filter(([word]) => new RegExp(`\\b${word}\\b`, 'i').test(cureText)).map(([, buff]) => buff);
  const cooldownMs = 1000 * (n(/(\d+) seconds? cooldown/i) || n(/cooldown is (\d+) seconds?/i)
    || 60 * n(/(\d+) minutes? re-use cooldown/i) || 1);
  return {
    name: item.name,
    hp: n(/heals (\d+) base hp/i),
    sp: n(/(\d+) base sp/i),
    hpShare: full ? 1 : share,
    spShare: full ? 1 : share,
    cures,
    cooldownMs,
  };
}

/**
 * The consumable as an action the engine can take. `charges` limits it per
 * fight (Kafra Elixirs); left out, the TAS is assumed to carry enough.
 */
export function consumableAction(c: Consumable, charges?: number): Action {
  const healed = (fight: Fight) => c.hp * (1 + (fight.f.dmg.potion_healing ?? 0) / 100) + c.hpShare * fight.f.maxHp;
  const restored = (fight: Fight) => c.sp + c.spShare * fight.f.maxSp;
  return {
    id: c.name,
    isSkill: false,
    offensive: false,
    reactive: true, // never a "move": drunk when wanted, see `wanted`
    charges,
    castMs: () => 0,
    delayMs: () => 0,
    cooldownMs: () => c.cooldownMs,
    spCost: () => 0,
    ready: (fight) => wanted(fight, c, healed(fight), restored(fight)),
    resolve(fight) {
      if (c.hp || c.hpShare) heal_(fight, healed(fight));
      if (c.sp || c.spShare) fight.me.sp = Math.min(fight.f.maxSp, fight.me.sp + restored(fight));
      for (const buff of c.cures) drop(fight, buff);
    },
  };
}

/**
 * Worth drinking now? A cure when its status is on you; a heal when none of
 * it would be wasted; a full restore (the berries, the elixir) only once HP
 * is low, since its cooldown is what holds you up at the end of a hard fight.
 */
function wanted(fight: Fight, c: Consumable, hp: number, sp: number): boolean {
  if (c.cures.some((b) => has(fight, b))) return true;
  const me = fight.me; const f = fight.f;
  if (c.hpShare >= 0.5) return me.hp < 0.35 * f.maxHp || (c.spShare >= 0.5 && me.sp < 0.15 * f.maxSp);
  if (hp > 0 && me.hp <= f.maxHp - hp) return true;
  if (sp > 0 && me.sp <= f.maxSp - sp) return true;
  return false;
}

/**
 * What a character carries (the project owner, 2026-09-26):
 *   - Green Potions always: cheap, so no limit.
 *   - Healing items only when asked for: nobody carries hundreds, and they
 *     cost a fortune to burn through.
 *   - Kafra Elixirs against a boss: free there, but 2 a life (more with an
 *     Elixir Badge -- see `Fighter.kafraElixirs`).
 */
export const DEFAULT_CONSUMABLES = ['Green Potion'];
export const HEALING_ITEMS = ['White Potion', 'Blue Potion', 'Yggdrasil Berry'];
export const BOSS_ELIXIR = 'Kafra Elixir';

export function consumables(names: string[]): Action[] {
  return names.map((n) => consumableAction(readConsumable(n)));
}

/** The loadout for one fight: the carried items, plus the elixirs on a boss. */
export function loadout(
  o: { carried: string[]; healing: boolean; boss: boolean; elixirs: number },
): Action[] {
  const names = [...o.carried, ...(o.healing ? HEALING_ITEMS : [])]
    .filter((n, i, all) => all.indexOf(n) === i && n !== BOSS_ELIXIR);
  const out = consumables(names);
  if (o.boss && o.elixirs > 0) out.push(consumableAction(readConsumable(BOSS_ELIXIR), o.elixirs));
  return out;
}
