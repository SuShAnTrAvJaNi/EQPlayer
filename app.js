/* Settings: streaming keys (kept here so it loads with the app) */
      (function () {
        var KEY = 'eqp-cfg-v1';
        var o = {};
        try { o = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
        cfgSp.value = o.VITE_SPOTIFY_CLIENT_ID || '';
        cfgAm.value = o.VITE_APPLE_MUSIC_DEVELOPER_TOKEN || '';
        cfgSave.onclick = function () {
          var sp = cfgSp.value.trim(), am = cfgAm.value.trim();
          if (!sp && !am) {
            cfgSave.textContent = 'Enter a key first';
            setTimeout(function () { cfgSave.textContent = 'Save keys on this device'; }, 2000);
            return;
          }
          localStorage.setItem(KEY, JSON.stringify({
            VITE_SPOTIFY_CLIENT_ID: sp,
            VITE_APPLE_MUSIC_DEVELOPER_TOKEN: am
          }));
          cfgSave.textContent = 'Saved. Reload the page.';
        };
      })();

/* Main app */
(function(){
'use strict';
const $=s=>document.querySelector(s);
const BANDS=[31,62,125,250,500,1000,2000,4000,8000,16000];
const LBL=['31','62','125','250','500','1k','2k','4k','8k','16k'];
const NB=BANDS.length, GMAX=12, BQ=1.41;
const PRESETS={
  'Flat':[0,0,0,0,0,0,0,0,0,0],
  'Bass boost':[6,5,4,2,1,0,0,0,0,0],
  'Treble boost':[0,0,0,0,0,0,1,3,5,6],
  'Vocal':[-2,-2,-1,0,2,4,3,1,0,-1],
  'Loudness':[5,4,1,0,-1,0,0,2,4,3],
  'Late night':[3,2,0,-1,-2,-2,-1,-1,-2,-3]
};
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const fmtTime=s=>{if(!isFinite(s)||s<0)return '0:00';s=Math.floor(s);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const fmtMB=b=>b>=1e9?(b/1e9).toFixed(1)+' GB':(b/1e6).toFixed(b>=1e8?0:1)+' MB';
const fmtG=g=>(g>0?'+':'')+g.toFixed(1);

/* ---------- small persistent prefs (localStorage; tiny data only) ---------- */
const ls={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
};
function validState(s){
  return !!s&&Array.isArray(s.gains)&&s.gains.length===NB&&s.gains.every(g=>typeof g==='number'&&isFinite(g));
}
let state=ls.get('eqp-v4',null);
if(!validState(state)) state={gains:Array(NB).fill(0),pre:0,auto:true,bypass:false,bass:0,treble:0};
else { state.gains=state.gains.map(g=>clamp(g,-GMAX,GMAX)); state.pre=clamp(isFinite(+state.pre)?+state.pre:0,-24,6); state.auto=state.auto!==false; state.bypass=!!state.bypass; state.bass=clamp(+state.bass||0,-GMAX,GMAX); state.treble=clamp(+state.treble||0,-GMAX,GMAX); }
const REV_TYPES=['Off','Room','Auditorium','Great Hall','Stadium'];
state.bal=clamp(+state.bal||0,-100,100);
state.width=isFinite(+state.width)&&state.width!=null?clamp(+state.width,0,200):100;
state.revType=REV_TYPES.includes(state.revType)?state.revType:'Off';
state.revMix=isFinite(+state.revMix)&&state.revMix!=null?clamp(+state.revMix,0,100):35;
let customPresets=ls.get('eqp-presets10',{});
if(!customPresets||typeof customPresets!=='object'||Array.isArray(customPresets)) customPresets={};
const prefs=Object.assign({vol:1,shuffle:false,repeat:0,viz:'bars',eqm:'sl'},ls.get('eqp-prefs',{}));
let _spT=0, _ssT=0;
const savePrefs=()=>{ clearTimeout(_spT); _spT=setTimeout(()=>ls.set('eqp-prefs',prefs),350); };
const saveState=()=>{ clearTimeout(_ssT); _ssT=setTimeout(()=>ls.set('eqp-v4',state),350); };
const flushSaves=()=>{ clearTimeout(_spT); clearTimeout(_ssT); ls.set('eqp-prefs',prefs); ls.set('eqp-v4',state); };
addEventListener('pagehide',flushSaves); document.addEventListener('visibilitychange',()=>{ if(document.hidden) flushSaves(); });

/* ---------- audio graph ----------
 src -> pre -> bass shelf -> treble shelf -> 10 peaking filters -> wet -+
     \-> dry ---------------------------------------------------------+-> limiterIn -> limiter -> master -> an -> vol -> out
                                                                           \-> stereo split -> 2 meter analysers (muted)
*/
const AC=window.AudioContext||window.webkitAudioContext;
let ac; try{ac=new AC({latencyHint:'playback'});}catch(e){ac=new AC();}
const audio=new Audio(); audio.preload='auto';
const srcNode=ac.createMediaElementSource(audio);
const preNode=ac.createGain();
const dryGain=ac.createGain(), wetGain=ac.createGain();
const mkBand=f=>{const n=ac.createBiquadFilter();n.type='peaking';n.frequency.value=f;n.Q.value=BQ;n.gain.value=0;return n;};
const mkShelf=(type,f)=>{const n=ac.createBiquadFilter();n.type=type;n.frequency.value=f;n.gain.value=0;return n;};
const BASS_HZ=110, TREBLE_HZ=7500;
const bassNode=mkShelf('lowshelf',BASS_HZ), trebleNode=mkShelf('highshelf',TREBLE_HZ);
const filters=BANDS.map(mkBand);
// never connected: exact target values for the headroom calculation
const shadowBass=mkShelf('lowshelf',BASS_HZ), shadowTreble=mkShelf('highshelf',TREBLE_HZ);
const shadow=BANDS.map(mkBand);
const allShadow=[shadowBass,shadowTreble].concat(shadow);
const limiterIn=ac.createGain();
const limiter=ac.createDynamicsCompressor();
limiter.threshold.value=-3.0; limiter.knee.value=6; limiter.ratio.value=12; limiter.attack.value=0.003; limiter.release.value=0.18;
const master=ac.createGain();
const an=ac.createAnalyser(); an.fftSize=4096; an.smoothingTimeConstant=0.45; an.minDecibels=-88; an.maxDecibels=-18;
const volNode=ac.createGain();
const mSplitIn=ac.createGain(); mSplitIn.channelCount=2; mSplitIn.channelCountMode='explicit'; mSplitIn.channelInterpretation='speakers'; // mono files show on both meters
const mSplit=ac.createChannelSplitter(2);
const mAn=[ac.createAnalyser(),ac.createAnalyser()];
mAn.forEach(a=>{a.fftSize=2048;a.smoothingTimeConstant=0;});
const meterMute=ac.createGain(); meterMute.gain.value=0;
srcNode.connect(preNode); preNode.connect(dryGain);
{ let last=preNode; [bassNode,trebleNode].concat(filters).forEach(f=>{last.connect(f);last=f;}); last.connect(wetGain); }
/* stereo stage: width (mid/side) -> balance -> reverb send/return -> limiter */
const mixIn=ac.createGain(); mixIn.channelCount=2; mixIn.channelCountMode='explicit'; mixIn.channelInterpretation='speakers';
const mono=()=>{const g=ac.createGain(); g.channelCount=1; g.channelCountMode='explicit'; return g;};
const wSplit=ac.createChannelSplitter(2), wMerge=ac.createChannelMerger(2);
const mMid=mono(), mSide=mono(), mInv=mono(), wGain=mono(), wInv=mono(), sumL=mono(), sumR=mono(), balL=mono(), balR=mono();
mMid.gain.value=0.5; mSide.gain.value=0.5; mInv.gain.value=-1; wInv.gain.value=-1;
dryGain.connect(mixIn); wetGain.connect(mixIn); mixIn.connect(wSplit);
wSplit.connect(mMid,0); wSplit.connect(mMid,1); wSplit.connect(mSide,0); wSplit.connect(mInv,1); mInv.connect(mSide);   // M=(L+R)/2  S=(L-R)/2
mSide.connect(wGain); wGain.connect(wInv);
mMid.connect(sumL); wGain.connect(sumL); mMid.connect(sumR); wInv.connect(sumR);                                      // L=M+wS  R=M-wS
sumL.connect(balL); sumR.connect(balR); balL.connect(wMerge,0,0); balR.connect(wMerge,0,1);
const revConv=ac.createConvolver(), revWet=ac.createGain(), revDry=ac.createGain(); revWet.gain.value=0;
wMerge.connect(revDry); revDry.connect(limiterIn); wMerge.connect(revConv); revConv.connect(revWet); revWet.connect(limiterIn);
const REV={Room:{dec:.55,pd:.004},Auditorium:{dec:1.5,pd:.012},'Great Hall':{dec:2.8,pd:.02},Stadium:{dec:4.4,pd:.03}};
const REV_INFO={Off:'Reverb is off',Room:'Small room · 0.5 s',Auditorium:'Concert room · 1.5 s','Great Hall':'Large hall · 2.8 s',Stadium:'Open arena · 4.4 s'};
const impCache={}; let curRev=null;
function makeImpulse(name){
  const p=REV[name], sr=ac.sampleRate, n=Math.max(64,Math.floor(sr*p.dec)), pd=Math.floor(sr*p.pd), buf=ac.createBuffer(2,n,sr);
  for(let c=0;c<2;c++){
    const d=buf.getChannelData(c); let lp=0;
    for(let i=0;i<n;i++){
      const t=i/n, env=Math.pow(1-t,2.5), a=Math.max(.08,1-t*1.1);   // decaying noise, getting darker over time
      lp+=((Math.random()*2-1)-lp)*a;
      d[i]=i<pd?0:lp*env;
    }
  }
  return buf;
}
function applyFx(){
  const t=ac.currentTime, b=state.bal;
  balL.gain.setTargetAtTime(b>0?1-b/100:1,t,0.02); balR.gain.setTargetAtTime(b<0?1+b/100:1,t,0.02);
  wGain.gain.setTargetAtTime(state.width/100,t,0.02);
  if(state.revType!==curRev){
    curRev=state.revType;
    if(curRev!=='Off'){ if(!impCache[curRev]) impCache[curRev]=makeImpulse(curRev); revConv.buffer=impCache[curRev]; } else { revConv.buffer=null; }
  }
  const m=state.revType==='Off'?0:state.revMix/100;
  revWet.gain.setTargetAtTime(m*0.9,t,0.03); revDry.gain.setTargetAtTime(1-m*0.25,t,0.03);
}
limiterIn.connect(limiter); limiter.connect(master); master.connect(an); an.connect(volNode); volNode.connect(ac.destination);
limiterIn.connect(mSplitIn); mSplitIn.connect(mSplit); mSplit.connect(mAn[0],0); mSplit.connect(mAn[1],1);
mAn.forEach(a=>a.connect(meterMute)); meterMute.connect(ac.destination);

const userGain=()=>prefs.muted?0:prefs.vol*prefs.vol;
volNode.gain.value=userGain();
let vizDirty=true;

function setBypassGains(fast){
  const t=ac.currentTime, tc=fast?0.002:0.01;
  dryGain.gain.cancelScheduledValues(t); wetGain.gain.cancelScheduledValues(t);
  dryGain.gain.setTargetAtTime(state.bypass?1:0,t,tc);
  wetGain.gain.setTargetAtTime(state.bypass?0:1,t,tc);
}

const NPTS=160;
const freqs=new Float32Array(NPTS), mag=new Float32Array(NPTS), ph=new Float32Array(NPTS), curve=new Float32Array(NPTS);
for(let i=0;i<NPTS;i++) freqs[i]=20*Math.pow(1000,i/(NPTS-1));

let grDb=0;
function recompute(){
  curve.fill(0);
  allShadow.forEach(sh=>{
    sh.getFrequencyResponse(freqs,mag,ph);
    for(let k=0;k<NPTS;k++) curve[k]+=20*Math.log10(Math.max(mag[k],1e-6));
  });
  // Auto-Headroom is separate from the manual preamp: it only adds its own attenuation (grDb, shown as GR),
  // and never moves the user's preamp slider.
  grDb=0;
  if(state.auto&&!state.bypass){
    let peak=0; for(let k=0;k<NPTS;k++) if(curve[k]>peak) peak=curve[k];
    // only boosts above +6 dB are trimmed, by half of the excess, and never more than 6 dB,
    // so ordinary EQ moves keep their loudness
    grDb=Math.round(Math.min(6,Math.max(0,peak-6)*0.5)*10)/10;
  }
  preNode.gain.setTargetAtTime(state.bypass?1:Math.pow(10,(state.pre-grDb)/20),ac.currentTime,0.03);
}
let applying=false;
function update(){
  const t=ac.currentTime;
  state.gains.forEach((g,i)=>{ shadow[i].gain.value=g; filters[i].gain.setTargetAtTime(g,t,0.02); });
  shadowBass.gain.value=state.bass; shadowTreble.gain.value=state.treble;
  bassNode.gain.setTargetAtTime(state.bass,t,0.02); trebleNode.gain.setTargetAtTime(state.treble,t,0.02);
  if(!applying&&presetSel.value!==''){presetSel.value='';delBtn.disabled=true;}
  applyFx();
  if(!updQ) updQ=requestAnimationFrame(flushUpdate);
}
let updQ=0;
function flushUpdate(){ if(updQ){ cancelAnimationFrame(updQ); updQ=0; } recompute(); syncUI(); saveState(); vizDirty=true; }

/* ---------- 10-band vertical faders ---------- */
const presetSel=$('#preset'), delBtn=$('#delPreset'), abBtn=$('#ab');
const bandsEl=$('#bands'); const cols=[];
const TH=26, HH=13; // fader cap height and half of it
const posAt=f=>'calc('+HH+'px + (100% - '+TH+'px) * '+f+')';
function buildSliders(){
  bandsEl.innerHTML=''; cols.length=0;
  const sc=document.createElement('div'); sc.className='bcol scale';
  sc.innerHTML='<div class="bv">dB</div><div class="bt">'+
    [[12,0],[6,.25],[0,.5],[-6,.75],[-12,1]].map(a=>'<span style="top:'+posAt(a[1])+'">'+(a[0]>0?'+'+a[0]:a[0]<0?'−'+(-a[0]):'0')+'</span>').join('')+
    '</div><div class="bf">Hz</div>';
  bandsEl.appendChild(sc);
  const ticks=[0,.25,.5,.75,1].map(f=>'<i class="tk'+(f===.5?' z':'')+'" style="top:'+posAt(f)+'"></i>').join('');
  const lastTap=[]; let dragI=-1;
  const gainFromY=(el,e)=>{
    const r=el.getBoundingClientRect(), th=TH*(r.height/el.offsetHeight||1);
    const f=clamp((e.clientY-r.top-th/2)/Math.max(1,r.height-th),0,1);
    let g=Math.round((GMAX-f*2*GMAX)*10)/10; if(Math.abs(g)<0.25) g=0; return g;
  };
  BANDS.forEach((f,i)=>{
    const c=document.createElement('div'); c.className='bcol';
    c.innerHTML='<div class="bv">0.0</div><div class="bt" role="slider" tabindex="0" aria-label="'+(f>=1000?(f/1000)+' kHz':f+' Hz')+'" aria-valuemin="-12" aria-valuemax="12">'+ticks+'<div class="rail"></div><div class="fill"></div><div class="lvl"><i></i><b></b></div><div class="thumb"></div></div><div class="bf">'+LBL[i]+'</div>';
    const bt=c.querySelector('.bt');
    bt.addEventListener('pointerdown',e=>{
      e.preventDefault();
      const now=performance.now();
      if(lastTap[i]&&now-lastTap[i]<320){ lastTap[i]=0; state.gains[i]=0; update(); return; } // double-tap = reset band
      lastTap[i]=now; dragI=i; bt.classList.add('drag'); try{bt.setPointerCapture(e.pointerId);}catch(_){}
      state.gains[i]=gainFromY(bt,e); update();
    });
    bt.addEventListener('pointermove',e=>{ if(dragI!==i) return; state.gains[i]=gainFromY(bt,e); update(); });
    const end=()=>{ if(dragI===i) dragI=-1; bt.classList.remove('drag'); };
    bt.addEventListener('pointerup',end); bt.addEventListener('pointercancel',end); bt.addEventListener('lostpointercapture',end);
    bt.addEventListener('keydown',e=>{
      const d=e.key==='ArrowUp'||e.key==='ArrowRight'?0.5:e.key==='ArrowDown'||e.key==='ArrowLeft'?-0.5:0;
      if(e.key==='Home'||e.key==='0'){ state.gains[i]=0; update(); e.preventDefault(); }
      else if(d){ state.gains[i]=clamp(Math.round((state.gains[i]+d)*10)/10,-GMAX,GMAX); update(); e.preventDefault(); }
    });
    bandsEl.appendChild(c);
    cols.push({bv:c.querySelector('.bv'),bt,fill:c.querySelector('.fill'),thumb:c.querySelector('.thumb'),lv:c.querySelector('.lvl i'),pk:c.querySelector('.lvl b')});
  });
}

/* ---------- preamp pill slider ---------- */
const PMIN=-24, PMAX=6, PW=26;
// The slider shows the level the output actually gets. With Headroom on, that is the base preamp minus the
// automatic trim, so it moves when the EQ, bass or treble change. Dragging sets the base to keep the shown value.
const preShown=()=>{ const v=(state.auto&&!state.bypass)?state.pre-grDb:state.pre; return Math.round(clamp(v,PMIN,PMAX)*10)/10; };
const preSet=v=>{ const base=(state.auto&&!state.bypass)?v+grDb:v; state.pre=Math.round(clamp(base,-24,6)*10)/10; };
const pill=$('#pre'), pFill=pill.querySelector('.pfill'), pThumb=pill.querySelector('.pthumb'), pZero=pill.querySelector('.pzero');
(function(){
  let last=0, drag=false;
  const val=e=>{
    const r=pill.getBoundingClientRect(), k=r.width/pill.offsetWidth||1, tw=PW*k;
    const f=clamp((e.clientX-r.left-tw/2)/Math.max(1,r.width-tw),0,1);
    let v=Math.round((PMIN+f*(PMAX-PMIN))*10)/10; if(Math.abs(v)<0.3) v=0; return v;
  };
  pill.addEventListener('pointerdown',e=>{
    e.preventDefault();
    const now=performance.now();
    if(now-last<320){ last=0; preSet(0); update(); return; } // double-tap = reset preamp
    last=now; drag=true; pill.classList.add('drag'); try{pill.setPointerCapture(e.pointerId);}catch(_){}
    preSet(val(e)); update();
  });
  pill.addEventListener('pointermove',e=>{ if(drag){ preSet(val(e)); update(); } });
  const end=()=>{ drag=false; pill.classList.remove('drag'); };
  pill.addEventListener('pointerup',end); pill.addEventListener('pointercancel',end); pill.addEventListener('lostpointercapture',end);
  pill.addEventListener('keydown',e=>{
    const d=e.key==='ArrowUp'||e.key==='ArrowRight'?0.5:e.key==='ArrowDown'||e.key==='ArrowLeft'?-0.5:0;
    if(e.key==='Home'||e.key==='0'){ preSet(0); update(); e.preventDefault(); }
    else if(d){ preSet(clamp(Math.round((preShown()+d)*10)/10,PMIN,PMAX)); update(); e.preventDefault(); }
  });
})();

/* ---------- rotary Bass / Treble knobs ---------- */
const kpt=(a,r)=>[32+r*Math.sin(a*Math.PI/180),32-r*Math.cos(a*Math.PI/180)];
function karc(a0,a1,r){
  if(Math.abs(a1-a0)<0.01) return '';
  const p0=kpt(a0,r), p1=kpt(a1,r);
  return 'M'+p0[0].toFixed(2)+' '+p0[1].toFixed(2)+'A'+r+' '+r+' 0 '+(Math.abs(a1-a0)>180?1:0)+' '+(a1>a0?1:0)+' '+p1[0].toFixed(2)+' '+p1[1].toFixed(2);
}
function makeKnob(host,key,label,o){
  o=Object.assign({min:-GMAX,max:GMAX,step:.5,def:0,uni:false,fx:false,fmt:v=>fmtG(v)+' dB'},o||{});
  const mid=(o.min+o.max)/2, half=(o.max-o.min)/2;
  const angOf=v=>o.uni?((v-o.min)/(o.max-o.min)*270-135):((v-mid)/half*135);
  const a0=o.uni?-135:0;
  const ticks=[-135,-67.5,0,67.5,135].map(a=>{const p=kpt(a,29),q=kpt(a,a===0?32:31);return '<line x1="'+p[0].toFixed(2)+'" y1="'+p[1].toFixed(2)+'" x2="'+q[0].toFixed(2)+'" y2="'+q[1].toFixed(2)+'" stroke="'+(a===0?'#8a8a8a':'#4a4a4a')+'" stroke-width="1.2"/>';}).join('');
  host.innerHTML='<div class="klab">'+label+'</div>'+
    '<div class="knob" role="slider" tabindex="0" aria-label="'+label+'" aria-valuemin="'+o.min+'" aria-valuemax="'+o.max+'"><svg viewBox="0 0 64 64">'+
    '<defs><radialGradient id="kg-'+key+'" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#5c5c5c"/><stop offset=".55" stop-color="#2b2b2b"/><stop offset="1" stop-color="#141414"/></radialGradient></defs>'+
    ticks+'<path class="ktrack" d="'+karc(-135,135,25)+'"/><path class="kact" d=""/>'+
    '<circle class="kcap" cx="32" cy="32" r="17" fill="url(#kg-'+key+')"/>'+
    '<g class="kptr"><line x1="32" y1="16.5" x2="32" y2="23"/></g></svg></div><output class="kval"></output>';
  const knob=host.querySelector('.knob'), act=host.querySelector('.kact'), ptr=host.querySelector('.kptr'), out=host.querySelector('.kval');
  let sx=0, sy=0, sv=0, drag=false, last=0;
  const upd=()=>{ if(o.fx){ applying=true; update(); applying=false; } else update(); };
  const calc=e=>{ const r=sv+((e.clientX-sx)-(e.clientY-sy))*(o.max-o.min)/240; const v=Math.round(clamp(r,o.min,o.max)/o.step)*o.step; return +v.toFixed(3)||0; };
  knob.addEventListener('pointerdown',e=>{
    e.preventDefault();
    const now=performance.now();
    if(last&&now-last<320){ last=0; state[key]=o.def; upd(); return; } // double-tap = reset knob
    last=now; drag=true; knob.classList.add('drag'); try{knob.setPointerCapture(e.pointerId);}catch(_){}
    sx=e.clientX; sy=e.clientY; sv=state[key];
  });
  knob.addEventListener('pointermove',e=>{ if(!drag) return; const v=calc(e); if(v!==state[key]){ state[key]=v; upd(); } });
  const end=()=>{ drag=false; knob.classList.remove('drag'); };
  knob.addEventListener('pointerup',end); knob.addEventListener('pointercancel',end); knob.addEventListener('lostpointercapture',end);
  knob.addEventListener('keydown',e=>{
    const d=e.key==='ArrowUp'||e.key==='ArrowRight'?o.step:e.key==='ArrowDown'||e.key==='ArrowLeft'?-o.step:0;
    if(e.key==='Home'||e.key==='0'){ state[key]=o.def; upd(); e.preventDefault(); }
    else if(d){ state[key]=clamp(+(Math.round((state[key]+d)/o.step)*o.step).toFixed(3),o.min,o.max); upd(); e.preventDefault(); }
  });
  return function sync(){
    const v=state[key], a=angOf(v);
    act.setAttribute('d',karc(a0,a,25)); ptr.setAttribute('transform','rotate('+a.toFixed(1)+' 32 32)');
    out.textContent=o.fmt(v); out.className='kval'+(o.fx?'':(v>o.def?' pos':v<o.def?' neg':''));
    knob.setAttribute('aria-valuenow',v);
  };
}
const syncBass=makeKnob($('#knBass'),'bass','BASS'), syncTreble=makeKnob($('#knTreble'),'treble','TREBLE');
const syncBal=makeKnob($('#knBal'),'bal','BALANCE',{min:-100,max:100,step:1,fx:true,fmt:v=>v===0?'CENTER':(v<0?'L ':'R ')+Math.abs(v)});
const syncWidth=makeKnob($('#knWidth'),'width','WIDTH',{min:0,max:200,step:5,def:100,fx:true,fmt:v=>v+'%'});
const syncRevMix=makeKnob($('#knRevMix'),'revMix','MIX',{min:0,max:100,step:1,def:35,uni:true,fx:true,fmt:v=>v+'%'});

function syncUI(){
  state.gains.forEach((g,i)=>{
    const c=cols[i]; if(!c) return;
    const frac=(GMAX-g)/(2*GMAX); // 0 = top (+12), 1 = bottom (-12)
    c.bv.textContent=fmtG(g); c.bv.className='bv'+(g>0?' pos':g<0?' neg':'');
    c.thumb.style.top='calc((100% - '+TH+'px) * '+frac.toFixed(4)+')';
    if(g>=0){ c.fill.style.top='calc((100% - '+TH+'px) * '+frac.toFixed(4)+' + '+HH+'px)'; c.fill.style.bottom='50%'; }
    else { c.fill.style.top='50%'; c.fill.style.bottom='calc((100% - '+TH+'px) * '+(1-frac).toFixed(4)+' + '+HH+'px)'; }
    c.bt.setAttribute('aria-valuenow',g);
    c.bt.classList.toggle('byp',state.bypass);
  });
  const shown=preShown();
  const f=(shown-PMIN)/(PMAX-PMIN), z=-PMIN/(PMAX-PMIN), lo=Math.min(f,z), hi=Math.max(f,z);
  pThumb.style.left='calc((100% - '+PW+'px) * '+f.toFixed(4)+')';
  pFill.style.left='calc('+(PW/2)+'px + (100% - '+PW+'px) * '+lo.toFixed(4)+')';
  pFill.style.width='calc((100% - '+PW+'px) * '+(hi-lo).toFixed(4)+')';
  pZero.style.left='calc('+(PW/2)+'px + (100% - '+PW+'px) * '+z.toFixed(4)+')';
  pill.setAttribute('aria-valuenow',shown); pill.setAttribute('aria-valuetext',shown.toFixed(1)+' dB');
  $('#preO').textContent=(shown>0?'+':'')+shown.toFixed(1)+' dB';
  $('#grRead').textContent=state.auto?(grDb>0?'−'+grDb.toFixed(1):'0.0')+' dB':'off';
  $('#tone').classList.toggle('byp',state.bypass);
  syncBass(); syncTreble();
  abBtn.textContent=state.bypass?'EQ OFF':'EQ ON';
  abBtn.classList.toggle('on',!state.bypass); abBtn.classList.toggle('off',state.bypass);
  $('#auto').classList.toggle('on',state.auto);
  $('#autoM').classList.toggle('on',state.auto);
  syncBal(); syncWidth(); syncRevMix();
  document.querySelectorAll('#rvPills button').forEach(b=>b.classList.toggle('on',b.dataset.r===state.revType));
  $('#rvInfo').textContent=REV_INFO[state.revType]||'';
  $('#knRevMix').classList.toggle('dis',state.revType==='Off');
}
abBtn.onclick=()=>{state.bypass=!state.bypass;setBypassGains();applying=true;update();applying=false;}; // A/B must not deselect the preset
$('#auto').onclick=()=>{state.auto=!state.auto;update();};
$('#reset').onclick=()=>{
  state.gains=Array(NB).fill(0);state.pre=0;state.bass=0;state.treble=0;state.bal=0;state.width=100;state.auto=true;state.bypass=false;state.revType='Off';state.revMix=35;
  applying=true; setBypassGains(); update(); applying=false; renderPresetSelect('b:Flat');
};

/* ---------- presets ---------- */
function renderPresetSelect(value){
  presetSel.innerHTML='';
  presetSel.appendChild(new Option('Current (unsaved)',''));
  const g1=document.createElement('optgroup'); g1.label='Built-in';
  Object.keys(PRESETS).forEach(n=>g1.appendChild(new Option(n,'b:'+n)));
  presetSel.appendChild(g1);
  const names=Object.keys(customPresets).sort((a,b)=>a.localeCompare(b));
  if(names.length){
    const g2=document.createElement('optgroup'); g2.label='My presets';
    names.forEach(n=>g2.appendChild(new Option(n,'u:'+n)));
    presetSel.appendChild(g2);
  }
  presetSel.value=value||'';
  if(presetSel.value!==(value||'')) presetSel.value='';
  delBtn.disabled=!presetSel.value.startsWith('u:');
}
function applyPreset(v){
  if(!v) return;
  applying=true;
  if(v.startsWith('b:')){
    const g=PRESETS[v.slice(2)]; if(!g){applying=false;return;}
    state.gains=g.slice(); state.auto=true; state.bass=0; state.treble=0;
  }else{
    const p=customPresets[v.slice(2)]; if(!validState(p)){applying=false;return;}
    state.gains=p.gains.map(x=>clamp(x,-GMAX,GMAX)); state.pre=typeof p.pre==='number'&&isFinite(p.pre)?clamp(p.pre,-24,6):0; state.auto=!!p.auto; state.bass=typeof p.bass==='number'?clamp(p.bass,-GMAX,GMAX):0; state.treble=typeof p.treble==='number'?clamp(p.treble,-GMAX,GMAX):0;
  }
  state.bypass=false;
  setBypassGains(); update();
  applying=false;
  renderPresetSelect(v);
}
presetSel.onchange=()=>applyPreset(presetSel.value);
/* ---------- mute: the speaker icon at the low end of the volume row ---------- */
function syncMute(){
  const b=$('#muteBtn'); if(!b) return;
  b.setAttribute('aria-pressed',prefs.muted?'true':'false'); b.classList.toggle('on',!!prefs.muted); b.setAttribute('aria-label',prefs.muted?'Unmute':'Mute');
  volNode.gain.setTargetAtTime(userGain(),ac.currentTime,0.02);
  if(SX.active()) SX.setVolume(prefs.muted?0:prefs.vol);
}
$('#muteBtn').onclick=()=>{ prefs.muted=!prefs.muted; savePrefs(); syncMute(); };
$('#savePreset').onclick=()=>{
  showModal({title:'Save preset',text:'Name this EQ setting (e.g. Headphones).',input:true,value:'',ok:'Save',onOk:name=>{
    name=name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,30);
    if(!name) return toast('Give the preset a name');
    customPresets[name]={gains:state.gains.slice(),pre:state.pre,auto:state.auto,bass:state.bass,treble:state.treble};
    ls.set('eqp-presets10',customPresets);
    renderPresetSelect('u:'+name);
    toast('Saved “'+name+'”');
  }});
};
delBtn.onclick=()=>{
  const v=presetSel.value; if(!v.startsWith('u:')) return;
  const name=v.slice(2);
  showModal({title:'Delete preset',text:'Delete “'+name+'”?',ok:'Delete',danger:true,onOk:()=>{
    delete customPresets[name]; ls.set('eqp-presets10',customPresets); renderPresetSelect('');
  }});
};

/* ---------- modal + toast ---------- */
const modal=$('#modal'),mInput=$('#mInput'),mOk=$('#mOk');
let mHandler=null,mNeedsText=false;
function showModal({title,text='',input=false,value='',ok='OK',danger=false,onOk}){
  if(!$('#mTitle')){ const h=document.createElement('h2'); h.id='mTitle'; const p=document.createElement('p'); p.id='mText'; const bx=modal.querySelector('.box'); bx.prepend(p); bx.prepend(h); }
  $('#mTitle').textContent=title; $('#mText').textContent=text; $('#mText').style.display=text?'':'none';
  mInput.style.display=input?'':'none'; mInput.value=value; mNeedsText=input;
  mOk.textContent=ok; mOk.className=danger?'danger':'on'; mHandler=onOk;
  modal.classList.add('show'); if(input) setTimeout(()=>mInput.focus(),50);
}
function hideModal(){modal.classList.remove('show');mInput.blur();}
function submitModal(){
  const v=mInput.value.trim();
  if(mNeedsText&&!v) return;
  const h=mHandler; hideModal(); if(h) h(v);
}
mOk.onclick=submitModal;
$('#mCancel').onclick=hideModal;
modal.addEventListener('click',e=>{ if(e.target===modal) hideModal(); });   // tap the dimmed backdrop to dismiss
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&modal.classList.contains('show')) hideModal(); });
mInput.addEventListener('keydown',e=>{if(e.key==='Enter')submitModal();});
let toastTimer=null;
function toast(msg,ms){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),ms||2600);
}

