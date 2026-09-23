const sharp = require('/home/team/shared/aislopscanner/node_modules/sharp');
(async () => {
  const { data, info } = await sharp('/home/team/shared/site/public/donkey-results-full.png').raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  console.log('dims:', w, 'x', h, 'channels:', ch);
  // opaque pixel stats
  let opaque = 0; const rows = new Array(h).fill(0);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const a = data[(y*w+x)*ch+3]; if (a>128){ opaque++; rows[y]++; } }
  console.log('opaque pct:', (100*opaque/(w*h)).toFixed(1));
  const rowWith = (pct) => { const target = opaque*pct/100; let acc=0; for (let y=0;y<h;y++){ acc+=rows[y]; if (acc>=target) return y; } return -1; };
  console.log('vertical span: row 1% =', rowWith(1), ' 50% =', rowWith(50), ' 99% =', rowWith(99), ' (of h='+h+')');
  // lime-glasses pixels in upper half: neon lime ~ (R>120, G>160, B<110)
  let lime = 0, limeMaxY = 0;
  for (let y=0;y<h>>1;y++) for (let x=0;x<w;x++){ const i=(y*w+x)*ch;
    if (data[i+3]>128 && data[i]>110 && data[i+1]>150 && data[i+2]<110){ lime++; limeMaxY=Math.max(limeMaxY,y); } }
  console.log('lime(glasses) px in upper half:', lime, 'deepest lime row:', limeMaxY);
  // legs: opaque col-groups in bottom 15% (expect >=2 separate groups => left/right legs)
  const y0 = Math.floor(h*0.85); const cols = new Array(w).fill(0);
  for (let y=y0;y<h;y++) for (let x=0;x<w;x++) if (data[(y*w+x)*ch+3]>128) cols[x]++;
  let groups=0, inG=false;
  for (let x=0;x<w;x++){ const v = cols[x]>0; if (v&&!inG){ groups++; inG=true; } else if (!v) inG=false; }
  console.log('opaque col-groups in bottom 15% (leg clusters):', groups, 'of', w, 'cols wide');
  // residual hard-rect check: any fully-opaque pure-black pixel at extreme corners within 3px
  let cornerBlack = 0;
  for (let y=0;y<3;y++) for (let x=0;x<3;x++){ const i=(y*w+x)*ch; if (data[i+3]>200) cornerBlack++; }
  console.log('opaque corner sample px (expect 0):', cornerBlack);
})();
