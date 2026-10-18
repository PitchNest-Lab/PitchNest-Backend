/**
 * Minimal DOMMatrix for pdfjs-dist (used by pdf-parse) on Node.
 *
 * WHY. In Node, pdfjs obtains DOMMatrix from the optional native package
 * `@napi-rs/canvas`. Without it, pdfjs' legacy build throws at IMPORT time
 * (`const SCALE_MATRIX = new DOMMatrix()`), so text extraction fails before it
 * starts. The Lambda package deliberately does not ship that 20+ MB
 * platform-specific native binary: text extraction never renders, it only
 * needs DOMMatrix to exist and do correct 2-D affine math (the worker uses
 * `new DOMMatrix().scaleSelf(...).translateSelf(...)` for some glyph outlines).
 *
 * Installed only when no DOMMatrix exists, so a real implementation (browser,
 * or Node with @napi-rs/canvas loaded first) always wins.
 *
 * 2-D only: [a c e; b d f; 0 0 1]. Non-2-D inputs are rejected loudly rather
 * than computed wrongly.
 */

type Init = number[] | Float32Array | Float64Array | { a: number; b: number; c: number; d: number; e: number; f: number };

class DOMMatrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  readonly is2D = true;

  constructor(init?: Init | string) {
    if (init === undefined || init === null) return;
    if (typeof init === "string") {
      if (init.trim() === "" || init.trim() === "none") return;
      throw new TypeError("DOMMatrix polyfill: string transforms are not supported");
    }
    if (Array.isArray(init) || ArrayBuffer.isView(init)) {
      const v = Array.from(init as ArrayLike<number>);
      if (v.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = v;
      } else if (v.length === 16) {
        // Column-major 4x4; accept only affine 2-D matrices.
        [this.a, this.b, , , this.c, this.d, , , , , , , this.e, this.f] = v;
      } else {
        throw new TypeError("DOMMatrix polyfill: expected 6 or 16 values");
      }
      return;
    }
    ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = init as any);
  }

  // m11..m42 aliases used by some callers.
  get m11() { return this.a; }
  set m11(v: number) { this.a = v; }
  get m12() { return this.b; }
  set m12(v: number) { this.b = v; }
  get m21() { return this.c; }
  set m21(v: number) { this.c = v; }
  get m22() { return this.d; }
  set m22(v: number) { this.d = v; }
  get m41() { return this.e; }
  set m41(v: number) { this.e = v; }
  get m42() { return this.f; }
  set m42(v: number) { this.f = v; }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  /** this = this × other */
  multiplySelf(o: Init): this {
    const m = o instanceof DOMMatrix2D ? o : new DOMMatrix2D(o);
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
    return this;
  }

  /** this = other × this */
  preMultiplySelf(o: Init): this {
    const m = o instanceof DOMMatrix2D ? o : new DOMMatrix2D(o);
    const { a, b, c, d, e, f } = this;
    this.a = m.a * a + m.c * b;
    this.b = m.b * a + m.d * b;
    this.c = m.a * c + m.c * d;
    this.d = m.b * c + m.d * d;
    this.e = m.a * e + m.c * f + m.e;
    this.f = m.b * e + m.d * f + m.f;
    return this;
  }

  translateSelf(tx = 0, ty = 0): this {
    return this.multiplySelf([1, 0, 0, 1, tx, ty]);
  }

  scaleSelf(sx = 1, sy = sx, _sz = 1, ox = 0, oy = 0): this {
    this.translateSelf(ox, oy);
    this.multiplySelf([sx, 0, 0, sy, 0, 0]);
    return this.translateSelf(-ox, -oy);
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  multiply(o: Init) { return new DOMMatrix2D(this).multiplySelf(o); }
  translate(tx?: number, ty?: number) { return new DOMMatrix2D(this).translateSelf(tx, ty); }
  scale(sx?: number, sy?: number, sz?: number, ox?: number, oy?: number) {
    return new DOMMatrix2D(this).scaleSelf(sx, sy, sz, ox, oy);
  }
  inverse() { return new DOMMatrix2D(this).invertSelf(); }

  transformPoint(p: { x?: number; y?: number } = {}) {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }

  toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
  toFloat64Array() { return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
}

/** Installs the polyfill if (and only if) no DOMMatrix is available. */
export function ensurePdfjsNodePolyfills(): void {
  const g = globalThis as any;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = DOMMatrix2D;
  }
}

export { DOMMatrix2D };
