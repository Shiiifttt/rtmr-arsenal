/**
 * Kingslayer: the Duelist line's final job (server job slot Shadow Chaser).
 *
 * Numbers come from the tooltips (data/raw/db-skills.json), which the
 * project owner says are more accurate than the 2023 server code
 * (2026-09-26). The code fills in only what a tooltip leaves unsaid -- how the
 * shield's weight and refine count, how a hit earns a Duel Counter, what
 * Finisher Ready does -- per .claude/scratch/kingslayer-server.md.
 *
 * From the project owner (2026-09-26):
 *   - Main buffs up before the pull (long casts): Bishop's Guard, Knight's
 *     Regen, King's Fortress. Rook's Wall and Queen's Barrier optional.
 *   - Shield build: max Duel Counters, Shield Boomerang into King's Chains
 *     (Bulwark Gem combo), fillers Rook's Smash, Queen's Brand and the Rogue
 *     skills. Dodge with Pawn's Rod, King's Gambit, Hiding and Decoy.
 *   - Queen's Gambit build: Nopaew Lufrewop, an Auto Guard 10 shield.
 *   - Hiding -> Sneak Attack and Bishop's Tax raise damage for the big hits.
 *   - Check Mate: not used (heavy SP investment; 250k cap live). Riposte:
 *     clunky. Both are off unless a profile turns them on.
 *
 * Confirmed by the project owner (2026-09-26): King's Chains spends 1
 * counter, Queen's Brand 3 (the 2023 code: 5); Queen's Gambit lands 9 hits.
 *
 * Assumptions to confirm (README open questions):
 *   - Shield skills: base ATK + the shield's weight / 9 (weight in the
 *     server's 0.1 units) in place of weapon ATK, +10 per shield refine after
 *     DEF (2023 code); element as the tooltip, the weapon's.
 */
import type { Passives } from '../character.ts';
import { defMultiplier, effectivePierce } from '../../../sim/src/derived.ts';
import { attrFix, countsAsBoss, magicDamage, physicalCardFix, physicalDamage, refineAtk, TUNE } from '../formulas.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import { playbookPlan } from '../playbook.ts';
import {
  canUse, dot, followUpComing, grant, has, mobCloaked, noteProc, readMarks, readyAt, say, stacks, strike,
  type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, attackAction, backSlide, breakSight, hidingAction, lv, morrocsMark, optionOn, orphanHeal, pullOffWard, stayHidden,
  cellMs, reactionMs, toolkit, waitAction, walkOut, wardUp,
} from './common.ts';
import {
  autoDefense, COMMON_TOOLS, heldForSnap, isPreempt, predictActions, priorityWith, reactWith, snapThreatDue, stayReadyAction, type DefenseTool,
} from './defense.ts';

const TREE = ['Kingslayer', 'Duelist', 'Rogue', 'Thief', 'Orphan'];

const element = (fight: Fight) => fight.f.weapon?.element ?? 'Neutral';
const T = toolkit(TREE, element);
const { cast, cooldown, spCost, learned } = T;

export const ALIASES: Record<string, string[]> = {};

const SKILLS = [
  "King's Chains", 'Shield Boomerang', "Rook's Smash", "Queen's Brand", "Queen's Gambit", 'Retribution',
  'Check Mate', 'Delta Skyfall', 'Wind Slash', 'Overpower', 'Face-Off', 'Sneak Attack', "Bishop's Tax",
  'Decoy', 'Riposte', "Pawn's Rod", "King's Gambit", "Queen's Barrier", "Rook's Wall", 'Reflect Shield',
  "Bishop's Guard", "Knight's Regen", "King's Fortress", 'Duel Stance', 'Ready to Rip', 'Hiding',
  "Morroc's Mark", 'Shield Mastery', 'Blade Mastery', 'Improve Dodge', 'Improve Defense', 'Improve Wisdom',
  'Increase SP Recovery', 'Heal', "Pawn's Cure",
  // Rogue's Magic Pierce: passives() read it for DEF pen, but it was missing here, so always 0 (found 2026-10-02).
  'Magic Pierce',
];

export function maxLevels(): Record<string, number> {
  return Object.fromEntries(SKILLS.map((n) => [n, T.sk(n).row.max]));
}

export function passives(
  levels: Record<string, number>, weaponType: string | null, baseLevel: number,
): Passives {
  const L = (n: string) => levels[n] ?? 0;
  // A Long Sword counts: the Ruined Noble Sword's own bonus is Queen's Brand, a sword-or-dagger skill.
  const blade = ['Dagger', 'Sword', 'One-Handed Sword', 'Long Sword'].includes(weaponType ?? '');
  return {
    // Blade Mastery: "3 Atk ... per level", swords and daggers.
    masteryAtk: blade ? 3 * L('Blade Mastery') : 0,
    hit: 0,
    // Improve Dodge: "4 flee per level".
    flee: 4 * L('Improve Dodge'),
    // Improve Defense "1 HP per skill level, per Base Level"; Shield Mastery
    // "25 HP per level"; Bishop's Guard "500 per level" (up the whole fight).
    hpFlat: L('Improve Defense') * baseLevel + 25 * L('Shield Mastery') + 500 * L("Bishop's Guard"),
    // Gadget Mastery (RA_RESEARCHTRAP): +1 INT a level and 10 + 5 SP a level,
    // whatever the weapon (RTM status.cpp:4656, 3898).
    spFlat: Math.floor((L('Improve Wisdom') * 2 * baseLevel) / 3) + (L('Gadget Mastery') > 0 ? 10 + 5 * L('Gadget Mastery') : 0),
    stats: { int: L('Gadget Mastery') },
    // Magic Pierce (AB_EXPIATIO): the target's DEF 1% a level lower, a buff
    // kept up (RTM battle.cpp:5489) -- as DEF penetration.
    defPen: L('Magic Pierce'),
    // Duel Stance "Increase Max HP by 2% per level", held all fight.
    hpPercent: 2 * L('Duel Stance'),
    spRegen: { flat: 2 * L('Increase SP Recovery'), maxShare: 0.001 * L('Increase SP Recovery') },
    notes: [
      'passives: Blade Mastery (ATK), Improve Dodge (flee), Improve Defense + Shield Mastery + Bishop\'s Guard (HP), '
        + 'Duel Stance (Max HP %), Improve Wisdom (SP); Bishop\'s Guard\'s VIT DEF bonus not modelled',
    ],
  };
}

// ---- Duel Counters --------------------------------------------------------------

const MAX_COUNTERS = 10;
const counters = (fight: Fight) => stacks(fight, 'counters');
function setCounters(fight: Fight, n: number) {
  fight.me.buffs.counters = { until: 1e12, stacks: Math.max(0, Math.min(MAX_COUNTERS, n)) };
}

/**
 * Duel Stance: a physical hit that damages you gives a counter at 25 + 15%
 * per level (the tooltip; the 2023 code agrees: once per attack, never for
 * magic or a blocked hit). A rollout weighs the chance in.
 */
function onHurt(fight: Fight, hit: { physical: boolean }) {
  gemAutocast(fight);
  if (!hit.physical || !has(fight, 'duelStance')) return;
  const p = Math.min(1, (25 + 15 * lv(fight.f, 'Duel Stance')) / 100);
  if (fight.rng.expect) setCounters(fight, counters(fight) + p);
  else if (fight.rng.chance(p)) setCounters(fight, counters(fight) + 1);
}

/**
 * Bulwark Gem of the Weak: "1% chance to Autocast Shield Boomerang and
 * King's Chains when hit", under "Per Refine:" -- so +1% a refine (the
 * project owner, 2026-09-27). Both, free, the chain lifted by the combo; a
 * rollout (expected-value mode) skips it.
 */
const autocastChance = new WeakMap<Fighter, number>();
function gemAutocast(fight: Fight) {
  let p = autocastChance.get(fight.f);
  if (p === undefined) {
    // character.ts reads it off the gear, per refine where the text says so.
    const hits = (fight.f.autocastWhenHit ?? []).filter((a) => a.skills.includes('Shield Boomerang') && a.skills.includes("King's Chains"));
    autocastChance.set(fight.f, p = Math.min(1, hits.reduce((n, a) => n + a.chance, 0)));
  }
  // Option gemFirstHit: the first hit taken always procs it -- a test of what
  // one proc is worth (the project owner, 2026-09-30).
  const forced = fight.options.gemFirstHit === true && !fight.me.spent.gemFirstHit && !fight.rng.expect && hasShield(fight);
  if (forced) fight.me.spent.gemFirstHit = true;
  if (!forced && (!p || fight.rng.expect || !hasShield(fight) || !fight.rng.chance(p))) return;
  fight.me.buffs.gemProcs = { until: 1e12, stacks: (fight.me.buffs.gemProcs?.stacks ?? 0) + 1 };
  fight.log && say(fight, "Bulwark Gem autocasts Shield Boomerang and King's Chains");
  noteProc(fight, 'Shield Boomerang'); noteProc(fight, "King's Chains");
  shieldBoomerang.resolve(fight);
  kingsChains.resolve(fight);
}

