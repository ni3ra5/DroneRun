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
