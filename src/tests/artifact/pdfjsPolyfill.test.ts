import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMMatrix2D, ensurePdfjsNodePolyfills } from "../../utils/pdfjsNodePolyfills.ts";

const close = (m: DOMMatrix2D, v: number[]) =>
  [m.a, m.b, m.c, m.d, m.e, m.f].forEach((x, i) => assert.ok(Math.abs(x - v[i]) < 1e-9, `index ${i}: ${x} != ${v[i]}`));

test("identity and init forms", () => {
  close(new DOMMatrix2D(), [1, 0, 0, 1, 0, 0]);
  close(new DOMMatrix2D([2, 0, 0, 3, 4, 5]), [2, 0, 0, 3, 4, 5]);
  close(new DOMMatrix2D([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 4, 5, 0, 1]), [2, 0, 0, 3, 4, 5]);
  assert.throws(() => new DOMMatrix2D([1, 2, 3]));
  assert.throws(() => new DOMMatrix2D("rotate(45deg)"));
});

test("scaleSelf then translateSelf matches the DOM spec (pdfjs worker usage)", () => {
  // new DOMMatrix().scaleSelf(1/w, -1/h).translateSelf(0, -h)  with w=4, h=2
  close(new DOMMatrix2D().scaleSelf(1 / 4, -1 / 2).translateSelf(0, -2), [0.25, 0, 0, -0.5, 0, 1]);
});

test("multiply, preMultiply, invert round-trip", () => {
  const m = new DOMMatrix2D([2, 1, -1, 3, 5, -7]);
  close(m.multiply(m.inverse()), [1, 0, 0, 1, 0, 0]);
  const n = new DOMMatrix2D([1, 0, 0, 1, 10, 20]);
  close(new DOMMatrix2D(m).preMultiplySelf(n), [2, 1, -1, 3, 15, 13]);
  const p = m.transformPoint({ x: 1, y: 1 });
  assert.deepEqual([p.x, p.y], [6, -3]);
});

test("installs only when DOMMatrix is absent", () => {
  const g = globalThis as any;
  const original = g.DOMMatrix;
  try {
    delete g.DOMMatrix;
    ensurePdfjsNodePolyfills();
    assert.equal(g.DOMMatrix, DOMMatrix2D);
    const sentinel = class {};
    g.DOMMatrix = sentinel;
    ensurePdfjsNodePolyfills();
    assert.equal(g.DOMMatrix, sentinel, "an existing implementation must win");
  } finally {
    if (original === undefined) delete g.DOMMatrix;
    else g.DOMMatrix = original;
  }
});