// ---- damage helpers -----------------------------------------------------------------

/** A weapon skill hit off the weapon. */
const weaponHit = (fight: Fight, name: string, ratio: number, o: { ranged?: boolean } = {}) =>
  T.physical(fight, name, ratio, o);

/**
 * A shield skill hit (King's Chains, Shield Boomerang). Fitted to the
 * project owner's dummy readings (2026-09-26, profiles/kingslayer-dummy.json:
 * King's Chains 7,155 a shown hit, Shield Boomerang 6,269): the base is the
 * shield's weight / 9 (weight in the server's 0.1 units, as the 2023 code)
 * plus equip ATK, times ATK% -- no mastery ATK, no status ATK, no STR bonus, and
 * not the doubled skill ATK weapon skills get. Then the ratio, long-range
 * damage, DEF, the skill's gear bonus, and 10 per shield refine on top.
 * Gives 7,163 and 6,179.
 *
 * No weapon mastery (Blade Mastery) on shield skills: the project owner
 * (2026-09-30) and every Chains reading since. The 2023 renewal code would
 * add it (battle.cpp battle_skill_stacks_masteries_vvs exempts them only
 * #ifndef RENEWAL) -- the readings win.
 */
function shieldHit(fight: Fight, name: string, ratio: number, mult = 1) {
  const f = fight.f; const s = f.shield!;
  // No weapon mastery: the 2023 code gives the shield skills no mastery ATK
  // (battle.cpp:3580, the damage parts are never filled in), and the owner's
  // readings of 2026-09-28 (no weapon 5,669; Abandoned Guardian 7,155) fit
  // only without Blade Mastery.
  const base = Math.floor((s.weight * 10) / 9) + f.equipAtk;
  // Always Neutral, whatever the weapon (the project owner, 2026-09-27).
  const hit = plainHit(fight, name, base, ratio, true, 'Neutral');
  return (crit: boolean) => (hit(crit) + 10 * s.refine) * mult;
}

/**
 * A hit on a fixed base rather than the full ATK: base x ATK% x cards x
 * element x long/short-range damage x ratio, then DEF and the skill's gear
 * bonus. No status ATK, no STR bonus on the weapon, no doubled skill ATK --
 * what the owner's shield and Rook's Smash readings fit.
 */
function plainHit(fight: Fight, name: string, base: number, ratio: number, ranged: boolean, ele = element(fight)) {
  const f = fight.f; const m = fight.m;
  const skillDamage = f.skillMods(name, 'damage').percent;
  return (_crit: boolean) => {
    let dmg = base * (1 + f.atkPercent / 100) * physicalCardFix(f, m) * attrFix(ele, m.element, m.elementLevel);
    dmg *= 1 + (ranged ? f.dmg.ranged_damage ?? 0 : f.dmg.melee_damage ?? 0) / 100;
    dmg *= ratio / 100;
    dmg = dmg * defMultiplier(m.def, effectivePierce(f.defPen)) - m.softDef;
    return Math.max(1, dmg) * (1 + skillDamage / 100);
  };
}

/**
 * Shield Mastery and King's Fortress Lv3 "+1% per STR and 2% per VIT" on
 * shield skills. Shield Mastery is +20% a level in the game's own
 * description (the project owner, 2026-09-28); the crawled text still says
 * 10%. The owner's King's Chains readings of 2026-09-28 fit 20% within 1%.
 */
function shieldBonus(fight: Fight): number {
  const s = fight.f.stats;
  return 20 * lv(fight.f, 'Shield Mastery') + (fortressLevel(fight) >= 3 ? s.str + 2 * s.vit : 0);
}

