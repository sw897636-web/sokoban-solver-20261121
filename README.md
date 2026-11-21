# sokoban-solver-20261121

[make.fun bounty: sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. Built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.

## How it works

Every generated level is a one-wide hallway with 1-4 rooms off it, each room
holding 3-4 boxes and as many goals, and a box pushed out of a room's door
can never return, so the rooms are independent problems joined only by the
player's walk. A level's push-optimal count is the sum of its rooms' optima,
so the solver decomposes each level into hallway + rooms, solves each room
push-optimally, and joins the room solutions with hallway walks.

Each room is solved with A* over macro pushes: a state is the sorted box
cells plus the player's reachable region, the heuristic is the cheapest
box-to-goal assignment under push distances that ignore other boxes, and
states are pruned by static dead cells (reverse push-reachability from the
goals) and by 2x2 freeze deadlocks. The search is deterministic: no clock,
no randomness, fixed iteration orders, and a node cap (work, not time) as
the only cut-off, so two runs write identical bytes.

Practice set: 1,000,000 (all 5 instances solved in exactly P* pushes:
13, 16, 29, 47, 60), in about 0.4 seconds for the whole set.

## Run it

```sh
node main.ts [inputDir] [outputDir]
```

Defaults are `/input` and `/output`. It reads `<inputDir>/<id>/level.txt`
for every sub-directory id and writes `<outputDir>/<id>/solution.txt` with
the player's moves (`u`/`d`/`l`/`r`).

## License

MIT. See [LICENSE](LICENSE).
