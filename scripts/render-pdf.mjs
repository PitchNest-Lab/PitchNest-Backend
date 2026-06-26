// Rasterize test-report.pdf to PNGs (one per page) for visual inspection.
// Usage: node scripts/render-pdf.mjs [pdfPath]
import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfPath = process.argv[2] || path.resolve(process.cwd(), "test-report.pdf");
const outDir = path.resolve(process.cwd(), "scripts", "render-out");
fs.mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
console.log(`Pages: ${doc.numPages}`);
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport, canvasFactory: {
    create: (w, h) => { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; },
    reset: (cc, w, h) => { cc.canvas.width = w; cc.canvas.height = h; },
    destroy: (cc) => { cc.canvas.width = 0; cc.canvas.height = 0; },
  } }).promise;
  const out = path.join(outDir, `page-${i}.png`);
  fs.writeFileSync(out, canvas.toBuffer("image/png"));
  console.log(`wrote ${out}`);
}
