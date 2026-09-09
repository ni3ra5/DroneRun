# DroneRun

A procedurally generated 3D drone race built with three.js. Every seed produces a
different course of 16 checkpoint gates threaded through a city of towers, blocks
and floating slabs. Currently single-player time trial; the networking seam is
built and documented but not yet wired to a server.

```bash
npm install
npm run dev      # http://localhost:5173
npm run verify   # headless checks: flight model, generation, collision, rules
npm run build    # production bundle -> dist/
```

## Controls

| Input | Action |
| --- | --- |
| `W` `S` | Move forward / backward |
| `A` `D` | Rotate (yaw) left / right |
| `Q` `E` | Move left / right |
| `K` `M` | Fly up / down |
| `Shift` | **Boost** — limited reserve, refills when released |
| `1` | Return to the last gate cleared (if you get wedged) |
| `Esc` | Pause — resume, restart, new track, or back to the main menu |

Left hand flies; the right hand holds altitude on `K` and `M`.

`Space` fires a power-up, but power-ups are currently switched off — see below
— so it is unbound. Restart and new-track are buttons on the pause and finish
screens rather than keys. Music is muted with the speaker button on the HUD, because `M` is the
descend key.

Two details in `core/Input.js` worth knowing:

- **Nothing is bound to `⌘` or `Ctrl`**, which avoids a real platform problem.
  While `⌘` is held, macOS treats the keyboard as a menu-shortcut context: it
  makes `keyup` for other keys unreliable *and* suppresses auto-repeat
  `keydown`. Between them no liveness signal survives, so nothing can verify
  whether a key is still down — an earlier scheme that used `⌘` for descend
  would drop the forward key mid-flight because of it. The latching code for
  that case is still present, but now purely defensive. `Shift` is a modifier
  too and carries none of this behaviour, so boost is unaffected.
- **Keys are matched on physical key code**, not the character produced, so
  holding `Shift` for boost does not stop altitude control working.

### Boost

`Shift` widens the flight envelope rather than applying a magic shove: it
raises the tilt limit from 38° to 55° *and* the available rotor thrust by 50%.
Tilt is what produces horizontal acceleration, and holding altitude at a
steeper lean costs more thrust (`mg / cos θ`) — so raising one without the
other would just make the drone sink while it accelerated.

- ~57 → 92 km/h top speed, and noticeably harder acceleration.
- 2.8 s of continuous boost from full; 6 s to refill, starting 0.6 s after you
  release.
- Drain it completely and it locks out: you must release the key *and* let it
  recover to 25% before it will fire again. So an empty meter cannot be
  machine-gunned, and tapping is never better than holding.
- Costs about 1 m of altitude over a full reserve while the vertical-hold
  integrator winds up against the extra drag — a real trade-off, but well
  inside the 4-5 m gate radii.

The meter is the amber bar in the bottom-left panel: it glows while firing and
turns red while locked out.

## Flight model

`src/drone/DronePhysics.js` is a real rigid-body quadcopter, not a kinematic
mover:

- **Four rotors** each produce thrust along the body's +Y axis. Their offsets
  from the centre of mass convert thrust *differences* into pitch and roll
  torque; their alternating spin directions convert them into yaw torque via
  reaction drag. A mixer inverts that relationship to turn a desired
  (thrust, torque) into four rotor commands.
- **Motors have spool-up lag** (first-order, τ = 45 ms), so control is never
  instantaneous, and the forces applied are the ones the rotors *actually*
  produce after lag — not the ones that were commanded.
- **A cascaded controller** sits on top, as in a real flight controller's
  self-levelling mode. The outer loop turns stick input into a target attitude
  and climb rate; a quaternion PD inner loop drives attitude error to zero;
  vertical is a climb-rate controller with a clamped integrator, so releasing
  the stick holds altitude.
- **Full Euler rigid-body integration**, including the `ω × Iω` gyroscopic term,
  so hard yaw genuinely couples into pitch and roll.
