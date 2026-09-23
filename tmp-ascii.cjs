const sharp = require('/home/team/shared/aislopscanner/node_modules/sharp');
function render(src, label, region, scaleCols) {
  return new Promise(async (res) => {
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, ch = info.channels;
    const [x0, y0, x1, y1] = region;
    const rw = x1 - x0, rh = y1 - y0;
    const cell = Math.max(1, Math.ceil(rw / scaleCols));
    const cols = Math.floor(rw / cell), rows = Math.floor(rh / cell);
    console.log('=== ' + label + ' crop ' + rw + 'x' + rh + '@(' + x0 + ',' + y0 + ') rendered as ' + cols + 'x' + rows + ' ===');
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        let n = 0, lum = 0, lime = 0, dark = 0;
        for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
          const X = x0 + c*cell + dx, Y = y0 + r*cell + dy;
          if (X >= w || Y >= h) continue;
          const i = (Y*w + X)*ch; const R=data[i], G=data[i+1], B=data[i+2], A=data[i+3];
          if (A < 40) { n++; continue; }
          n++; lum += (R+G+B)/3;
          if (G > 130 && R > 40 && R < 200 && B < 110) lime++;
          if (R < 90 && G < 90 && B < 90) dark++;
        }
        if (n === 0) { line += ' '; continue; }
        const l = lum / n;
        let ch2;
        if (lime > n*0.25) ch2 = 'L';
        else if (l < 75) ch2 = '#';
        else if (l < 140) ch2 = '+';
        else if (l < 200) ch2 = '.';
        else ch2 = ' ';
        line += ch2;
      }
      out += line + '\n';
    }
    console.log(out);
    res();
  });
}
(async () => {
  // HERO: feet region (bottom ~25% wide across) — and the small blob at (577,933)
  const { data: dh, info: ih } = await sharp('/home/team/shared/site/public/donkey-landing.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  console.log('HERO total bottom-25% lime+darks count: yStart=' + Math.floor(ih.height*0.75));
  let limeH=0, darkH=0;
  for (let y=Math.floor(ih.height*0.75); y<ih.height; y++) for (let x=0; x<ih.width; x++) {
    const i=(y*ih.width+x)*ih.channels;
    if (dh[i+3]<40) continue;
    const R=dh[i],G=dh[i+1],B=dh[i+2];
    if (G>130&&R>40&&R<200&&B<110) limeH++;
    if (R<90&&G<90&&B<90) darkH++;
  }
  console.log('HERO bottom 25%: lime=' + limeH, 'dark=' + darkH);
  await render('/home/team/shared/site/public/donkey-landing.png', 'HERO feet strip', [300, 840, 1150, 1191], 100);
  await render('/home/team/shared/site/public/donkey-results-nosign.png', 'RESULTS bottom 20%', [0, Math.floor(1017*0.80), 519, 1017], 100);
})();
