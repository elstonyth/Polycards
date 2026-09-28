// Full-page navigation. A module wrapper (not window.location.assign inline)
// because jsdom marks window.location unforgeable, so component tests can only
// observe navigation by mocking this module.
export function leaveFor(url: string) {
  window.location.assign(url);
}

// A full reload, behind the same seam for the same reason.
export function reloadPage() {
  window.location.reload();
}
