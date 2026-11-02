// The words and pictures a task is drawn with, shared by the board, the builder
// and the planner.
import type { AdminTaskDefinition } from '../../lib/queries';
import { goalAmount, shortPack } from './task-board';
import { labelsOf, type Draft } from './task-draft';

export const TICKET_ART = '/images/lucky-draw/ticket.webp';
export const COINS_ART = '/images/task/credits-coins.webp';

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

export const rewardPicture = (d: Draft): string | null =>
  d.rewardType === 'tickets'
    ? TICKET_ART
    : d.rewardType === 'credit'
      ? COINS_ART
      : d.prize.image;

export const goalWords = (
  t: AdminTaskDefinition,
): { verb: string; amount: string; what: string } => {
  const n = goalAmount(t.requirement);
  const name = t.view?.goal_name ?? null;
  switch (t.requirement.type) {
    case 'checkin_days':
      return t.kind === 'daily'
        ? { verb: 'Check in', amount: 'today', what: '' }
        : {
            verb: 'Check in',
            amount: `${n} ${n === 1 ? 'day' : 'days'}`,
            what: '',
          };
    case 'vault_pixel_count':
      return {
        verb: t.kind === 'achievement' ? 'Vault' : 'Pull',
        amount: `${n} ×`,
        what:
          name ??
          (t.requirement.pixel_pokemon_id ? 'a Pokémon' : 'any Pokémon'),
      };
    case 'rip_count':
      return {
        verb: 'Rip',
        amount: `${n} ×`,
        what: name ?? (t.requirement.pack_id ? 'a pack' : 'any pack'),
      };
    case 'topup_myr':
      return { verb: 'Top up', amount: money(n), what: '' };
    case 'reach_level':
      return { verb: 'Reach', amount: `VIP level ${n}`, what: '' };
    case 'vault_count':
      return {
        verb: 'Vault',
        amount: `${n} ${n === 1 ? 'card' : 'cards'}`,
        what: '',
      };
    default:
      return { verb: '', amount: labelsOf(t).requirement, what: '' };
  }
};

export const rewardWords = (
  t: AdminTaskDefinition,
): { main: string; sub: string | null } => {
  const tickets = t.tickets ?? 0;
  const plus = tickets > 0 ? `+ ${tickets} tickets` : null;
  const value = t.view?.reward_value_myr ?? null;
  switch (t.reward.type) {
    case 'tickets':
      return {
        main: `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'}`,
        sub: null,
      };
    case 'credit':
      return {
        main: `${money(Number(t.reward.amount_myr ?? 0))} credit`,
        sub: plus,
      };
    case 'pack':
      return {
        main: t.view?.reward_name
          ? `Free rip · ${shortPack(t.view.reward_name)}`
          : labelsOf(t).reward,
        sub:
          [value !== null ? money(value) : null, plus]
            .filter(Boolean)
            .join(' ') || null,
      };
    case 'card':
      return {
        main: t.view?.reward_name ?? labelsOf(t).reward,
        sub:
          [value !== null ? money(value) : null, plus]
            .filter(Boolean)
            .join(' ') || null,
      };
    default:
      return { main: labelsOf(t).reward, sub: null };
  }
};

export const rewardPictureOf = (t: AdminTaskDefinition): string | null =>
  t.reward.type === 'tickets'
    ? TICKET_ART
    : t.reward.type === 'credit'
      ? COINS_ART
      : (t.view?.reward_image ?? null);