- **Anisotropic quadratic drag** per body axis, which is what gives the craft
  its terminal speed (~56 km/h, ~92 boosted) and its settling behaviour. Note
  that because drag is evaluated in the *body* frame, a steep lean puts a large
  slice of horizontal airspeed onto the body's vertical axis — so that
  coefficient is deliberately moderate. Descent rate is regulated by the climb
  controller, not by drag.

Physics runs at a **fixed 240 Hz** decoupled from the render rate. Gains this
stiff are not stable at a variable 60 Hz step, and a fixed step is also what
lets two clients agree, which matters for multiplayer later.

## Racing the field

**Bots** are chosen on the start screen (none / 3 / 5 / 7) and remembered. A
bot is not a scripted mover: it owns a real `DronePhysics` body and a real
boost reserve, and flies by pushing the same four stick values a player does —
same drag, same tilt limits, same motor lag, same buildings to hit. Its gates
are judged by the same `crossedGate` rule as yours, so nobody is scored on
different terms.

Its controller is a two-stage pursuit: `lineup` flies to a staging point on
the gate's own axis so the approach arrives square to the aperture, then
`commit` drives at a point *beyond* the gate so it flies through rather than
converging on the threshold and stopping. Overshooting drops it back to
`lineup` to go round again — without that, a bot that misses parks itself just
past the gate forever. A watchdog puts a wedged bot back on the line at its
last gate, so a field can never strand one.

Skill is spread evenly rather than randomly across the field, so even three
bots contain a fast one and a slow one. Seven bots cost about 0.026 ms per
frame in total.

### Missing gates

A bot that never fluffs a gate is both unbeatable and obviously mechanical.
Rather than letting a bot *decide* to skip one — which would mean judging it
by different rules than the player — a fumble is produced by shoving its aim
off the gate axis and letting the physics and the ordinary `crossedGate` test
settle what happens. About 10 % of shoved approaches still clip the ring and
count, which is exactly the near-miss you want; the rest sail past, the
existing overshoot recovery sends the bot round again, and the lost seconds
are real. Every bot also carries a small permanent aim offset per gate, so
even clean approaches are not laser-straight.

Measured over 40 bot-races: **5.8 % of gates missed** (0.93 per race), 90 % of
intended fumbles landing as real misses, every bot still finishing, and the
skill gradient holding — the fastest bot missed 1 gate and averaged 59.6 s
while the slowest missed 13 and averaged 92.5 s.

Two details took measuring to get right:

- **The offset has to be far larger than the ring.** The drone crosses the
  gate plane roughly midway between its on-axis staging point (~15 m back) and
  its aim point (~14 m beyond), so only about half the lateral offset has been
  realised by the time it reaches the ring. An offset of 1.2× the radius
  therefore sailed straight through the middle, and the realised miss rate was
  1.9 % against a configured 3–13 %.
- **The aim point must stay well beyond the gate.** Pulling it close to the
  plane so the offset landed fully looked like the obvious fix, and broke
  recovery instead: `ahead` never passed the overshoot threshold, so bots hung
  beside the ring waiting on the 14-second watchdog and lap times ballooned
  to 173 s.

Bot randomness is seeded from the track, so a given seed reproduces the same
race — which the networking plan depends on, since it ships only a seed.

**Standings** update live on the left. Order is: finishers first (earliest
first), then whoever has cleared more gates, then whoever reached the current
gate soonest. Gaps show as time between racers on the same gate and as gates
when they are not — a gap in seconds is meaningless between racers at
different points on the course. Ties break by name so rows never jitter.

## Power-ups — currently switched off

**`FEATURES.powerUps` in [`src/config.js`](src/config.js) is `false`.** With it
off, no crates spawn, `Space` is unbound (and un-swallowed, so it activates a
focused button again), and the item slot, effect pips and the `Space` row in
the controls list all disappear — nothing is advertised that does not work.
Set the flag to `true` to bring the whole feature back; there is nothing else
to change. The code stays in the tree and stays covered by `npm run verify`,
so it will not rot while it is off.