const hasShield = (fight: Fight) => !!fight.f.shield;
const bladeInHand = (fight: Fight) => ['Dagger', 'Sword', 'One-Handed Sword', 'Long Sword'].includes(fight.f.weapon?.type ?? '');
const fortressLevel = (fight: Fight) => (has(fight, 'fortress') ? fight.me.buffs.fortress.stacks : 0);
/** The Bulwark Gem's "Shield Boomerang can combo into King's Chains within 3 s for 50% more damage". */
const comboGem = new WeakMap<Fighter, boolean>();
const hasComboGem = (f: Fighter) => {
  let v = comboGem.get(f);
  if (v === undefined) comboGem.set(f, v = /Shield\s+Boomerang\s+can\s+combo\s+into\s+King's\s+Chains/i.test(f.gearText ?? ''));
  return v;
};

// ---- attacks -------------------------------------------------------------------------

// Sword and shield at 1 AGI swing too slowly to be worth the time: off
// unless a profile sets autoAttack (the project owner, 2026-09-27).
const swing = attackAction(T);
const attack: Action = { ...swing, ready: (fight) => fight.options.autoAttack === true };
const orphan = orphanHeal(T);
// Option healBelow (a share of Max HP): Heal only under it -- the owner's 75%
// (2026-09-29). Unset: whenever a whole Heal fits in the missing HP.
const heal: Action = {
  ...orphan,
  ready: (fight) => optionOn(fight, 'heal') && orphan.ready!(fight)
    && (typeof fight.options.healBelow !== 'number' || fight.me.hp < fight.options.healBelow * fight.f.maxHp),
};

const kingsChains: Action = {
  id: "King's Chains",
  isSkill: true,
  offensive: true,
  // With the Bulwark Gem it always follows Shield Boomerang, even at a little
  // downtime: the x1.5 is worth it (the project owner, 2026-09-27).
  ready: (fight) => learned("King's Chains")(fight) && hasShield(fight) && counters(fight) >= 1
    && (!hasComboGem(fight.f) || has(fight, 'sbCombo') || !optionOn(fight, 'alwaysCombo'))
    // Option retriCombo (the project owner's burst, 2026-09-30): build to 10
    // counters (Delta, Queen's Gambit), Tax, Retribution for Finisher Ready,
    // Rook's Smash, Boomerang, Chains -- so Chains waits while Retribution is
    // off cooldown and Finisher Ready is not up.
    && !(fight.options.retriCombo === true && learned('Retribution')(fight)
      && readyAt(fight, 'Retribution') <= fight.t && !has(fight, 'finisher'))
    // Option comboCounters: under Finisher Ready, Chains waits for this many counters (the owner's two Deltas).
    && !(fight.options.retriCombo === true && has(fight, 'finisher')
      && counters(fight) < (typeof fight.options.comboCounters === 'number' ? fight.options.comboCounters : 1)),
  castMs: cast("King's Chains"),
  cooldownMs: cooldown("King's Chains"),
  spCost: spCost("King's Chains"),
  resolve(fight) {
    const f = fight.f; const s = f.stats; const l = lv(f, "King's Chains");
    // Counters as they were when it went off: the owner's reading at 10
    // fits 10 in the ratio, not the 9 left after its cost.
    const held = counters(fight);
    setCounters(fight, held - 1);
    const missing = Math.floor(((f.maxHp - fight.me.hp) * 100) / f.maxHp);
    // "200+10% per level +1% per VIT/STR", "Extra 1% per VIT per Duel
    // Counter", "Extra 1% per Soft DEF and Hard DEF", "Finisher Ready: extra
    // 30% per missing HP %".
    const ratio = 200 + 10 * l + s.vit + s.str + s.vit * held + f.softDef + f.def
      + shieldBonus(fight) + (has(fight, 'finisher') && fight.options.finisher !== false ? 30 * missing : 0);
    // (option finisher: false turns the Finisher Ready bonus off -- a test while it is unconfirmed live.)
    const combo = has(fight, 'sbCombo') ? 1.5 : 1;
    if (combo > 1) delete fight.me.buffs.sbCombo;
    // "Throws a rebounding shield 4 times": one roll shown as four; ignores flee.
    strike(fight, "King's Chains", { hits: 4, split: true, canMiss: false, critBonus: null, kind: 'ranged',
      damage: shieldHit(fight, "King's Chains", ratio, combo) });
  },
};

/**
 * King's Chains will be ready, with a counter to spend, within `ms`: the
 * window a Shield Boomerang, Bishop's Tax or Sneak Attack is spent to lift.
 */
function comboSoon(fight: Fight, ms: number): boolean {
  return learned("King's Chains")(fight) && hasShield(fight) && counters(fight) >= 1
    && readyAt(fight, "King's Chains") <= fight.t + ms;
}

const shieldBoomerang: Action = {
  id: 'Shield Boomerang',
  isSkill: true,
  offensive: true,
  // Thrown freely; King's Chains is the one that waits for it (the project
  // owner, 2026-09-27).
  ready: (fight) => learned('Shield Boomerang')(fight) && hasShield(fight),
  castMs: () => 0,
  cooldownMs: cooldown('Shield Boomerang'),
  spCost: spCost('Shield Boomerang'),
  resolve(fight) {
    const f = fight.f; const l = lv(f, 'Shield Boomerang');
    // "Damage is 200+20% per level +1% per vit".
    const ratio = 200 + 20 * l + f.stats.vit + shieldBonus(fight);
    strike(fight, 'Shield Boomerang', { hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: shieldHit(fight, 'Shield Boomerang', ratio) });
    if (hasComboGem(f)) grant(fight, 'sbCombo', 3000);
  },
};

const rooksSmash: Action = {
  id: "Rook's Smash",
  isSkill: true,
  offensive: true,
  ready: (fight) => learned("Rook's Smash")(fight) && hasShield(fight) && optionOn(fight, 'rooksSmash'),
  castMs: () => 0,
  cooldownMs: cooldown("Rook's Smash"),
  spCost: spCost("Rook's Smash"),
  resolve(fight) {
    const f = fight.f; const l = lv(f, "Rook's Smash");
    // "Generates up to 3 Duel Counters under Duel Stance", before it lands.
    if (has(fight, 'duelStance')) setCounters(fight, Math.max(counters(fight), 3));
    // "150+5% per level + 1% per Str", "Extra 25% Damage per Duel Counter",
    // "Additional Damage equal 1/5 HP" -- Max HP (the project owner, 2026-10-02),
    // "Dealing 2 hits, with full damage on each", 3 when it cannot be knocked back (the owner).
    const ratio = 150 + 5 * l + f.stats.str + 25 * counters(fight);
    // HP / 5 is added after the ratio and the element (battle.cpp
    // battle_calc_skill_constant_addition): no element, no cards, but the
    // monster's DEF still cuts it with the rest of the hit.
    const hpPart = (fight.f.maxHp / 5) * defMultiplier(fight.m.def, effectivePierce(fight.f.defPen));
    // The weapon's part is small: at full HP the owner's hit is 5,876 against
    // HP / 5 = 5,606. It fits the weapon's own ATK + refine + equip ATK
    // (x ATK%, the ratio at 10 counters and long-range damage): ~277 to ~272.
    const w = f.weapon;
    const weaponBase = (w ? w.atk + refineAtk(w.level, w.refine) : 0) + f.equipAtk;
    const weaponPart = plainHit(fight, "Rook's Smash", weaponBase, ratio, true);
    // The second hit lands twice on a target the first did not knock back
    // (the project owner's dummy, 2026-09-27: 5,876 + 5,881 + 5,881): a
    // boss, or the dummy. Anything else is pushed away after two.
    const hits = fight.m.boss || fight.m.dummy || fight.m.noKnockback ? 3 : 2;
    for (let i = 0; i < hits; i++) {
      // A short-range hit to the server (KN_SPEARSTAB, you slide onto the
      // target): Reflect Shield sends 38% of it back and Safety Wall stops it.
      // The owner's log on Heartless (2026-09-29): three hits of 1,562 = 38%
      // of his ~4,110 Rook's Smash. Its damage still takes long-range bonuses.
      strike(fight, "Rook's Smash", { hits: 1, canMiss: true, critBonus: null, kind: 'melee',
        damage: (crit) => weaponPart(crit) + hpPart });
    }
  },
};

/** Queen's Brand "Requires 3 Duel Counters to cast" -- and spends them (the project owner). */
const BRAND_COUNTERS = 3;
const queensBrand: Action = {
  id: "Queen's Brand",
  isSkill: true,
  offensive: true,
  // ~30 damage per SP on one target (the sim, 2026-09-27) against ~125 for
  // King's Chains, and its 3 counters feed King's Chains and Retribution:
  // a profile can set queensBrand: false to keep them for those.
  ready: (fight) => learned("Queen's Brand")(fight) && bladeInHand(fight) && counters(fight) >= BRAND_COUNTERS
    && optionOn(fight, 'spendCounters') && optionOn(fight, 'queensBrand'),
  castMs: cast("Queen's Brand"),
  cooldownMs: cooldown("Queen's Brand"),
  spCost: spCost("Queen's Brand"),
  resolve(fight) {
    const f = fight.f; const l = lv(f, "Queen's Brand");
    setCounters(fight, counters(fight) - BRAND_COUNTERS);
    // "250+15% per level + 3% per Vit", "Extra 30% Damage per Duel Counter",
    // "If on Duel Stance, bonus damage by 1/20 of current HP".
    const ratio = 250 + 15 * l + 3 * f.stats.vit + 30 * counters(fight);
    const hpPart = has(fight, 'duelStance') ? fight.me.hp / 20 : 0;
    strike(fight, "Queen's Brand", { hits: 3, split: true, canMiss: true, critBonus: null, kind: 'melee',
      damage: (crit) => weaponHit(fight, "Queen's Brand", ratio)(crit) + hpPart });
  },
};

/** Queen's Gambit's hits per cast: 9 (the project owner; the 2023 unit ticks every 100 ms for 0.95 s). */
const QG_TICKS = 9;
const queensGambit: Action = {
  id: "Queen's Gambit",
  isSkill: true,
  offensive: true,
  // "Defense decreases by 50% during cast time."
  castDefCut: 0.5,
  // Risky (25% Max HP, DEF halved while casting): the opener, or right after
  // Rook's Smash and Delta Skyfall to take counters up, or to refill them --
  // not once they are high (the project owner, 2026-09-27). Never below 65%
  // HP, so the cost leaves 40%.
  // Option simple: once a fight, timed to the King's Gambit (simpleGambitNow).
  // A cloaked monster (Famine Incarnate's Invisible): its area pulls it out
  // (the project owner, 2026-09-29: "can try" -- unconfirmed), whatever the
  // other rules say. Option revealGambit, on unless a profile turns it off.
  findsCloaked: true,
  ready: (fight) => learned("Queen's Gambit")(fight) && fight.me.hp >= 0.65 * fight.f.maxHp
    && (mobCloaked(fight) ? optionOn(fight, 'revealGambit')
      : optionOn(fight, 'queensGambit')
        && (simple(fight) ? simpleGambitNow(fight) : castIsSafe(fight, cast("Queen's Gambit")(fight)) && counters(fight) <= 5)),
  castMs: cast("Queen's Gambit"),
  cooldownMs: cooldown("Queen's Gambit"),
  spCost: spCost("Queen's Gambit"),
  // "Requires Extra 25% Max HP to cast."
  hpCost: (fight) => Math.floor(0.25 * fight.f.maxHp),
  resolve(fight) {
    const f = fight.f; const l = lv(f, "Queen's Gambit");
    // "Damage is ATK+MATK divided by 2. Extra 25% damage per level. Extra
    // 0.5% per INT damage." The owner's reading (~1,929 a hit) fits ATK +
    // MATK with no halving (as the 2023 code), at 100 + 25% a level + INT/2.
    const ratio = 100 + 25 * l + 0.5 * f.stats.int;
    const skillDamage = f.skillMods("Queen's Gambit", 'damage').percent;
    if (mobCloaked(fight)) {
      delete fight.mob.buffs.invisible; delete fight.mob.buffs.hiding;
      fight.log && say(fight, `Queen's Gambit pulls ${fight.m.name} out of hiding`);
    }
    const ele = element(fight);
    strike(fight, "Queen's Gambit", {
      hits: QG_TICKS, canMiss: false, critBonus: null, kind: 'magic', aoe: true,
      damage: (crit) => {
        const atk = physicalDamage(f, fight.m, {
          ratio: 100, element: ele, statusElement: 'Neutral', ranged: false, crit, skillDamage: 0,
        }, fight.rng);
        const matk = magicDamage(f, fight.m, { ratio: 100, element: ele, skillDamage: 0, bonus: 0 }, fight.rng);
        return (atk + matk) * (ratio / 100) * (1 + skillDamage / 100);
      },
    });
    if (simple(fight)) fight.me.buffs.gambitsCast = { until: 1e12, stacks: stacks(fight, 'gambitsCast') + 1 };
    // "Gives you 5 Duel Counters if it hits enemies."
    setCounters(fight, counters(fight) + 5);
  },
};

const retribution: Action = {
  id: 'Retribution',
  isSkill: true,
  offensive: true,
  // Only with enough counters to be worth what King's Chains loses (+VIT%
  // a counter): option retributionAt, 10 by default -- which also brings
  // Finisher Ready.
  ready: (fight) => learned('Retribution')(fight) && optionOn(fight, 'spendCounters')
    && counters(fight) >= (typeof fight.options.retributionAt === 'number' ? fight.options.retributionAt : 10),
  castMs: cast('Retribution'),
  cooldownMs: cooldown('Retribution'),
  spCost: spCost('Retribution'),
  resolve(fight) {
    const f = fight.f; const l = lv(f, 'Retribution');
    const spent = Math.floor(counters(fight));
    setCounters(fight, 0);
    // "Damage is 200+50% per level + 5% per VIT", "Extra 3% per VIT damage per counter".
    const ratio = 200 + 50 * l + 5 * f.stats.vit + 3 * f.stats.vit * spent;
    strike(fight, 'Retribution', { hits: 1, canMiss: true, critBonus: null, kind: 'melee',
      damage: weaponHit(fight, 'Retribution', ratio) });
    // "10 counters also grant Finisher Ready for 5s": half damage taken, and
    // King's Chains +30% per missing HP % (2023 code).
    if (spent >= MAX_COUNTERS) grant(fight, 'finisher', 5000);
  },
};

const checkMate: Action = {
  id: 'Check Mate',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Check Mate')(fight) && fight.options.checkMate === true,
  castMs: cast('Check Mate'),
  cooldownMs: cooldown('Check Mate'),
  // The SP column is paid first; the rest of your SP goes into the blow.
  spCost: spCost('Check Mate'),
  resolve(fight) {
    const f = fight.f;
    // "200+1% per Current SP +10% of Max HP", "Doubled Damage with 6 or more
    // Duel Counters", "capped at 250,000 before debuffs" (live, the owner).
    const ratio = 200 + fight.me.sp;
    fight.me.sp = 0;
    const doubled = counters(fight) >= 6 ? 2 : 1;
    const hpPart = 0.1 * f.maxHp;
    strike(fight, 'Check Mate', { hits: 1, canMiss: false, critBonus: null, kind: 'melee',
      damage: (crit) => Math.min(250_000, (weaponHit(fight, 'Check Mate', ratio)(crit) + hpPart) * doubled) });
  },
};

/** A plain weapon filler read straight from its tooltip line. */
function filler(id: string, ratio: (fight: Fight) => number,
  o: { ranged?: boolean; ignoreFlee?: boolean; crit?: boolean; blade?: boolean; rogue?: boolean } = {}): Action {
  return {
    id,
    isSkill: true,
    offensive: true,
    // The Rogue fillers cost more SP than their damage is worth, and a player
    // keeps to the Kingslayer's own attacks (the project owner, 2026-09-27):
    // off unless a profile sets rogueFillers.
    ready: (fight) => learned(id)(fight) && (!o.blade || bladeInHand(fight))
      // Wind Slash alone (option windSlash): the one ranged Rogue filler,
      // so it keeps you out of melee behind Rook's Wall.
      && (!o.rogue || fight.options.rogueFillers === true || (id === 'Wind Slash' && fight.options.windSlash === true)),
    castMs: cast(id),
    cooldownMs: cooldown(id),
    spCost: spCost(id),
    resolve(fight) {
      strike(fight, id, { hits: 1, canMiss: !o.ignoreFlee, critBonus: o.crit ? 0 : null,
        kind: o.ranged ? 'ranged' : 'melee', damage: weaponHit(fight, id, ratio(fight), { ranged: o.ranged }) });
    },
  };
}
const L = (fight: Fight, n: string) => lv(fight.f, n);
// "Damage is 150+25% per level +2% per STR", "can CRIT", range 5+.
const windSlash = filler('Wind Slash', (x) => 150 + 25 * L(x, 'Wind Slash') + 2 * x.f.stats.str, { ranged: true, crit: true, blade: true, rogue: true });
// "Damage is 230+10% per level + 3% per AGI", sword or dagger. With Rook's
// Smash it fills counters to 5 (the project owner, 2026-09-27; the 2023 code:
// +1 a hit, up to 5).
// "Extra VIT scaling damage per 2 duel counters": +1% of VIT per 2 counters
// (Refuge Patch 15, 2026-09-12) -- +5 x VIT% held at 10.
const deltaBase = filler('Delta Skyfall', (x) => 230 + 10 * L(x, 'Delta Skyfall') + 3 * x.f.stats.agi
  + x.f.stats.vit * Math.floor(counters(x) / 2), { ranged: true, blade: true });
const deltaSkyfall: Action = {
  ...deltaBase,
  // As a filler it is poor per SP (~23 damage a point on Heartless, against
  // 77 for King's Chains): cast to build counters, unless deltaFiller is set.
  ready: (fight) => deltaBase.ready!(fight)
    && (fight.options.deltaFiller === true || (has(fight, 'duelStance') && counters(fight) < 5)),
  resolve(fight) {
    deltaBase.resolve(fight);
    // +1 a cast, up to 5 (the project owner, 2026-09-30; was +3 from the 2023 code's per-hit gain).
    if (has(fight, 'duelStance') && counters(fight) < 5) setCounters(fight, Math.min(5, counters(fight) + 1));
  },
};
// "Damage is 160+10% per level +2% per STR", "Ignores flee".
const overpower = filler('Overpower', (x) => 160 + 10 * L(x, 'Overpower') + 2 * x.f.stats.str, { ignoreFlee: true, rogue: true });
// "Damage is 200+25% per level +1% per STR" (the wall double is left out).
const faceOff = filler('Face-Off', (x) => 200 + 25 * L(x, 'Face-Off') + x.f.stats.str, { rogue: true });

/**
 * Dragon Breath, from gear (the Old Dragon shadow set grants Lv10; its
 * pendant alone Lv5): "Damage is 100+30% per level +5% per VIT", Fire,
 * "guaranteed damage" (ignores flee), "Boosted by Long Range amplifiers",
 * 0.5 s + 0.5 s cast, 10 s cooldown. The 2023 code runs it as a weapon hit
 * that DEF still cuts. Dragon Pact (granted with it) is taken as up.
 */
const dragonBreath: Action = {
  id: 'Dragon Breath',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Dragon Breath')(fight) && castIsSafe(fight, cast('Dragon Breath')(fight)),
  castMs: cast('Dragon Breath'),
  cooldownMs: cooldown('Dragon Breath'),
  spCost: spCost('Dragon Breath'),
  resolve(fight) {
    const f = fight.f; const l = L(fight, 'Dragon Breath');
    const ratio = 100 + 30 * l + 5 * f.stats.vit;
    const skillDamage = f.skillMods('Dragon Breath', 'damage').percent;
    strike(fight, 'Dragon Breath', { hits: 1, canMiss: false, critBonus: null, kind: 'ranged',
      damage: (crit) => physicalDamage(f, fight.m, {
        ratio, element: 'Fire', statusElement: 'Neutral', ranged: true, crit, skillDamage,
      }, fight.rng) });
  },
};

/**
 * Decoy: a dodge for a skill cast at you, the way Hiding is (the project
 * owner, 2026-09-27) -- you dash back and hide as the clone goes off, so
 * the cast finds nobody. Not a filler.
 *
 * Only against a non-boss caster: Decoy puts you in a state of its own, not
 * Hiding's, which on this server stops single-target casts from anything
 * (the project owner's reading, 2026-09-29 -- an assumption, untested).
 */
const decoyAnswers = (m: Monster) => !countsAsBoss(m);
const decoy: Action = {
  id: 'Decoy',
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: learned('Decoy'),
  castMs: cast('Decoy'),
  cooldownMs: cooldown('Decoy'),
  spCost: spCost('Decoy'),
  resolve(fight) {
    const s = fight.f.stats;
    // "Damage is 200+25% per level +1% per INT and LUK." The clone explodes; you dash back.
    strike(fight, 'Decoy', { hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: weaponHit(fight, 'Decoy', 200 + 25 * L(fight, 'Decoy') + s.int + s.luk, { ranged: true }) });
    grant(fight, 'hidden', 1000);
  },
};

const sneakAttack: Action = {
  id: 'Sneak Attack',
  isSkill: true,
  offensive: true,
  // "Only usable while in Hiding status and will cancel Hiding once used."
  ready: (fight) => learned('Sneak Attack')(fight) && has(fight, 'hidden') && !followUpComing(fight),
  castMs: () => 0,
  cooldownMs: cooldown('Sneak Attack'),
  spCost: spCost('Sneak Attack'),
  resolve(fight) {
    const f = fight.f;
    // "Damage is 150+15% per level + Flat Dex"; "the enemy receives more damage for 5s", "15%".
    strike(fight, 'Sneak Attack', { hits: 1, canMiss: true, critBonus: null, kind: 'melee',
      damage: (crit) => weaponHit(fight, 'Sneak Attack', 150 + 15 * L(fight, 'Sneak Attack'))(crit) + f.stats.dex });
    fight.mob.buffs.raid = { until: fight.t + 5000, stacks: 1, value: 15 };
  },
};

/** Hiding as an opening for Sneak Attack, not as a dodge. Shares Hiding's cooldown. */
const hideToStrike: Action = {
  id: 'Hide to strike',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Hiding')(fight) && learned('Sneak Attack')(fight) && optionOn(fight, 'sneakAttack')
    && readyAt(fight, 'Hiding') <= fight.t && readyAt(fight, 'Sneak Attack') <= fight.t
    && !has(fight, 'hidden') && !has(fight, 'revealed') && !fight.mob.cast && comboSoon(fight, 3000),
  castMs: () => 0,
  delayMs: () => 100,
  cooldownMs: () => 0,
  spCost: (fight) => 15 + Math.floor(0.05 * fight.f.maxSp),
  resolve(fight) {
    grant(fight, 'hidden', 2000);
    fight.me.cds.Hiding = fight.t + T.cooldown('Hiding')(fight);
  },
};

const bishopsTax: Action = {
  id: "Bishop's Tax",
  isSkill: true,
  offensive: true,
  // Just before the Shield Boomerang -> King's Chains combo it is there to
  // lift: at Lv5 its 12 s cover two of them (the project owner, 2026-09-27).
  // With HP to spare: at half or more by default (option taxHp, a share of
  // Max HP; the owner's first rule was 75%).
  ready: (fight) => learned("Bishop's Tax")(fight) && optionOn(fight, 'bishopsTax')
    && fight.me.hp >= (typeof fight.options.taxHp === 'number' ? fight.options.taxHp : 0.5) * fight.f.maxHp
    // Option keepTaxed: open with it and recast as it runs out, combo or not
    // (the owner's Ifrit plan, 2026-09-29).
    && (fight.options.keepTaxed === true ? (fight.mob.buffs.tax?.until ?? -1) <= fight.t + 500
      // Option retriCombo: the Tax goes on at Retribution's counters (retributionAt), just before it.
      : fight.options.retriCombo === true && learned('Retribution')(fight) && readyAt(fight, 'Retribution') <= fight.t
        ? counters(fight) >= (typeof fight.options.retributionAt === 'number' ? fight.options.retributionAt : 10)
        : comboSoon(fight, 3000)),
  castMs: cast("Bishop's Tax"),
  cooldownMs: cooldown("Bishop's Tax"),
  spCost: spCost("Bishop's Tax"),
  // "Requires 25% extra Max HP to cast".
  hpCost: (fight) => Math.floor(0.25 * fight.f.maxHp),
  resolve(fight) {
    const f = fight.f; const l = L(fight, "Bishop's Tax");
    // "Damage is 200+30% per level + 2% per Dex", "Enemies hit receive 15%
    // extra damage", "3s to 12s by level".
    strike(fight, "Bishop's Tax", { hits: 1, canMiss: true, critBonus: null, kind: 'melee',
      damage: weaponHit(fight, "Bishop's Tax", 200 + 30 * l + 2 * f.stats.dex) });
    fight.mob.buffs.tax = { until: fight.t + (3 + (9 * (l - 1)) / 4) * 1000, stacks: 1, value: 15 };
  },
};

// ---- defence ---------------------------------------------------------------------------

const hiding = hidingAction(T);

const pawnsRod: Action = {
  id: "Pawn's Rod",
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: learned("Pawn's Rod"),
  castMs: cast("Pawn's Rod"),
  cooldownMs: cooldown("Pawn's Rod"),
  spCost: spCost("Pawn's Rod"),
  // "Timing duration is 1.5 seconds."
  resolve(fight) { grant(fight, 'magicRod', 1500); },
};

const kingsGambit: Action = {
  id: "King's Gambit",
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: learned("King's Gambit"),
  castMs: () => 0,
  cooldownMs: cooldown("King's Gambit"),
  spCost: spCost("King's Gambit"),
  // "Duration is 1,5s + 0.25s per level"; ground spells on it are cancelled.
  resolve(fight) { grant(fight, 'landProtector', 1500 + 250 * L(fight, "King's Gambit")); },
};

/**
 * King's Gambit put down before a ground spell too fast to answer (Magnus
 * Exorcismus, 0.3s): the project owner (2026-09-27) pre-casts it and hopes it
 * soaks one or two casts. The first cast cannot be called; from then on the
 * reuse delay is counted from the last one seen, and the Gambit goes down
 * when it runs out inside the Gambit's duration. Shares the Gambit's cooldown.
 */
const FAST_CAST_MS = 500;
function fastGroundDueSoon(fight: Fight, within: number): boolean {
  const actors = [{ m: fight.m, st: fight.mob }, ...fight.mob.adds.map((a) => ({ m: a.m, st: a.st }))];
  return actors.some(({ m, st }) => m.skills.some((sk) => sk.targets === 'aoe' && sk.avoid.includes('walk') && !sk.noGambit
    && sk.castMs <= FAST_CAST_MS && sk.type !== 'none' && sk.type !== 'status'
    // Only a skill the monster fires at once when it can (Heartless's Magnus,
    // 90% a try) can be timed; a rare one is never "due", or it would hold
    // every cast back all fight. And past 2 s overdue, it is not coming yet.
    && sk.ai.rate >= 0.5
    && (st.cds[sk.skill] !== undefined
      ? st.cds[sk.skill] + sk.ai.delayMs <= fight.t + within && fight.t <= st.cds[sk.skill] + sk.ai.delayMs + 2000
      // Never cast yet: due at the pull -- Heartless opens with Magnus every
      // time (the project owner, 2026-09-27; option openerGambit).
      : optionOn(fight, 'openerGambit') && fight.t < 1500)));
}

/**
 * A cast of `ms` will finish before a fast ground spell can land on it --
 * or King's Gambit covers it: Magnus's 0.3 s cast cancels Queen's Gambit
 * mid-cast (the project owner, 2026-09-27).
 */
function castIsSafe(fight: Fight, ms: number): boolean {
  if (ms <= 0 || !optionOn(fight, 'safeCasts')) return true;
  const covered = (fight.me.buffs.landProtector?.until ?? -1) >= fight.t + ms;
  return covered || (!fight.mob.cast && !fastGroundDueSoon(fight, ms + 300));
}
const preGambit: Action = {
  id: "Pre-cast King's Gambit",
  isSkill: true,
  offensive: false,
  // With option defense 'auto' the shared prediction (defense.ts) does this.
  ready: (fight) => !autoDefense(fight) && learned("King's Gambit")(fight) && readyAt(fight, "King's Gambit") <= fight.t
    && !has(fight, 'landProtector') && optionOn(fight, 'preGambit')
    && fastGroundDueSoon(fight, 1500 + 250 * L(fight, "King's Gambit") - 300),
  castMs: () => 0,
  cooldownMs: () => 0,
  spCost: spCost("King's Gambit"),
  resolve(fight) {
    kingsGambit.resolve(fight);
    fight.me.cds["King's Gambit"] = fight.t + cooldown("King's Gambit")(fight);
  },
};

/**
 * Pawn's Cure (PR_STRECOVERY) on yourself: the project owner (2026-09-29)
 * cures most statuses with it and keeps Green Potions for Silence, which
 * stops skills. The 2023 code clears only the holds and Bleeding; the
 * tooltip says "and much more". Taken as: Bleeding, Burning, the poisons,
 * Critical Wound, root and Decrease AGI (the owner). Stun, Freeze and Stone
 * stop you casting anyway.
 */
const CURED_BUFFS = ['magicpoison', 'cloudpoison', 'criticalwound', 'rooted', 'webbed', 'decagi'];
const CURED_DOTS = ['Bleeding', 'Burning'];
const afflicted = (fight: Fight) => CURED_BUFFS.some((b) => has(fight, b))
  || fight.me.dots.some((d) => CURED_DOTS.includes(d.name) && d.until > fight.t);
const pawnsCure: Action = {
  id: "Pawn's Cure",
  isSkill: true,
  offensive: false,
  ready: (fight) => learned("Pawn's Cure")(fight) && afflicted(fight),
  castMs: cast("Pawn's Cure"),
  cooldownMs: cooldown("Pawn's Cure"),
  spCost: spCost("Pawn's Cure"),
  resolve(fight) {
    for (const b of CURED_BUFFS) delete fight.me.buffs[b];
    fight.me.dots = fight.me.dots.filter((d) => !CURED_DOTS.includes(d.name));
  },
};

const queensBarrier: Action = {
  id: "Queen's Barrier",
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: (fight) => learned("Queen's Barrier")(fight) && !has(fight, 'barrier'),
  castMs: cast("Queen's Barrier"),
  cooldownMs: cooldown("Queen's Barrier"),
  spCost: spCost("Queen's Barrier"),
  resolve(fight) {
    // "[Lv 5]: Barrier: 10% MaxHP, Blocks 5 Hits", "up to 15 seconds".
    const l = L(fight, "Queen's Barrier");
    fight.me.buffs.barrier = { until: fight.t + 15_000, stacks: l, value: 0.02 * l * fight.f.maxHp };
  },
};

// ---- the rotation --------------------------------------------------------------------------

/**
 * Step back out of the monster's short range (3 cells) so Rook's Wall
 * counts again: only with the wall up. 3 cells at Rook's Wall's slowed walk
 * (walk speed 200 under Defender in the server code, against 150).
 */
const stepBack: Action = {
  id: 'Step back',
  isSkill: false,
  offensive: false,
  ready: (fight) => has(fight, 'close') && has(fight, 'defender') && optionOn(fight, 'keepRange'),
  castMs: () => 0,
  delayMs: (fight) => 3 * (has(fight, 'defender') ? 200 : cellMs(fight)),
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) { delete fight.me.buffs.close; },
};

