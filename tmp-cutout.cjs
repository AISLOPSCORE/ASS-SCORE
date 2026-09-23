const sharp = require('/home/team/shared/aislopscanner/node_modules/sharp');
(async () => {
  const src = '/home/team/shared/Postexpandeddonkey.png';
  const out = '/home/team/shared/site/public/donkey-results-full.png';
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const avg = (x0, y0) => { let r=0,g=0,b=0,n=0; for(let y=y0;y<y0+12;y++) for(let x=x0;x<x0+12;x++){ const i=(y*w+x)*ch; r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; } return [r/n,g/n,b/n]; };
  const a = [avg(0,0), avg(w-12,0), avg(0,h-12), avg(w-12,h-12)];
  const bg = [a.reduce((s,p)=>s+p[0],0)/4, a.reduce((s,p)=>s+p[1],0)/4, a.reduce((s,p)=>s+p[2],0)/4];
  const dist2 = (i) => { const dr=data[i]-bg[0], dg=data[i+1]-bg[1], db=data[i+2]-bg[2]; return dr*dr+dg*dg+db*db; };
  const TH = 62*62;
  const mask = new Uint8Array(w*h);
  const q = new Int32Array(w*h); let qh=0, qt=0;
  const push = (x,y) => { const idx=y*w+x; if (mask[idx]) return; if (dist2(idx*ch) <= TH) { mask[idx]=1; q[qt++]=idx; } };
  for (let x=0;x<w;x++){ push(x,0); push(x,h-1); }
  for (let y=0;y<h;y++){ push(0,y); push(w-1,y); }
  while (qh<qt) { const idx=q[qh++]; const x=idx%w, y=(idx/w)|0;
    if (x>0) push(x-1,y); if (x<w-1) push(x+1,y); if (y>0) push(x,y-1); if (y<h-1) push(x,y+1); }
  // dilate: union of bg + 1px ring (erodes subject ~1px per pass, kills dark halo)
  const dilate = (srcM) => {
    const c = new Uint8Array(w*h);
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const idx=y*w+x;
      if (srcM[idx]) { c[idx]=1; continue; }
      for (let dy=-1;dy<=1&&!c[idx];dy++) for (let dx=-1;dx<=1&&!c[idx];dx++){
        const nx=x+dx, ny=y+dy;
        if (nx>=0&&nx<w&&ny>=0&&ny<h&&srcM[ny*w+nx]) c[idx]=1; } }
    return c; };
  let m = mask; for (let k=0;k<2;k++) m = dilate(m);
  let ones=0; for (let i=0;i<w*h;i++) if (m[i]) ones++;
  console.log('bg mask pct:', (100*ones/(w*h)).toFixed(2), 'bg target:', bg.map(v=>v.toFixed(1)));
  // feather alpha (gaussian sigma 1.5 radius 4, JS separable)
  let alpha = new Float32Array(w*h);
  for (let i=0;i<w*h;i++) alpha[i] = m[i] ? 0 : 255;
  const sigma=1.5, R=4; const kf=new Float32Array(R*2+1); let ks=0;
  for (let i=-R;i<=R;i++){ const v=Math.exp(-(i*i)/(2*sigma*sigma)); kf[i+R]=v; ks+=v; }
  for (let i=0;i<kf.length;i++) kf[i]/=ks;
  const tmp = new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ let s=0; for (let dx=-R;dx<=R;dx++){ const nx=x+dx; s += alpha[y*w+Math.min(w-1,Math.max(0,nx))]*kf[dx+R]; } tmp[y*w+x]=s; }
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ let s=0; for (let dy=-R;dy<=R;dy++){ const ny=y+dy; s += tmp[Math.min(h-1,Math.max(0,ny))*w+x]*kf[dy+R]; } alpha[y*w+x]=s; }
  // subject bbox (alpha>40) + pad
  let minX=w, minY=h, maxX=-1, maxY=-1;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){ const av=alpha[y*w+x]; if (av>40){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; } }
  const pad=10;
  minX=Math.max(0,minX-pad); minY=Math.max(0,minY-pad); maxX=Math.min(w-1,maxX+pad); maxY=Math.min(h-1,maxY+pad);
  const cw=maxX-minX+1, chh=maxY-minY+1;
  console.log('subject bbox:', {minX,minY,maxX,maxY,cw,chh});
  const outBuf = Buffer.alloc(cw*chh*4); let trans=0;
  for (let y=0;y<chh;y++) for (let x=0;x<cw;x++){ const si=((y+minY)*w+(x+minX))*ch; const di=(y*cw+x)*4;
    outBuf[di]=data[si]; outBuf[di+1]=data[si+1]; outBuf[di+2]=data[si+2]; outBuf[di+3]=Math.round(alpha[(y+minY)*w+(x+minX)]);
    if (outBuf[di+3]===0) trans++; }
  await sharp(outBuf, { raw: { width: cw, height: chh, channels: 4 } }).png().toFile(out);
  console.log('wrote', out, cw+'x'+chh, 'transparent pct:', (100*trans/(cw*chh)).toFixed(2));
  const v = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (x,y) => { const i=(y*v.info.width+x)*4; return [v.data[i],v.data[i+1],v.data[i+2],v.data[i+3]]; };
  console.log('corners tl/tr/bl/br:', o(2,2), o(cw-3,2), o(2,chh-3), o(cw-3,chh-3));
  console.log('center:', o((cw>>1),(chh>>1)));
})();
