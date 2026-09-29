/**
 * A variant spec: a name, a colon, and changes separated by ';' -- the
 * syntax tools/variants.ts documents (slot=Item+refine, slot.cards=...,
 * stat.str=N, skill.X=N, option.k=v, items=..., healing=true, res.k=N,
 * mob.SKILL.avoid=how). Shared by the variant and farm tools.
 */
import type { Profile } from './character.ts';
import type { Build } from '../../sim/src/types.ts';

export interface Variant {
  name: string;
  profile: Profile;
  res: Record<string, number>;
  avoid: { skill: string; how: string }[];
}

type Dataset = { itemList: { id: number; name: string }[] };

export function applyVariant(profile: Profile, baseBuild: Build, data: Dataset, spec: string): Variant {
  const idOf = (name: string) => {
    const hit = data.itemList.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
    if (!hit) throw new Error(`no item named "${name.trim()}"`);
    return hit.id;
  };

  const [name, rest] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, ''];
  const build: Build = structuredClone(baseBuild);
  const p: Profile = { ...profile, build, skills: { ...(profile.skills ?? {}) }, options: { ...(profile.options ?? {}) } };
  const res: Record<string, number> = {}; const avoid: Variant['avoid'] = [];
  for (const change of rest.split(';').map((c) => c.trim()).filter(Boolean)) {
    const eq = change.indexOf('=');
    const key = change.slice(0, eq).trim(); const value = change.slice(eq + 1).trim();
    const [head, field] = key.split(/\.(.+)/);
    if (head === 'stat') { (build.baseStats as unknown as Record<string, number>)[field] = Number(value); continue; }
    if (head === 'skill') { p.skills![field] = Number(value); continue; }
    if (head === 'items') { p.consumables = value === 'none' ? [] : value.split(',').map((x) => x.trim()); continue; }
    if (head === 'healing') { p.healing = value === 'true'; continue; }
    if (head === 'res') { res[field] = (res[field] ?? 0) + Number(value); continue; }
    if (head === 'mob') { avoid.push({ skill: field.split('.')[0], how: value }); continue; }
    // A list (the rotation's order) as JSON: option.order=["New Moon","Full Moon","Attack"].
    if (head === 'option') { p.options![field] = value.startsWith('[') ? JSON.parse(value) : value === 'true' ? true : value === 'false' ? false : Number.isFinite(Number(value)) ? Number(value) : value; continue; }
    const slot = (build.slots[head] ??= { itemId: null, refine: 0, cards: [] });
    if (!field) {
      const m = /^(.*?)(?:\s*\+(\d+))?$/.exec(value)!;
      slot.itemId = idOf(m[1]); slot.cards = []; slot.rolls = undefined;
      if (m[2]) slot.refine = Number(m[2]);
    } else if (field === 'cards') slot.cards = value.split(',').map(idOf);
    else if (field === 'refine') slot.refine = Number(value);
    else if (field === 'rolls') {
      // "roll1:max_hp:2, roll3:ranged_damage:5" (values joined by '/'), or none.
      slot.rolls = value === 'none' ? undefined : Object.fromEntries(value.split(',').map((r) => {
        const [key, option, vals] = r.trim().split(':');
        return [key, { option, values: vals.split('/').map(Number) }];
      }));
    }
    else throw new Error(`unknown change "${change}"`);
  }
  return { name: name.trim(), profile: p, res, avoid };
}