/**
 * The Kingslayer's dodges for the automatic defence (option defense 'auto',
 * defense.ts), from the project owner (2026-09-29): King's Gambit stops any
 * ground spell but Earthquake (noGambit) and is put down ahead of one too
 * fast to answer; Pawn's Rod eats a spell cast at you for 1.5 s; Decoy is
 * Hiding's cheaper stand-in against a cast at you; Queen's Barrier (long
 * cooldown) is kept for a hit that would kill -- and goes up before the
 * pull (option barrierOpener) to soak the first hits.
 */
const readyBy = (fight: Fight, id: string, endsAt: number) => lv(fight.f, id) > 0 && readyAt(fight, id) <= endsAt - 50;
const groundSpell = (s: MobSkill) => s.targets === 'aoe' && s.avoid.includes('walk') && !s.noGambit;
const gambitMs = (fight: Fight) => 1500 + 250 * L(fight, "King's Gambit");
const TOOLS: DefenseTool[] = [
  ...COMMON_TOOLS,
  {
    way: 'gambit', action: "King's Gambit",
    plan: (fight, s, _from, r) => (groundSpell(s) && readyBy(fight, "King's Gambit", r.endsAt) && s.castMs > FAST_CAST_MS
      ? Math.max(fight.t, r.endsAt - 100) : null),
    covers: (fight, s, endsAt) => groundSpell(s) && (fight.me.buffs.landProtector?.until ?? -1) >= endsAt,
    pre: {
      holdMs: gambitMs,
      up: (fight) => has(fight, 'landProtector'),
      answers: groundSpell,
      minShare: 0,
      on: (fight) => optionOn(fight, 'preGambit'),
    },
  },
  {
    way: 'rod', action: "Pawn's Rod",
    plan: (fight, s, _from, r) => {
      const c = rule("Pawn's Rod").castMs(fight);
      return s.avoid.includes('rod') && readyBy(fight, "Pawn's Rod", r.endsAt) && r.lead >= c ? Math.max(fight.t, r.endsAt - c - 700) : null;
    },
  },
  {
    way: 'decoy', action: 'Decoy',
    plan: (fight, s, from, r) => {
      const c = rule('Decoy').castMs(fight);
      return s.targets === 'single' && r.hideWorks && decoyAnswers(from) && readyBy(fight, 'Decoy', r.endsAt) && r.lead >= c
        ? Math.max(fight.t, r.endsAt - c - 150) : null;
    },
  },
  {
    way: 'barrier', action: "Queen's Barrier", reserve: true,
    plan: (fight, _s, _from, r) => (readyBy(fight, "Queen's Barrier", r.endsAt) && !has(fight, 'barrier')
      && r.lead >= rule("Queen's Barrier").castMs(fight) ? Math.max(fight.t, r.endsAt - 400) : null),
  },
];
export const KINGSLAYER_TOOLS = TOOLS;

