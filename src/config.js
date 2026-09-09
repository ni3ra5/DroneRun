/**
 * Feature flags.
 *
 * Flip a flag here and the feature disappears from the game *and* from the
 * controls list, HUD and drop tables — nothing is left half-wired or
 * advertised to the player without working. The code behind a disabled
 * feature stays in the tree and stays covered by `npm run verify`, so it does
 * not rot while switched off.
 */
export const FEATURES = {
  /**
   * Power-ups: pickup crates on the course, the item slot, Space to fire,
   * missiles, mines and the timed effect system.
   *
   * Turned off for now. Set to true to bring it all back; there is nothing
   * else to change.
   */
  powerUps: false,
};

/**
 * Realtime relay for online races (the Cloudflare Worker in `server/`).
 *
 * Localhost falls through to a locally running `wrangler dev`, so development
 * needs no configuration. Anything else uses the deployed worker below; if
 * you redeploy under a different name or subdomain, update it here.
 *
 * A `?relay=` query parameter overrides both, which is handy for pointing a
 * deployed client at a local relay while debugging.
 */
const PRODUCTION_RELAY = 'wss://dronerun-relay.ni3ra5.workers.dev';

export function relayUrl() {
  const override = new URLSearchParams(window.location.search).get('relay');
  if (override) return override.replace(/^http/, 'ws');
  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'ws://127.0.0.1:8787';
  return PRODUCTION_RELAY;
}

/** True when online play is possible — i.e. a relay is actually configured. */
export function relayConfigured() {
  return Boolean(relayUrl());
}
