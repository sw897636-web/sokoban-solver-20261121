// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy (from the published level structure, not from any solver code):
// every level is a one-wide hallway with 1-4 rooms off it, each room holding
// 3-4 boxes and as many goals, and a box pushed out of a room's door can
// never return, so the rooms are independent problems joined only by the
// player's walk. A level's push-optimal count is the sum of its rooms'
// optima, so this program solves each room push-optimally and concatenates
// the room solutions with hallway walks in between.
//
// Each room is solved with A* over macro pushes: a state is the sorted box
// cells plus the player's reachable region, the heuristic is the cheapest
// box-to-goal assignment under push distances that ignore other boxes, and
// states are pruned by static dead cells (reverse push-reachability from
// the goals) and by 2x2 freeze deadlocks. The search is deterministic: no
// clock, no randomness, fixed iteration orders, and a node cap (work, not
// time) as the only cut-off, so two runs write identical bytes.
//
// Usage: node main.ts [inputDir] [outputDir]  (defaults /input and /output,
// or MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR when set by the harness)
// Reads <inputDir>/<id>/level.txt for every sub-directory id and writes
// <outputDir>/<id>/solution.txt with the player's moves (u/d/l/r).

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// The cell one step from i in direction d, or -1 when that step leaves the board.
function stepCell(W, H, i, d) {
  const x = i % W;
  const y = (i / W) | 0;
  const nx = x + DIRS[d].dx;
  const ny = y + DIRS[d].dy;
  if (nx < 0 || nx >= W || ny < 0 || ny >= H) return -1;
  return ny * W + nx;
}

// Breadth-first walk from `from` over cells where pass[c] is 1 and c is not
// in `blocked` (an array of cell indices). Returns the move string, or null
// when `to` cannot be reached. Deterministic: directions tried u, d, l, r.
function walkMoves(W, H, pass, blocked, from, to) {
  const N = W * H;
  if (from === to) return '';
  const parent = new Int32Array(N).fill(-1);
  const pdir = new Int8Array(N).fill(-1);
  const isBlocked = new Uint8Array(N);
  for (const b of blocked) isBlocked[b] = 1;
  parent[from] = from;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi];
    for (let d = 0; d < 4; d++) {
      const y = stepCell(W, H, x, d);
      if (y < 0 || !pass[y] || isBlocked[y] || parent[y] >= 0) continue;
      parent[y] = x;
      pdir[y] = d;
      if (y === to) {
        const chars = [];
        let c = y;
        while (parent[c] !== c) {
          chars.push(DIRS[pdir[c]].ch);
          c = parent[c];
        }
        chars.reverse();
        return chars.join('');
      }
      q.push(y);
    }
  }
  return null;
}

function parseLevel(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const h = lines.length;
  let w = 0;
  for (const l of lines) if (l.length > w) w = l.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const line = lines[y];
    for (let x = 0; x < line.length; x++) {
      const c = line[x];
      const i = y * w + x;
      if (c === '#') continue;
      wall[i] = 0;
      if (c === '.') goal[i] = 1;
      else if (c === '$') boxes.push(i);
      else if (c === '*') {
        boxes.push(i);
        goal[i] = 1;
      } else if (c === '@') player = i;
      else if (c === '+') {
        player = i;
        goal[i] = 1;
      }
    }
  }
  return { w, h, wall, goal, boxes, player };
}

function permutations(n) {
  const out = [];
  const cur = [];
  const used = new Array(n).fill(false);
  (function gen() {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      gen();
      cur.pop();
      used[i] = false;
    }
  })();
  return out;
}