const ACTIONS: Action[] = [
  attack, waitAction, heal, dragonBreath, kingsChains, shieldBoomerang, rooksSmash, queensBrand, queensGambit, retribution, checkMate,
  windSlash, deltaSkyfall, overpower, faceOff, decoy, sneakAttack, hideToStrike, bishopsTax,
  hiding, pawnsRod, pawnsCure, kingsGambit, preGambit, queensBarrier, walkOut, breakSight, morrocsMark, stayHidden, pullOffWard, stepBack,
  backSlide, ...predictActions(TOOLS), stayReadyAction(TOOLS),
].map(withRules);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const rule = (id: string) => BY_ID.get(id)!;
const PREEMPTS = ACTIONS.filter(isPreempt);

/**
 * Hard rules: hidden with a monster chain still coming, stay in. Otherwise
 * the TAS is free; the shield build's "keep max counters" is the profile
 * option spendCounters: false.
 */
/** What a ward would stop: Pneuma the long-range hits, Safety Wall the melee skills. */
const LONG_RANGE = new Set(["King's Chains", 'Shield Boomerang', 'Delta Skyfall', 'Wind Slash', 'Dragon Breath']);
const MELEE_SKILLS = new Set(["Rook's Smash", 'Retribution', "Queen's Brand", 'Sneak Attack', "Bishop's Tax", 'Overpower', 'Face-Off', 'Check Mate']);

