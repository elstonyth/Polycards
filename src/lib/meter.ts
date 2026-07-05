// Pure split of a formatted money string into rollable digit cells.
export function meterChars(
  formatted: string,
): { char: string; digit: boolean }[] {
  return Array.from(formatted, (char) => ({
    char,
    digit: char >= '0' && char <= '9',
  }));
}