// Push-optimal search for one region (a room, or the whole level as a
// fallback). isPlay marks the cells the player may walk on; isBox marks the
// cells a box may be pushed onto. boxes0 and goals0 are cell indices.
// Returns { moves, finalPlayer } or null. `greedy` switches the priority
// from A* (g + h) to best-first (h only) as a fallback that finds any
// solution when the optimal search runs out of its node budget.
function solveRegion(W, H, wall, isPlay, isBox, boxes0, goals0, startPlayer, maxExpansions, greedy) {
  const N = W * H;
  const goals = goals0.slice().sort((a, b) => a - b);
  const goalSet = new Uint8Array(N);
  for (const g of goals) goalSet[g] = 1;
  const n = goals.length;
  const startBoxes = boxes0.slice().sort((a, b) => a - b);

  // Push distances in box space: distFrom[a][b] is the fewest pushes that
  // move one box from a to b, ignoring other boxes. A push from x to a
  // neighbour y needs the player to stand on the cell behind x.
  const distFrom = new Array(N).fill(null);
  for (let a = 0; a < N; a++) {
    if (!isBox[a]) continue;
    const dist = new Int32Array(N).fill(-1);
    dist[a] = 0;
    const q = [a];
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      for (let d = 0; d < 4; d++) {
        const y = stepCell(W, H, x, d);
        if (y < 0 || !isBox[y] || dist[y] >= 0) continue;
        const behind = stepCell(W, H, x, d ^ 1);
        if (behind < 0 || !isPlay[behind]) continue;
        dist[y] = dist[x] + 1;
        q.push(y);
      }
    }
    distFrom[a] = dist;
  }

  // Static dead cells: reverse push-reachability from the goals. A cell a
  // box sits on that cannot reach any goal this way is dead for good.
  const live = new Uint8Array(N);
  const lq = [];
  for (const g of goals) {
    live[g] = 1;
    lq.push(g);
  }
  for (let qi = 0; qi < lq.length; qi++) {
    const y = lq[qi];
    for (let d = 0; d < 4; d++) {
      const x = stepCell(W, H, y, d ^ 1);
      if (x < 0 || !isBox[x] || live[x]) continue;
      const behind = stepCell(W, H, x, d ^ 1);
      if (behind < 0 || !isPlay[behind]) continue;
      live[x] = 1;
      lq.push(x);
    }
  }
  const dead = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (isBox[c] && !live[c]) dead[c] = 1;

  // 2x2 blocks that touch the box domain, for the freeze-deadlock check.
  const blocks = [];
  for (let y = 0; y + 1 < H; y++) {
    for (let x = 0; x + 1 < W; x++) {
      const c = y * W + x;
      const blk = [c, c + 1, c + W, c + W + 1];
      if (blk.some((cell) => isBox[cell])) blocks.push(blk);
    }
  }

  const perms = n <= 5 ? permutations(n) : null;
  function heuristic(boxes) {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = distFrom[boxes[i]][goals[p[i]]];
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const d = distFrom[boxes[i]][goals[j]];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  }

  function isDeadState(boxes) {
    for (const b of boxes) if (dead[b]) return true;
    for (const blk of blocks) {
      let filled = true;
      let bad = false;
      for (const c of blk) {
        if (boxes.indexOf(c) >= 0) {
          if (!goalSet[c]) bad = true;
        } else if (!wall[c]) {
          filled = false;
          break;
        }
      }
      if (filled && bad) return true;
    }
    return false;
  }

  // The player's reachable region from `start` with `boxes` as obstacles:
  // parent links for walk reconstruction, the region's smallest cell (the
  // canonical key of the region), and a membership map.
  function regionFrom(start, boxes) {
    const parent = new Int32Array(N).fill(-1);
    const pdir = new Int8Array(N).fill(-1);
    const inRegion = new Uint8Array(N);
    parent[start] = start;
    inRegion[start] = 1;
    const q = [start];
    let regionMin = start;
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      if (x < regionMin) regionMin = x;
      for (let d = 0; d < 4; d++) {
        const y = stepCell(W, H, x, d);
        if (y < 0 || !isPlay[y] || inRegion[y] || boxes.indexOf(y) >= 0) continue;
        inRegion[y] = 1;
        parent[y] = x;
        pdir[y] = d;
        q.push(y);
      }
    }
    return { parent, pdir, inRegion, regionMin };
  }

  function regionMinFrom(start, boxes) {
    return regionFrom(start, boxes).regionMin;
  }

  function pathFrom(region, target) {
    const chars = [];
    let c = target;
    while (region.parent[c] !== c) {
      chars.push(DIRS[region.pdir[c]].ch);
      c = region.parent[c];
    }
    chars.reverse();
    return chars.join('');
  }

  function sameBoxes(a, b) {
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Binary heap ordered by (f, -g, insertion order): deterministic.
  const heap = [];
  let seq = 0;
  function heapLess(a, b) {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g > b.g;
    return a.seq < b.seq;
  }
  function heapPush(node) {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i];
        heap[i] = heap[m];
        heap[m] = t;
        i = m;
      }
    }
    return top;
  }

  const best = new Map();
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity || isDeadState(startBoxes)) return null;
  const startKey = startBoxes.join(',') + '@' + regionMinFrom(startPlayer, startBoxes);
  best.set(startKey, 0);
  heapPush({
    f: greedy ? h0 : h0,
    g: 0,
    h: h0,
    key: startKey,
    boxes: startBoxes,
    player: startPlayer,
    parentKey: null,
    moves: '',
    seq: seq++,
  });
  // Parent records for reconstruction: key -> { parentKey, moves, boxes, player }.
  const records = new Map();
  records.set(startKey, { parentKey: null, moves: '', boxes: startBoxes, player: startPlayer });

  let expansions = 0;
  while (heap.length > 0) {
    const cur = heapPop();
    if (best.get(cur.key) !== cur.g) continue;
    if (sameBoxes(cur.boxes, goals)) {
      const parts = [];
      let k = cur.key;
      while (k !== null) {
        const r = records.get(k);
        parts.push(r.moves);
        k = r.parentKey;
      }
      parts.reverse();
      return { moves: parts.join(''), finalPlayer: cur.player };
    }
    if (++expansions > maxExpansions) return null;
    const region = regionFrom(cur.player, cur.boxes);
    for (let i = 0; i < n; i++) {
      const b = cur.boxes[i];
      for (let d = 0; d < 4; d++) {
        const t = stepCell(W, H, b, d);
        if (t < 0 || !isBox[t] || cur.boxes.indexOf(t) >= 0) continue;
        const pp = stepCell(W, H, b, d ^ 1);
        if (pp < 0 || !isPlay[pp] || cur.boxes.indexOf(pp) >= 0) continue;
        if (!region.inRegion[pp]) continue;
        const nb = cur.boxes.slice();
        nb[i] = t;
        nb.sort((a, c) => a - c);
        if (isDeadState(nb)) continue;
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const ng = cur.g + 1;
        const rep = regionMinFrom(b, nb);
        const key = nb.join(',') + '@' + rep;
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        if (greedy && prev !== undefined) continue;
        best.set(key, ng);
        const moves = pathFrom(region, pp) + DIRS[d].ch;
        records.set(key, { parentKey: cur.key, moves, boxes: nb, player: b });
        heapPush({
          f: greedy ? h : ng + h,
          g: ng,
          h,
          key,
          boxes: nb,
          player: b,
          parentKey: cur.key,
          moves,
          seq: seq++,
        });
      }
    }
  }
  return null;
}