The rest of this section describes it as it behaves when enabled.

Crates sit on the racing line; fly through one to pick it up, `Space` to use
it. You carry one at a time. Offensive items target the racer ahead, and the
drop table only rolls them when there is somebody to aim at, so a solo run
never hands you a dud.

| Item | Effect |
| --- | --- |
| **Homing missile** | Steers after the racer ahead at a bounded turn rate, so a fast, evasive drone can make it miss. On impact: velocity to zero, a spin kick, and degraded control authority — the same thing the collision solver already does on a hard impact. |
| **Rotor jam** | Degrades one of the victim's four rotors. |
| **Gate scrambler** | Hides their next gate's ring, chevron and distance for 4 s. |
| **Overdrive** | Refills the boost reserve and clears any lockout. |
| **Afterburner** | Cuts drag rather than adding thrust: 57 → 95 km/h, but coast-down goes from 5.2 s to 14.7 s. A trade, not an upgrade. |
| **Focus** | Slows the world to 60 % while your input rate stays full. |
| **Phase** | Collision off for 3 s — fly straight through a tower. |
| **Mine** | Dropped behind you, armed after a moment so you cannot mine yourself. |

Rotor jam is the one that exploits the simulation. Because the physics runs a
real four-rotor mixer under a PD attitude controller, degrading one rotor makes
the victim's *own* controller fight the asymmetry, and the lurching that comes
out is emergent rather than animated.

It is modelled as a **fluctuating** rotor, and that detail is load-bearing. A
steady loss turned out not to be a usable dial at all: while the controller has
thrust headroom it compensates completely and nothing is felt, and the instant
the loss exceeds what a hover needs the airframe flips and never recovers —
measured as a cliff between 0° and 182° of tilt with nothing in between.
Oscillating the delivered thrust keeps the controller permanently a step
behind, which gives a smooth severity dial: 25° of wobble hovering, 38° under
power, fully recoverable when it expires.

Not implemented from the original list: EMP/shock, tether, ink cloud, gyro
lock, turbulence patch, downdraft well. The effect system takes them as timed
modifiers on `body.mods` or as flags, so they are additive rather than
structural.

## Presentation

**Day / night** is chosen on the start screen and remembered. Everything a
theme touches is declared in one table in `world/Environment.js`, and the
switch mutates existing objects rather than rebuilding the scene — sky
gradient, fog colour and density, all four lights, the ground, both grids,
star visibility and tone-mapping exposure. `Structures` re-tints its instance
colour buffers to match: dark blue-greys lit by their own light strips at
night, concrete and glass with muted cladding by day.

**Compass tape** across the top and **altitude tape** down the right are
canvas-drawn (`ui/Compass.js`, `ui/AltitudeTape.js`) rather than assembled
from DOM nodes — both scroll continuously, and redrawing ~40 elements per
frame would be wasteful. Drawing only the visible arc also makes the compass's
360°/0° wrap free of any seam. Each redraws only when its value has moved far
enough to change a pixel. The altitude tape marks the ground line, which is
the most useful reference there is when you are threading a low gate.

**Boost** shows as a tube of streaks around the flight axis
(`drone/BoostEffect.js`) whose speed and length scale with actual velocity, so
it reads as air rushing past rather than a fixed animation. It is one
`LineSegments` with a dynamic buffer — 72 streaks, one draw call, no texture.
A matching screen-space rush stays strictly peripheral so it never competes
with the gate you are flying at.

**Music** starts with each round, loops, and stops on the main menu
(`core/Music.js`). Volume ramps rather than cutting, and if the browser's
autoplay policy ever rejects playback the module arms a one-shot listener and
retries on the next interaction instead of silently staying mute. The speaker
button on the HUD mutes, and the choice persists.

## Track generation

`src/world/TrackGenerator.js` walks a polyline from a shuffled deck of moves —
straight, hard left, hard right, climb, dive, hairpin — seeded with a guaranteed
quota of each. Two details are load-bearing:

- **Gates sit mid-leg, not on the corners**, and take their normal from the
  spline's own tangent there. On a corner the smoothed curve's local direction
  can be nearly the *reverse* of the incoming leg (badly so at a hairpin), which
  makes a corner-mounted gate impossible to claim in the forward direction.
  Mid-leg also puts the turn *between* gates, so you corner and then thread.
- **The six-axis requirement is verified, not assumed.** Altitude clamping can
  silently eat a climb or dive, so a finished course is checked for climb gates,
  dive gates, perpendicular legs and at least one true reversal, and regenerated
  if it comes up short. Courses with visually overlapping gate rings are
  rejected the same way.

Obstacles are rejected unless they clear the racing line by 8.5 m and every gate
aperture by a margin, so a generated course is always flyable. The whole city
renders in two instanced draw calls.

Checkpoints are validated by testing the **segment the drone travelled this
frame** against the gate's plane, not by proximity. A gate therefore cannot be
missed by flying through it fast, and cannot be claimed by reversing back
through it.

## Verification

`npm run verify` drives the real modules headlessly — no browser needed:

- Flight model: hover holds altitude, each control moves the drone in the
  correct direction, climb/descent rates, recovery from a violent tumble,
  resting on the ground without sinking or jittering.
- Boost: top speed and acceleration gains, vertical hold converges under
  sustained boost, altitude cost per reserve, and every rule of the meter —
  drain, lockout, release-to-re-engage, refill timing, and that tapping the key
  never beats holding it.
- Input, against a stubbed event target: that every binding maps to exactly
  one action and releases cleanly, that forward + yaw + climb + boost hold
  together, that descend survives `Shift` being held for boost, that `M`
  descends without also muting, that removed bindings fire nothing, and that a
  spurious `keyup` under `⌘` is still ignored defensively.
- Trail continuity across the ring buffer's wrap-around.
- Standings: every ordering rule, both gap forms, and that ties order stably.
- Bots: that every bot finishes every course against live collision, that no
  field strands one, and that the skill spread actually produces a field.
- Gate misses: that they happen, that they stay occasional rather than
  constant, that an intended fumble usually becomes a real miss, that weaker
  bots miss more and finish later for it, that a fumbled gate is retried
  cleanly rather than looped on, and that a bot race is reproducible from its
  seed.
- Power-ups (still tested while the feature is off, so it does not rot): that
  the flag is off, that a jam reaches exactly one rotor and swings past what a hover
  needs, that it lurches but stays recoverable, that afterburner's speed gain
  costs braking, that a hit kills momentum and its authority loss expires, and
  that solo races never roll a target-seeking item.
- Pickups: swept collection (a 280 m single frame still collects), cooldown and
  respawn, and — the one that caught a real bug — that **flying the racing line
  actually collects crates**. Placement that looked fine on paper sat on the
  corners between gates, exactly where a flown path departs furthest from the
  smoothed curve, and collected 0 %. It is 80 % now.
- Generation, across 60 seeds: six-axis coverage, no overlapping gates, racing
  line clearance, no obstacle blocking an aperture.
- Race rules: forward crossings count, reverse crossings do not, an 80 m
  single-frame jump still registers.
- **Flyability**: a pursuit autopilot flies the real physics through complete
  courses against live collision. This is the check that proves generated tracks
  are actually raceable rather than merely generated.

## Playing online

Two pieces, because they have different hosting needs:

| Piece | Where |
| --- | --- |
| Game client (static) | **Vercel** |
| Realtime relay | **Cloudflare Workers + Durable Objects** (`server/`) |

Vercel cannot host the relay half. Its functions start per request, have
execution limits, and cannot hold an open WebSocket or keep room state
between calls — the opposite of what a lobby needs.

Durable Objects fit because a room *is* an object: one Durable Object per
race code, single-threaded, with its own state. It uses the **WebSocket
Hibernation** API, so an idle lobby is evicted and costs nothing until a
message arrives, which is why this stays inside the free tier for a group of
friends.