/**
 * Skills that leave you next to the monster: melee range (Retribution 3
 * cells, Bishop's Tax and Sneak Attack 1), and Rook's Smash, which slides
 * you onto the target -- and leaves you there when it cannot be knocked
 * back (Heartless, bosses). Up close a monster's hits are short range, so
 * Rook's Wall stops counting until you step back (engine 'close').
 */
const CLOSE_SKILLS = new Set(['Retribution', "Bishop's Tax", 'Sneak Attack', "Queen's Brand", 'Check Mate', 'Overpower', 'Face-Off']);
const leavesYouClose = (fight: Fight, id: string) => CLOSE_SKILLS.has(id)
  || (id === "Rook's Smash" && (fight.m.noKnockback || fight.m.boss));

function withRules(a: Action): Action {
  if (a.reactive || !(a.offensive || a.isSkill)) return a;
  const own = a.ready;
  const resolve = (fight: Fight) => {
    a.resolve(fight);
    if (leavesYouClose(fight, a.id)) grant(fight, 'close', 1e12);
  };
  return {
    ...a,
    resolve,
    ready: (fight) => {
      // Option defense 'auto': a hard snap cast is due -- stay idle, ready to dodge it.
      if (heldForSnap(fight, a, TOOLS)) return false;
      // Nothing into a ward: pull the monster off it first (pullOffWard).
      if (LONG_RANGE.has(a.id) && wardUp(fight, 'pneuma')) return false;
      if (MELEE_SKILLS.has(a.id) && wardUp(fight, 'safetywall')) return false;
      // Its Reflect Shield sends part of a melee hit back: only with HP to
      // take it (Heartless keeps it up nearly all fight).
      if (MELEE_SKILLS.has(a.id) && fight.mob.buffs.reflectshield && fight.mob.buffs.reflectshield.until > fight.t
        && fight.me.hp < 0.7 * fight.f.maxHp && optionOn(fight, 'reflectCare')) return false;
      if (a.id === 'Sneak Attack') return own?.(fight) ?? true;
      if (has(fight, 'hidden') && followUpComing(fight)) return false;
      // Hidden to strike: only Sneak Attack comes out of it.
      if (has(fight, 'hidden') && readyAt(fight, 'Sneak Attack') <= fight.t && optionOn(fight, 'sneakAttack')) return false;
      return own?.(fight) ?? true;
    },
  };
}

/**
 * The burst (the project owner, 2026-09-27): Hiding (a dodge, or on purpose)
 * -> Sneak Attack -> Bishop's Tax if healthy -> Shield Boomerang -> King's
 * Chains. Counters: Rook's Smash and Delta Skyfall to 5, Queen's Gambit on
 * top while they are low, then hits taken in Duel Stance hold them at 10.
 */
const ORDER = [
  'Stay hidden', "Morroc's Mark", "Pre-cast King's Gambit", 'Step back', 'Heal', "Pawn's Cure", 'Pull it off the ward',
  'Sneak Attack', "Bishop's Tax", "King's Chains", 'Shield Boomerang', 'Hide to strike',
  "Rook's Smash", 'Dragon Breath', 'Delta Skyfall', "Queen's Gambit",
  'Retribution', "Queen's Brand",
  'Wind Slash', 'Overpower', 'Face-Off',
  'Attack',
];

