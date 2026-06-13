// MOCK user/collector pool. `userOrGeneric()` resolves ANY username so every
// /profile/<user> link works.
import { MOCK_CARDS, type MockCard } from './cards';

export type MockUser = {
  username: string;
  pfp: string;
  rank: number;
  points: number;
  pulls: number;
  volume: number; // USD traded
  joined: string;
  collection: MockCard[];
};

// Usernames seen across leaderboard / activity / community, plus extras.
const USERNAMES = [
  'FightingProdigy3098',
  'love',
  'PsychicGuardian5685',
  'RockHunter5734',
  'kaoyan',
  'ProfessorOak',
  'EmberCollector9389',
  'IceTactician3911',
  'CrystalRanger9084',
  'PoisonTactician4598',
  'FireKnight8258',
  'PoisonExplorer2503',
  'CrystalMentor3422',
  'PrinceOfDragons',
  'PoisonTamer',
  'DragonTamerJin',
  'GrassWhisperer77',
  'ThunderApex',
];
const PFP = (i: number) => `/images/pfps/pfp-${(i % 81) + 1}.webp`;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export const MOCK_USERS: MockUser[] = USERNAMES.map((username, i) => ({
  username,
  pfp: PFP(i * 4 + 2),
  rank: i + 1,
  points: Math.round(900_000_000 / (i + 1.4)),
  pulls: 1800 - i * 73,
  volume: Math.round(9_000_000 / (i + 1.2)),
  joined: `${2021 + (i % 4)}`,
  collection: MOCK_CARDS.slice((i * 3) % 30, ((i * 3) % 30) + 9),
}));

export function findUser(username: string): MockUser | null {
  return (
    MOCK_USERS.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    ) ?? null
  );
}

export function userOrGeneric(username: string): MockUser {
  const found = findUser(username);
  if (found) return found;
  const h = hash(username);
  return {
    username,
    pfp: `/images/pfps/pfp-${(h % 81) + 1}.webp`,
    rank: 100 + (h % 900),
    points: 1_000_000 + (h % 40_000_000),
    pulls: 50 + (h % 900),
    volume: 5_000 + (h % 200_000),
    joined: `${2022 + (h % 3)}`,
    collection: MOCK_CARDS.slice(h % 30, (h % 30) + 9),
  };
}