/* ---------- responsive layout ----------
   No device picker or calibration: the layout follows the real viewport (100dvh + safe-area insets in CSS).
   This only toggles size classes that the EQ / meter CSS uses. */
let scale=1;
const stage=$('#stage');
const typing=()=>{const a=document.activeElement;return !!a&&(a.tagName==='INPUT'&&a.type!=='range'&&a.type!=='file');};
function fit(){
  const de=document.documentElement;
  const vw=de.clientWidth||window.innerWidth, vh=de.clientHeight||window.innerHeight;
  if(vw<200||vh<200) return;
  const cl=stage.classList, portrait=vh>=vw, phone=Math.min(vw,vh)<600;
  cl.toggle('portrait',portrait); cl.toggle('landscape',!portrait);
  cl.toggle('phone',phone); cl.toggle('tablet',!phone);
  cl.toggle('short',vh<700); cl.toggle('tiny',vw<340); cl.toggle('squat',vh<340);
  sizeViz();
}
let fitTimer=null;
function safeFit(){ if(typing()) return; clearTimeout(fitTimer); fitTimer=setTimeout(fit,120); }
window.addEventListener('resize',safeFit);
if(window.visualViewport) window.visualViewport.addEventListener('resize',safeFit);
window.addEventListener('orientationchange',()=>{ setTimeout(fit,100); setTimeout(fit,500); });
window.addEventListener('load',()=>{ setTimeout(fit,100); setTimeout(fit,600); });
function pickerStart(){}
function pickerEnd(){ setTimeout(fit,300); }