/** It answers with Pneuma or Safety Wall (Angel of Genesis): a Rook's Smash opener only lands in the ward. */
const castsWards = (m: Monster) => m.skills.some((sk) => /PNEUMA|SAFETYWALL/.test(sk.skill));

/** The priority list, or a profile's own (option order: the same ids, reordered). */
export const KINGSLAYER_ORDER = ORDER;

/** The rotation's switches and play styles, for the searches (kits/index.ts RotationSpace). */
export const KINGSLAYER_SEARCH = {
  order: ORDER,
  switches: {
    bishopsTax: [true, false], taxHp: [0.5, 0.75, 0.35], sneakAttack: [true, false], preGambit: [true, false],
    deltaFiller: [false, true], queensBrand: [false, true], queensGambit: [true, false], reflectCare: [true, false],
    heal: [true, false], rogueFillers: [false, true], fortress: [3, 2, 1], rooksWall: [false, true], autoAttack: [false, true],
    rooksSmash: [true, false], keepRange: [true, false], spendCounters: [true, false], windSlash: [false, true], retributionAt: [10, 6, 1], openerGambit: [true, false], safeCasts: [true, false], rookOpener: [true, false],
    // Dodge only what costs this share of Max HP (kits/common.ts assessThreat); Kingslayer defaults to 0.4.
    tankShare: [0.4, 0.25, 0.6],
  } as Record<string, unknown[]>,
  sets: {
    // Rook's Wall up and nothing that brings you into melee: every hit stays long range.
    "ranged only behind Rook's Wall": { rooksWall: true, rooksSmash: false, spendCounters: false, bishopsTax: false, sneakAttack: false },
    "Rook's Wall, step back after melee": { rooksWall: true, keepRange: true },
  } as Record<string, Record<string, unknown>>,
  droppable: ['Sneak Attack', "Bishop's Tax", 'Hide to strike', "Rook's Smash", 'Dragon Breath', 'Delta Skyfall', "Queen's Gambit",
    'Retribution', "Queen's Brand", 'Wind Slash', 'Overpower', 'Face-Off'],
};
/**
 * Option simple: the few-buttons rotation a player can hold in real
 * combat (the project owner, 2026-09-28). Shield Boomerang and King's
 * Chains do the damage; Rook's Smash, Delta Skyfall and one Queen's Gambit
 * only build counters; no Retribution (counters stay high), no fillers.
 * Against Heartless: King's Gambit on the first Magnus, Tax, Rook's Smash,
 * Delta, Shield Boomerang, King's Chains, then Queen's Gambit timed to land
 * as the Gambit's Land Protector ends. Tax waits for half HP (taxHp).
 */
const SIMPLE_ORDER = [
  'Stay hidden', "Morroc's Mark", "Pre-cast King's Gambit", 'Step back', 'Heal', "Pawn's Cure", 'Pull it off the ward',
  "Bishop's Tax", "Queen's Gambit", "Rook's Smash", 'Delta Skyfall', "King's Chains", 'Shield Boomerang',
];
const simple = (fight: Fight) => fight.options.simple === true;
/** Simple rotation: Rook's Smash only while it adds counters ("up to 3"). */
const simpleGate = (fight: Fight, id: string) => id !== "Rook's Smash" || counters(fight) < 3;

/**
 * Simple rotation: the one Queen's Gambit a fight. Under King's Gambit it
 * starts so that it lands as the Land Protector ends -- Magnus cannot catch
 * the cast; with no Gambit down, only when no fast ground spell is due.
 */
function simpleGambitNow(fight: Fight): boolean {
  // simpleGambits: more than the one (a number of casts a fight).
  const most = typeof fight.options.simpleGambits === 'number' ? fight.options.simpleGambits : 1;
  if (stacks(fight, 'gambitsCast') >= most) return false;
  const ms = cast("Queen's Gambit")(fight);
  const lp = fight.me.buffs.landProtector?.until ?? -1;
  if (lp > fight.t) return fight.t + ms >= lp - 150;
  return !fight.mob.cast && !fastGroundDueSoon(fight, ms + 300);
}

function priority(fight: Fight): Action {
  // simpleAdd: extra buttons after the simple ones, lowest priority (Wind Slash, Retribution...).
  const add = fight.options.simpleAdd;
  const extra = Array.isArray(add) ? add as string[] : typeof add === 'string' ? add.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const order = simple(fight) ? [...SIMPLE_ORDER, ...extra] : Array.isArray(fight.options.order) ? fight.options.order as string[] : ORDER;
  for (const id of order) {
    if (simple(fight) && !simpleGate(fight, id)) continue;
    // With no counter King's Chains cannot follow a Shield Boomerang: open
    // with Rook's Smash (3 counters) instead (the project owner, 2026-09-27).
    // At the pull only: later, hits in Duel Stance refill counters quickly
    // and a Rook's Smash would drag you into melee for nothing.
    if (id === 'Shield Boomerang' && fight.t < 3000 && optionOn(fight, 'rookOpener') && !castsWards(fight.m) && counters(fight) < 1 && hasComboGem(fight.f) && canUse(fight, rule("Rook's Smash"))) {
      return rule("Rook's Smash");
    }
    const a = rule(id);
    if (canUse(fight, a)) return a;
  }
  return rule('Wait');
}

// ---- reacting to a cast bar ---------------------------------------------------------------

function react(fight: Fight, s: MobSkill, from: Monster): { action: string; at: number } | null {
  const t = assessThreat(fight, s, from);
  if (!t.heavy) return null;
  const { endsAt } = t;
  const ready = (id: string) => lv(fight.f, id) > 0 && readyAt(fight, id) <= endsAt - 50
    && rule(id).spCost(fight) <= fight.me.sp;
  const ground = s.targets === 'aoe' && s.avoid.includes('walk');
  // King's Gambit already down and lasting past it: nothing to do.
  if (ground && !s.noGambit && (fight.me.buffs.landProtector?.until ?? -1) >= endsAt) return null;
  // The playbook first (data/playbook.json): this class's answer to the skill.
  const rodCast = rule("Pawn's Rod").castMs(fight);
  const decoyCast = rule('Decoy').castMs(fight);
  const planned = playbookPlan(fight, s, from, endsAt, {
    gambit: () => (ground && !s.noGambit && ready("King's Gambit") && s.castMs > FAST_CAST_MS
      ? { action: "King's Gambit", at: Math.max(fight.t, endsAt - 100) } : null),
    walk: () => (t.canWalk ? { action: 'Walk out', at: fight.t + reactionMs(fight) } : null),
    hide: () => (t.hideWorks && t.hideReady ? { action: 'Hiding', at: Math.max(fight.t, endsAt - 150) } : null),
    decoy: () => (s.targets === 'single' && t.hideWorks && decoyAnswers(from) && ready('Decoy') && t.lead >= decoyCast
      ? { action: 'Decoy', at: Math.max(fight.t, endsAt - decoyCast - 150) } : null),
    rod: () => (s.avoid.includes('rod') && ready("Pawn's Rod") && t.lead >= rodCast
      ? { action: "Pawn's Rod", at: Math.max(fight.t, endsAt - rodCast - 700) } : null),
    los: () => (t.canLos ? { action: 'Break line of sight', at: fight.t + reactionMs(fight) } : null),
    barrier: () => (ready("Queen's Barrier") && !has(fight, 'barrier') && t.lead >= rule("Queen's Barrier").castMs(fight)
      ? { action: "Queen's Barrier", at: Math.max(fight.t, endsAt - 400) } : null),
  });
  if (planned !== undefined) return planned;
  // King's Gambit cancels a ground spell outright, and the rest of its waves
  // -- when the cast bar leaves time to see it and answer (the owner: Magnus's
  // 0.3s does not; that one is pre-cast, preGambit).
  if (ground && !s.noGambit && ready("King's Gambit") && s.castMs > FAST_CAST_MS) {
    return { action: "King's Gambit", at: Math.max(fight.t, endsAt - 100) };
  }
  if (t.canWalk && s.targets === 'aoe') return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  // Pawn's Rod: a spell cast at you; it has a 0.5s cast, then 1.5s of cover.
  if (s.avoid.includes('rod') && ready("Pawn's Rod") && t.lead >= rodCast) {
    return { action: "Pawn's Rod", at: Math.max(fight.t, endsAt - rodCast - 700) };
  }
  if (t.hideWorks && t.hideReady && (t.hideCovers || !t.canWalk)) {
    return { action: 'Hiding', at: Math.max(fight.t, endsAt - 150) };
  }
  // Decoy: Hiding's stand-in for a cast at you, when its cast fits the bar.
  if (s.targets === 'single' && t.hideWorks && decoyAnswers(from) && ready('Decoy') && t.lead >= decoyCast) {
    return { action: 'Decoy', at: Math.max(fight.t, endsAt - decoyCast - 150) };
  }
  if (t.canLos) return { action: 'Break line of sight', at: fight.t + reactionMs(fight) };
  if (t.canWalk) return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  // Nothing dodges it: soak it with Queen's Barrier.
  if (ready("Queen's Barrier") && !has(fight, 'barrier') && t.lead >= rule("Queen's Barrier").castMs(fight)) {
    return { action: "Queen's Barrier", at: Math.max(fight.t, endsAt - 400) };
  }
  return null;
}

