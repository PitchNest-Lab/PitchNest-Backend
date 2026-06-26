// Programmatic overlap check: extracts positioned text from the generated PDF
// and flags pairs of text boxes on the same page that overlap (the acceptance
// criterion "no overlapping text"). Not a substitute for eyeballing, but catches
// gross collisions. Run after test-report.ts. Usage: npx tsx scripts/check-overlaps.ts
import fs from "fs";
import path from "path";
// @ts-ignore - legacy build ships its own types loosely
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const file = path.resolve(process.cwd(), "test-report.pdf");
const data = new Uint8Array(fs.readFileSync(file));

interface Box { str: string; x: number; y: number; w: number; h: number; }

function overlapAmount(a: Box, b: Box) {
  const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return { xo, yo };
}

(async () => {
  const doc = await pdfjs.getDocument({ data }).promise;
  console.log(`Pages: ${doc.numPages}`);
  let totalFlags = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const boxes: Box[] = content.items
      .filter((it: any) => it.str && it.str.trim().length > 0)
      .map((it: any) => {
        const [a, , , d, e, f] = it.transform;
        const h = it.height || Math.abs(d) || 6;
        // PDF origin is bottom-left; treat (e, f) as the text baseline.
        return { str: it.str, x: e, y: f - h * 0.2, w: it.width || (it.str.length * a * 0.5), h };
      });

    const flags: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        const { xo, yo } = overlapAmount(A, B);
        // Require meaningful overlap in BOTH axes to flag a real collision.
        if (xo > 4 && yo > 3.5) {
          // Ignore tiny fragments and identical-baseline adjacency artifacts.
          if (A.str.trim().length < 2 || B.str.trim().length < 2) continue;
          flags.push(
            `   ⚠ "${A.str.trim().slice(0, 28)}" (x${A.x.toFixed(0)},y${A.y.toFixed(0)}) ∩ "${B.str.trim().slice(0, 28)}" (x${B.x.toFixed(0)},y${B.y.toFixed(0)}) [x${xo.toFixed(1)} y${yo.toFixed(1)}]`,
          );
        }
      }
    }
    if (flags.length) {
      totalFlags += flags.length;
      console.log(`\nPage ${p}: ${flags.length} potential overlap(s)`);
      flags.slice(0, 25).forEach((f) => console.log(f));
    } else {
      console.log(`Page ${p}: clean ✓`);
    }
  }
  console.log(`\nTotal potential overlaps: ${totalFlags}`);
})().catch((e) => { console.error(e); process.exit(1); });
