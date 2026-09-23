const sharp = require('/home/team/shared/aislopscanner/node_modules/sharp');
(async () => {
  const src = '/home/team/shared/Postexpandeddonkey.png';
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const bg = [0.1, 0.1, 0.0];
  const dist2 = (i) => { const dr=data[i]-bg[0], dg=data[i+1]-bg[1], db=data[i+2]-bg[2]; return dr*dr+dg*dg+db*db; };
  console.log('dist2 at corner (0,0):', dist2(0), 'TH:', 62*62);
  const TH = 62*62;
  const mask = new Uint8Array(w*h);
  const q = new Int32Array(w*h); let qh=0, qt=0;
  const push = (x,y) => { const idx=y*w+x; if (mask[idx]) return; if (dist2(idx*ch) <= TH) { mask[idx]=1; q[qt++]=idx; } };
  for (let x=0;x<w;x++){ push(x,0); push(x,h-1); }
  for (let y=0;y<h;y++){ push(0,y); push(w-1,y); }
  console.log('seeded count:', qt);
  while (qh<qt) { const idx=q[qh++]; const x=idx%w, y=(idx/w)|0;
    if (x>0) push(x-1,y); if (x<w-1) push(x+1,y); if (y>0) push(x,y-1); if (y<h-1) push(x,y+1); }
  let ones=0; for (let i=0;i<w*h;i++) if (mask[i]) ones++;
  console.log('mask ones after BFS:', ones, 'pct:', (100*ones/(w*h)).toFixed(2));
  console.log('mask at (0,0):', mask[0], 'at (640,512):', mask[512*w+640], 'at (768,512):', mask[512*w+768]);
})();
