import { describe, expect, it } from "vitest";
import {
  applyMove,
  boardFromTiles,
  moveBoard,
  spawnTileInTiles,
  tilesFromBoard,
  type Board,
  type Direction,
  type Tile,
} from "./logic";

/**
 * FE-MOTION-4: the tile-identity layer must be a strict parallel of the
 * board-layer slide semantics — same boards, same gained, same moved flag —
 * while adding stable ids for animation. These tests pin the equivalence.
 */

function board(rows: number[][]): Board {
  return rows.map((row) => [...row]);
}

function toTiles(rows: number[][]): Tile[] {
  return tilesFromBoard(board(rows));
}

describe("applyMove equivalence with moveBoard", () => {
  const cases: Array<{ name: string; rows: number[][]; direction: Direction }> = [
    {
      name: "double-merge suppression row [4,4,8] left",
      rows: [
        [4, 4, 8, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      direction: "left",
    },
    {
      name: "[2,2,4] left",
      rows: [
        [2, 2, 4, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      direction: "left",
    },
    {
      name: "column merge up",
      rows: [
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [4, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      direction: "up",
    },
    {
      name: "column merge down",
      rows: [
        [0, 0, 0, 0],
        [4, 0, 0, 0],
        [2, 0, 0, 0],
        [2, 0, 0, 0],
      ],
      direction: "down",
    },
    {
      name: "full board right with row merges",
      rows: [
        [2, 2, 4, 4],
        [4, 4, 8, 8],
        [2, 4, 2, 4],
        [0, 0, 2, 2],
      ],
      direction: "right",
    },
    {
      name: "mixed board up",
      rows: [
        [0, 2, 0, 4],
        [0, 2, 4, 0],
        [4, 0, 4, 4],
        [2, 2, 0, 0],
      ],
      direction: "up",
    },
    {
      name: "no-move checkerboard left",
      rows: [
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, 2],
      ],
      direction: "left",
    },
  ];

  for (const { name, rows, direction } of cases) {
    it(`${name}: board, gained and moved match moveBoard`, () => {
      const start = board(rows);
      const expected = moveBoard(start, direction);
      const result = applyMove(toTiles(rows), direction);
      expect(boardFromTiles(result.tiles)).toEqual(expected.board);
      expect(result.gained).toBe(expected.gained);
      expect(result.moved).toBe(expected.moved);
    });
  }

  it("matches moveBoard for every direction on a merge-heavy board", () => {
    const rows = [
      [2, 2, 2, 2],
      [0, 4, 0, 4],
      [8, 8, 0, 0],
      [0, 0, 16, 16],
    ];
    for (const direction of ["left", "right", "up", "down"] as const) {
      const expected = moveBoard(board(rows), direction);
      const result = applyMove(toTiles(rows), direction);
      expect(boardFromTiles(result.tiles), direction).toEqual(expected.board);
      expect(result.gained, direction).toBe(expected.gained);
      expect(result.moved, direction).toBe(expected.moved);
    }
  });
});

describe("applyMove identity semantics", () => {
  it("suppresses a double merge: [4,4,8] left is [8,8,0,0], gained 8, one merge", () => {
    const tiles = toTiles([
      [4, 4, 8, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const result = applyMove(tiles, "left");
    expect(boardFromTiles(result.tiles)[0]).toEqual([8, 8, 0, 0]);
    expect(result.gained).toBe(8);
    // Exactly one merge: the produced 8 must not re-merge with the original 8.
    expect(result.mergedIds).toHaveLength(1);
    const occurrences = result.tiles.filter((tile) => tile.id === result.mergedIds[0]).length;
    expect(occurrences).toBe(1);
    // Every surviving id appears at most once (no duplicated survivors).
    expect(new Set(result.tiles.map((tile) => tile.id)).size).toBe(result.tiles.length);
  });

  it("does not merge through an already-merged tile: [2,2,4] left is [4,4]", () => {
    const result = applyMove(
      toTiles([
        [2, 2, 4, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "left",
    );
    expect(boardFromTiles(result.tiles)[0]).toEqual([4, 4, 0, 0]);
    expect(result.gained).toBe(4);
    expect(result.mergedIds).toHaveLength(1);
  });

  it("keeps the destination-side tile's id and doubles its value on merge", () => {
    const tiles = toTiles([
      [0, 2, 2, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const leftPair = tiles.find((tile) => tile.c === 1)!;
    const result = applyMove(tiles, "left");
    expect(result.tiles).toHaveLength(1);
    expect(result.tiles[0]).toMatchObject({ id: leftPair.id, value: 4, r: 0, c: 0 });
    expect(result.mergedIds).toEqual([leftPair.id]);
    // The survivor also slid, so the move is tracked as a movement.
    expect(result.movements).toEqual([
      { id: leftPair.id, from: { r: 0, c: 1 }, to: { r: 0, c: 0 } },
    ]);

    const rightPair = tiles.find((tile) => tile.c === 2)!;
    const rightResult = applyMove(tiles, "right");
    expect(rightResult.tiles[0]).toMatchObject({ id: rightPair.id, value: 4, r: 0, c: 3 });
  });

  it("reports a stationary in-place merge as moved with no movements", () => {
    const tiles = toTiles([
      [4, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const result = applyMove(tiles, "left");
    expect(result.moved).toBe(true);
    expect(result.movements).toEqual([]);
    expect(result.mergedIds).toHaveLength(1);
  });

  it("does not mutate the input tiles", () => {
    const tiles = toTiles([
      [0, 2, 0, 2],
      [0, 0, 0, 0],
      [0, 0, 4, 4],
      [0, 0, 0, 0],
    ]);
    const snapshot = tiles.map((tile) => ({ ...tile }));
    applyMove(tiles, "left");
    expect(tiles).toEqual(snapshot);
  });
});

describe("spawnTileInTiles", () => {
  it("spawns exactly one tile on a previously empty cell, across seeds", () => {
    const tiles = toTiles([
      [2, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 8, 0],
    ]);
    const before = boardFromTiles(tiles);
    const beforeCount = before.flat().filter((value) => value !== 0).length;
    for (const roll of [0, 0.25, 0.5, 0.75, 0.99]) {
      let calls = 0;
      // First rng draw picks the cell, the second the value (spawnTile order).
      const rng = () => (calls++ === 0 ? roll : 0.5);
      const spawned = spawnTileInTiles(tiles, rng);
      expect(calls).toBe(2);
      expect(before[spawned.r]![spawned.c]).toBe(0);
      expect([2, 4]).toContain(spawned.value);
      const after = boardFromTiles([...tiles, spawned]);
      expect(after.flat().filter((value) => value !== 0).length).toBe(beforeCount + 1);
      // Existing tiles are untouched.
      for (const tile of tiles) expect(after[tile.r]![tile.c]).toBe(tile.value);
    }
  });

  it("maps the second rng draw to 2 @90% / 4 @10%", () => {
    expect(spawnTileInTiles([], () => 0.5).value).toBe(2);
    expect(spawnTileInTiles([], () => 0.89).value).toBe(2);
    expect(spawnTileInTiles([], () => 0.9).value).toBe(4);
    expect(spawnTileInTiles([], () => 0.95).value).toBe(4);
  });

  it("picks the single remaining empty cell deterministically", () => {
    const tiles = toTiles([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 0],
    ]);
    expect(spawnTileInTiles(tiles, () => 0.99)).toMatchObject({ r: 3, c: 3, value: 4 });
  });

  it("throws when no cell is empty (unreachable through the component)", () => {
    const full = toTiles([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(() => spawnTileInTiles(full, () => 0)).toThrow(/no empty cell/i);
  });
});

describe("tilesFromBoard / boardFromTiles", () => {
  it("round-trips a full board", () => {
    const rows = [
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 2048, 2],
      [0, 0, 0, 0],
    ];
    expect(boardFromTiles(tilesFromBoard(rows))).toEqual(rows);
  });

  it("assigns a unique id per tile", () => {
    const tiles = toTiles([
      [2, 2, 2, 2],
      [4, 4, 4, 4],
      [8, 8, 8, 8],
      [16, 16, 16, 16],
    ]);
    expect(new Set(tiles.map((tile) => tile.id)).size).toBe(tiles.length);
  });
});
