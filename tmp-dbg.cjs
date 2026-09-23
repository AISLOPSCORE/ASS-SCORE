const sharp = require('/home/team/shared/aislopscanner/node_modules/sharp');
(async () => {
  const src = '/home/team/shared/Postexpandeddonkey.png';
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  console.log('channels:', ch, 'len:', data.length);
  const px=(x,y)=>[data[(y*w+x)*ch],data[(y*w+x)*ch+1],data[(y*w+x)*ch+2],data[(y*w+x)*ch+3]];
  console.log('(0,0):', px(0,0), '(640,512):', px(640,512), '(768,512):', px(768,512), '(100,100):', px(100,100));
  let dark=0, total=w*h;
  for (let i=0;i<data.length;i+=ch){ const r=data[i],g=data[i+1],b=data[i+2]; if (r<40&&g<40&&b<40) dark++; }
  console.log('near-black pct:', (100*dark/total).toFixed(2));
})();
