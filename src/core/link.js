/**
 * Shareable-link handling, in one place.
 *
 * A room is fully described by its seed: both ends generate identical
 * geometry from it (see TrackGenerator), so a link is all anybody needs to
 * race the same course. No account, no lobby id, no server round trip.
 */

export function readSeed() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const seed = params.get('seed');
  return seed && seed.trim() ? seed.trim() : null;
}

/** Update the address bar without adding a history entry. */
export function writeSeed(seed) {
  const url = new URL(window.location.href);
  url.hash = `seed=${encodeURIComponent(seed)}`;
  window.history.replaceState(null, '', url.toString());
}

export function shareUrl(seed) {
  const url = new URL(window.location.href);
  url.hash = `seed=${encodeURIComponent(seed)}`;
  return url.toString();
}
