import { SIM } from './config.mjs';

// Pure map from a semantic event to where the sprite should be and how it
// looks. The viewer owns ALL motion; agents never describe pixels.
export function targetFor(event) {
  const s = SIM.stations;
  switch (event.kind) {
    case 'arrived':
      return { ...s.entrance, mood: 'neutral' };
    case 'played_pack': {
      const slot = s[event.detail?.slot] ?? s.slot1;
      return { ...slot, mood: 'busy' };
    }
    case 'pull_result':
      return {
        ...s.slot1,
        mood: event.detail?.rarity === 'legendary' ? 'happy' : 'neutral',
      };
    case 'complained':
      return { ...s.desk, mood: 'angry' };
    case 'admin_picked_up':
    case 'admin_resolved':
      return { ...s.desk, mood: 'busy' };
    case 'left':
      return { ...s.entrance, mood: 'neutral' };
    default:
      return { ...s.entrance, mood: 'neutral' };
  }
}
