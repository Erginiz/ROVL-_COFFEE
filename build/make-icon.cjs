const zlib=require('zlib'); const fs=require('fs')
const S=256, cx=127.5, cy=127.5
function px(x,y){
  // rounded-rect mask (corner radius r)
  const r=46
  let inside=true
  const dx=Math.min(x, S-1-x), dy=Math.min(y, S-1-y)
  if(dx<r && dy<r){ const ddx=r-dx, ddy=r-dy; if(Math.hypot(ddx,ddy)>r) inside=false }
  if(!inside) return [0,0,0,0]
  // base brand lime
  let R=214,G=251,B=121
  const d=Math.hypot(x-cx,y-cy)
  // vinyl record
  if(d<94){ R=23;G=35;B=27 }              // dark disc
  // subtle grooves
  if(d<94 && d>26){ const g=Math.sin(d/5.0); if(g>0.7){ R=34;G=48;B=39 } }
  if(d<24){ R=214;G=251;B=121 }           // lime label
  if(d<6){ R=23;G=35;B=27 }               // spindle hole
  return [R,G,B,255]
}
// build raw RGBA scanlines with filter byte 0
const raw=Buffer.alloc((S*4+1)*S)
let o=0
for(let y=0;y<S;y++){ raw[o++]=0; for(let x=0;x<S;x++){ const p=px(x,y); raw[o++]=p[0]; raw[o++]=p[1]; raw[o++]=p[2]; raw[o++]=p[3] } }
function chunk(type,data){ const len=Buffer.alloc(4); len.writeUInt32BE(data.length); const t=Buffer.from(type); const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,data]))>>>0); return Buffer.concat([len,t,data,crc]) }
function crc32(buf){ let c=~0; for(let i=0;i<buf.length;i++){ c^=buf[i]; for(let k=0;k<8;k++) c = (c>>>1) ^ (0xEDB88320 & -(c&1)); } return ~c }
const sig=Buffer.from([137,80,78,71,13,10,26,10])
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(S,0); ihdr.writeUInt32BE(S,4); ihdr[8]=8; ihdr[9]=6; // 8-bit RGBA
const idat=zlib.deflateSync(raw,{level:9})
const png=Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))])
fs.writeFileSync('build/icon.png',png)
// wrap PNG into an ICO (PNG-embedded, 256x256)
const dir=Buffer.alloc(6); dir.writeUInt16LE(0,0); dir.writeUInt16LE(1,2); dir.writeUInt16LE(1,4)
const ent=Buffer.alloc(16); ent[0]=0; ent[1]=0; ent[2]=0; ent[3]=0; ent.writeUInt16LE(1,4); ent.writeUInt16LE(32,6); ent.writeUInt32LE(png.length,8); ent.writeUInt32LE(22,12)
fs.writeFileSync('build/icon.ico',Buffer.concat([dir,ent,png]))
console.log('wrote build/icon.png ('+png.length+'B) and build/icon.ico ('+(png.length+22)+'B)')
