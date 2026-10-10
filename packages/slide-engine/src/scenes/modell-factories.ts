/* eslint-disable */
// @ts-nocheck
/*
 * Szenenfabriken der Vorlesung "Der Modellbegriff im Wandel".
 *
 * Geometrie und didaktische Animationen aus Modellbegriff_ThreeJS_clean.html.
 * Die Darstellung verwendet die native Excalidraw-Papier-/Tintenpalette:
 * matte Flächen und klare Konturen statt Metall, Leuchten und Blau/Gold.
 * Typen und Lebenszyklus kapselt
 * ./modell-host.ts; dieses Modul greift auf keine globalen Objekte ausser
 * document.createElement (Glow-Textur) zu.
 */
import type * as ThreeNamespace from "three";

import type { ModellSceneFactories } from "./modell-types";
import { modellTheme, type ModellTheme } from "./modell-theme";
import { advanceOscillator, oscillatorQuantities, wireDiameterRatio, hangingSpringEnergy } from "./oscillator-physics";
import { modellLanguageContexts } from "./modell-state";

export function createModellSceneFactories(T: typeof ThreeNamespace, theme: ModellTheme = modellTheme()): ModellSceneFactories {
const C = {cream:theme.accent, teal:theme.ink, blue:theme.accent, violet:theme.secondary, white:theme.ink, dark:theme.fill, line:theme.line};
const V = (x=0,y=0,z=0)=>new T.Vector3(x,y,z);
function material(c,opts={}){return new T.MeshStandardMaterial({...opts,color:typeof c==='number'?theme.fill:c,roughness:1,metalness:0,emissive:0,emissiveIntensity:0,flatShading:true});}
function mesh(g,m,p,x=0,y=0,z=0){const o=new T.Mesh(g,m);o.position.set(x,y,z);p.add(o);return o;}
function box(p,w,h,d,c,x=0,y=0,z=0,opts={}){const g=new T.BoxGeometry(w,h,d);const o=mesh(g,material(c,opts),p,x,y,z);edges(o,g,theme.ink,.65);return o;}
function ball(p,r,c,x=0,y=0,z=0,glow=false){return mesh(new T.SphereGeometry(r,20,14),(glow?new T.MeshBasicMaterial({color:c,toneMapped:false}):material(c)),p,x,y,z);}
function line(p,points,c=C.line,opacity=1){const g=new T.BufferGeometry().setFromPoints(points.map(v=>Array.isArray(v)?V(...v):v));const o=new T.Line(g,new T.LineBasicMaterial({color:c,transparent:opacity<1,opacity,toneMapped:false}));p.add(o);return o;}
function path(p,points,c=C.teal,r=.018){const curve=new T.CatmullRomCurve3(points.map(v=>Array.isArray(v)?V(...v):v));const o=mesh(new T.TubeGeometry(curve,80,r,7,false),material(c,{emissive:c,emissiveIntensity:.28}),p);return {curve,mesh:o};}
function edges(p,g,c=C.teal,opacity=.7){const geometry=new T.EdgesGeometry(g);const points=geometry.attributes.position;for(let i=0;i<points.count;i++){points.setXYZ(i,points.getX(i)+Math.sin(i*13.7)*.008,points.getY(i)+Math.cos(i*9.3)*.008,points.getZ(i));}const o=new T.LineSegments(geometry,new T.LineBasicMaterial({color:c,transparent:true,opacity,toneMapped:false}));p.add(o);return o;}
function group(p,x=0,y=0,z=0){const g=new T.Group();g.position.set(x,y,z);p.add(g);return g;}
function grid(p,w=8,d=5,y=-1.9){const g=new T.GridHelper(w,20,C.line,C.line);g.material.transparent=true;g.material.opacity=.18;g.position.set(0,y,0);p.add(g);return g;}
function opacityTree(g,a){g.traverse(o=>{if(o.material){const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>{m.transparent=true;m.opacity=a;m.depthWrite=a>.5;});}});g.visible=a>.005;}
function spring(p){let pts=[];for(let i=0;i<=240;i++){let t=i/240;pts.push(V(.22*Math.sin(t*14*Math.PI),-t,.22*Math.cos(t*14*Math.PI)));}return path(p,pts,C.cream,.032).mesh;}
function oscillator(p,lab){
 const g=group(p);const detail=group(g);box(detail,2.6,.18,1.35,0x254452,0,-1.65,0);box(detail,2.55,.12,.8,0x43606a,0,1.75,0);
 for(const x of [-1.07,1.07]){mesh(new T.CylinderGeometry(.045,.045,3.4,14),material(0x78979f),detail,x,0,-.28);for(const z of [-.48,.48])ball(detail,.052,0xa8bfbd,x,-1.52,z);}
 const body=box(detail,.78,.65,.73,0xc7d8d3,0,-.4,0,{metalness:.65,roughness:.27});const trim=box(body,.79,.06,.74,C.cream,0,-.2,0);
 const sp=spring(g);sp.position.y=1.52;let previousLength=-1;
 const abstract=group(g);const massPoint=ball(abstract,.18,C.cream,0,-.4,0,true);const anchor=ball(abstract,.065,C.teal,0,1.52,0,true);line(abstract,[[-.55,1.59,0],[.55,1.59,0]],C.teal,.8);
 const a=group(g,1.35,.55,0);lab(a,'k','highlight');const b=group(g,.85,-.4,.3);lab(b,'m','highlight');
 grid(g,4,3,-1.76);
 return {g,detail,sp,body,massPoint,abstract,b,update(x,abstraction=0){
  body.position.y=-.4+x;massPoint.position.y=-.4+x;b.position.y=-.4+x;
  const length=1.52-(-.4+x+.32);
  if(Math.abs(length-previousLength)>1e-6){
   const pts=Array.from({length:241},(_,i)=>{const u=i/240;return V(.22*Math.sin(u*14*Math.PI),-u*length,.22*Math.cos(u*14*Math.PI));});
   sp.geometry.dispose();sp.geometry=new T.TubeGeometry(new T.CatmullRomCurve3(pts),240,.032,8,false);previousLength=length;
  }
  opacityTree(detail,1-abstraction);opacityTree(abstract,.15+.85*abstraction);
 }};
}
function chip(p,x=0,y=0,z=0){const g=group(p,x,y,z);box(g,1.7,1.45,.2,0x1d4052,0,0,0,{metalness:.5});box(g,1.26,1.04,.16,0x142a3a,0,0,.19);edges(g,new T.BoxGeometry(1.73,1.48,.24),C.blue,.7);for(let i=0;i<7;i++){const v=(i-3)*.2;for(const sign of [-1,1]){box(g,.22,.055,.07,0x86a8b0,sign*.98,v,.03);box(g,.055,.22,.07,0x86a8b0,v,sign*.85,.03);}}return g;}
function glowTexture(){const c=document.createElement('canvas');c.width=c.height=32;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(16,16,11,0,Math.PI*2);ctx.fill();return new T.CanvasTexture(c);}
function hero(root,lab,state,transfer=false){
 const n=1700, pos=new Float32Array(n*3),col=new Float32Array(n*3),targets=[];const palette=[C.cream,C.teal,C.blue,C.violet,C.violet];
 for(let k=0;k<5;k++){const a=new Float32Array(n*3);for(let i=0;i<n;i++){let u=((i*613)%n)/n,v=((i*1097)%n)/n, x,y,z;
  if(k===0){let f=i%6;x=(u-.5)*2.8;y=(v-.5)*2.8;z=1.4;if(f===1)z=-1.4;if(f===2){z=x;x=1.4;}if(f===3){z=x;x=-1.4;}if(f===4){z=y;y=1.4;}if(f===5){z=y;y=-1.4;}}
  else if(k===1){x=(u-.5)*5.5;y=Math.sin(u*Math.PI*3)*1.2;z=(v-.5)*1.15;y+=(v-.5)*.2;}
  else if(k===2){x=(u-.5)*3.4;y=(v-.5)*2.7;z=((i%5)-2)*.17;if(i%8===0){x=(i%2?1:-1)*1.9;y=(v-.5)*3.2;}}
  else if(k===3){x=(u-.5)*4.8;z=(v-.5)*2.4;y=.28*x*x+.28*z*z-1.15;}
  else{x=((i%5)-2)*1.03;y=(((Math.floor(i/5)%11)/10)-.5)*3;z=((Math.floor(i/55)%7)/6-.5)*2.2;}
  a.set([x,y,z],3*i);
 }targets.push(a);}
 pos.set(targets[0]);const geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(pos,3));geo.setAttribute('color',new T.BufferAttribute(col,3));const mat=new T.PointsMaterial({size:3.6,sizeAttenuation:false,toneMapped:false,map:glowTexture(),transparent:true,depthWrite:false,vertexColors:true,blending:T.NormalBlending});const cloud=new T.Points(geo,mat);root.add(cloud);grid(root,7,5,-2.05);
 const ring=mesh(new T.TorusGeometry(2.35,.008,6,120),new T.MeshBasicMaterial({color:C.line,transparent:true,opacity:.5}),root,0,-2.02,0);ring.rotation.x=Math.PI/2;
 const label=group(root,0,-2.32,0);lab(label,'ABBILD → BEZIEHUNG → FUNKTION','dim');let displayed=0;
 return {width:6.6,height:5.8,camera:[4.8,2.8,10],top:78,update(t,dt){if(dt===0)displayed=state.morph;else displayed+=(state.morph-displayed)*Math.min(1,dt*7);const k=Math.min(3,Math.floor(displayed)),f=displayed-k;const cc=new T.Color(palette[k]).lerp(new T.Color(palette[k+1]),f);for(let i=0;i<n;i++){for(let j=0;j<3;j++)pos[i*3+j]=targets[k][i*3+j]*(1-f)+targets[k+1][i*3+j]*f;const b=.57+.43*((i*17%71)/71);col.set([cc.r*b,cc.g*b,cc.b*b],3*i);}geo.attributes.position.needsUpdate=true;geo.attributes.color.needsUpdate=true;cloud.rotation.y=Math.sin(t*.16)*.09;}};
}
function makeMini(root,lab,state){const o=oscillator(root,lab);o.g.rotation.y=-.18;const label=group(root,0,-2.03,.1);lab(label,'AUSWÄHLEN · VEREINFACHEN · WEGLASSEN','dim');return{width:4.9,height:4.75,camera:[4.1,1.8,10],top:77,update(t){o.update(.36*Math.cos(t*1.2),state.abstraction);}};}
function makeLaw(root,lab,state){
 // One physical state drives both the hanging mass and a real, fixed-duration
 // time trace. Never restart the phase or rewrite past motion when k changes.
 const hanger=group(root,-2.3,0,0);
 box(hanger,1.65,.12,.5,C.dark,0,1.75,0);
 const sp=spring(hanger);sp.position.y=1.69;sp.name='law-spring';
 let geometryLength=-1,geometryK=-1;
 const body=box(hanger,.65,.6,.6,C.dark,0,0,0);body.name='law-mass';
 const equilibrium=line(hanger,[[-.72,0,0],[.72,0,0]],C.violet,.65);equilibrium.name='law-equilibrium';
 lab(group(hanger,.75,1.1,0),'k','highlight');lab(group(body,.58,0,0),'m = 1 kg','highlight');
 const eqLabel=lab(group(hanger,0,-2.15,0),'Δl₀ = mg/k','dim');
 const graph=group(root,.1,0,0),w=3.4;
 for(let i=0;i<5;i++){const y=-1.1+i*.55;line(graph,[[0,y,0],[w,y,0]],C.line,.4);const x=i*w/4;line(graph,[[x,-1.1,0],[x,1.1,0]],C.line,.3);}
 const geom=new T.BufferGeometry();geom.setAttribute('position',new T.BufferAttribute(new Float32Array(512*3),3));
 const trace=new T.Line(geom,new T.LineBasicMaterial({color:C.teal,toneMapped:false}));trace.name='law-time-trace';trace.frustumCulled=false;graph.add(trace);
 const dot=ball(graph,.075,C.cream,0,0,.08,true);dot.name='law-trace-marker';
 lab(group(graph,0,1.5,0),'Δl [m]','dim');lab(group(graph,w+.25,-1.3,0),'t [s]','dim');
 const hi=lab(group(graph,-.4,1.1,0),'','dim'),lo=lab(group(graph,-.4,-1.1,0),'','dim');
 const start=lab(group(graph,0,-1.5,0),'0','dim'),end=lab(group(graph,w,-1.5,0),'8','dim');
 return{width:8.4,height:4.8,camera:[.1,.5,10],top:136,update(t,dt){
  if(dt>0){state.oscillator=advanceOscillator(state.oscillator,state.stiffness,dt);state.oscillatorTrace.push({time:state.oscillator.time,x:state.oscillator.x});}
  const q=oscillatorQuantities(state.oscillator,state.stiffness),from=Math.max(0,state.oscillator.time-8);
  while(state.oscillatorTrace.length>1&&state.oscillatorTrace[1].time<from)state.oscillatorTrace.shift();
  const samples=state.oscillatorTrace.slice(-512),max=Math.max(10,q.equilibrium,...samples.map(p=>p.x)),min=Math.min(0,...samples.map(p=>p.x));
  // A single length scale for spring, mass and equilibrium marker. The assembly
  // has no invented floor or stops that the ideal model could pass through.
  // Fixed reference length and drawing scale: changing k must never secretly
  // resize the unloaded spring, the mass, or the spatial coordinate system.
  const lengthScale=.07,restLength=1.4;
  const springLength=restLength+state.oscillator.x*lengthScale;
  // Rebuild the helix, not scale.y: axial mesh scaling would also flatten the
  // wire cross-section. The circular wire follows the fourth-root k relation.
  if(Math.abs(springLength-geometryLength)>1e-6||geometryK!==state.stiffness){
   const pts=Array.from({length:241},(_,i)=>{const a=i/240;return V(.22*Math.sin(a*14*Math.PI),-a*springLength,.22*Math.cos(a*14*Math.PI));});
   sp.geometry.dispose();sp.geometry=new T.TubeGeometry(new T.CatmullRomCurve3(pts),240,.012*wireDiameterRatio(state.stiffness),8,false);
   geometryLength=springLength;geometryK=state.stiffness;
  }
  body.position.y=sp.position.y-springLength-.3;
  equilibrium.position.y=sp.position.y-restLength-q.equilibrium*lengthScale-.3;
  eqLabel.textContent=`Δl₀ = ${q.equilibrium.toFixed(2).replace('.',',')} m`;
  const xy=p=>[(p.time-from)/8*w,-1.1+(p.x-min)/(max-min)*2.2];
  samples.forEach((p,i)=>{const [x,y]=xy(p);geom.attributes.position.setXYZ(i,x,y,.04);});
  geom.setDrawRange(0,samples.length);geom.attributes.position.needsUpdate=true;
  const [x,y]=xy(state.oscillator);dot.position.set(x,y,.08);
  hi.textContent=max.toFixed(1).replace('.',',');lo.textContent=min.toFixed(1).replace('.',',');
  start.textContent=from.toFixed(1).replace('.',',');end.textContent=(from+8).toFixed(1).replace('.',',');
  root.userData.physics={...state.oscillator,...q};
 }};
}
function makeLimits(root,lab,state){
 const o=oscillator(root,lab);o.g.position.x=-2.15;o.g.scale.setScalar(.84);
 const force=group(root,1.65,0,0),energy=group(root,1.65,0,0);
 const arrow=new T.ArrowHelper(V(0,1,0),V(-2.15,0,.35),.7,C.teal,.18,.1);root.add(arrow);
 for(let i=-2;i<=2;i++){line(force,[[-1.15,i*.5,0],[1.15,i*.5,0]],C.line,.35);line(force,[[i*.5,-1.15,0],[i*.5,1.15,0]],C.line,.35);}
 line(force,[[-1.3,0,0],[1.3,0,0]],C.teal,.7);line(force,[[0,-1.3,0],[0,1.3,0]],C.teal,.7);
 path(force,[[-1,1,0],[1,-1,0]],C.teal,.024);const fd=ball(force,.075,C.cream,0,0,.1,true);
 lab(group(force,1.5,0,0),'x − x₀','dim');lab(group(force,0,1.5,0),'F [N]','dim');
 const bars=[['kinetic','Eₖ',C.violet],['elastic','E_f',C.cream],['gravitational','E_g',C.teal]].map(([key,title,color],i)=>{
  const x=(i-1)*1.05,bar=box(energy,.56,1,.4,color,x,0,0);bar.name=`energy-${key}`;
  lab(group(energy,x,-1.65,0),title,'highlight');return {key,bar};
 });
 line(energy,[[-1.5,-1.3,0],[1.5,-1.3,0]],C.teal,.7);
 const totalLabel=lab(group(energy,0,1.55,0),'','dim');
 return {width:7.7,height:4.35,camera:[.3,.6,10],top:80,update(t){
  const q=hangingSpringEnergy(t),relative=q.displacement/q.amplitude;
  // World y points up; physical extension x points down.
  o.update(-q.displacement*.72,.36);
  const isEnergy=state.description==='energy';energy.visible=isEnergy;force.visible=!isEnergy;
  arrow.visible=!isEnergy&&Math.abs(q.force)>1e-8;
  arrow.position.y=(-.4-q.displacement*.72)*.84;
  arrow.setDirection(V(0,q.force>0?-1:1,0));
  const length=Math.abs(relative)*.85;
  arrow.setLength(length,Math.min(.15,length*.35),Math.min(.085,length*.2));
  fd.position.set(relative,-relative,.1);
  for(const {key,bar} of bars){
   const height=2.4*q[key]/q.totalAtStart;
   bar.visible=q[key]>1e-12;bar.scale.y=height;bar.position.y=-1.3+height/2;
  }
  totalLabel.textContent=`E = ${q.total.toFixed(2).replace('.',',')} J`;
  root.userData.physics=q;
 }};
}
function makeRuntime(root,lab,state){
 grid(root,9,5,-1.8);const left=group(root,-3.3,0,0);const inp=ball(left,.32,C.blue,0,0,0,true);const rings=[];for(let i=0;i<3;i++){const r=mesh(new T.TorusGeometry(.47+i*.12,.012,6,60),new T.MeshBasicMaterial({color:C.blue,transparent:true,opacity:.5-i*.12}),left);r.rotation.y=.4; rings.push(r);}lab(group(left,0,-.92,0),'EINGANG x','highlight');const c=chip(root,-.42,0,0);lab(group(c,0,0,.4),'f','large');lab(group(c,0,-1.36,0),'MODELL + INTERFACE','dim');
 const servo=group(root,2.7,0,0);box(servo,1.5,1.5,.48,0x1d3a48,0,0,-.18);const disk=mesh(new T.CylinderGeometry(.64,.64,.11,64),material(0x6c8995,{metalness:.7}),servo,0,0,.15);disk.rotation.x=Math.PI/2;const ring=mesh(new T.TorusGeometry(.72,.018,8,70),material(C.blue,{emissive:C.blue,emissiveIntensity:.25}),servo,0,0,.18);
 const pointer=group(servo,0,0,.31);box(pointer,.065,.62,.045,C.cream,0,.27,0,{emissive:C.cream,emissiveIntensity:.5});ball(pointer,.085,C.cream,0,0,.03,true);for(let i=-4;i<=4;i++){let a=i*Math.PI/6;const k=box(servo,.025,.09,.02,0xb1c4c8,Math.sin(a)*.8,Math.cos(a)*.8,.1);k.rotation.z=-a;}
 lab(group(servo,0,-1.22,0),'STELLWINKEL y','highlight');const p1=path(root,[[-2.75,0,0],[-2.05,0,0],[-1.55,0,0]],C.blue,.021),p2=path(root,[[.8,0,0],[1.4,0,0],[1.82,0,0]],C.blue,.021);const pulses=[ball(root,.055,C.cream,0,0,.05,true),ball(root,.055,C.cream,0,0,.05,true)];
 line(root,[[-1.75,-1.68,0],[.94,-1.68,0]],C.blue,.7);lab(group(root,-.4,-2.0,0),'LAUFZEITUMGEBUNG','dim');
 return {width:8.8,height:4.75,camera:[1.2,1.6,10],top:144,update(t,dt){if(state.executing&&dt>0){state.servoAngle+=(state.outputAngle-state.servoAngle)*(1-Math.exp(-dt*8));}pointer.rotation.z=-T.MathUtils.degToRad(state.servoAngle);pulses.forEach((o,i)=>{o.visible=state.executing;o.position.copy((i?p2:p1).curve.getPoint((t*.58+i*.2)%1));o.position.z+=.04;});rings.forEach((r,i)=>r.rotation.y=.4+Math.sin(t*.7+i)*.1);}};
}
function makeLearning(root,lab,state){
 const g=group(root,0,-.2,0),W=5.7,H=2.7,x0=-2.85,y0=-1.15;const toX=x=>x0+(x+1)*W/2,toY=y=>y0+y*H/1.85;
 for(let j=0;j<=5;j++){const y=y0+j*H/5;line(g,[[x0,y,0],[x0+W,y,0]],C.line,.4);}for(let j=0;j<=6;j++){let x=x0+j*W/6;line(g,[[x,y0,0],[x,y0+H,0]],C.line,.3);}line(g,[[x0-.1,y0,0],[x0+W+.15,y0,0]],C.teal,.7);line(g,[[x0,y0-.1,0],[x0,y0+H+.15,0]],C.teal,.7);
 state.data.forEach(([x,y])=>ball(g,.055,C.teal,toX(x),toY(y),.045,true));
 const points=Array.from({length:151},()=>V());const geom=new T.BufferGeometry().setFromPoints(points);const curve=new T.Line(geom,new T.LineBasicMaterial({color:C.violet,linewidth:2,toneMapped:false}));g.add(curve);for(const dy of [-.009,.009]){const extra=new T.Line(geom,curve.material);extra.position.y=dy;g.add(extra);}const marker=ball(g,.09,C.cream,0,0,.08,true);const markerLine=line(g,[[0,y0,0],[0,0,0]],C.cream,.65);
 lab(group(g,x0,y0-.25,0),'−1','dim');lab(group(g,0,y0-.25,0),'0','dim');lab(group(g,x0+W,y0-.25,0),'+1','dim');lab(group(g,x0+W+.33,y0,0),'x','dim');lab(group(g,x0-.12,y0+H+.36,0),'y','dim');lab(group(g,x0-.27,y0,0),'0','dim');lab(group(g,x0-.35,y0+H,0),'1,85','dim');lab(group(g,0,-1.9,0),'21 BEISPIELE · 3 LERNBARE PARAMETER','dim');
 return {width:7.3,height:4.5,camera:[.7,.85,10],top:143,update(){const p=geom.attributes.position.array;for(let i=0;i<=150;i++){let x=-1+2*i/150;let y=state.a[0]+state.a[1]*x+state.a[2]*x*x;p[i*3]=toX(x);p[i*3+1]=toY(y);p[i*3+2]=.08;}geom.attributes.position.needsUpdate=true;geom.computeBoundingSphere();const x=state.inferX,y=state.a[0]+state.a[1]*x+state.a[2]*x*x;marker.position.set(toX(x),toY(y),.1);const lp=markerLine.geometry.attributes.position;lp.setXYZ(0,toX(x),y0,.02);lp.setXYZ(1,toX(x),toY(y),.02);lp.needsUpdate=true;}};
}
function makeLanguage(root,lab,state){
 const groups=[];const input=group(root,-3.65,0,0);groups.push(input);for(let i=0;i<3;i++){const b=box(input,.66,.38,.2,0x42647e,0,.62-i*.62,0,{emissive:C.blue,emissiveIntensity:.15});edges(b,new T.BoxGeometry(.68,.4,.22),C.blue,.6);}
 const emb=group(root,-2.05,0,0);groups.push(emb);for(let r=0;r<3;r++)for(let c=0;c<5;c++){box(emb,.16,.24,.22,((r+c)%2?C.blue:C.teal),-.38+c*.19,.62-r*.62,0,{emissive:C.blue,emissiveIntensity:.09});}
 const attn=group(root,-.28,0,0);groups.push(attn);for(let d=0;d<3;d++){const panel=box(attn,1.32,2.15,.025,0x244556,0,0,-.34+d*.32,{transparent:true,opacity:.15,depthWrite:false});edges(panel,new T.BoxGeometry(1.34,2.17,.03),C.violet,.4);for(let r=0;r<3;r++)for(let c=0;c<4;c++)ball(attn,.032,C.violet,-.42+c*.28,.62-r*.62,-.31+d*.32,true);}
 for(let i=0;i<3;i++)for(let j=0;j<=i;j++){path(attn,[[-.58,.62-i*.62,.42],[-.03,(.62-i*.62+.62-j*.62)/2,.7],[.57,.62-j*.62,.42]],i===2?C.violet:C.blue,.009);}
 const ffn=group(root,1.45,0,0);groups.push(ffn);box(ffn,.63,1.85,.44,0x44325a,0,0,0,{emissive:C.violet,emissiveIntensity:.07});edges(ffn,new T.BoxGeometry(.66,1.88,.46),C.violet,.65);for(let j=0;j<6;j++)line(ffn,[[-.19,-.64+j*.25,.24],[.19,-.64+j*.25,.24]],C.violet,.55);
 const out=group(root,3.0,0,0);groups.push(out);const bars=[];for(let i=0;i<3;i++){const b=box(out,.9,.25,.25,C.cream,-.12,.64-i*.64,0,{emissive:C.cream,emissiveIntensity:.16});bars.push(b);}
 const xs=[-3.65,-2.05,-.28,1.45,3];
 for(let i=0;i<4;i++)line(root,[[xs[i]+.45,0,-.35],[xs[i+1]-.45,0,-.35]],C.blue,.55);
 const pulse=ball(root,.07,C.cream,0,0,.55,true);const feedback=path(root,[[3.3,-.4,-.1],[3,-1.9,-.7],[-3.2,-1.9,-.7],[-3.7,-.5,-.1]],C.line,.01);
 return {width:9.1,height:4.8,camera:[1.0,1.3,10],top:170,update(t){const vals=modellLanguageContexts[state.context].candidates.map(([,share])=>Number(share)/100);bars.forEach((b,i)=>{b.scale.x=vals[i]*2.6;b.position.x=-.5+(.9*vals[i]*2.6)/2;});const active=state.tokenAdded?0:Math.min(4,state.langStep);groups.forEach((g,i)=>{g.scale.setScalar(i===active?1.07:1);});pulse.position.set(-3.4+(t*.7%1)*6.3,.08,.65);pulse.visible=!state.tokenAdded;feedback.mesh.material.color.set(state.tokenAdded?C.cream:C.line);}};
}
function makeTransfer(root,lab,state){
 grid(root,9,4,-1.4);const gs=[],colors=[C.cream,C.teal,C.violet,C.blue,C.cream];const words=['Aufgabe','Daten','Lernen','Prüfen','Einsetzen'];
 for(let i=0;i<5;i++){let g=group(root,(i-2)*1.78,0,0);gs.push(g);box(g,1.32,.09,1.26,0x1e3948,0,-.84,0);const r=mesh(new T.TorusGeometry(.64,.018,8,60),material(colors[i],{emissive:colors[i],emissiveIntensity:.25}),g,0,-.78,0);r.rotation.x=Math.PI/2;
  if(i===0){edges(g,new T.BoxGeometry(.66,.66,.66),colors[i]);ball(g,.13,colors[i],0,0,0,true);}
  if(i===1){for(let a=0;a<3;a++)for(let b=0;b<3;b++)for(let c=0;c<2;c++)ball(g,.052,colors[i],(a-1)*.24,(b-1)*.24,(c-.5)*.3,true);}
  if(i===2){for(let a=0;a<2;a++)for(let b=0;b<3;b++)ball(g,.07,colors[i],(a-.5)*.55,(b-1)*.3,0,true);for(let a=0;a<3;a++)for(let b=0;b<3;b++)line(g,[[-.275,(a-1)*.3,0],[.275,(b-1)*.3,0]],colors[i],.45);}
  if(i===3){path(g,[[-.34,0,0],[-.08,-.22,0],[.36,.34,0]],colors[i],.035);const ring=mesh(new T.TorusGeometry(.52,.015,8,50),material(colors[i]),g);}
  if(i===4){const c=chip(g);c.scale.setScalar(.42);lab(group(g,0,0,.16),'f','highlight');}
  lab(group(root,(i-2)*1.78,-1.35,0),String(i+1).padStart(2,'0')+' '+words[i],'dim');if(i<4)path(root,[[(i-2)*1.78+.72,-.25,0],[(i-1)*1.78-.72,-.25,0]],C.line,.017);
 }
 const feedback=path(root,[[3.56,-.8,-.6],[2.6,-1.55,-1.2],[-2.6,-1.55,-1.2],[-3.56,-.8,-.6]],C.line,.011);lab(group(root,0,-1.8,-.2),'PRÜFEN UND RÜCKKOPPELN','dim');
 return{width:9.6,height:4.7,camera:[3,3.4,12],top:80,update(t,dt){gs.forEach((g,i)=>{const target=i===state.transferStep?1.14:.95;g.scale.lerp(V(target,target,target),dt===0?1:Math.min(1,dt*7));g.rotation.y=Math.sin(t*.3+i)*.12;});}};
}

return { morph: hero, miniature: makeMini, law: makeLaw, limits: makeLimits, runtime: makeRuntime, learning: makeLearning, language: makeLanguage, transfer: makeTransfer };
}