/* ---------- bottom navigation, screens, menu, EQ sub-modes ---------- */
let curTab='library';
const navBtns=[...document.querySelectorAll('#nav button')];
function setTab(t){
  if(t==='menu'){ openMenu(); return; }
  menuWrap.classList.remove('show'); stage.classList.remove('menu-open');
  closeNP(); closeQueue(); closeEqSheet(true);
  curTab=t;
  const cl=stage.classList;
  ['library','eq','search'].forEach(x=>cl.toggle('t-'+x,x===t));
  navBtns.forEach(b=>b.classList.toggle('act',b.dataset.t===t));
  if(t==='search') $('#search').focus();
  vizDirty=true; setTimeout(()=>{ sizeViz(); drawWave(); if(t==='library') scrollToCurrent(); },30);
}
navBtns.forEach(b=>b.onclick=()=>{ userNavigated=true; setTab(b.dataset.t); });
const menuWrap=$('#menuWrap');
function openMenu(){
  markSettingsSeen(); fillOutputs();
  closeNP(); closeQueue(); closeEqSheet(true); closeMore();
  stage.classList.add('menu-open');
  menuWrap.classList.add('show');
  navBtns.forEach(b=>b.classList.toggle('act',b.dataset.t==='menu'));
}
// going back returns to the tab the user came from (curTab never becomes 'menu')
function closeMenu(){
  if(!menuWrap.classList.contains('show')) return;
  menuWrap.classList.remove('show'); stage.classList.remove('menu-open');
  setTab(curTab);
}
$('#menuDone').onclick=closeMenu;
$('#autoM').onclick=()=>{ state.auto=!state.auto; update(); };
stage.addEventListener('scroll',()=>{ stage.scrollTop=0; stage.scrollLeft=0; });
const eqSec=$('#sEq');
function setEqMode(m){
  if(!['sl','tn','rv'].includes(m)) m='sl';
  prefs.eqm=m; savePrefs();
  ['sl','tn','rv'].forEach(x=>eqSec.classList.toggle('m-'+x,x===m));
  document.querySelectorAll('#eqModes button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  vizDirty=true; setTimeout(sizeViz,30);
}
document.querySelectorAll('#eqModes button').forEach(b=>b.onclick=()=>setEqMode(b.dataset.m));
document.querySelectorAll('#rvPills button').forEach(b=>b.onclick=()=>{ state.revType=b.dataset.r; applying=true; update(); applying=false; });
let userNavigated=false;
function initUI(){ setEqMode(prefs.eqm); setLibTab('songs'); if(!userNavigated) setTab('library'); }

/* ---------- colour theme (spectrum picker) ---------- */
const T={acc:'#ffa000',acc2:'#ff8f00',mid:'#ffb300',rgb:'255,160,0'};
let theme=Object.assign({h:353,s:96},ls.get('eqp-theme',{}));
theme.h=clamp(+theme.h||0,0,360); theme.s=clamp(isFinite(+theme.s)?+theme.s:100,0,100);
const THEMES=[['Apple Music red',353,96],['Amber',38,100],['Red',2,90],['Pink',325,85],['Violet',268,85],['Blue',212,100],['Cyan',186,100],['Green',140,80],['Lime',78,90],['Mono',0,0]];
const hsl=(h,s,l)=>'hsl('+(((h%360)+360)%360).toFixed(0)+','+s.toFixed(0)+'%,'+l+'%)';
function hslRgb(h,s,l){ s/=100;l/=100; const k=n=>(n+h/30)%12, a=s*Math.min(l,1-l), f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1))); return [f(0),f(8),f(4)].map(v=>Math.round(v*255)); }
function applyTheme(save){
  const h=theme.h, s=theme.s, st=document.documentElement.style;
  T.acc=hsl(h,s,50); T.acc2=hsl(h-4,s,48); T.mid=hsl(h+4,s,52); T.rgb=hslRgb(h,s,50).join(',');
  if(h===353&&Math.round(s)===96){ T.acc='#FA243C'; T.rgb='250,36,60'; }
  st.setProperty('--acc',T.acc); st.setProperty('--acc2',T.acc2); st.setProperty('--mid',T.mid); st.setProperty('--hi',hsl(h+8,s,60));
  st.setProperty('--edge',hsl(h,s,65)); st.setProperty('--ink',hsl(h,Math.max(s,20),5)); st.setProperty('--dk',hsl(h,s,9)); st.setProperty('--deep',hsl(h-5,s,40));
  st.setProperty('--rgb',T.rgb); st.setProperty('--glow','rgba('+T.rgb+',.45)');
  $('#specH .sthumb').style.left=(theme.h/360*100)+'%'; $('#specH .sthumb').style.background=hsl(h,100,50);
  $('#specS .sthumb').style.left=theme.s+'%'; $('#specS .sthumb').style.background=T.acc;
  $('#specS').style.background='linear-gradient(90deg,'+hsl(h,0,50)+','+hsl(h,100,50)+')';
  document.querySelectorAll('.sw').forEach((b,i)=>b.classList.toggle('cur',Math.abs(THEMES[i][1]-h)<2&&THEMES[i][2]===Math.round(s)));
  if(vw) sizeViz();
  vizDirty=true; if(save) ls.set('eqp-theme',theme);
}
(function(){
  const box=$('#swatches');
  THEMES.forEach(a=>{ const b=document.createElement('button'); b.className='sw'; b.title=a[0]; b.setAttribute('aria-label',a[0]);
    b.style.background=a[2]?hsl(a[1],a[2],50):'#bbb'; b.onclick=()=>{theme.h=a[1];theme.s=a[2];applyTheme(true);}; box.appendChild(b); });
  const spec=(el,set)=>{ let d=false; const v=e=>{const r=el.getBoundingClientRect();return clamp((e.clientX-r.left)/r.width,0,1);};
    el.addEventListener('pointerdown',e=>{e.preventDefault();d=true;try{el.setPointerCapture(e.pointerId);}catch(_){}set(v(e));});
    el.addEventListener('pointermove',e=>{if(d)set(v(e));});
    const end=()=>{d=false;}; el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end); el.addEventListener('lostpointercapture',end); };
  spec($('#specH'),f=>{theme.h=Math.round(f*360);applyTheme(true);});
  spec($('#specS'),f=>{theme.s=Math.round(f*100);applyTheme(true);});
  const wrap=$('#themeWrap');
  $('#themeBtn').onclick=()=>wrap.classList.add('show');
  $('#themeDone').onclick=()=>wrap.classList.remove('show');
  wrap.addEventListener('pointerdown',e=>{ if(e.target===wrap) wrap.classList.remove('show'); });
  $('#themeReset').onclick=()=>{theme.h=353;theme.s=96;applyTheme(true);};
})();

/* ---------- stereo level meters (ballistic) + spectrum / scope + band LEDs ---------- */
const mbufF=mAn[0].getFloatTimeDomainData?[new Float32Array(2048),new Float32Array(2048)]:null;
const mbufB=[new Uint8Array(2048),new Uint8Array(2048)];
const elFill=[...document.querySelectorAll('.mfill')], elPeak=[...document.querySelectorAll('.mpeak')];
const elVal=[$('#mvalL'),$('#mvalR')], elLim=$('#mlim'), clipBtn=$('#clip');
const mDb=[-90,-90], mHold=[-90,-90], mHoldT=[0,0];
let overT=-1e9, lastRaf=0, lastTxt=0, liveUntil=0;
const MMIN=-48, MMAX=6, CLIP_DB=-0.1;
const mPct=db=>(clamp(db,MMIN,MMAX)-MMIN)/(MMAX-MMIN)*100;
function updateMeter(now,dt){
  for(let c=0;c<2;c++){
    let peak=0;
    if(mbufF){ const b=mbufF[c]; mAn[c].getFloatTimeDomainData(b); for(let i=0;i<b.length;i++){const a=Math.abs(b[i]); if(a>peak)peak=a;} }
    else { const b=mbufB[c]; mAn[c].getByteTimeDomainData(b); for(let i=0;i<b.length;i++){const a=Math.abs(b[i]-128)/128; if(a>peak)peak=a;} }
    const db=peak>1e-5?20*Math.log10(peak):-90;
    mDb[c]=db>mDb[c]?db:Math.max(db,mDb[c]-28*dt);           // instant attack, 28 dB/s fall
    if(db>=mHold[c]||now-mHoldT[c]>1500){mHold[c]=db;mHoldT[c]=now;} // 1.5 s peak hold
    if(db>CLIP_DB) overT=now;
    elFill[c].style.clipPath='inset(0 '+(100-mPct(mDb[c])).toFixed(1)+'% 0 0)';
    elPeak[c].style.left='calc('+mPct(mHold[c]).toFixed(1)+'% - 1px)';
  }
  if(now-lastTxt>130){
    lastTxt=now;
    const gr=typeof limiter.reduction==='number'?limiter.reduction:(limiter.reduction&&limiter.reduction.value)||0;
    clipBtn.classList.toggle('hot',now-overT<4000);
    for(let c=0;c<2;c++){
      elVal[c].textContent=mHold[c]>-80?mHold[c].toFixed(1)+' dB':'–∞';
      elVal[c].style.color=mHold[c]>CLIP_DB?'var(--bad)':'';
    }
    elLim.textContent=gr<-0.4?'LIM '+gr.toFixed(1):'';
    const lt=$('#mlimTxt'); if(lt) lt.textContent=gr<-0.4?gr.toFixed(1)+' dB':'0.0 dB';
  }
}
clipBtn.onclick=()=>{ overT=-1e9; clipBtn.classList.remove('hot'); };

const vBox=$('#vizBox'), vc=$('#viz'), vx=vc.getContext('2d');
let vw=0, vh=0, vk=1, vGrad=null, NBAR=48;
const barLo=[], barHi=[];
const fbuf=new Uint8Array(an.frequencyBinCount), tbuf=new Uint8Array(an.fftSize);
const sm=new Float32Array(96), pkv=new Float32Array(96), pkT=new Float64Array(96);
const bsm=new Float32Array(NB), bpk=new Float32Array(NB), bpkT=new Float64Array(NB);
const VPAD=8, VLAB=12, VTOP=6;
function buildBars(){
  NBAR=clamp(Math.floor(vw/11),32,72);
  const binHz=ac.sampleRate/an.fftSize;
  for(let i=0;i<NBAR;i++){
    barLo[i]=20*Math.pow(1000,i/NBAR)/binHz;
    barHi[i]=20*Math.pow(1000,(i+1)/NBAR)/binHz;
  }
}
function sizeViz(){
  const w=vc.clientWidth, h=vc.clientHeight; if(!w||!h) return;
  vk=Math.min(2,Math.max(1,(window.devicePixelRatio||1)*Math.min(1,scale)));
  const pw=Math.round(w*vk), ph2=Math.round(h*vk);
  if(vc.width!==pw||vc.height!==ph2){ vc.width=pw; vc.height=ph2; }
  vw=w; vh=h;
  vGrad=vx.createLinearGradient(0,vh-VLAB,0,VTOP);
  vGrad.addColorStop(0,T.acc2); vGrad.addColorStop(.6,T.acc); vGrad.addColorStop(.8,T.mid); vGrad.addColorStop(.9,'#ff6d00'); vGrad.addColorStop(1,'#ff3d00');
  buildBars(); vizDirty=true;
}
if(window.ResizeObserver) new ResizeObserver(sizeViz).observe(vc); else window.addEventListener('resize',sizeViz);
vBox.addEventListener('click',()=>{ prefs.viz=prefs.viz==='scope'?'bars':'scope'; savePrefs(); vizDirty=true; });

