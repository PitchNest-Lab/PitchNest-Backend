import { resolveDeckType } from "../controllers/deckController.ts";

const pdf = Buffer.from("%PDF-1.7 rest of file...");
// A real .pptx is a zip: PK magic followed by binary local-file-header bytes.
const pptx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x11, 0x22, 0x33, 0x44]);
// Legacy .ppt/.doc: OLE compound-file header.
const legacyOffice = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
const exe = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00");
const text = Buffer.from("Slide 1: the problem we solve");

const tests: Array<[string, Buffer, string | undefined, string | null]> = [
  ["real pdf + pdf mime", pdf, "application/pdf", "application/pdf"],
  ["real pdf + octet-stream", pdf, "application/octet-stream", "application/pdf"],
  ["real pdf + empty mime", pdf, "", "application/pdf"],
  ["pptx + octet-stream", pptx, "application/octet-stream", null],
  [
    "pptx + correct pptx mime",
    pptx,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    null,
  ],
  ["legacy .ppt (OLE header)", legacyOffice, "application/vnd.ms-powerpoint", null],
  ["windows executable", exe, "application/octet-stream", null],
  ["text + octet-stream", text, "application/octet-stream", "text/plain"],
  ["text + text/plain mime", text, "text/plain", "text/plain"],
  ["empty buffer, no mime", Buffer.alloc(0), "", null],
];

let fail = 0;
for (const [name, buf, mime, want] of tests) {
  const got = resolveDeckType(buf, mime);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${got}`);
}
console.log(fail === 0 ? "ALL DECK-TYPE TESTS PASSED" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
