import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

const fileOf = (dir) => join(dir, 'findings.jsonl');
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function findingKey(f) {
  const eps = [...(f.endpoints ?? [])].sort().join(',');
  return `${f.category}|${eps}|${norm(f.summary)}`;
}

export function readFindings(dir) {
  const path = fileOf(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      // Skip a torn/partial final line rather than throwing (see event-log.mjs).
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((r) => r !== undefined);
}

export function recordFinding(dir, f) {
  mkdirSync(dir, { recursive: true });
  const key = findingKey(f);
  if (readFindings(dir).some((x) => findingKey(x) === key))
    return { added: false, key };
  const fd = openSync(fileOf(dir), 'a');
  try {
    writeSync(fd, JSON.stringify({ ...f, key }) + '\n');
  } finally {
    closeSync(fd);
  }
  return { added: true, key };
}

export function blocksGate(f) {
  return (
    f.status === 'confirmed' &&
    (f.category === 'bug' || f.category === 'missing-capability') &&
    (f.severity === 'critical' || f.severity === 'high')
  );
}