function barVal(i){
  const lo=barLo[i], hi=barHi[i], n=fbuf.length;
  if(hi-lo<1){
    const c=(lo+hi)/2, a=Math.floor(c), fr=c-a;
    const v0=fbuf[Math.min(n-1,a)], v1=fbuf[Math.min(n-1,a+1)];
    return (v0+(v1-v0)*fr)/255;
  }
  let m=0; const e=Math.min(n-1,Math.floor(hi));
  for(let b=Math.ceil(lo);b<=e;b++) if(fbuf[b]>m) m=fbuf[b];
  return m/255;
}
function drawBars(now,dt,x0,iw,base,ah){
  const pitch=iw/NBAR, bw=Math.max(2,pitch-2);
  vx.fillStyle=vGrad; vx.beginPath();
  for(let i=0;i<NBAR;i++){
    const v=Math.min(1,barVal(i)*(1+0.35*i/NBAR));
    if(v>sm[i]) sm[i]+=(v-sm[i])*0.7; else sm[i]=Math.max(v,sm[i]-dt*1.3);   // fast attack, smooth fall
    if(sm[i]>=pkv[i]){ pkv[i]=sm[i]; pkT[i]=now+420; } else if(now>pkT[i]) pkv[i]=Math.max(sm[i],pkv[i]-dt*0.7);
    const h=sm[i]*ah; if(h>0.5) vx.rect(x0+i*pitch+1,base-h,bw,h);
  }
  vx.fill();
  vx.fillStyle='#0b0b0b'; vx.beginPath();                                        // LED segment cuts
  for(let y=base-4;y>VTOP;y-=4) vx.rect(x0,y,iw,1.5);
  vx.fill();
  vx.fillStyle='#fff3e0'; vx.beginPath(); const hot=[];                           // peak caps: white, red when hot
  for(let i=0;i<NBAR;i++){
    const p=pkv[i]; if(p<=0.02) continue;
    const y=base-p*ah-2;
    if(p>0.9) hot.push(i); else vx.rect(x0+i*pitch+1,y,bw,2);
  }
  vx.fill();
  if(hot.length){ vx.fillStyle='#ff5252'; vx.beginPath(); hot.forEach(i=>vx.rect(x0+i*pitch+1,base-pkv[i]*ah-2,bw,2)); vx.fill(); }
}
function drawScope(x0,iw,base,ah){
  an.getByteTimeDomainData(tbuf);
  const N=tbuf.length, span=Math.min(1536,N>>1), mid=VTOP+ah/2, amp=ah/2-3;
  let s=0; for(let i=1;i<N-span;i++){ if(tbuf[i-1]<128&&tbuf[i]>=128){ s=i; break; } } // rising zero-crossing trigger
  vx.fillStyle='rgba(255,255,255,.08)'; vx.fillRect(x0,Math.round(mid),iw,1);
  const step=Math.max(1,span/iw), path=new Path2D();
  for(let j=0;j<iw;j++){
    const v=tbuf[Math.min(N-1,s+Math.floor(j*step))];
    const y=clamp(mid-(v-128)/128*amp*1.5,VTOP,base);
    if(j===0) path.moveTo(x0,y); else path.lineTo(x0+j,y);
  }
  vx.lineJoin='round'; vx.lineCap='round';
  vx.strokeStyle='rgba('+T.rgb+',.28)'; vx.lineWidth=6; vx.stroke(path);
  vx.strokeStyle=T.mid; vx.lineWidth=2; vx.stroke(path);
  vx.strokeStyle='#fff3e0'; vx.lineWidth=.8; vx.stroke(path);
}
const FMARK=[[50,'50'],[100,'100'],[200,'200'],[500,'500'],[1000,'1k'],[2000,'2k'],[5000,'5k'],[10000,'10k']];
function drawViz(now,dt){
  if(!vw) return;
  vx.setTransform(vk,0,0,vk,0,0);
  vx.fillStyle='#0b0b0b'; vx.fillRect(0,0,vw,vh);
  const x0=VPAD, iw=vw-VPAD*2, base=vh-VLAB, ah=base-VTOP, L3=Math.log(1000);
  vx.font='600 9px -apple-system,system-ui,sans-serif'; vx.textAlign='center';
  FMARK.forEach(m=>{
    const x=x0+Math.log(m[0]/20)/L3*iw;
    vx.fillStyle='rgba(255,255,255,.05)'; vx.fillRect(Math.round(x),VTOP,1,ah);
    vx.fillStyle='#666'; vx.fillText(m[1],x,vh-3);
  });
  if(prefs.viz==='scope') drawScope(x0,iw,base,ah); else drawBars(now,dt,x0,iw,base,ah);
  if(!state.bypass){                                                              // live EQ response overlay
    vx.beginPath();
    for(let k=0;k<NPTS;k++){
      const x=x0+k/(NPTS-1)*iw, y=base-ah*(0.5+clamp(curve[k],-18,18)/36);
      if(k===0) vx.moveTo(x,y); else vx.lineTo(x,y);
    }
    vx.setLineDash([3,3]); vx.strokeStyle='rgba(255,255,255,.45)'; vx.lineWidth=1.2; vx.stroke(); vx.setLineDash([]);
  }
  vx.textAlign='left'; vx.fillStyle='rgba('+T.rgb+',.7)'; vx.font='700 9px -apple-system,system-ui,sans-serif';
  vx.fillText(prefs.viz==='scope'?'SCOPE':'SPECTRUM',x0+2,VTOP+9);
}
function updateBandLevels(now,dt){
  const binHz=ac.sampleRate/an.fftSize, n=fbuf.length;
  for(let i=0;i<NB;i++){
    const lo=Math.max(0,Math.floor(BANDS[i]/1.41/binHz)), hi=Math.min(n-1,Math.max(lo+1,Math.ceil(BANDS[i]*1.41/binHz)));
    let m=0; for(let b=lo;b<=hi;b++) if(fbuf[b]>m) m=fbuf[b];
    const v=m/255;
    if(v>bsm[i]) bsm[i]+=(v-bsm[i])*0.7; else bsm[i]=Math.max(v,bsm[i]-dt*1.5);
    if(bsm[i]>=bpk[i]){ bpk[i]=bsm[i]; bpkT[i]=now+500; } else if(now>bpkT[i]) bpk[i]=Math.max(bsm[i],bpk[i]-dt*0.8);
    const c=cols[i]; if(!c) continue;
    c.lv.style.transform='scaleY('+bsm[i].toFixed(3)+')';
    c.pk.style.bottom=(bpk[i]*98).toFixed(1)+'%';
  }
}
function frame(now){
  requestAnimationFrame(frame);
  now=now||performance.now();
  const live=!isPausedNow()||now<liveUntil||vizDirty;   // fully idle when paused and settled: no canvas work
  if(!live){ lastRaf=now; return; }
  const dt=Math.min(0.1,(now-lastRaf)/1000||0.016); lastRaf=now;
  vizDirty=false;
  const cl=stage.classList;
  if(cl.contains('t-eq')||cl.contains('eq-sheet')){
    an.getByteFrequencyData(fbuf);
    updateMeter(now,dt); drawViz(now,dt); updateBandLevels(now,dt);
  }
  if(!isPausedNow()) drawWave(now); if(lyr.open) lyrTick();
}

/*TAGS-START*/
/* ---------- ID3 tag reader (v2.2 / v2.3 / v2.4, plus v1 fallback) ---------- */
function unsync(buf){
  const out=new Uint8Array(buf.length); let j=0;
  for(let i=0;i<buf.length;i++){ out[j++]=buf[i]; if(buf[i]===0xFF&&buf[i+1]===0x00) i++; }
  return out.subarray(0,j);
}
const syncsafe=(b,o)=>((b[o]&0x7f)<<21)|((b[o+1]&0x7f)<<14)|((b[o+2]&0x7f)<<7)|(b[o+3]&0x7f);
const u32=(b,o)=>((b[o]*16777216)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3]);
const ascii=(b,o,n)=>{let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(b[o+i]);return s;};
function decodeText(bytes,enc){
  try{
    let d;
    if(enc===1){
      if(bytes[0]===0xFF&&bytes[1]===0xFE) d=new TextDecoder('utf-16le').decode(bytes.subarray(2));
      else if(bytes[0]===0xFE&&bytes[1]===0xFF) d=new TextDecoder('utf-16be').decode(bytes.subarray(2));
      else d=new TextDecoder('utf-16le').decode(bytes);
    }
    else if(enc===2) d=new TextDecoder('utf-16be').decode(bytes);
    else if(enc===3) d=new TextDecoder('utf-8').decode(bytes);
    else d=new TextDecoder('iso-8859-1').decode(bytes);
    return d.split('\u0000').map(s=>s.trim()).filter(Boolean)[0]||'';
  }catch(e){return '';}
}
function sniffImage(b){
  if(b.length>3&&b[0]===0xFF&&b[1]===0xD8) return 'image/jpeg';
  if(b.length>7&&b[0]===0x89&&b[1]===0x50&&b[2]===0x4E&&b[3]===0x47) return 'image/png';
  if(b.length>3&&b[0]===0x47&&b[1]===0x49&&b[2]===0x46) return 'image/gif';
  return '';
}
function parseApic(d,ver,out){
  // d = frame data. v2.2 'PIC': enc, 3-byte format, type, desc, data. v2.3/2.4 'APIC': enc, mime\0, type, desc, data
  const enc=d[0]; let p=1;
  if(ver===2){ p+=3; } else { while(p<d.length&&d[p]!==0) p++; p++; }
  const picType=d[p++];
  if(enc===1||enc===2){ while(p+1<d.length&&!(d[p]===0&&d[p+1]===0)) p+=2; p+=2; }
  else { while(p<d.length&&d[p]!==0) p++; p++; }
  if(p>=d.length) return;
  const img=d.subarray(p);
  const mime=sniffImage(img);
  if(!mime||img.length>3*1024*1024) return;
  if(!out.cover||picType===3){ out.cover={type:mime,buf:img.slice().buffer}; out._coverFront=picType===3; }
}
function parseFrames(buf,ver,flags,out){
  let pos=0;
  if(ver>=3&&(flags&0x40)){ // extended header
    pos=ver===4?syncsafe(buf,0):u32(buf,0)+4;
  }
  const hdr=ver===2?6:10, idLen=ver===2?3:4;
  while(pos+hdr<=buf.length){
    if(buf[pos]===0) break;
    const id=ascii(buf,pos,idLen);
    let size;
    if(ver===2) size=(buf[pos+3]<<16)|(buf[pos+4]<<8)|buf[pos+5];
    else if(ver===4) size=syncsafe(buf,pos+4);
    else size=u32(buf,pos+4);
    const f1=ver>=3?buf[pos+8]:0, f2=ver>=3?buf[pos+9]:0;
    if(size<=0||pos+hdr+size>buf.length) break;
    let d=buf.subarray(pos+hdr,pos+hdr+size);
    pos+=hdr+size;
    if(ver===3&&(f2&0xC0)) continue;            // compressed / encrypted
    if(ver===4){ if(f2&0x0C) continue; if(f2&0x02) d=unsync(d); if(f2&0x01) d=d.subarray(4); }
    if(!d.length) continue;
    if(id==='TIT2'||id==='TT2'){ if(!out.title) out.title=decodeText(d.subarray(1),d[0]); }
    else if(id==='TPE1'||id==='TP1'){ if(!out.artist) out.artist=decodeText(d.subarray(1),d[0]); }
    else if(id==='TALB'||id==='TAL'){ if(!out.album) out.album=decodeText(d.subarray(1),d[0]); }
    else if(id==='APIC'||id==='PIC'){ try{ parseApic(d,ver===2?2:ver,out); }catch(e){} }
  }
}
async function readTags(file){
  const out={title:'',artist:'',album:'',cover:null};
  try{
    const head=new Uint8Array(await file.slice(0,10).arrayBuffer());
    if(head[0]===0x49&&head[1]===0x44&&head[2]===0x33&&head[3]>=2&&head[3]<=4){
      const ver=head[3], flags=head[5];
      const size=syncsafe(head,6);
      let buf=new Uint8Array(await file.slice(10,10+Math.min(size,12*1024*1024)).arrayBuffer());
      if((flags&0x80)&&ver<4) buf=unsync(buf);
      parseFrames(buf,ver,flags,out);
    }
  }catch(e){}
  if(!out.title&&!out.artist){
    try{
      if(file.size>128){
        const t=new Uint8Array(await file.slice(file.size-128).arrayBuffer());
        if(t[0]===0x54&&t[1]===0x41&&t[2]===0x47){
          const lat=(a,b)=>new TextDecoder('iso-8859-1').decode(t.subarray(a,b)).replace(/\u0000.*$/,'').trim();
          out.title=lat(3,33); out.artist=lat(33,63); out.album=lat(63,93);
        }
      }
    }catch(e){}
  }
  delete out._coverFront;
  return out;
}
/*TAGS-END*/

/* ---------- library storage: IndexedDB (falls back to memory if unavailable) ----------
   tracks : small metadata records (loaded at start-up)
   blobs  : the audio bytes (read lazily, one song at a time, when played)
   covers : embedded artwork (read lazily when a song is shown) */
