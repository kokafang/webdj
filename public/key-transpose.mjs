const NATURAL={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const SHARPS=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const FLATS=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const mod12=value=>((value%12)+12)%12;

// Integer-cent arithmetic prevents repeated 0.01 steps accumulating drift.
export function splitPitch(value){
  if(!Number.isFinite(value)||value < -12||value > 12)throw new RangeError('变调超出范围');
  const total=Math.round(value*100);
  return {semitones:Math.trunc(total/100)||0,cents:total%100||0};
}
export function stepPitch(value,cents){
  splitPitch(value);
  if(!Number.isInteger(cents))throw new RangeError('音分步进必须是整数');
  return Math.max(-1200,Math.min(1200,Math.round(value*100)+cents))/100;
}
export function coarsePitch(value,semitones){
  if(!Number.isInteger(semitones)||Math.abs(semitones)>12)throw new RangeError('半音超出范围');
  return Math.max(-1200,Math.min(1200,semitones*100+splitPitch(value).cents))/100;
}

function transposeOne(key,semitones) {
  const camelot=/^(1[0-2]|[1-9])([AB])$/i.exec(key);
  if(camelot){
    // Camelot positions follow fifths; seven positions equal one semitone.
    // Reference: https://mixedinkey.com/harmonic-mixing-guide/
    return `${mod12(Number(camelot[1])-1+semitones*7)+1}${camelot[2]}`;
  }
  const note=/^([A-G])([#♯b♭]?)(\s*(?:m|maj(?:or)?|min(?:or)?|大调|小调)?)$/i.exec(key);
  if(!note)return null;
  if(mod12(semitones)===0)return key;
  const [,root,accidental,suffix]=note;
  const flat=accidental==='b'||accidental==='♭';
  const pitch=NATURAL[root.toUpperCase()]+(accidental?(flat?-1:1):0);
  let next=(flat?FLATS:SHARPS)[mod12(pitch+semitones)];
  if(accidental==='#')next=next.replace('♯','#');
  if(accidental==='b')next=next.replace('♭','b');
  return next+suffix;
}

// Derive the live key without changing the track's saved original key.
// A slash represents the alternative keys already used in the Crate.
export function transposeKey(key,semitones) {
  if(typeof key!=='string'||!key.trim()||!Number.isInteger(semitones))return null;
  const parts=key.trim().split(/(\s*\/\s*)/);
  for(let i=0;i<parts.length;i+=2){
    const next=transposeOne(parts[i],semitones);
    if(next===null)return null;
    parts[i]=next;
  }
  return parts.join('');
}

const LETTERS=Object.keys(NATURAL);
const ACCIDENTALS={'-2':'𝄫','-1':'♭',0:'',1:'♯',2:'𝄪'};
const CAMELOT={
  A:['G♯m','E♭m','B♭m','Fm','Cm','Gm','Dm','Am','Em','Bm','F♯m','C♯m'],
  B:['B','F♯','D♭','A♭','E♭','B♭','F','C','G','D','A','E'],
};

// Presentation only: saved source notation stays untouched. The relative is
// spelled as a major key's sixth or a minor key's third, not just a pitch class.
export function describeKey(key,semitones=0) {
  const transposed=transposeKey(key,semitones);
  if(transposed===null)return null;
  const result=[];
  for(let part of transposed.split(/\s*\/\s*/)){
    const camelot=/^(1[0-2]|[1-9])([AB])$/i.exec(part);
    if(camelot)part=CAMELOT[camelot[2].toUpperCase()][Number(camelot[1])-1];
    const note=/^([A-G])([#♯b♭]?)(?:\s*(m|maj(?:or)?|min(?:or)?|大调|小调))?$/i.exec(part);
    if(!note)return null;
    const root=note[1].toUpperCase(),accidental=note[2],suffix=note[3]||'';
    const minor=suffix!=='M'&&['m','min','minor','小调'].includes(suffix.toLowerCase());
    const offset=accidental==='b'||accidental==='♭'?-1:accidental?1:0;
    const pitch=mod12(NATURAL[root]+offset);
    const relativeRoot=LETTERS[(LETTERS.indexOf(root)+(minor?2:5))%7];
    let relativeOffset=mod12(pitch+(minor?3:-3)-NATURAL[relativeRoot]);
    if(relativeOffset>6)relativeOffset-=12;
    if(!(relativeOffset in ACCIDENTALS))return null;
    const relativeMode=minor?'Major':'Minor';
    result.push({label:`${root}${ACCIDENTALS[offset]} ${minor?'Minor':'Major'}`,relative:`${relativeRoot}${ACCIDENTALS[relativeOffset]} ${relativeMode}`,relativeMode});
  }
  return result;
}
