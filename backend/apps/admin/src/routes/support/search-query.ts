// Phones are stored as +60123456789 and searched as a plain substring, so a
// number pasted from a chat ("012-345 6789") only matches without its separators.
export const supportSearchQuery = (raw: string): string => {
  const q = raw.trim();
  return /^[+\d\s()-]+$/.test(q) ? q.replace(/[\s()-]/g, "") : q;
};
