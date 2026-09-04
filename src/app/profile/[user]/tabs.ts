/** The public profile's two tabs, and the `?tab=` mapping. Its own module, NOT
 *  ProfileClient: that file is 'use client', so anything exported from it is a
 *  client reference the server page may render but never CALL — doing so 500s
 *  the route ("Attempted to call tabFromParam() from the server"). */
export const TABS = ['Collection', 'Activity'] as const;
export type Tab = (typeof TABS)[number];

/** `?tab=` → the tab the profile opens on (the pull feed's avatars link to
 *  ?tab=activity). Anything else falls back to Collection. */
export function tabFromParam(param: string | undefined): Tab {
  return TABS.find((t) => t.toLowerCase() === param?.toLowerCase()) ?? TABS[0];
}