// ---- before the pull ------------------------------------------------------------------------

function prep(fight: Fight) {
  const f = fight.f;
  // The lair maps are too tight for the TAS's dodging: walk in server cells,
  // react like a player, and take anything under 40% Max HP rather than
  // hide from it (the project owner, 2026-09-28). A profile can set them back.
  fight.options.mobility ??= 'server';
  fight.options.tankShare ??= 0.4;
  // The simple rotation opens on King's Gambit for the first Magnus and keeps it for the later ones.
  if (fight.options.simple === true) { fight.options.openerGambit = true; fight.options.preGambit = true; }
  // Ready to Rip (LK_CONCENTRATION, renewal): status and weapon ATK +1+lv %,
  // HIT +10 a level, hard DEF -(5+5 a level) %, Endure -- kept up all fight
  // with option readyToRip (RTM status.cpp:11471; soft DEF's cut is
  // pre-renewal only). The shield skills take none of the ATK.
  const rtr = lv(f, 'Ready to Rip');
  if (rtr > 0 && fight.options.readyToRip === true) {
    // Option readyToRipAtkRate: the live tooltip's "ATK +(1+lv)%" read as a
    // plain ATK% (like Angel of Genesis Card's), which shield skills take
    // -- the project owner's reading (2026-09-30), unconfirmed; the 2023 code
    // raises status and weapon ATK only (status.cpp:6946, 7024).
    const rate = fight.options.readyToRipAtkRate === true;
    fight.f = { ...f, concentration: rate ? 0 : 1 + rtr, atkPercent: f.atkPercent + (rate ? 1 + rtr : 0),
      hit: f.hit + 10 * rtr, def: Math.floor(f.def * (1 - (5 + 5 * rtr) / 100)) };
  }
  if (lv(f, 'Duel Stance') > 0) grant(fight, 'duelStance', 1e12);
  // Option defense 'auto': Queen's Barrier goes up before the pull and soaks
  // the first hits (the project owner, 2026-09-29); its cooldown runs from the
  // pull. Option barrierOpener false keeps it for a lethal cast instead.
  if (autoDefense(fight) && fight.options.barrierOpener !== false && lv(f, "Queen's Barrier") > 0) {
    queensBarrier.resolve(fight);
    fight.me.cds["Queen's Barrier"] = queensBarrier.cooldownMs(fight);
  }
  setCounters(fight, typeof fight.options.startCounters === 'number' ? fight.options.startCounters : 0);
  // King's Fortress: one level at a time. Lv3 (shield skills) unless the profile picks 1 (HP) or 2 (SP).
  const fort = typeof fight.options.fortress === 'number' ? fight.options.fortress : 3;
  if (lv(f, "King's Fortress") >= fort && hasShield(fight)) {
    fight.me.buffs.fortress = { until: 1e12, stacks: fort };
    // "[Lv 1]: Regen 1% HP every 2 seconds." "[Lv 2]: Regen 1% SP every 2 seconds."
    if (fort === 1) dot(fight, "King's Fortress", 2000, 1e12, 0.01 * f.maxHp, false, true);
    if (fort === 2) dot(fight, "King's Fortress", 2000, 1e12, 0.01 * f.maxSp, false, false, true);
  }
  // Knight's Regen: "1+1% Max HP per level" every 5 s, "60+60s per level".
  const kr = lv(f, "Knight's Regen");
  if (kr > 0) dot(fight, "Knight's Regen", 5000, (60 + 60 * kr) * 1000, (1 + kr) / 100 * f.maxHp, false, true);
  // Reflect Shield: "10+4% per level" of melee damage back.
  if (lv(f, 'Reflect Shield') > 0 && hasShield(fight) && optionOn(fight, 'reflectShield')) {
    fight.me.buffs.reflectshield = { until: 1e12, stacks: 1, value: 10 + 4 * lv(f, 'Reflect Shield') };
  }
  // Rook's Wall: "10% Ranged Reduction per Level" -- a toggle, off unless the profile turns it on.
  if (fight.options.rooksWall === true && lv(f, "Rook's Wall") > 0 && hasShield(fight)) {
    fight.me.buffs.defender = { until: 1e12, stacks: 1, value: 10 * lv(f, "Rook's Wall") };
  }
}

function prepNotes(fight: Fight): string[] {
  const out: string[] = [];
  if (has(fight, 'duelStance')) out.push('Duel Stance');
  out.push("Bishop's Guard");
  if (fight.me.dots.some((d) => d.name === "Knight's Regen")) out.push("Knight's Regen");
  if (has(fight, 'fortress')) out.push(`King's Fortress Lv${fight.me.buffs.fortress.stacks}`);
  if (has(fight, 'reflectshield')) out.push(`Reflect Shield ${fight.me.buffs.reflectshield.value}%`);
  if (has(fight, 'defender')) out.push("Rook's Wall");
  if (has(fight, 'barrier')) out.push(`Queen's Barrier (${fight.me.buffs.barrier.stacks} hits)`);
  if (hasComboGem(fight.f)) out.push('Bulwark Gem combo');
  return out;
}

/**
 * Out of combat (the farm tool, between fights): Knight's Regen kept up --
 * 1+lv % Max HP every 5 s, recast every 60+60 x lv s for 50% of Max SP -- and
 * King's Fortress Lv1 (1% HP every 2 s) or Lv2 (1% SP every 2 s).
 */
function idleRegen(f: Fighter, options: Record<string, unknown>): { hpPerSec: number; spPerSec: number } {
  let hp = 0; let sp = 0;
  const kr = f.skillLevels["Knight's Regen"] ?? 0;
  if (kr > 0) { hp += ((1 + kr) / 100) * f.maxHp / 5; sp -= (0.5 * f.maxSp) / (60 + 60 * kr); }
  const fort = typeof options.fortress === 'number' ? options.fortress : 3;
  if ((f.skillLevels["King's Fortress"] ?? 0) >= fort && f.shield) {
    if (fort === 1) hp += 0.01 * f.maxHp / 2;
    if (fort === 2) sp += 0.01 * f.maxSp / 2;
  }
  return { hpPerSec: hp, spPerSec: sp };
}

const ROLES: Record<string, string> = {
  "King's Chains": 'Shield', 'Shield Boomerang': 'Shield',
  Retribution: 'Counters', "Queen's Brand": 'Counters', "Rook's Smash": 'Counters', "Queen's Gambit": 'Counters',
  'Check Mate': 'Finisher',
  'Sneak Attack': 'Openers', "Bishop's Tax": 'Openers',
  'Wind Slash': 'Fillers', 'Delta Skyfall': 'Fillers', 'Dragon Breath': 'Fillers', Overpower: 'Fillers', 'Face-Off': 'Fillers', Decoy: 'Dodges',
  'Reflect Shield': 'Reflect', Attack: 'Auto-attacks',
};

export const kingslayer: Kit = {
  className: 'Kingslayer',
  actions: ACTIONS,
  roles: ROLES,
  cycleAnchor: 'Shield Boomerang',
  coreRoles: ['Shield', 'Counters'],
  magicActions: [],
  priority: priorityWith(() => PREEMPTS, priority, rule('Stay ready')),
  holding: (fight) => !!snapThreatDue(fight, TOOLS),
  react: reactWith(TOOLS, react),
  prep,
  prepNotes,
  idleRegen,
  onHurt,
  // Rook's Smash puts you on the target: no walk back after a dodge (the project owner, 2026-09-28).
  gapClosers: ["Rook's Smash"],
  // What the shield combo runs on, for the Rotation overlay's arrows.
  statuses: (fight) => readMarks(fight, {
    me: [
      { key: 'counters', label: 'Duel Counters', stacks: true }, { key: 'sbCombo', label: 'Boomerang → Chains combo' },
      { key: 'finisher', label: 'Finisher Ready' }, { key: 'landProtector', label: "King's Gambit" },
      { key: 'barrier', label: "Queen's Barrier", value: true }, { key: 'hidden', label: 'Hiding' },
    ],
    target: [{ key: 'tax', label: "Bishop's Tax" }, { key: 'raid', label: 'Sneak Attack mark' }],
  }),
};

