// Every real card handle is a lowercase slug carrying the card's numeric id —
// all 1,200 live handles on 2026-10-25 match `slug-<4+ digits>`. This gate is
// deliberately looser than that (a digit somewhere, [a-z0-9-] only, 3–120
// chars) so an unusual future handle still passes. Shared by the card loader
// and the proxy, which answers anything else with a bare 404 before rendering.
export const isPlausibleCardHandle = (handle: string): boolean =>
  /^(?=.*\d)[a-z0-9-]{3,120}$/.test(handle);
