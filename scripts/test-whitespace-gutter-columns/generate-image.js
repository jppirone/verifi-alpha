// Whitespace-gutter variant of test-real-tesseract-columns' test image. Identical content, fonts,
// and column x-positions (left column x=60, right column x=320) — the ONLY change from that
// folder's generate-image.js is that the vertical ruled-line divider is simply not drawn, leaving
// genuine open whitespace between the columns instead. Isolates one variable: does a thin ruled
// line specifically confuse Tesseract's column/gutter detection, versus a plain whitespace gap of
// (in this image) roughly the same width?
//
// Run in any browser console (or via the Claude Browser pane's javascript_tool):
//   1. Paste/execute this script.
//   2. `c.toDataURL('image/png')` gives a PNG data URL — two-column-resume-gutter.png in this
//      folder is exactly that.

const W = 850, H = 1100;
const c = document.createElement('canvas');
c.width = W; c.height = H;
const ctx = c.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
ctx.fillStyle = '#000';

ctx.font = 'bold 28px Arial';
ctx.fillText('TAYLOR MORGAN CHEN', 60, 55);
ctx.font = '16px Arial';
ctx.fillText('Product Marketing Manager', 60, 82);
ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(60, 100); ctx.lineTo(790, 100); ctx.stroke();
// NO vertical divider line — genuine open whitespace gutter instead. This is the only change from
// scripts/test-real-tesseract-columns/generate-image.js.

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

// window.__gutterPngDataUrl = c.toDataURL('image/png');
