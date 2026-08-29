import { describe, expect, it } from "vitest";
import { canMove, isValidBoard, keyToDirection, moveBoard, slideLine, type Board } from "./logic";

function board(rows: number[][]): Board {
  return rows.map((row) => [...row]);
}

describe("slideLine", () => {
  it("slides values to the left", () => {
    expect(slideLine([2, 0, 2, 0]).line).toEqual([4, 0, 0, 0]);
  });

  it("merges equal neighbours once (no double merge)", () => {
    // [2,2,2,2] -> [4,4,0,0], not [8,0,0,0]
    const result = slideLine([2, 2, 2, 2]);
    expect(result.line).toEqual([4, 4, 0, 0]);
    expect(result.gained).toBe(8);
  });

  it("does not merge through an already-merged tile", () => {
    expect(slideLine([4, 2, 2, 0]).line).toEqual([4, 4, 0, 0]);
  });

  it("reports gained score from merges only", () => {
    expect(slideLine([2, 2, 4, 0]).gained).toBe(4);
    expect(slideLine([2, 4, 8, 0]).gained).toBe(0);
  });
});

describe("moveBoard directions (FP-2A.1)", () => {
  it("left: tiles move towards column 0", () => {
    const result = moveBoard(
      board([
        [0, 0, 2, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "left",
    );
    expect(result.board[0]).toEqual([2, 0, 0, 0]);
    expect(result.moved).toBe(true);
  });

  it("right: tiles move towards the last column", () => {
    const result = moveBoard(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "right",
    );
    expect(result.board[0]).toEqual([0, 0, 0, 2]);
  });

  it("up: a tile in the lower area moves upward", () => {
    const result = moveBoard(
      board([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      "up",
    );
    expect(result.board[0]![0]).toBe(2);
    expect(result.board[3]![0]).toBe(0);
  });

  it("up: a tile already at the top stays put and reports moved=false", () => {
    const start = board([
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const result = moveBoard(start, "up");
    expect(result.board).toEqual(start);
    expect(result.moved).toBe(false);
  });

  it("down: a tile in the upper area moves downward", () => {
    const result = moveBoard(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "down",
    );
    expect(result.board[0]![0]).toBe(0);
    expect(result.board[3]![0]).toBe(2);
  });

  it("down: a tile already at the bottom stays put", () => {
    const start = board([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    const result = moveBoard(start, "down");
    expect(result.board).toEqual(start);
    expect(result.moved).toBe(false);
  });

  it("merges vertically in a column for up", () => {
    const result = moveBoard(
      board([
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "up",
    );
    expect(result.board[0]![0]).toBe(4);
    expect(result.board[1]![0]).toBe(0);
    expect(result.gained).toBe(4);
  });

  it("an unchanged board reports moved=false", () => {
    const start = board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(moveBoard(start, direction).moved).toBe(false);
    }
  });
});

describe("canMove", () => {
  it("allows moves while any cell is empty", () => {
    expect(canMove(board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 0],
    ]))).toBe(true);
  });

  it("allows moves when neighbours match", () => {
    expect(canMove(board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 4],
    ]))).toBe(true);
  });

  it("detects game over on a full unmergeable board", () => {
    expect(canMove(board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]))).toBe(false);
  });
});

describe("keyToDirection (FP-2A.2)", () => {
  it("maps arrow keys", () => {
    expect(keyToDirection("ArrowLeft")).toBe("left");
    expect(keyToDirection("ArrowRight")).toBe("right");
    expect(keyToDirection("ArrowUp")).toBe("up");
    expect(keyToDirection("ArrowDown")).toBe("down");
  });

  it("maps WASD in both cases", () => {
    expect(keyToDirection("w")).toBe("up");
    expect(keyToDirection("a")).toBe("left");
    expect(keyToDirection("s")).toBe("down");
    expect(keyToDirection("d")).toBe("right");
    expect(keyToDirection("W")).toBe("up");
    expect(keyToDirection("A")).toBe("left");
    expect(keyToDirection("S")).toBe("down");
    expect(keyToDirection("D")).toBe("right");
  });

  it("ignores unrelated keys", () => {
    expect(keyToDirection("x")).toBeUndefined();
    expect(keyToDirection("Enter")).toBeUndefined();
    expect(keyToDirection(" ")).toBeUndefined();
  });
});

describe("isValidBoard (FP-13.2)", () => {
  it("accepts a 4x4 board of zeros and powers of two", () => {
    const board = [
      [2, 4, 8, 2048],
      [0, 0, 2, 4],
      [0, 0, 0, 0],
      [1024, 512, 256, 128],
    ];
    expect(isValidBoard(board)).toBe(true);
  });

  it("rejects wrong dimensions", () => {
    expect(isValidBoard([[2, 0, 0, 0]])).toBe(false);
    expect(isValidBoard([[], [], [], []])).toBe(false);
    expect(isValidBoard([])).toBe(false);
    expect(isValidBoard("nope")).toBe(false);
    expect(isValidBoard(null)).toBe(false);
  });

  it("rejects non-integer, negative and non-power-of-two tiles", () => {
    expect(isValidBoard([
      [1.5, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])).toBe(false);
    expect(isValidBoard([
      [-2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])).toBe(false);
    expect(isValidBoard([
      [3, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])).toBe(false);
  });
});