const store=(function(){
  let db=null, mem=null;
  function open(){
    return new Promise((res,rej)=>{
      if(!window.indexedDB) return rej(new Error('no idb'));
      let r; try{ r=indexedDB.open('eqplayer',1); }catch(e){ return rej(e); }
      r.onupgradeneeded=()=>{const d=r.result;
        d.createObjectStore('tracks',{keyPath:'id',autoIncrement:true});
        d.createObjectStore('blobs'); d.createObjectStore('covers');};
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); r.onblocked=()=>rej(new Error('blocked'));
    });
  }
  const getReq=(st,key)=>new Promise((res,rej)=>{const q=db.transaction(st).objectStore(st).get(key);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
  const allReq=st=>new Promise((res,rej)=>{const q=db.transaction(st).objectStore(st).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
  const txDone=t=>new Promise((res,rej)=>{t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('aborted'));});
  return {
    async init(){
      try{ db=await open(); db.onversionchange=()=>{db.close();}; this.persistent=true; }
      catch(e){ db=null; mem={tracks:new Map(),blobs:new Map(),covers:new Map(),seq:1}; this.persistent=false; }
    },
    persistent:false,
    async all(){
      if(!db) return [...mem.tracks.values()].sort((a,b)=>a.id-b.id);
      return (await allReq('tracks')).sort((a,b)=>a.id-b.id);
    },
    async add(rec,buf,cover){
      if(!db){ const id=mem.seq++; mem.tracks.set(id,{...rec,id}); mem.blobs.set(id,buf); if(cover) mem.covers.set(id,cover); return id; }
      const t=db.transaction(['tracks','blobs','covers'],'readwrite');
      const done=txDone(t);
      done.catch(()=>{}); // the awaited path below reports the failure; avoids an unhandled rejection
      const id=await new Promise((res,rej)=>{
        const q=t.objectStore('tracks').add(rec);
        q.onsuccess=()=>{ const k=q.result; if(buf) t.objectStore('blobs').put(buf,k); if(cover) t.objectStore('covers').put(cover,k); res(k); };
        q.onerror=()=>rej(q.error);
      });
      await done; return id;
    },
    async blob(id){ return db?getReq('blobs',id):mem.blobs.get(id); },
    async cover(id){ return db?getReq('covers',id):mem.covers.get(id); },
    async del(id){
      if(!db){ mem.tracks.delete(id); mem.blobs.delete(id); mem.covers.delete(id); return; }
      const t=db.transaction(['tracks','blobs','covers'],'readwrite');
      t.objectStore('tracks').delete(id); t.objectStore('blobs').delete(id); t.objectStore('covers').delete(id);
      await txDone(t);
    },
    async clear(){
      if(!db){ mem.tracks.clear(); mem.blobs.clear(); mem.covers.clear(); return; }
      const t=db.transaction(['tracks','blobs','covers'],'readwrite');
      t.objectStore('tracks').clear(); t.objectStore('blobs').clear(); t.objectStore('covers').clear();
      await txDone(t);
    }
  };
})();

/* ---------- player state ---------- */
let lib=[], queue=[], curId=null, srcId=null, curUrl=null, coverUrl=null, loadToken=0, pendingPos=0;
let filter='', seeking=false, busyAdding=false;
const playBtn=$('#play'), listEl=$('#list');
const isAudio=f=>/audio|mpeg|mp3/i.test(f.type)||/\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(f.name);
const byId=id=>lib.find(t=>t.id===id);
const libIds=[];
let libTab='songs', libGroup=null, searchIds=[], qsrc='all';
const searchEl=$('#slist');
function viewList(){ return lib; }
function syncQueue(){ if(qsrc==='all') queue=lib.map(t=>t.id); }
const seek=$('#seek'), vol=$('#vol');
const fillR=el=>{ const mn=+el.min||0, mx=+el.max||100; el.style.setProperty('--p',((+el.value-mn)/(mx-mn)*100).toFixed(1)+'%'); };
const setSeek=v=>{ seek.value=v; drawWave(); };

/* ---- timeline scrubber (thumb-less; 4px at rest, 9px while touched) ---- */
const scrub=$('#scrub'), scrubFill=$('#scrubFill'), curEl=$('#cur'), durEl=$('#dur');
let wdrag=false, lastDurTxt='', lastNowAttr=-1;
const WN=240, waveCache={};                                   // waveform peaks are no longer drawn
function seedWave(){} function useWave(){} async function loadWave(){}
function drawWave(){
  const dur=nowDur(), t=nowTime();
  const frac=wdrag?seek.value/1000:(dur>0?clamp(t/dur,0,1):0);
  scrubFill.style.width=(frac*100).toFixed(2)+'%';
  const cur=wdrag?frac*dur:t;
  const txt=dur>0?'-'+fmtTime(Math.max(0,dur-cur)):'0:00';
  if(txt!==lastDurTxt){ lastDurTxt=txt; durEl.textContent=txt; }
  const sec=Math.floor(cur);
  if(sec!==lastNowAttr){
    lastNowAttr=sec;
    scrub.setAttribute('aria-valuemax',String(Math.round(dur)||0));
    scrub.setAttribute('aria-valuenow',String(sec));
    scrub.setAttribute('aria-valuetext',fmtTime(cur)+(dur>0?' of '+fmtTime(dur):''));
  }
}
const wfrac=e=>{ const r=scrub.getBoundingClientRect(); return clamp((e.clientX-r.left)/Math.max(1,r.width),0,1); };
function wmove(e){ const f=wfrac(e); seek.value=Math.round(f*1000); if(nowDur()) curEl.textContent=fmtTime(f*nowDur()); drawWave(); }
scrub.addEventListener('pointerdown',e=>{ if(!nowDur()) return; e.preventDefault(); wdrag=true; seeking=true; scrub.classList.add('drag'); try{scrub.setPointerCapture(e.pointerId);}catch(_){} wmove(e); });
scrub.addEventListener('pointermove',e=>{ if(wdrag) wmove(e); });
function wend(){ if(!wdrag) return; wdrag=false; scrub.classList.remove('drag'); if(nowDur()) seekTo(seek.value/1000*nowDur()); seeking=false; lyrTick(true); savePos(); drawWave(); }
scrub.addEventListener('pointerup',wend); scrub.addEventListener('pointercancel',wend); scrub.addEventListener('lostpointercapture',wend);
scrub.addEventListener('keydown',e=>{
  const dur=nowDur(); if(!dur) return;
  let t=nowTime(), n=null;
  if(e.key==='ArrowRight'||e.key==='ArrowUp') n=t+5;
  else if(e.key==='ArrowLeft'||e.key==='ArrowDown') n=t-5;
  else if(e.key==='PageUp') n=t+30; else if(e.key==='PageDown') n=t-30;
  else if(e.key==='Home') n=0; else if(e.key==='End') n=dur-1;
  if(n==null) return;
  e.preventDefault(); seekTo(clamp(n,0,dur)); lyrTick(true); drawWave();
});
/* ---- audio badge (MP3 · 44.1kHz · Stereo) read from the first MPEG frame ---- */
function audioFmt(buf,name){
  const ext=((name||'').match(/\.([a-z0-9]+)$/i)||[0,''])[1].toUpperCase()||'AUDIO';
  if(ext!=='MP3') return ext;
  try{
    const b=new Uint8Array(buf); let p=0;
    if(b[0]===0x49&&b[1]===0x44&&b[2]===0x33) p=10+syncsafe(b,6);
    const end=Math.min(b.length-4,p+200000);
    for(let i=p;i<end;i++){
      if(b[i]===0xFF&&(b[i+1]&0xE0)===0xE0){
        const ver=(b[i+1]>>3)&3, lay=(b[i+1]>>1)&3, sr=(b[i+2]>>2)&3;
        if(ver===1||lay===0||sr===3) continue;
        const hz=[[11025,12000,8000],0,[22050,24000,16000],[44100,48000,32000]][ver][sr];
        const br=(ver===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[(b[i+2]>>4)&15];
        if(lay===1&&br) return 'MP3 · '+br+' kbps';
        return 'MP3 · '+(hz/1000)+'kHz · '+(((b[i+3]>>6)&3)===3?'Mono':'Stereo');
      }
    }
  }catch(e){}
  return 'MP3';
}

/* ---- rows ---- */
function trackRow(t,i){
  const d=document.createElement('div'); d.className='track'; d.dataset.id=t.id;
  d.innerHTML='<span class="num"><span class="n"></span><span class="eqb"><i></i><i></i><i></i></span></span><span class="info"><span class="t"></span><span class="a"></span></span><button class="rm" aria-label="Remove song">✕</button>';
  d.querySelector('.n').textContent=i+1;
  d.querySelector('.t').textContent=t.title;
  d.querySelector('.a').textContent=(t.artist||'Unknown artist')+(isStreamTrack(t)?' · '+(SRC_NAME[t.source]||'Streaming'):'');
  return d;
}
const groupKey=(t,kind)=>kind==='albums'?(t.album||'Unknown album'):(t.artist||'Unknown artist');
function updateLibHead(){
  $('#libCrumb').style.display=libGroup!==null?'flex':'none';
  $('#libTitle').textContent=libGroup||'';
}
function renderLibList(){
  listEl.innerHTML=''; libIds.length=0; updateLibHead();
  if(!lib.length){ listEl.innerHTML='<div class="empty">No songs yet.<br>Tap “Add MP3s” — they are saved inside the app.</div>'; return; }
  const frag=document.createDocumentFragment();
  if(libTab==='songs'||libGroup!==null){
    const v=libGroup!==null?lib.filter(t=>groupKey(t,libTab)===libGroup):lib;
    v.forEach((t,i)=>{ libIds.push(t.id); frag.appendChild(trackRow(t,i)); });
  }else{
    const m=new Map();
    lib.forEach(t=>{ const k=groupKey(t,libTab); if(!m.has(k)) m.set(k,[]); m.get(k).push(t); });
    [...m.keys()].sort((a,b)=>a.localeCompare(b)).forEach(k=>{
      const arr=m.get(k), d=document.createElement('div'); d.className='track grp'; d.dataset.g=k;
      d.innerHTML='<span class="num"><span class="gi">♪</span></span><span class="info"><span class="t"></span><span class="a"></span></span><span class="chev">›</span>';
      d.querySelector('.t').textContent=k;
      d.querySelector('.a').textContent=arr.length+' song'+(arr.length>1?'s':'')+(libTab==='albums'&&arr[0].artist?' · '+arr[0].artist:'');
      frag.appendChild(d);
    });
  }
  listEl.appendChild(frag); markCurrent();
}
function renderSearch(){
  const q=filter.trim().toLowerCase(); searchEl.innerHTML=''; searchIds=[];
  if(!q){ searchEl.innerHTML='<div class="empty">Type to search your library</div>'; return; }
  const v=lib.filter(t=>[t.title,t.artist,t.album,t.name].map(x=>x||'').join(' ').toLowerCase().includes(q));
  if(!v.length){ searchEl.innerHTML='<div class="empty">No songs match your search</div>'; return; }
  const frag=document.createDocumentFragment();
  v.forEach((t,i)=>{ searchIds.push(t.id); frag.appendChild(trackRow(t,i)); });
  searchEl.appendChild(frag); markCurrent();
}
function renderList(){ renderLibList(); renderSearch(); }
function setLibTab(t){
  libTab=t; libGroup=null;
  document.querySelectorAll('#libTabs button').forEach(b=>b.classList.toggle('on',b.dataset.lt===t));
  renderLibList(); listEl.scrollTop=0;
}
document.querySelectorAll('#libTabs button').forEach(b=>b.onclick=()=>setLibTab(b.dataset.lt));
$('#libBack').onclick=()=>{ libGroup=null; renderLibList(); listEl.scrollTop=0; };
function markCurrent(){
  const pl=!isPausedNow(); syncPlayState();
  [listEl,searchEl].forEach(el=>{
    el.classList.toggle('playing',pl);
    el.querySelectorAll('.track').forEach(r=>r.classList.toggle('cur',curId!=null&&+r.dataset.id===curId));
  });
}
function scrollToCurrent(){
  const r=listEl.querySelector('.track.cur'); if(!r) return;
  const top=r.offsetTop, bot=top+r.offsetHeight;
  if(top<listEl.scrollTop||bot>listEl.scrollTop+listEl.clientHeight)
    listEl.scrollTo({top:Math.max(0,top-(listEl.clientHeight-r.offsetHeight)/2),behavior:'smooth'});
}
function playFrom(e,ids,src){
  const row=e.target.closest('.track'); if(!row||row.classList.contains('grp')) return;
  const id=+row.dataset.id;
  if(e.target.closest('.rm')){ e.stopPropagation(); askRemove(id); return; }
  const at=performance.now(); ensureUnlocked(); queue=ids.slice(); qsrc=src; ls.set('eqp-queue',null); loadTrack(id,{play:true,at:at});
}
listEl.addEventListener('click',e=>{
  const g=e.target.closest('.grp');
  if(g){ libGroup=g.dataset.g; renderLibList(); listEl.scrollTop=0; return; }
  playFrom(e,libIds,libTab==='songs'&&libGroup===null?'all':'custom');
});
searchEl.addEventListener('click',e=>playFrom(e,searchIds,'custom'));

/* iOS only lets a media element start playing from a tap. Loading a song from the database is
   asynchronous, so the first time we "unlock" the element inside the tap (silently). */
let unlocked=false, unlocking=false;
function silentUrl(){
  const sr=8000,n=sr,b=new ArrayBuffer(44+n*2),v=new DataView(b);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);
  return URL.createObjectURL(new Blob([b],{type:'audio/wav'}));
}
function ensureUnlocked(){
  try{ac.resume();}catch(e){}
  if(unlocked) return;
  unlocked=true; unlocking=true;
  let tmp=null;
  if(!audio.getAttribute('src')){ tmp=silentUrl(); audio.src=tmp; }
  const startSrc=audio.src, pos=audio.currentTime;
  volNode.gain.value=0;
  const done=()=>{
    if(audio.src===startSrc){
      if(!audio.paused) internalPauses++;   // the pause event for this stop arrives later; it is not the user's
      audio.pause();
      if(tmp){ audio.removeAttribute('src'); audio.load(); } else { try{audio.currentTime=pos;}catch(e){} }
    }
    if(tmp) URL.revokeObjectURL(tmp);
    volNode.gain.value=userGain(); unlocking=false;
  };
  let p; try{p=audio.play();}catch(e){}
  if(p&&p.then) p.then(done,done); else done();
}

/* ---- colour-bleed mesh: 3-4 dominant colours from the cover drive the drifting orbs ---- */
const MESH_DEF=['#fa243c','#7a3cff','#ff7a45','#2a64ff'];
function meshSet(c){ const st=document.documentElement.style; for(let i=0;i<4;i++) st.setProperty('--o'+(i+1),c[i]||MESH_DEF[i]); }
function rgb2hsl(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2, d=mx-mn; let h=0,sa=0;
  if(d){ sa=l>.5?d/(2-mx-mn):d/(mx+mn); h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4); h*=60; } return [h,sa,l]; }
let meshTok=0;
function meshFrom(url){
  const tok=++meshTok;
  if(!url){ meshSet(MESH_DEF); return; }
  const img=new Image(); img.crossOrigin='anonymous';
  img.onload=()=>{
    if(tok!==meshTok) return;
    try{
      const c=document.createElement('canvas'); c.width=c.height=32;
      const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(img,0,0,32,32);
      const d=x.getImageData(0,0,32,32).data, bins=Array.from({length:12},()=>({w:0,h:0,s:0,l:0}));
      for(let i=0;i<d.length;i+=4){
        const [h,sa,l]=rgb2hsl(d[i],d[i+1],d[i+2]); if(l<.1||l>.93) continue;
        const w=(.15+sa)*(1-Math.abs(2*l-1)), b=bins[Math.floor(h/30)%12];
        b.w+=w; b.h+=h*w; b.s+=sa*w; b.l+=l*w;
      }
      const top=bins.filter(b=>b.w>0).sort((a,b)=>b.w-a.w).slice(0,4)
        .map(b=>'hsl('+Math.round(b.h/b.w)+','+Math.round(clamp(b.s/b.w,.45,.9)*100)+'%,'+Math.round(clamp(b.l/b.w,.38,.58)*100)+'%)');
      while(top.length<4) top.push(MESH_DEF[top.length]);
      meshSet(top);
    }catch(e){ meshSet(MESH_DEF); }
  };
  img.onerror=()=>{ if(tok===meshTok) meshSet(MESH_DEF); };
  img.src=url;
}
function paintArt(url){
  const v=url?'url("'+url+'")':'';
  ['#art','#art2','#miniArt'].forEach(sel=>{ const el=$(sel); el.style.backgroundImage=v; });
  $('#art').textContent=url?'':'♪';
  $('#miniArt').textContent=url?'':'♪';
  meshFrom(url);
}
function setTitle(el,text){
  el.textContent=text; el.classList.remove('mq'); el.style.removeProperty('--mq');
  requestAnimationFrame(()=>{
    const over=el.scrollWidth-el.clientWidth;
    if(over>2){ const sp=document.createElement('span'); sp.textContent=text; el.textContent=''; el.appendChild(sp); el.style.setProperty('--mq',-(over+12)+'px'); el.classList.add('mq'); }
  });
}
function setCover(c){
  if(coverUrl){URL.revokeObjectURL(coverUrl);coverUrl=null;}
  if(c&&c.buf){ coverUrl=URL.createObjectURL(new Blob([c.buf],{type:c.type||'image/jpeg'})); paintArt(coverUrl); }
  else paintArt(null);
}
function renderNow(t){
  setTitle($('#tTitle'),t?t.title:'No track loaded');
  $('#tTitle2').textContent=t?t.title:''; $('#tArtist2').textContent=t?(t.artist||'Unknown artist'):'';
  $('#miniT').textContent=t?t.title:'Not playing'; $('#miniA').textContent=t?(t.artist||'Unknown artist'):' ';
  $('#tBadge').textContent=t?(t.fmt||''):'';
  $('#tArtist').textContent=t?(t.artist||'Unknown artist'):' ';
  const pos=t?queue.indexOf(t.id):-1;
  $('#tSub').textContent=t?((t.album?t.album+' · ':'')+(pos>=0?'Track '+(pos+1)+' of '+queue.length:'')):'Open Library to add your MP3s';
  if(!t){ setCover(null); curEl.textContent='0:00'; setSeek(0); }
  if(typeof syncFav==='function') syncFav();
  if(typeof qRender==='function') qRender();
}
let pauseAt=0;                      // time of the last ⏸ tap: a play request made before it must not start playback
async function loadTrack(id,opts){
  opts=opts||{}; const t=byId(id); if(!t) return;
  const askedAt=opts.at||performance.now();
  if(opts.play&&pauseAt<=askedAt) wantPlay=true;
  if(isStreamTrack(t)) return loadStreamTrack(t,opts);
  document.body.classList.remove('stream-dsp');
  if(SX.active()) SX.stop();
  const token=++loadToken;
  curId=id; seedWave(id); renderNow(t); markCurrent(); scrollToCurrent(); setCover(null);
  let buf=null;
  try{ buf=await store.blob(id); }catch(e){}
  if(token!==loadToken) return;
  if(!buf){ toast('Could not read this song. Try removing and adding it again.',3500); return; }
  if(!t.fmt) t.fmt=audioFmt(buf,t.name);
  loadWave(id,buf);
  $('#tBadge').textContent=t.fmt;
  const url=URL.createObjectURL(new Blob([buf],{type:t.mime||'audio/mpeg'}));
  const old=curUrl; curUrl=url; pendingPos=opts.pos||0;
  audio.src=url; srcId=id; lyrRequest(t,buf);
  if(old) URL.revokeObjectURL(old);
  setSeek(0); $('#cur').textContent=fmtTime(pendingPos); $('#dur').textContent='0:00';
  if(opts.play&&pauseAt>askedAt){ wantPlay=false; }
  else if(opts.play){
    try{ac.resume();}catch(e){}
    const p=audio.play();
    if(p&&p.catch) p.catch(()=>toast('Tap ▶ to start playback'));
  }
  store.cover(id).then(c=>{ if(token===loadToken){ setCover(c); setMediaSession(t); } }).catch(()=>{});
  setMediaSession(t);
  savePos(true);
}
function setMediaSession(t){
  try{
    if(!('mediaSession' in navigator)) return;
    const md={title:t.title,artist:t.artist||'',album:t.album||''};
    if(coverUrl) md.artwork=[{src:coverUrl,sizes:'512x512'}];
    navigator.mediaSession.metadata=new MediaMetadata(md);
  }catch(e){}
}
function stopCurrent(){
  loadToken++; if(SX.active()) SX.stop(); audio.pause(); audio.removeAttribute('src'); audio.load(); lyrCancel(); lyrSetLines([],false); lyrShow('');
  if(curUrl){URL.revokeObjectURL(curUrl);curUrl=null;}
  curId=null; srcId=null; ls.set('eqp-last',null); renderNow(null); markCurrent();
  if('mediaSession' in navigator){ try{ navigator.mediaSession.metadata=null; }catch(e){} }
}
function nextId(dir){
  if(!queue.length) return null;
  let i=queue.indexOf(curId);
  if(prefs.shuffle&&dir>0&&queue.length>1){ let r; do{r=Math.floor(Math.random()*queue.length);}while(r===i); return queue[r]; }
  if(i<0) i=dir>0?-1:queue.length;
  const n=i+dir;
  if(n<0) return prefs.repeat===1?queue[queue.length-1]:queue[0];
  if(n>=queue.length) return prefs.repeat===1?queue[0]:null;
  return queue[n];
}

/* ---------- adding / removing songs ---------- */
// Files and folders share one handler. A folder pick returns every file below it (sub-folders included);
// only audio is imported, and a .lrc is paired with its MP3 by name anywhere in the same pick.
['files','folderIn'].forEach(id=>{
  const inp=$('#'+id);
  inp.addEventListener('click',()=>{ pickerStart(); ensureUnlocked(); });
  inp.addEventListener('cancel',pickerEnd);
  inp.onchange=async e=>{
    pickerEnd();
    const all=[...e.target.files];
    const files=all.filter(isAudio);
    const lrcMap=new Map(all.filter(f=>/\.lrc$/i.test(f.name)).map(f=>[stemOf(f.name),f]));
    e.target.value='';
    if(!all.length) return;
    if(files.length) await addFiles(files,lrcMap);
    else if(lrcMap.size) toast('Add the matching MP3 together with its .lrc file',3800);
    else toast('No audio files found in that selection',3000);
  };
});
async function addFiles(files,lrcMap){
  if(busyAdding){ toast('Still adding songs…'); return; }
  busyAdding=true;
  files.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  const added=[]; let skipped=0, failed=0, full=false;
  for(let i=0;i<files.length;i++){
    const f=files[i];
    $('#storTxt').textContent='Adding '+(i+1)+' of '+files.length+': '+f.name;
    if(lib.some(t=>t.name===f.name&&t.size===f.size)){ skipped++; continue; }
    try{
      const tags=await readTags(f);
      const buf=await f.arrayBuffer();
      const lf=lrcMap&&lrcMap.get(stemOf(f.name));
      const lrcText=lf?(await lf.text()).slice(0,200000):'';
      const rec={source:'local',lrc:lrcText,name:f.name,title:tags.title||f.name.replace(/\.[^.]+$/,''),artist:tags.artist||'',album:tags.album||'',size:f.size,mime:f.type||'',added:Date.now()};
      const id=await store.add(rec,buf,tags.cover);
      rec.id=id; lib.push(rec); added.push(id);
      if(added.length%4===0){ syncQueue(); renderList(); }
    }catch(err){
      if(err&&(err.name==='QuotaExceededError'||/quota/i.test(String(err.message)))){ full=true; break; }
      failed++;
    }
  }
  busyAdding=false;
  syncQueue(); renderList(); updateStorage();
  try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist(); }catch(e){}
  let msg=added.length?('Added '+added.length+' song'+(added.length>1?'s':'')):'';
  if(skipped) msg+=(msg?' · ':'')+skipped+' already in library';
  if(failed) msg+=(msg?' · ':'')+failed+' could not be saved';
  if(full) msg='Storage is full. Remove some songs and try again.'+(added.length?' ('+added.length+' added)':'');
  if(!store.persistent&&added.length) msg+=(msg?' · ':'')+'Not saved on this device';
  if(msg) toast(msg,3800);
  if(curId==null&&added.length){ loadTrack(added[0],{play:true}); }
}
function askRemove(id){
  const t=byId(id); if(!t) return;
  showModal({title:'Remove song',text:'Remove “'+t.title+'” from the app? Your original file is not touched.',ok:'Remove',danger:true,onOk:async()=>{
    try{ await store.del(id); }catch(e){ toast('Could not remove it'); return; }
    lib=lib.filter(x=>x.id!==id); queue=queue.filter(x=>x!==id); if(favs.delete(id)) ls.set('eqp-favs',[...favs]);
    if(curId===id) stopCurrent();
    syncQueue(); renderList(); updateStorage();
  }});
}
$('#clear').onclick=()=>{
  if(!lib.length){ toast('The library is already empty'); return; }
  if(busyAdding){ toast('Wait for the songs to finish adding'); return; }
  showModal({title:'Clear all songs',text:'Remove all '+lib.length+' songs from the app and free the space? Your original files are not touched.',ok:'Clear all',danger:true,onOk:async()=>{
    try{ await store.clear(); }catch(e){ toast('Could not clear the library'); return; }
    stopCurrent(); lib=[]; queue=[]; qsrc='all'; favs.clear(); ls.set('eqp-favs',[]); renderList(); updateStorage(); toast('Library cleared');
  }});
};
async function updateStorage(){
  const used=lib.reduce((s,t)=>s+(t.size||0),0);
  let txt=lib.length+' song'+(lib.length===1?'':'s')+' · '+fmtMB(used);
  let pct=0;
  try{
    if(navigator.storage&&navigator.storage.estimate){
      const e=await navigator.storage.estimate();
      if(e&&e.quota){ pct=Math.min(100,(e.usage||used)/e.quota*100); txt+=' · ~'+fmtMB(Math.max(0,e.quota-(e.usage||0)))+' free'; }
    }
  }catch(e){}
  if(!store.persistent) txt+=' · not saved';
  if(!busyAdding) $('#storTxt').textContent=txt;
  $('#clear').disabled=!lib.length;
  $('#storBar').style.width=Math.max(used?1.5:0,pct)+'%';
}

