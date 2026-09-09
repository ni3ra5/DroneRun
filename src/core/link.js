/**
 * Shareable-link handling, in one place.
 *
 * A room is fully described by its seed: both ends generate identical
 * geometry from it (see TrackGenerator), so a link is all anybody needs to
 * race the same course. No account, no lobby id, no server round trip.
 */

function params() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

export function readSeed() {
  const seed = params().get('seed');
  return seed && seed.trim() ? seed.trim() : null;
}

/** Room code from the link, if this is an invite. */
export function readRoom() {
  const room = params().get('room');
  return room && room.trim() ? room.trim().toUpperCase() : null;
}

/**
 * Update the address bar without adding a history entry.
 * The room code is preserved when present, so refreshing during an online
 * session does not silently drop you out of the lobby.
 */
export function writeSeed(seed) {
  const room = readRoom();
  const url = new URL(window.location.href);
  url.hash = room
    ? `room=${encodeURIComponent(room)}&seed=${encodeURIComponent(seed)}`
    : `seed=${encodeURIComponent(seed)}`;
  window.history.replaceState(null, '', url.toString());
}

export function writeRoom(room, seed) {
  const url = new URL(window.location.href);
  url.hash = room
    ? `room=${encodeURIComponent(room)}${seed ? `&seed=${encodeURIComponent(seed)}` : ''}`
    : `seed=${encodeURIComponent(seed ?? '')}`;
  window.history.replaceState(null, '', url.toString());
}

/** The link a friend opens to land straight in this lobby. */
export function inviteUrl(room, seed) {
  const url = new URL(window.location.href);
  url.hash = `room=${encodeURIComponent(room)}${seed ? `&seed=${encodeURIComponent(seed)}` : ''}`;
  return url.toString();
}