### Deploy the relay

```bash
cd server
npx wrangler login       # once, in your own browser
npm run deploy
```

`wrangler deploy` prints a URL like
`https://dronerun-relay.<your-subdomain>.workers.dev`. Paste it into
`PRODUCTION_RELAY` in [`src/config.js`](src/config.js) as a `wss://` URL, then
redeploy the client. Until that constant is set, the start screen simply
hides the online controls rather than offering a button that cannot work.

Run it locally with `cd server && npm run dev`; the client points at
`ws://127.0.0.1:8787` automatically on localhost. A `?relay=` query parameter
overrides both, which is useful for pointing a deployed client at a local
relay while debugging.

`cd server && npm test` runs 21 protocol checks against a running relay:
seeding, host assignment and migration, ready state, permission (only the
host may change the course or start), state relay, and refusing a ninth
player.

### How a race works

The host creates a room and shares the invite link, which carries the room
code and seed. Opening it drops a friend straight into the lobby. Everyone
readies up, the host starts, and each client runs its own 3-2-1.

Clocks are deliberately *not* synchronised. Aligning them would buy tens of
milliseconds, which is meaningless when every player's time is measured
locally from their own countdown ending.

Only kinematic state crosses the wire — course geometry never does, since
both ends generate it from the seed. That is about 40 bytes per player per
tick, so a full eight-player room is roughly 6 KB/s. Peers are rendered
120 ms behind the newest packet and interpolated between the two snapshots
that straddle render time, so 20 Hz updates draw smoothly at any frame rate.

Bots are suppressed in an online race — the lobby is the field. Mixing them in
would also mean every client stamping bot splits on its own race clock, so
the standings would disagree between players. Human opponents appear on the
live scoreboard on the same terms as anyone else.

## Deploying to Vercel

Vercel auto-detects the Vite setup; `vercel.json` pins it explicitly. Push the
repo and import it, or:

```bash
npx vercel --prod
```

The seed lives in the URL fragment (`/#seed=cobalt-drift-417`), so a link
reproduces a course exactly — no account, no lobby. Pasting a link into an
already-open tab is picked up too, since a fragment change alone does not reload
the page.

## Adding multiplayer

**Vercel alone cannot host the realtime half.** Serverless functions start per
request, have execution limits, and cannot hold an open WebSocket or keep room
state between calls. Host the client on Vercel and the socket server somewhere
persistent — a small Node `ws` service on Fly.io or Railway, or one Cloudflare
Durable Object per room.

The seam is already in place in `src/net/Network.js`:

- **Geometry is never transmitted.** Both ends derive the course from the seed,
  so a room is just a seed string and per-frame traffic is only each drone's
  position and orientation — about 40 bytes per player per tick.
- `RemoteFleet` already renders and interpolates other players' drones, holding
  them ~120 ms behind the newest packet and interpolating between the two
  snapshots that straddle render time, so 20 Hz updates draw smoothly at 144 fps.
- `makeStatePacket` one-sources the wire format.

To go live, implement `NetworkAdapter`'s four methods against your transport and
emit `join` / `leave` / `state`, then hand that adapter to `Game` in place of
`LocalAdapter`. Nothing else changes.

## Layout

```
src/
  core/     Game loop, input, camera rig, seeded RNG, share links, music
  drone/    Flight physics; boost reserve and its speed streaks; airframe mesh
  world/    Track generation, collision, obstacle rendering, sky/lighting
  race/     Checkpoint rules and timing; gate visuals and racing line;
            bots, standings, power-ups, pickups and projectiles
  net/      Adapter contract, peer rendering, Cloudflare relay client
server/     Cloudflare Worker + Durable Object relay, and its protocol tests
  ui/       HUD panels, modals, compass, altitude tape, scoreboard, indicator
  net/      Networking interface, remote drone interpolation
public/
  BG.mp3      Background music, served unhashed rather than bundled
scripts/
  verify.mjs  Headless verification suite
```

`window.game` is exposed in the browser for debugging.
