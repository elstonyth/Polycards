import { createHash } from 'node:crypto';

export const stableHumanizedInt = (key: string): bigint =>
  createHash('sha256').update(key).digest().readBigUInt64BE(0);

// Python Random(integer) compatibility keeps the supplied desktop daily plans unchanged.
export function desktopRandom(key: string) {
  let seed = stableHumanizedInt(key);
  const words: number[] = [];
  do {
    words.push(Number(seed & 0xffffffffn));
    seed >>= 32n;
  } while (seed);
  const mt = new Uint32Array(624);
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++)
    mt[i] = Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i;
  let i = 1;
  let j = 0;
  for (let k = Math.max(624, words.length); k; k--) {
    mt[i] =
      (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) +
      words[j] +
      j;
    if (++i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
    if (++j >= words.length) j = 0;
  }
  for (let k = 623; k; k--) {
    mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i;
    if (++i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
  }
  mt[0] = 0x80000000;
  let index = 624;
  const uint = () => {
    if (index >= 624) {
      for (let n = 0; n < 624; n++) {
        const y = (mt[n] & 0x80000000) | (mt[(n + 1) % 624] & 0x7fffffff);
        mt[n] = mt[(n + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = mt[index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    return (y ^ (y >>> 18)) >>> 0;
  };
  return {
    random: () =>
      ((uint() >>> 5) * 67108864 + (uint() >>> 6)) / 9007199254740992,
    randint: (lo: number, hi: number) => {
      const count = hi - lo + 1;
      const bits = Math.floor(Math.log2(count)) + 1;
      let value: number;
      do {
        value = uint() >>> (32 - bits);
      } while (value >= count);
      return lo + value;
    },
  };
}
