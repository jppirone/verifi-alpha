// Canvas-drawing script that produces the two-column resume test image used in EVERY column/OCR
// test tonight (test-tesseract-wasm-ocr, test-tesseract-wasm-psm, test-tesseract-wasm-columns, and
// now this real-Tesseract test). Byte-for-byte identical to the script that generated the original
// image — recovered verbatim from this session's own transcript (the original RGBA buffer was
// generated in-browser and POSTed directly to a Supabase Edge Function; it was never itself saved
// to disk, so it could not be reused as a file, but the deterministic generation CODE was still on
// record). Re-running this unmodified script reproduces the same canvas drawing (same dimensions,
// fonts, sizes, and x/y positions) rather than constructing a new/different example.
//
// Run in any browser console (or via the Claude Browser pane's javascript_tool) on any page:
//   1. Paste/execute this script.
//   2. `const png = c.toDataURL('image/png')` gives a PNG data URL of the exact same test image.
// two-column-resume.png in this folder is the PNG saved from exactly this process.

const W = 850, H = 1100;
const c = document.createElement('canvas');
c.width = W; c.height = H;
const ctx = c.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
ctx.fillStyle = '#000';

// Header spans full width
ctx.font = 'bold 28px Arial';
ctx.fillText('TAYLOR MORGAN CHEN', 60, 55);
ctx.font = '16px Arial';
ctx.fillText('Product Marketing Manager', 60, 82);
ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(60, 100); ctx.lineTo(790, 100); ctx.stroke();
// Vertical divider between columns
ctx.beginPath(); ctx.moveTo(300, 130); ctx.lineTo(300, 1050); ctx.stroke();

// LEFT column (narrow): contact + skills, x=60..280
let ly = 140;
function leftLine(text, size, bold, gap) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px Arial';
  ctx.fillText(text, 60, ly);
  ly += gap;
}
leftLine('CONTACT', 16, true, 26);
leftLine('taylor.chen@example.com', 12, false, 18);
leftLine('(555) 402-7731', 12, false, 18);
leftLine('Austin, TX', 12, false, 34);
leftLine('SKILLS', 16, true, 26);
leftLine('Product Marketing', 12, false, 18);
leftLine('Go-to-Market Strategy', 12, false, 18);
leftLine('Competitive Analysis', 12, false, 18);
leftLine('SQL, Tableau, Figma', 12, false, 18);
leftLine('Cross-functional Leadership', 12, false, 34);
leftLine('EDUCATION', 16, true, 26);
leftLine('B.A. Marketing', 12, false, 18);
leftLine('Riverbend College, 2016', 12, false, 18);

// RIGHT column (wide): experience, x=320..790
let ry = 140;
function rightLine(text, size, bold, gap) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px Arial';
  ctx.fillText(text, 320, ry);
  ry += gap;
}
rightLine('EXPERIENCE', 18, true, 28);
rightLine('Senior Product Marketing Manager, Nimbus Cloud Co', 14, true, 20);
rightLine('Jan 2020 - Present', 12, false, 20);
rightLine('- Launched 4 major product releases, exceeding adoption targets', 12, false, 17);
rightLine('- Built competitive intelligence program adopted company-wide', 12, false, 17);
rightLine('- Managed $1.2M annual marketing budget across 3 product lines', 12, false, 30);
rightLine('Product Marketing Manager, Fieldstone Software', 14, true, 20);
rightLine('Aug 2016 - Dec 2019', 12, false, 20);
rightLine('- Developed positioning and messaging for flagship SaaS product', 12, false, 17);
rightLine('- Partnered with sales to build enablement materials and training', 12, false, 17);
rightLine('- Grew qualified pipeline 35% through targeted campaign work', 12, false, 30);
rightLine('Marketing Associate, Fieldstone Software', 14, true, 20);
rightLine('Jun 2016 - Aug 2016', 12, false, 20);
rightLine('- Supported content marketing and social media calendar', 12, false, 17);

// window.__col2PngDataUrl = c.toDataURL('image/png');
