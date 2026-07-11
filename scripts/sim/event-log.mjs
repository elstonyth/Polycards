import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

const fileOf = (dir) => join(dir, 'events.jsonl');

// O_APPEND keeps each written LINE intact even when concurrent processes write
// at once (one JSON line is well under PIPE_BUF), so the file never corrupts.
// seq (line-count-then-write) is only guaranteed unique WITHIN one process,
// where these sync calls can't be interleaved. The month runs concurrent agent
// SUBPROCESSES appending here, so seq may DUPLICATE across processes — fine
// today because nothing orders by seq (the viewer replays in file order, keyed
// by actor). ponytail: if a consumer ever needs a global order, use a lock file
// or the file's byte offset instead of a re-counted seq.
export function appendEvent(dir, event) {
  mkdirSync(dir, { recursive: true });
  const path = fileOf(dir);
  const seq = existsSync(path) ? countLines(readFileSync(path, 'utf8')) : 0;
  const record = { seq, ...event };
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    closeSync(fd);
  }
  return record;
}

export function readEvents(dir) {
  const path = fileOf(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      // A torn/partial final line during a live append must not crash the
      // viewer's 200ms poll — skip it, the writer will complete it next tick.
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((r) => r !== undefined);
}

function countLines(text) {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}