/* ---------- transport ---------- */
const ICON={
  play:'<svg class="f" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause:'<svg class="f" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev:'<svg class="f" viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 18V6z"/></svg>',
  next:'<svg class="f" viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM14.5 12 6 6v12z"/></svg>',
  shuf:'<svg class="s" viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  rep:'<svg class="s" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  rep1:'<svg class="s" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10l1.5-1v7" stroke-width="1.8"/></svg>'
};
function savePos(){
  // only save once the element really holds the current song; before that, keep the restored position
  if(curId==null||srcId!==curId) return;
  const pos=audio.readyState>=1?audio.currentTime:pendingPos;
  if(!isFinite(pos)) return;
  ls.set('eqp-last',{id:curId,pos:pos||0});
}
let lastSave=0;
/* ---------- wake-up / recovery (iOS sleeps the audio engine and can drop the song after a long pause) ---------- */
const kick=()=>{ try{ const p=ac.resume(); if(p&&p.catch) p.catch(()=>{}); }catch(e){} };
const elBroken=()=>!audio.getAttribute('src')||!!audio.error;
function lastPos(){ const l=ls.get('eqp-last',null); return audio.currentTime>0?audio.currentTime:(l&&l.id===curId?(l.pos||0):0); }
let wantPlay=false;                 // what the user asked for: true after ▶, false after ⏸
function reloadCurrent(play,why){
  if(curId==null) return;
  if(why) toast(why,2200);
  loadTrack(curId,{play:play&&wantPlay,pos:lastPos()});
}
let wd=null;
function startPlayback(){
  kick();
  wantPlay=true;
  if(elBroken()){ reloadCurrent(true,'Reconnecting the song…'); return; }
  const t0=audio.currentTime;
  const p=audio.play();
  // Tapping ⏸ while play() is pending rejects it with AbortError; that must not restart playback.
  if(p&&p.catch) p.catch(e=>{ if(!wantPlay||(e&&e.name==='AbortError')) return; reloadCurrent(true,'Reconnecting the song…'); });
  clearTimeout(wd);
  wd=setTimeout(()=>{            // watchdog: playing but silent or stuck?
    if(audio.paused||!wantPlay) return;
    if(ac.state!=='running'){ kick(); toast('Audio engine was asleep. Tap ▶ again if it is silent.',3200); }
    else if(audio.currentTime===t0&&audio.readyState<3) reloadCurrent(true,'Reconnecting the song…');
  },1600);
}
function wakeUp(){
  kick();
  if(curId!=null&&!curIsStream()&&audio.paused&&elBroken()) reloadCurrent(false);
}
ac.onstatechange=()=>{            // engine interrupted while "playing": show the real state so one tap on ▶ revives it
  if(ac.state!=='running'&&!audio.paused&&!unlocking){ wantPlay=false; audio.pause(); toast('Audio was interrupted. Tap ▶ to continue.',3000); }
};
window.addEventListener('pageshow',wakeUp); window.addEventListener('focus',wakeUp);
playBtn.onclick=()=>{
  kick();
  if(curIsStream()){ if(SX.active()) SX.toggle(); else SX.play(byId(curId),SX.position()); return; }
  if(curId==null){ if(lib.length){ ensureUnlocked(); queue=viewList().map(t=>t.id); loadTrack(queue[0],{play:true}); } return; }
  if(wantPlay){ wantPlay=false; pauseAt=performance.now(); audio.pause(); }
  else { unlocked=true; startPlayback(); }
};
$('#next').onclick=()=>{ ensureUnlocked(); const n=nextId(1); if(n!=null) loadTrack(n,{play:true}); };
$('#prev').onclick=()=>{
  ensureUnlocked();
  if(nowTime()>3){seekTo(0);return;}
  const n=nextId(-1); if(n!=null) loadTrack(n,{play:true});
};
const shufBtn=$('#shuf'), repBtn=$('#rep');
function syncModes(){ shufBtn.classList.toggle('on',prefs.shuffle); repBtn.classList.toggle('on',prefs.repeat>0); repBtn.innerHTML=prefs.repeat===2?ICON.rep1:ICON.rep; }
shufBtn.onclick=()=>{prefs.shuffle=!prefs.shuffle;savePrefs();syncModes();};
repBtn.onclick=()=>{prefs.repeat=(prefs.repeat+1)%3;savePrefs();syncModes();};
audio.addEventListener('play',()=>{cancelSleepFade();playBtn.innerHTML=ICON.pause;markCurrent();liveUntil=0;vizDirty=true;});
let internalPauses=0;
audio.addEventListener('pause',()=>{ if(internalPauses>0) internalPauses--; else wantPlay=false; playBtn.innerHTML=ICON.play;markCurrent();savePos();liveUntil=performance.now()+4200;});
audio.addEventListener('ended',()=>{
  if(unlocking) return;
  if(repeatOne()) return;
  wantPlay=false;
  const n=nextId(1);
  if(n!=null) loadTrack(n,{play:true});
  else { playBtn.innerHTML=ICON.play; try{audio.currentTime=0;}catch(e){} savePos(); }
});
function repeatOne(){ if(prefs.repeat===2){audio.currentTime=0;audio.play().catch(()=>{});return true;} return false; }
audio.addEventListener('loadedmetadata',()=>{
  drawWave(); lyrTryStart();
  if(pendingPos>0&&isFinite(audio.duration)){ try{audio.currentTime=Math.min(pendingPos,Math.max(0,audio.duration-1));}catch(e){} }
  if(isFinite(audio.duration)) pendingPos=0;
});
audio.addEventListener('timeupdate',()=>{
  if(!seeking){ $('#cur').textContent=fmtTime(audio.currentTime); if(audio.duration) setSeek(Math.round(audio.currentTime/audio.duration*1000)); }
  const now=Date.now(); if(now-lastSave>1500){ lastSave=now; savePos(); }
});
audio.addEventListener('error',()=>{ if(curId!=null&&audio.getAttribute('src')) toast('This file could not be played'); });
vol.value=prefs.vol; fillR(vol);
vol.oninput=()=>{ prefs.vol=+vol.value; if(prefs.muted){ prefs.muted=false; syncMute(); } fillR(vol); savePrefs(); if(SX.active()) SX.setVolume(prefs.vol); volNode.gain.setTargetAtTime(userGain(),ac.currentTime,0.02); };
$('#search').addEventListener('input',e=>{ filter=e.target.value; renderSearch(); });
$('#search').addEventListener('keydown',e=>{ if(e.key==='Enter') e.target.blur(); });
window.addEventListener('pagehide',()=>savePos(true));
document.addEventListener('visibilitychange',()=>{ if(document.hidden) savePos(true); else { checkSleep(); wakeUp(); } });
try{
  if('mediaSession' in navigator){
    navigator.mediaSession.setActionHandler('play',()=>{audio.play().catch(()=>{});});
    navigator.mediaSession.setActionHandler('pause',()=>{ wantPlay=false; audio.pause(); });
    navigator.mediaSession.setActionHandler('previoustrack',()=>$('#prev').click());
    navigator.mediaSession.setActionHandler('nexttrack',()=>$('#next').click());
  }
}catch(e){}