// Solve one whole level: decompose into hallway + rooms, solve each room
// push-optimally, and join the room solutions with hallway walks.
// Returns the move string, or '' when the level cannot be solved.
function solveLevel(text) {
  const { w: W, h: H, wall, goal, boxes, player } = parseLevel(text);
  const N = W * H;
  if (player < 0 || boxes.length === 0) return '';
  const hallRow = (player / W) | 0;
  const inHall = (c) => ((c / W) | 0) === hallRow;

  // Connected components of the floor off the hallway row: the rooms.
  const seen = new Uint8Array(N);
  const rooms = [];
  for (let c = 0; c < N; c++) {
    if (wall[c] || inHall(c) || seen[c]) continue;
    const comp = [];
    const q = [c];
    seen[c] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      comp.push(x);
      for (let d = 0; d < 4; d++) {
        const y = stepCell(W, H, x, d);
        if (y < 0 || wall[y] || inHall(y) || seen[y]) continue;
        seen[y] = 1;
        q.push(y);
      }
    }
    const compSet = new Uint8Array(N);
    for (const x of comp) compSet[x] = 1;
    const cBoxes = boxes.filter((b) => compSet[b]);
    if (cBoxes.length === 0) continue;
    const cGoals = [];
    for (let i = 0; i < N; i++) if (goal[i] && compSet[i]) cGoals.push(i);
    if (cBoxes.length !== cGoals.length) return solveWhole(W, H, wall, goal, boxes, player);
    let door = -1;
    let entry = -1;
    for (const x of comp) {
      for (let d = 0; d < 4; d++) {
        const y = stepCell(W, H, x, d);
        if (y >= 0 && inHall(y) && !wall[y]) {
          door = x;
          entry = y;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) return solveWhole(W, H, wall, goal, boxes, player);
    rooms.push({ comp, compSet, boxes: cBoxes, goals: cGoals, door, entry });
  }
  if (rooms.length === 0) return solveWhole(W, H, wall, goal, boxes, player);
  rooms.sort((a, b) => a.door - b.door);

  // Solve each room from its hallway square outside the door.
  const solved = [];
  for (const r of rooms) {
    const isPlay = new Uint8Array(N);
    for (const x of r.comp) isPlay[x] = 1;
    isPlay[r.entry] = 1;
    const sol =
      solveRegion(W, H, wall, isPlay, r.compSet, r.boxes, r.goals, r.entry, 400000, false) ||
      solveRegion(W, H, wall, isPlay, r.compSet, r.boxes, r.goals, r.entry, 400000, true);
    if (!sol) return '';
    solved.push({ room: r, sol, isPlay });
  }

  // Join the room solutions with walks through the hallway.
  const hallPass = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (!wall[c] && inHall(c)) hallPass[c] = 1;
  const allBoxesNow = boxes.slice();
  let moves = '';
  let cur = player;
  for (let i = 0; i < solved.length; i++) {
    const { room, sol, isPlay } = solved[i];
    let walk = walkMoves(W, H, hallPass, [], cur, room.entry);
    if (walk === null) {
      const openPass = new Uint8Array(N);
      for (let c = 0; c < N; c++) if (!wall[c]) openPass[c] = 1;
      walk = walkMoves(W, H, openPass, allBoxesNow, cur, room.entry);
    }
    if (walk === null) return '';
    moves += walk;
    moves += sol.moves;
    cur = sol.finalPlayer;
    // The room's boxes are now on its goals.
    for (let j = 0; j < allBoxesNow.length; j++) {
      if (room.compSet[allBoxesNow[j]]) allBoxesNow[j] = -1;
    }
    for (let j = 0; j < room.goals.length; j++) allBoxesNow.push(room.goals[j]);
    const keep = allBoxesNow.filter((b) => b >= 0);
    allBoxesNow.length = 0;
    for (const b of keep) allBoxesNow.push(b);
    if (i + 1 < solved.length) {
      // Leave through the door: walk to it (boxes fixed on the goals),
      // then step out onto the hallway square.
      let exit = walkMoves(W, H, isPlay, room.goals, cur, room.door);
      if (exit === null) {
        const openPass = new Uint8Array(N);
        for (let c = 0; c < N; c++) if (!wall[c]) openPass[c] = 1;
        exit = walkMoves(W, H, openPass, allBoxesNow, cur, room.entry);
        if (exit === null) return '';
        moves += exit;
        cur = room.entry;
      } else {
        moves += exit;
        const d = room.entry - room.door;
        let ch = '';
        if (d === 1) ch = 'r';
        else if (d === -1) ch = 'l';
        else if (d === W) ch = 'd';
        else if (d === -W) ch = 'u';
        else return '';
        moves += ch;
        cur = room.entry;
      }
    }
  }
  return moves;
}

// Fallback: solve the whole level as one region (used only when the
// hallway/room decomposition does not apply).
function solveWhole(W, H, wall, goal, boxes, player) {
  const N = W * H;
  const isPlay = new Uint8Array(N);
  const isBox = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (!wall[c]) {
      isPlay[c] = 1;
      isBox[c] = 1;
    }
  }
  const goals = [];
  for (let c = 0; c < N; c++) if (goal[c]) goals.push(c);
  const sol =
    solveRegion(W, H, wall, isPlay, isBox, boxes, goals, player, 200000, false) ||
    solveRegion(W, H, wall, isPlay, isBox, boxes, goals, player, 200000, true);
  return sol ? sol.moves : '';
}

function main() {
  // The harness mounts /input and /output in the grader's container; outside
  // one it passes the same directories as MAKEFUN_INPUT_DIR and
  // MAKEFUN_OUTPUT_DIR (the kit generator and scorer use the same stand-ins).
  // Explicit arguments win, then the environment, then the container paths.
  const inputDir = process.argv[2] || process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.argv[3] || process.env.MAKEFUN_OUTPUT_DIR || '/output';
  let ids = [];
  try {
    ids = readdirSync(inputDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    ids = ['i001', 'i002', 'i003', 'i004', 'i005'];
  }
  for (const id of ids) {
    let moves = '';
    try {
      const text = readFileSync(join(inputDir, id, 'level.txt'), 'utf8');
      moves = solveLevel(text);
    } catch {
      moves = '';
    }
    try {
      mkdirSync(join(outputDir, id), { recursive: true });
      writeFileSync(join(outputDir, id, 'solution.txt'), moves + '\n', 'utf8');
    } catch {
      // A missing output file scores 0 for that instance; keep going.
    }
  }
}

main();
