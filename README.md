# 🐍 Serpent Swarm

A single-file HTML5 snake game with monster waves, escape portals and a rising
score clock. No build step, no dependencies, no server — one `index.html` of
vanilla JavaScript and Canvas 2D.

## Play

- Online: <https://snake.ag-insights.co.uk>
- Locally: open `app/index.html` in a browser.

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Steer | Arrow keys | Swipe |
| Start / restart | Any key / Space | Tap |
| Save a high score | Type 1–6 printable non-space characters, then Enter | — |
| Decline name entry | Space | Tap |

## How it plays

- Red apples grow the snake, yellow apples double it, ICE apples freeze the swarm.
- Monster waves arrive on a countdown: they double to 16, then grow by 8 per wave,
  and the last half of every wave runs at double speed.
- Score thresholds open an escape portal; reach its gateway before the countdown
  ends to start the next level.
- A body hit cuts your tail; a head hit — snake, monster or wall — ends the run.
- High scores persist in `localStorage`.

## Development

There is no toolchain. Edit `app/index.html` and refresh.

The regression suite needs only Node:

```
node tests/harness.mjs            # all checks
node tests/harness.mjs --list     # list them
node tests/harness.mjs --filter T18
```

It extracts the game script from `app/index.html`, runs the real functions in a
stub-DOM `vm` context and drives movement, collisions, portals, timers, input and
rendering with controlled random, clock, storage and touch.

## Deploy

`app/` is the deployable unit; `app/netlify.toml` publishes exactly that folder,
never the repository root.

```
cd app && netlify deploy --prod
```