/* ---------- sleep timer ---------- */
let sleepEnd=0, sleepTick=null;
const sleepSel=$('#sleep'), sleepLeft=$('#sleepLeft');
sleepSel.onchange=()=>{
  const m=+sleepSel.value;
  clearInterval(sleepTick); sleepTick=null;
  if(!m){ sleepEnd=0; sleepLeft.textContent=''; return; }
  sleepEnd=Date.now()+m*60000;
  sleepTick=setInterval(checkSleep,1000); checkSleep();
  toast('Playback will stop in '+m+' minutes');
};
let sleepFadeT=0;
function cancelSleepFade(){ if(!sleepFadeT) return; clearTimeout(sleepFadeT); sleepFadeT=0; volNode.gain.cancelScheduledValues(ac.currentTime); volNode.gain.setTargetAtTime(userGain(),ac.currentTime,0.02); }
function checkSleep(){
  if(!sleepEnd) return;
  const left=sleepEnd-Date.now();
  if(left<=0){
    sleepEnd=0; clearInterval(sleepTick); sleepTick=null; sleepSel.value='0'; sleepLeft.textContent=''; syncSleepBtn();
    const t=ac.currentTime; volNode.gain.cancelScheduledValues(t); volNode.gain.setTargetAtTime(0,t,0.7);
    sleepFadeT=setTimeout(()=>{ sleepFadeT=0; audio.pause(); if(SX.active()) SX.pause(); volNode.gain.cancelScheduledValues(ac.currentTime); volNode.gain.setTargetAtTime(userGain(),ac.currentTime,0.02); toast('Sleep timer: stopped'); },2400);
    return;
  }
  const s=Math.ceil(left/1000); sleepLeft.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

function syncSleepBtn(){ $('#sleepBtn').classList.toggle('on',+sleepSel.value>0); }
{ const oc=sleepSel.onchange; sleepSel.onchange=()=>{ cancelSleepFade(); oc(); syncSleepBtn(); }; }
$('#sleepBtn').onclick=()=>{ const o=['0','15','30','60'], i=o.indexOf(sleepSel.value); sleepSel.value=o[(i+1)%o.length]; sleepSel.onchange(); };
const catKey=id=>{ const t=byId(id); return t?(t.album||t.artist||''):''; };
function jumpCat(dir){
  ensureUnlocked(); if(!queue.length) return;
  let i=queue.indexOf(curId); if(i<0) i=0;
  const k=catKey(queue[i]); let j;
  if(dir>0){ j=i+1; while(j<queue.length&&catKey(queue[j])===k) j++; if(j>=queue.length) j=0; }
  else{
    j=i; while(j>=0&&catKey(queue[j])===k) j--;
    if(j<0) j=queue.length-1;
    const k2=catKey(queue[j]); while(j>0&&catKey(queue[j-1])===k2) j--;
  }
  loadTrack(queue[j],{play:true});
}
$('#catPrev').onclick=()=>jumpCat(-1);
$('#catNext').onclick=()=>jumpCat(1);

/* ---------- lyrics + streaming glue (engines live in lyrics/ and streaming/) ---------- */
const SRC_NAME={spotify:'Spotify',apple_music:'Apple Music'};
const isStreamTrack=t=>!!t&&!!t.source&&t.source!=='local';
const curIsStream=()=>isStreamTrack(curId!=null?byId(curId):null);
const stemOf=n=>n.replace(/\.[^.]+$/,'').toLowerCase();
const isPausedNow=()=>curIsStream()?!SX.isPlaying():audio.paused;
const nowTime=()=>curIsStream()?SX.position():(audio.currentTime||0);
const nowDur=()=>curIsStream()?SX.duration():(isFinite(audio.duration)?audio.duration:0);
function seekTo(sec){
  if(curIsStream()){ SX.seek(sec); return; }
  const d=nowDur(); if(d>0) audio.currentTime=clamp(sec,0,d);
}
const SP_=window.StreamingProviders||{
  on(){return ()=>{};},
  status(){return {spotify:{configured:false,connected:false},apple:{configured:false,connected:false}};},
  spotifyLogin(){return Promise.reject(new Error('Streaming is unavailable.'));},
  appleConnect(){return Promise.reject(new Error('Streaming is unavailable.'));},
  handleRedirect(){return Promise.resolve(null);},
  disconnect(){},
  importLibrary(){return Promise.reject(new Error('Streaming is unavailable.'));},
  play(){return Promise.reject(new Error('Streaming is unavailable.'));},
  pause(){}, resume(){}, seek(){}, setVolume(){}, stop(){}
};
const lyrCfg={on:ls.get('eqp-lyrics-on',false)===true, ai:ls.get('eqp-lyrics-ai',false)===true};
let settingsSeen=ls.get('eqp-settings-seen',false)===true;
function markSettingsSeen(){
  if(settingsSeen) return;
  settingsSeen=true; ls.set('eqp-settings-seen',true); $('#setDot').hidden=true;
}

/* ----- lyrics view ----- */
const lyrBtn=$('#lyrBtn'), lyrWrap=$('#lyrWrap'), lyrScroll=$('#lyrScroll'), lyrInner=$('#lyrInner'), lyrMsg=$('#lyrMsg');
const lyr={open:false,id:0,ac:null,req:null,lines:[],synced:false,els:[],idx:-1,cur:null,manual:false};
function lyrShow(msg){ lyrMsg.textContent=msg||''; lyrMsg.hidden=!msg; lyrScroll.hidden=!!msg; }
function lyrSetLines(lines,synced){
  lyr.lines=lines; lyr.synced=synced; lyr.idx=-1;
  // lines with the same timestamp form one block (e.g. original + translation); the first line of the block is the sync target
  lyr.grp=lines.map((l,i)=>(synced&&i>0&&lines[i-1].t===l.t)?null:i);
  for(let i=0;i<lines.length;i++) if(lyr.grp[i]===null) lyr.grp[i]=lyr.grp[i-1];
  const frag=document.createDocumentFragment();
  lyr.els=lines.map((l,i)=>{
    const d=document.createElement('div');
    d.className='lyl'+(synced?'':' plain')+(synced&&lyr.grp[i]!==i?' tr':'');
    d.textContent=l.text||'♪';
    if(synced) d.dataset.i=i;
    frag.appendChild(d);
    return d;
  });
  lyrInner.textContent=''; lyrInner.appendChild(frag);
  lyrScroll.scrollTop=0;
}
function lyrBlur(ans){
  if(!lyr.synced) return;
  const g=ans>=0?lyr.grp[ans]:-1;
  for(let i=0;i<lyr.els.length;i++){
    const d=ans<0?3:Math.abs(lyr.grp[i]-g);
    lyr.els[i].style.filter=d===0?'':'blur('+(d===1?1:2.5)+'px)';
  }
}
function lyrCancel(){ lyr.id++; if(lyr.ac){ lyr.ac.abort(); lyr.ac=null; } lyr.req=null; }
function lyrCenter(el,smooth){
  const top=el.offsetTop-(lyrScroll.clientHeight-el.offsetHeight)/2;
  lyrScroll.scrollTo({top:Math.max(0,top),behavior:smooth?'smooth':'auto'});
}
// Highlights the active line. Runs from the frame loop while playing, so it costs one binary search per frame.
function lyrTick(force){
  if(!lyr.synced||!lyr.lines.length||(!lyr.open&&!force)) return;
  const t=nowTime();
  let lo=0,hi=lyr.lines.length-1,ans=-1;
  while(lo<=hi){ const m=(lo+hi)>>1; if(lyr.lines[m].t<=t){ ans=m; lo=m+1; } else hi=m-1; }
  if(ans>=0) ans=lyr.grp[ans];   // highlight the original line of a same-time block, not the translation after it
  if(ans===lyr.idx&&!force) return;
  if(lyr.els[lyr.idx]) lyr.els[lyr.idx].classList.remove('act');
  lyr.idx=ans;
  if(ans>=0&&lyr.els[ans]){ lyr.els[ans].classList.add('act'); if(!lyr.manual||force) lyrCenter(lyr.els[ans],!force); }
  lyrBlur(ans);
}
function lyrRequest(t,buf){
  lyrCancel(); lyrSetLines([],false); lyr.cur=t;
  if(!lyrCfg.on){ lyrShow(''); return; }
  if(!t){ lyrSetLines([],false); lyrShow('No track loaded'); return; }
  lyr.req={t,buf,id:lyr.id};
  lyrShow('Looking for lyrics…');
  lyrTryStart();
}
// Local files wait for loadedmetadata, because LRCLIB needs the real duration.
function lyrTryStart(){
  const r=lyr.req; if(!r) return;
  const stream=isStreamTrack(r.t);
  const dur=stream?(r.t.duration||0):audio.duration;
  if(!stream&&!(isFinite(dur)&&dur>0)) return;
  lyr.req=null;
  runLyrics(r,dur);
}
async function runLyrics(r,dur){
  const id=r.id, ac=new AbortController();
  lyr.ac=ac;
  let res=null;
  if(window.LyricsEngine){
    try{
      res=await window.LyricsEngine.resolve(r.t,{buffer:r.buf,duration:dur||0,allowAI:lyrCfg.ai,signal:ac.signal,
        onStatus:m=>{ if(id===lyr.id) lyrShow(m); }});
    }catch(e){ res=null; }
  }
  if(id!==lyr.id) return;
  lyr.ac=null;
  if(res&&res.lines&&res.lines.length){ lyrSetLines(res.lines,res.kind==='synced'); lyrShow(''); lyrTick(true); }
  else { lyrSetLines([],false); lyrShow('Lyrics not available'); }
}
function syncLyrUI(){
  const sw=(el,on)=>{ el.setAttribute('aria-checked',on?'true':'false'); el.querySelector('.switch').classList.toggle('on',on); };
  sw($('#lyrTog'),lyrCfg.on); sw($('#lyrAi'),lyrCfg.ai);
  if(!lyrCfg.on) lyr.open=false;
  lyrBtn.classList.toggle('on',lyr.open); lyrBtn.setAttribute('aria-pressed',lyr.open?'true':'false');
  if(!lyr.open) lyrSync.hidden=true;
  lyrWrap.hidden=!lyr.open;
  stage.classList.toggle('lyr-on',lyr.open);
}
function setLyricsOn(on){
  lyrCfg.on=!!on; ls.set('eqp-lyrics-on',lyrCfg.on);
  if(!lyrCfg.on){ lyrCancel(); lyrSetLines([],false); lyrShow(''); }
  syncLyrUI();
  if(lyrCfg.on&&curId!=null){
    const t=byId(curId);
    if(t){
      if(isStreamTrack(t)) lyrRequest(t,null);
      else store.blob(t.id).then(b=>{ if(curId===t.id) lyrRequest(t,b); }).catch(()=>{});
    }
  }
}
const lyrSync=$('#lyrSync');
lyrBtn.onclick=()=>{
  if(!lyrCfg.on){ setLyricsOn(true); lyr.open=true; }
  else lyr.open=!lyr.open;
  lyr.manual=false; syncLyrUI(); if(lyr.open) lyrTick(true);
};
['wheel','touchmove'].forEach(ev=>lyrScroll.addEventListener(ev,()=>{ if(!lyr.synced) return; lyr.manual=true; lyrSync.hidden=false; },{passive:true}));
lyrSync.onclick=()=>{ lyr.manual=false; lyrSync.hidden=true; lyrTick(true); };
$('#lyrTog').onclick=()=>setLyricsOn(!lyrCfg.on);
$('#lyrAi').onclick=()=>{ lyrCfg.ai=!lyrCfg.ai; ls.set('eqp-lyrics-ai',lyrCfg.ai); syncLyrUI(); };
lyrInner.addEventListener('click',e=>{
  const d=e.target.closest('.lyl');
  if(!d||!lyr.synced||d.dataset.i==null) return;
  seekTo(lyr.lines[+d.dataset.i].t);
  lyr.manual=false; lyrSync.hidden=true; lyrTick(true);
});

/* ----- streaming: settings UI, import, and playback adapter ----- */
function syncStreamUI(){
  const s=SP_.status();
  $('#spS').textContent=!s.spotify.configured?'Enter the client ID below':s.spotify.connected?'Connected · tap to sign out':'Not connected';
  $('#amS').textContent=!s.apple.configured?'Enter the token below':s.apple.connected?'Connected · tap to sign out':'Not connected';
  // aria-disabled instead of disabled, so a tap still gives feedback
  [['#spImp',s.spotify.connected,'Connect Spotify first'],['#amImp',s.apple.connected,'Connect Apple Music first']].forEach(([sel,ok,msg])=>{
    const b=$(sel); b.classList.toggle('off',!ok); b.setAttribute('aria-disabled',ok?'false':'true'); b.dataset.hint=msg;
  });
}
function askDisconnect(p){
  const name=p==='spotify'?'Spotify':'Apple Music';
  showModal({title:'Sign out of '+name,text:'Imported '+name+' tracks stay in your library, but you will need to sign in again to play them.',ok:'Sign out',danger:true,onOk:()=>{ SP_.disconnect(p); syncStreamUI(); toast(name+' signed out'); }});
}
$('#spBtn').onclick=()=>{
  if(SP_.status().spotify.connected) askDisconnect('spotify');
  else SP_.spotifyLogin().catch(e=>toast(e.message||'Could not start Spotify sign-in',4200));
};
$('#amBtn').onclick=()=>{
  if(SP_.status().apple.connected) askDisconnect('apple');
  else SP_.appleConnect().then(()=>{ syncStreamUI(); toast('Apple Music connected'); }).catch(e=>toast(e.message||'Apple Music sign-in failed',4200));
};
async function addStreamRecords(recs){
  let added=0, dup=0;
  for(const r of recs){
    if(lib.some(x=>x.source===r.source&&x.ext===r.ext)){ dup++; continue; }
    try{ r.id=await store.add(r,null,null); lib.push(r); added++; }catch(e){ break; }
  }
  syncQueue(); renderList(); updateStorage();
  return {added,dup};
}
async function streamImport(p){
  const btn=p==='spotify'?$('#spImp'):$('#amImp');
  btn.disabled=true;
  try{
    const r=await SP_.importLibrary(p,{onProgress:m=>toast(m,1600)});
    const res=await addStreamRecords(r.records);
    toast('Imported '+res.added+' track'+(res.added===1?'':'s')+(res.dup?' · '+res.dup+' already here':'')+(r.skipped?' · '+r.skipped+' playlist'+(r.skipped===1?'':'s')+' skipped':''),4800);
  }catch(e){ toast(e.message||'Import failed',4200); }
  finally{ syncStreamUI(); }
}
$('#spImp').onclick=()=>{ if($('#spImp').classList.contains('off')) return toast($('#spImp').dataset.hint||'Connect first',2400); streamImport('spotify'); };
$('#amImp').onclick=()=>{ if($('#amImp').classList.contains('off')) return toast($('#amImp').dataset.hint||'Connect first',2400); streamImport('apple'); };
function handleStreamRedirect(){
  SP_.handleRedirect()
    .then(r=>{ if(r) toast(r.msg,3200); syncStreamUI(); })
    .catch(e=>{ toast(e.message||'Sign-in failed',4200); syncStreamUI(); });
}

// Adapter: keeps the position and play state of the streamed track. Transport buttons use this when a streamed track is loaded.
const SX=(function(){
  let cur=null, playing=false, pos=0, dur=0, ts=0;
  const nowPos=()=>playing?pos+(Date.now()-ts)/1000:pos;
  function freeze(){ pos=nowPos(); ts=Date.now(); }
  function endStream(){
    cur=null; playing=false;
    const next=nextId(1);
    if(next!=null) loadTrack(next,{play:true});
    else { playBtn.innerHTML=ICON.play; markCurrent(); }
  }
  SP_.on('state',s=>{
    if(!cur||s.source!==cur.source) return;
    const key=cur.uri||cur.ext;
    if(s.uri&&key&&s.uri!==key) return;
    if(s.ended){ endStream(); return; }
    const was=playing;
    playing=!s.paused; pos=s.position||0; ts=s.ts||Date.now();
    if(s.duration) dur=s.duration;
    if(was!==playing){ playBtn.innerHTML=playing?ICON.pause:ICON.play; markCurrent(); }
    if(lyr.open) lyrTick(true);
  });
  SP_.on('error',e=>{
    playing=false; playBtn.innerHTML=ICON.play; markCurrent();
    toast(e.message||'Streaming error',4200);
  });
  function doPause(){
    if(!cur||!playing) return;
    freeze(); playing=false; playBtn.innerHTML=ICON.play;
    SP_.pause(cur.source); markCurrent();
  }
  function doResume(){
    if(!cur||playing) return;
    ts=Date.now(); playing=true; playBtn.innerHTML=ICON.pause;
    SP_.resume(cur.source); markCurrent();
  }
  return {
    active:()=>!!cur,
    isPlaying:()=>!!cur&&playing,
    position:()=>cur?nowPos():0,
    duration:()=>dur,
    prime(t,sec){ cur=t; playing=false; pos=sec||0; ts=Date.now(); dur=t.duration||0; },
    async play(t,sec){
      cur=t; playing=false; pos=sec||0; ts=Date.now(); dur=t.duration||0;
      try{ await SP_.play(t,sec||0); }
      catch(e){ playing=false; playBtn.innerHTML=ICON.play; markCurrent(); toast(e.message||'Could not play this track',4200); }
    },
    toggle(){ if(playing) doPause(); else doResume(); },
    pause:doPause,
    seek(sec){ pos=sec; ts=Date.now(); if(cur) SP_.seek(cur.source,sec); },
    setVolume(v){ SP_.setVolume(v); },
    stop(){ if(cur) SP_.stop(cur.source); cur=null; playing=false; pos=0; dur=0; }
  };
})();

async function loadStreamTrack(t,opts){
  if(SX.active()) SX.stop();
  loadToken++;
  audio.pause(); audio.removeAttribute('src'); audio.load(); srcId=null;
  if(curUrl){ URL.revokeObjectURL(curUrl); curUrl=null; }
  curId=t.id; seedWave(t.id); renderNow(t); markCurrent(); scrollToCurrent();
  document.body.classList.add('stream-dsp');
  setCover(null);
  if(t.art) paintArt(t.art);
  $('#tSub').textContent+=' · EQ bypassed';
  $('#tBadge').textContent=t.fmt||SRC_NAME[t.source]||'';
  setMediaSession(t);
  lyrRequest(t,null);
  if(opts.play) await SX.play(t,opts.pos||0);
  else SX.prime(t,opts.pos||0);
  playBtn.innerHTML=SX.isPlaying()?ICON.pause:ICON.play;
}

/* ---------- Apple Music shell: MiniPlayer, Now Playing sheet, EQ sheet, Up Next, favourites ---------- */
const npEl=$('#sPlayer'), miniEl=$('#mini'), miniPlay=$('#miniPlay'), qSheet=$('#qSheet'), qList=$('#qList');
const favBtn=$('#favBtn'), moreBtn=$('#moreBtn'), morePop=$('#morePop');
const favs=new Set(ls.get('eqp-favs',[]));
function syncPlayState(){
  stage.classList.toggle('paused',isPausedNow()||curId==null);
  document.body.classList.toggle('idle',isPausedNow()||curId==null);
  miniPlay.innerHTML=playBtn.innerHTML;
}
new MutationObserver(syncPlayState).observe(playBtn,{childList:true,subtree:true});
$('#miniNext').innerHTML=ICON.next;
miniPlay.onclick=e=>{ e.stopPropagation(); playBtn.click(); };
$('#miniNext').onclick=e=>{ e.stopPropagation(); $('#next').click(); };

/* open / close the Now Playing sheet (450ms, cubic-bezier(.32,.72,0,1)) */
function openNP(){
  stage.classList.add('np-open'); npEl.setAttribute('aria-hidden','false'); vizDirty=true;
  setTimeout(()=>{ drawWave(); if(lyr.open) lyrTick(true); },80);
}
function closeNP(){
  if(!stage.classList.contains('np-open')) return;
  if(npEl.contains(document.activeElement)) document.activeElement.blur();
  stage.classList.remove('np-open'); npEl.setAttribute('aria-hidden','true'); closeMore(); closeEqSheet(true); closeQueue();
}
(function(){
  // mini player: tap, Enter/Space, or swipe up
  let y0=null, moved=false;
  miniEl.addEventListener('pointerdown',e=>{ y0=e.clientY; moved=false; });
  miniEl.addEventListener('pointermove',e=>{ if(y0!=null&&y0-e.clientY>26&&!moved){ moved=true; openNP(); } });
  miniEl.addEventListener('pointerup',()=>{ y0=null; });
  miniEl.addEventListener('pointercancel',()=>{ y0=null; });
  miniEl.addEventListener('click',e=>{ if(e.target.closest('button')||moved){ moved=false; return; } openNP(); });
  miniEl.querySelector('#miniArt').addEventListener('click',()=>openNP());
  miniEl.querySelector('.mi').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openNP(); } });
  // grabber: tap or drag down to collapse
  const g=$('#grab'); let sy=null, dy=0;
  g.addEventListener('pointerdown',e=>{ sy=e.clientY; dy=0; npEl.style.transition='none'; try{g.setPointerCapture(e.pointerId);}catch(_){} });
  g.addEventListener('pointermove',e=>{ if(sy==null) return; dy=Math.max(0,e.clientY-sy); npEl.style.transform='translateY('+dy+'px)'; });
  const end=()=>{
    if(sy==null) return; const d=dy; sy=null; dy=0;
    npEl.style.transition=''; npEl.style.transform='';
    if(d>110||d<4) closeNP();
  };
  g.addEventListener('pointerup',end); g.addEventListener('pointercancel',end);
  g.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); closeNP(); } });
})();

