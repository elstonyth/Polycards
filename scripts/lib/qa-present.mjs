// qa-present.mjs: a check that says an element is there must fail when it is not.
// No side effects, so the scripts that do not load qa-kit (it reads a base and makes an output folder) import it directly.

/**
 * '' when each selector matches at least one element on the page, else "no element matches <selector>, ...".
 * Fold it into the check: report(name, !miss && ok, miss || detail).
 */
export async function missing(page, ...selectors) {
  const absent = [];
  for (const sel of selectors)
    if ((await page.locator(sel).count()) === 0) absent.push(sel);
  return absent.length ? 'no element matches ' + absent.join(', ') : '';
}