/* favourites (tiny list in localStorage) */
function syncFav(){
  const on=curId!=null&&favs.has(curId);
  const none=curId==null; favBtn.disabled=none; ['catPrev','catNext','rmCur'].forEach(i=>{ $('#'+i).disabled=none; });
  favBtn.classList.toggle('on',on); favBtn.setAttribute('aria-pressed',on?'true':'false');
  favBtn.querySelector('svg').style.fill=on?'currentColor':'none';
}
favBtn.onclick=()=>{ if(curId==null) return; if(favs.has(curId)) favs.delete(curId); else favs.add(curId); ls.set('eqp-favs',[...favs]); syncFav(); };

/* ••• menu */
function closeMore(){ morePop.hidden=true; moreBtn.setAttribute('aria-expanded','false'); }
moreBtn.onclick=e=>{
  e.stopPropagation();
  if(!morePop.hidden){ closeMore(); return; }
  const r=moreBtn.getBoundingClientRect();
  morePop.hidden=false; moreBtn.setAttribute('aria-expanded','true');
  morePop.style.top=Math.min(window.innerHeight-morePop.offsetHeight-12,r.bottom+8)+'px';
  morePop.style.right=Math.max(12,window.innerWidth-r.right)+'px';
};
document.addEventListener('pointerdown',e=>{ if(!morePop.hidden&&!e.target.closest('#morePop,#moreBtn')) closeMore(); });
morePop.addEventListener('click',e=>{ if(e.target.closest('#sleepBtn')) return; closeMore(); });
$('#rmCur').onclick=()=>{ if(curId!=null) askRemove(curId); };

/* Audio & EQ sheet: the EQ & DSP screen as a Liquid Glass sheet over Now Playing */
let eqSheetT=0;
let eqFromNP=false;
function openEqSheet(){
  clearTimeout(eqSheetT);
  eqFromNP=stage.classList.contains('np-open');
  stage.classList.add('eq-sheet'); vizDirty=true;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ stage.classList.add('eq-in'); sizeViz(); setTimeout(sizeViz,460); }));
}
function closeEqSheet(instant){
  if(!stage.classList.contains('eq-sheet')) return;
  stage.classList.remove('eq-in');
  clearTimeout(eqSheetT);
  // closing the EQ sheet never leaves Now Playing: if it was opened from the player, the player stays open
  if(eqFromNP) stage.classList.add('np-open');
  if(instant){ stage.classList.remove('eq-sheet'); return; }
  eqSheetT=setTimeout(()=>stage.classList.remove('eq-sheet'),460);
}
/* pull the EQ sheet down by its header to close it */
(function(){
  const el=$('#sEq'); let sy=null, sx=0, dy=0, drag=false;
  // a downward drag from the top of the sheet (header, grabber or the buttons above the controls) closes it
  el.addEventListener('pointerdown',e=>{
    if(e.target.closest('input,select,canvas,.bt,.pill')||el.scrollTop>0) return;
    if(e.clientY-el.getBoundingClientRect().top>150) return;
    sy=e.clientY; sx=e.clientX; dy=0; drag=false;
  });
  el.addEventListener('pointermove',e=>{
    if(sy==null) return;
    const d=e.clientY-sy;
    if(!drag){ if(d<12) return; if(Math.abs(e.clientX-sx)>d) { sy=null; return; } drag=true; el.style.transition='none'; try{el.setPointerCapture(e.pointerId);}catch(_){} }
    dy=Math.max(0,d); el.style.transform='translateY('+dy+'px)';
  });
  const end=()=>{ if(sy==null&&!drag) return; const d=dy, was=drag; sy=null; dy=0; drag=false; el.style.transition=''; el.style.transform=''; if(was&&d>90) closeEqSheet(); };
  el.addEventListener('pointerup',end); el.addEventListener('pointercancel',end);
})();
$('#npClose').onclick=closeNP;
$('#eqBtn').onclick=openEqSheet;
$('#eqDone').onclick=()=>closeEqSheet();

/* Up Next: shuffle, repeat, drag-to-reorder, swipe-to-remove */
const saveQueue=()=>{ qsrc='custom'; ls.set('eqp-queue',queue.slice()); };
function qRender(){
  if(!qSheet.classList.contains('show')) return;
  const cur=queue.indexOf(curId);
  $('#qNote').textContent=prefs.shuffle?'Shuffle is on: the next song is picked at random.':(queue.length?queue.length+' songs in the queue':'The queue is empty.');
  const frag=document.createDocumentFragment();
  queue.forEach((id,i)=>{
    const t=byId(id); if(!t) return;
    const row=document.createElement('div'); row.className='qrow'+(i===cur?' qnow':i<cur?' qpast':''); row.dataset.i=i;
    row.innerHTML='<div class="qdel" aria-hidden="true">Remove</div><div class="qfg"><div class="qi"><div class="qt"></div><div class="qa"></div></div><button class="qx" aria-label="Remove from queue">✕</button><div class="qh" role="button" tabindex="0" aria-label="Drag to reorder"><svg class="s" viewBox="0 0 24 24"><path d="M5 8h14M5 12h14M5 16h14"/></svg></div></div>';
    row.querySelector('.qt').textContent=t.title;
    row.querySelector('.qa').textContent=(t.artist||'Unknown artist')+(i===cur?' · Playing':'');
    frag.appendChild(row);
  });
  qList.textContent=''; qList.appendChild(frag);
  if(!queue.length) qList.innerHTML='<div class="empty">Nothing queued</div>';
}
function qRemoveAt(i){
  const id=queue[i]; queue.splice(i,1); saveQueue();
  if(id===curId){ /* the song keeps playing; it just leaves the queue */ }
  qRender(); renderNowTrackNo();
}
function renderNowTrackNo(){ const t=curId!=null?byId(curId):null; if(t){ const pos=queue.indexOf(t.id); $('#tSub').textContent=(t.album?t.album+' · ':'')+(pos>=0?'Track '+(pos+1)+' of '+queue.length:''); } }
function openQueue(){ qSheet.classList.add('show'); qSheet.setAttribute('aria-hidden','false'); qRender(); const n=qList.querySelector('.qnow'); if(n) setTimeout(()=>n.scrollIntoView({block:'center'}),60); }
function closeQueue(){ qSheet.classList.remove('show'); qSheet.setAttribute('aria-hidden','true'); }
$('#qBtn').onclick=openQueue; $('#qDone').onclick=closeQueue;
(function(){
  // grabber drag-down closes the sheet
  const g=$('#qGrab'); let sy=null, dy=0;
  g.addEventListener('pointerdown',e=>{ sy=e.clientY; dy=0; qSheet.style.transition='none'; try{g.setPointerCapture(e.pointerId);}catch(_){} });
  g.addEventListener('pointermove',e=>{ if(sy==null) return; dy=Math.max(0,e.clientY-sy); qSheet.style.transform='translateY('+dy+'px)'; });
  const end=()=>{ if(sy==null) return; const d=dy; sy=null; dy=0; qSheet.style.transition=''; qSheet.style.transform=''; if(d>100) closeQueue(); };
  g.addEventListener('pointerup',end); g.addEventListener('pointercancel',end);

  // row interactions (event delegation)
  let mode=null, row=null, x0=0, y0=0, top0=0, rowH=56, idx0=0;
  qList.addEventListener('click',e=>{
    const x=e.target.closest('.qx'); if(x){ qRemoveAt(+x.closest('.qrow').dataset.i); return; }
    const r=e.target.closest('.qrow'); if(!r||e.target.closest('.qh')||r.dataset.swiped) return;
    ensureUnlocked(); loadTrack(queue[+r.dataset.i],{play:true});
  });
  qList.addEventListener('pointerdown',e=>{
    const r=e.target.closest('.qrow'); if(!r) return;
    row=r; x0=e.clientX; y0=e.clientY; idx0=+r.dataset.i; rowH=r.offsetHeight||56; delete r.dataset.swiped;
    if(e.target.closest('.qh')){ mode='drag'; e.preventDefault(); try{qList.setPointerCapture(e.pointerId);}catch(_){} r.classList.add('drag'); }
    else mode='pending';
  });
  qList.addEventListener('pointermove',e=>{
    if(!row) return;
    const dx=e.clientX-x0, dy=e.clientY-y0;
    if(mode==='pending'){
      if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)){ mode='swipe'; row.dataset.swiped='1'; try{qList.setPointerCapture(e.pointerId);}catch(_){} }
      else if(Math.abs(dy)>10){ mode=null; row=null; return; }
    }
    if(mode==='swipe') row.querySelector('.qfg').style.transform='translateX('+Math.min(0,dx)+'px)';
    else if(mode==='drag') row.style.transform='translateY('+dy+'px)';
  });
  const finish=e=>{
    if(!row) return;
    const dx=e.clientX-x0, dy=e.clientY-y0, r=row, m=mode; row=null; mode=null;
    if(m==='swipe'){
      const fg=r.querySelector('.qfg');
      if(dx<-100){ fg.style.transform='translateX(-110%)'; const id0=queue[idx0]; setTimeout(()=>{ const i=queue.indexOf(id0); if(i>=0) qRemoveAt(i); },150); }
      else fg.style.transform='';
      setTimeout(()=>{ delete r.dataset.swiped; },60);
    } else if(m==='drag'){
      r.classList.remove('drag'); r.style.transform='';
      const to=clamp(idx0+Math.round(dy/rowH),0,queue.length-1);
      if(to!==idx0){ const [id]=queue.splice(idx0,1); queue.splice(to,0,id); saveQueue(); renderNowTrackNo(); }
      qRender();
    }
  };
  qList.addEventListener('pointerup',finish); qList.addEventListener('pointercancel',finish);
})();
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  if(modal.classList.contains('show')){ hideModal(); return; }
  if($('#themeWrap').classList.contains('show')){ $('#themeWrap').classList.remove('show'); return; }
  if(menuWrap.classList.contains('show')){ closeMenu(); return; }
  if(qSheet.classList.contains('show')) closeQueue();
  else if(!morePop.hidden) closeMore();
  else if(stage.classList.contains('eq-sheet')) closeEqSheet();
  else closeNP();
});

function initShell(){
  const sq=ls.get('eqp-queue',null);
  if(Array.isArray(sq)&&sq.length){ const ok=sq.filter(id=>byId(id)); if(ok.length){ queue=ok; qsrc='custom'; } }
  syncPlayState(); syncFav(); drawWave();
}

/* ---------- output device (Chrome, Edge, Android; iPhone and iPad use AirPlay from Control Center) ---------- */
const outDev=$('#outDev'), outNote=$('#outNote');
const canSink=typeof AudioContext!=='undefined'&&'setSinkId' in AudioContext.prototype;
async function applySink(){
  const id=ls.get('eqp-sink','')||'';
  if(!canSink||!id) return;          // nothing chosen: keep the browser's default device
  try{ await ac.setSinkId(id); }
  catch(e){ toast('Could not switch to that output',3000); ls.set('eqp-sink',''); }
}
async function fillOutputs(){
  if(!canSink){
    $('#outSec').hidden=false; outDev.hidden=true;
    outNote.textContent='Use AirPlay in Control Center to pick the output on iPhone and iPad.';
    return;
  }
  try{
    const devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput');
    const cur=ls.get('eqp-sink','')||'';
    outDev.innerHTML='<option value="">System default</option>'+devs.map((d,i)=>'<option value="'+d.deviceId+'">'+(d.label||'Output '+(i+1))+'</option>').join('');
    outDev.value=devs.some(d=>d.deviceId===cur)?cur:'';
    outNote.textContent='Where the sound plays';
  }catch(e){ outNote.textContent='Outputs unavailable in this browser'; }
}
outDev.onchange=()=>{ ls.set('eqp-sink',outDev.value); applySink(); };
if(navigator.mediaDevices&&navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange',fillOutputs);
const motTog=$('#motTog');
function applyMotion(){
  const on=prefs.motion!==false;
  document.body.classList.toggle('no-motion',!on);
  motTog.setAttribute('aria-checked',on?'true':'false'); motTog.querySelector('.switch').classList.toggle('on',on);
}
motTog.onclick=()=>{ prefs.motion=prefs.motion===false; savePrefs(); applyMotion(); };
function initGlue(){
  applyMotion();
  initShell();
  syncLyrUI();
  syncStreamUI();
  $('#setDot').hidden=settingsSeen;
  handleStreamRedirect();
}

/* ---------- start-up ---------- */
async function init(){
  try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist(); }catch(e){}
  try{ if('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(()=>{}).then(reg=>{ if(!reg) return;
    const offer=w=>{ const b=$('#updBar'); b.hidden=false; b.onclick=()=>{ b.disabled=true; b.textContent='Updating...'; navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true}); w.postMessage('skip'); }; };
    if(reg.waiting&&navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound',()=>{ const w=reg.installing; if(w) w.addEventListener('statechange',()=>{ if(w.state==='installed'&&navigator.serviceWorker.controller) offer(w); }); });
  }); }catch(e){}
  $('#prev').innerHTML=ICON.prev; $('#next').innerHTML=ICON.next; $('#shuf').innerHTML=ICON.shuf; playBtn.innerHTML=ICON.play;
  fillR(seek);
  applyTheme(false); renderPresetSelect(''); buildSliders(); syncModes(); setBypassGains(true); update(); flushUpdate(); initUI(); fit(); applySink(); syncMute();
  requestAnimationFrame(frame);
  await store.init();
  try{ lib=await store.all(); }catch(e){ lib=[]; }
  syncQueue(); renderList(); updateStorage();
  initGlue();
  // restore the last song and position (paused; only this one song is read from storage)
  const last=ls.get('eqp-last',null);
  if(last&&byId(last.id)){ loadTrack(last.id,{play:false,pos:last.pos||0}); }
  else renderNow(null);
}
init();
})();
