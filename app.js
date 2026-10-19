/* DYP v1 — no third-party scripts, analytics, network requests, or accounts. */
'use strict';

const DB_NAME = 'dyp-winter-bathing';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const TIMER_KEY = 'dyp.timer.v1';
const DRAFT_KEY = 'dyp.draft.v1';
const WEATHER_VALUES = ['', 'clear', 'partly-cloudy', 'cloudy', 'rain', 'snow', 'fog', 'other'];
const DIRECTION_VALUES = ['', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const $ = id => document.getElementById(id);
let database = null;
let sessions = [];
let currentView = 'home';
let editingId = null;
let draftGPS = null;
let activeSource = 'manual';
let toastTimeout;

const emptyTimer = () => ({ status: 'idle', startedAt: null, runningSince: null, accumulatedMs: 0 });
let timer = loadTimer();

function safeJSON(text) { try { return JSON.parse(text); } catch { return null; } }
function loadTimer() {
  const saved = safeJSON(localStorage.getItem(TIMER_KEY));
  if (!saved || !['idle', 'running', 'paused'].includes(saved.status) ||
      typeof saved.accumulatedMs !== 'number' || saved.accumulatedMs < 0 ||
      (saved.status === 'running' && (!Number.isFinite(saved.runningSince) || !saved.startedAt))) return emptyTimer();
  return saved;
}
function saveTimer() { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); }
function timerElapsedMs() { return Math.max(0, timer.accumulatedMs + (timer.status === 'running' ? Date.now() - timer.runningSince : 0)); }
function escapeHTML(input) { return String(input ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function formatLocalInput(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatDay(d) { return new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',year:'numeric'}).format(new Date(d)); }
function formatTime(d) { return new Intl.DateTimeFormat('en-GB', {hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d)); }
function fmtDuration(s, compact = false) {
  if (!Number.isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (compact) return h ? `${h}h ${m}m` : m ? `${m}m${sec ? ` ${sec}s`:''}` : `${sec}s`;
  return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m ${String(sec).padStart(2,'0')}s`;
}
function formatTemp(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(1).replace(/\.0$/, ''); }
function currentSeason() {
  const now = new Date();
  const y = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear()-1;
  return {start: new Date(y, 8, 1), end: new Date(y+1, 8, 1), year:y, label:`${y} / ${String(y+1).slice(2)}`};
}
function inSeason(session, season=currentSeason()) {
  const t = new Date(session.startedAt).getTime();
  return t >= season.start.getTime() && t < season.end.getTime();
}
function numericOrNull(raw) { if (raw === '' || raw === null || raw === undefined) return null; const n=Number(raw);return Number.isFinite(n)?n:null; }
function showToast(message) {
  const t=$('toast'); t.textContent=message; t.hidden=false;
  clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>{t.hidden=true;},3600);
}

function openDatabase() {
  return new Promise((resolve,reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const store = db.createObjectStore(SESSION_STORE,{keyPath:'id'});
        store.createIndex('startedAt','startedAt',{unique:false});
      }
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('Database update blocked by another tab'));
  });
}
function dbRequest(request) {return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function readSessions() {
  sessions=await dbRequest(database.transaction(SESSION_STORE,'readonly').objectStore(SESSION_STORE).getAll());
  sessions.sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt));
}
function writeSession(record) {
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(SESSION_STORE,'readwrite');
    tx.objectStore(SESSION_STORE).put(record);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
function removeSession(id) {
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(SESSION_STORE,'readwrite');
    tx.objectStore(SESSION_STORE).delete(id);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
function clearSessions() {
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(SESSION_STORE,'readwrite');
    tx.objectStore(SESSION_STORE).clear();
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
function putImportedRecords(records) {
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(SESSION_STORE,'readwrite');
    const store=tx.objectStore(SESSION_STORE);
    for (const record of records) store.add(record);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}

function navigate(view) {
  if (!$( `screen-${view}` )) return;
  currentView=view;
  document.querySelectorAll('.screen').forEach(el=>el.hidden=el.id!==`screen-${view}`);
  document.querySelectorAll('.nav-item').forEach(el=>{
    const active=el.dataset.view===view;
    el.classList.toggle('is-active',active);
    if (active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  if (view==='home') renderHome();
  if (view==='timer') renderTimer();
  if (view==='history') renderHistory();
  if (view==='insights') renderInsights();
  if (view==='settings') renderStorageStatus();
  window.scrollTo({top:0,behavior:'auto'});
}
function stats(rows) {
  const measured=rows.map(s=>s.waterTemperatureC).filter(v=>typeof v==='number' && Number.isFinite(v));
  const totalSeconds=rows.reduce((sum,s)=>sum+s.durationSeconds,0);
  const places=new Set(rows.map(s=>(s.location?.name || '').trim().toLocaleLowerCase()).filter(Boolean));
  return {
    count:rows.length, totalSeconds, averageDuration:rows.length?totalSeconds/rows.length:null,
    averageTemp:measured.length?measured.reduce((a,b)=>a+b,0)/measured.length:null,
    coldestTemp:measured.length?Math.min(...measured):null, places:places.size
  };
}
function emptyMarkup(text='No dips here yet.',description='Start a timer or add a past dip to begin your journal.') {
  return `<div class="empty-state"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M4 22c7-7 13-7 20 0s13 7 20 0M4 33c7-7 13-7 20 0s13 7 20 0" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg><strong>${escapeHTML(text)}</strong>${escapeHTML(description)}</div>`;
}
function rowHTML(s) {
  const date=new Date(s.startedAt);
  const place=s.location?.name?.trim() || 'Unnamed bathing spot';
  const extras=[formatTime(s.startedAt),fmtDuration(s.durationSeconds,true),s.weather?.condition?weatherLabel(s.weather.condition):''].filter(Boolean).join(' · ');
  return `<button class="session-row" type="button" data-edit-id="${escapeHTML(s.id)}" aria-label="Edit ${escapeHTML(place)}, ${escapeHTML(formatDay(s.startedAt))}">
    <span class="session-date"><strong>${date.getDate()}</strong><small>${new Intl.DateTimeFormat('en-GB',{month:'short'}).format(date).toUpperCase()}</small></span>
    <span class="session-primary"><strong>${escapeHTML(place)}</strong><small>${escapeHTML(extras)}</small></span>
    <span class="session-temp">${formatTemp(s.waterTemperatureC)}<span>${s.waterTemperatureC===null?'':'°C'}</span></span><span class="session-arrow">›</span></button>`;
}
function renderHome() {
  const season=currentSeason(), current=sessions.filter(s=>inSeason(s,season)), s=stats(current);
  $('season-label').textContent=`${season.label} SEASON`;
  $('home-dips').textContent=s.count;
  $('home-average').textContent=formatTemp(s.averageTemp);
  $('home-total').textContent=fmtDuration(s.totalSeconds,true);
  $('recent-list').innerHTML=sessions.length?sessions.slice(0,3).map(rowHTML).join(''):emptyMarkup();
  $('draft-banner').hidden=!localStorage.getItem(DRAFT_KEY);
}
function renderTimer() {
  const elapsed=timerElapsedMs(), tenths=Math.floor(elapsed/100)%10;
  const whole=Math.floor(elapsed/1000), mins=Math.floor(whole/60), sec=whole%60;
  $('stopwatch-display').innerHTML=`${String(mins).padStart(2,'0')}:${String(sec).padStart(2,'0')}<span>.${tenths}</span>`;
  $('timer-status').textContent=timer.status==='running'?'Timer running':timer.status==='paused'?'Timer paused':'Ready when you are';
  $('timer-start').hidden=timer.status!=='idle';
  $('timer-pause').hidden=timer.status!=='running';
  $('timer-resume').hidden=timer.status!=='paused';
  $('timer-finish').hidden=timer.status==='idle';
  $('timer-reset').hidden=timer.status==='idle';
}
function startTimer() {if(timer.status!=='idle')return;const now=Date.now();timer={status:'running',startedAt:new Date(now).toISOString(),runningSince:now,accumulatedMs:0};saveTimer();renderTimer();}
function pauseTimer() {if(timer.status!=='running')return;timer.accumulatedMs=timerElapsedMs();timer.runningSince=null;timer.status='paused';saveTimer();renderTimer();}
function resumeTimer() {if(timer.status!=='paused')return;timer.status='running';timer.runningSince=Date.now();saveTimer();renderTimer();}
function resetTimer() {if(timer.status==='idle')return;if(!confirm('Discard this timer without logging a dip?'))return;timer=emptyTimer();saveTimer();renderTimer();showToast('Timer discarded');}
function finishTimer() {
  if(timer.status==='idle')return;
  const seconds=Math.round(timerElapsedMs()/1000);
  if(seconds<1){showToast('Run the timer for at least one second');return;}
  if(localStorage.getItem(DRAFT_KEY) && !confirm('Replace your unfinished dip draft with this timed session?'))return;
  const draft=blankFormRecord();draft.startedAt=timer.startedAt;draft.durationSeconds=seconds;draft.source='stopwatch';
  localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));
  timer=emptyTimer();saveTimer();openLog();
}
function weatherLabel(c) {return ({clear:'Clear','partly-cloudy':'Partly cloudy',cloudy:'Cloudy',rain:'Rain',snow:'Snow',fog:'Fog',other:'Other'})[c] || '' ;}
function renderHistory() {
  const filter=$('history-filter').value, query=$('history-search').value.trim().toLocaleLowerCase();
  let list=sessions.filter(s=>(filter!=='season'||inSeason(s))&&(!query||[s.location?.name,s.notes,weatherLabel(s.weather?.condition)].some(str=>(str||'').toLocaleLowerCase().includes(query))));
  $('history-count').textContent=`${sessions.length} ${sessions.length===1?'dip':'dips'} in your journal`;
  if(!list.length){$('history-list').innerHTML=emptyMarkup(query||filter!=='all'?'No matching dips.':'No dips logged yet.',query?'Try another search.':'Your sessions will appear here.');return;}
  const groups=new Map();
  for(const s of list){const d=new Date(s.startedAt);const key=`${d.getFullYear()}-${d.getMonth()}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(s);}
  $('history-list').innerHTML=Array.from(groups.values()).map(group=>`<div class="history-group"><h2 class="month-heading">${new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric'}).format(new Date(group[0].startedAt))}</h2>${group.map(rowHTML).join('')}</div>`).join('');
}
function renderInsights() {
  const season=currentSeason(),rows=sessions.filter(s=>inSeason(s,season)),s=stats(rows);
  $('insights-season-label').textContent=`${season.label} SEASON`;
  $('metric-dips').textContent=s.count;
  $('metric-duration').textContent=fmtDuration(s.totalSeconds,true);
  $('metric-average-duration').textContent=fmtDuration(s.averageDuration);
  $('metric-coldest').textContent=formatTemp(s.coldestTemp);
  $('metric-average-water').textContent=formatTemp(s.averageTemp);
  $('metric-places').textContent=s.places;
  const months=Array.from({length:12},(_,i)=>{
    const date=new Date(season.year,8+i,1);
    return {date,label:new Intl.DateTimeFormat('en-GB',{month:'short'}).format(date),n:rows.filter(r=>{const d=new Date(r.startedAt);return d.getFullYear()===date.getFullYear()&&d.getMonth()===date.getMonth();}).length};
  });
  const max=Math.max(1,...months.map(m=>m.n));
  $('monthly-chart-subtitle').textContent=season.label;
  $('monthly-chart').innerHTML=months.map(m=>`<div class="month-col"><span class="month-value">${m.n||''}</span><div class="bar-track"><div class="bar" style="height:${m.n/max*100}%"></div></div><span class="month-name">${escapeHTML(m.label)}</span></div>`).join('');
  renderWaterChart(rows);
}
function renderWaterChart(rows){
  const points=rows.filter(s=>Number.isFinite(s.waterTemperatureC)).reverse().slice(-16);
  const target=$('water-chart');
  if(!points.length){target.innerHTML='<div class="chart-empty">Log water temperatures to see your seasonal trend.</div>';return;}
  const temps=points.map(s=>s.waterTemperatureC),mn=Math.floor(Math.min(...temps)-1),mx=Math.ceil(Math.max(...temps)+1);
  const yMin=mn===mx?mn-1:mn,yMax=mn===mx?mx+1:mx;
  const W=600,H=205,left=43,right=18,top=20,bottom=36;
  const y=t=>top+(yMax-t)/(yMax-yMin)*(H-top-bottom), x=i=>left+(points.length===1?0.5:i/(points.length-1))*(W-left-right);
  const coords=points.map((p,i)=>`${x(i).toFixed(1)},${y(p.waterTemperatureC).toFixed(1)}`);
  const ticks=[0,.5,1].map(t=>{const value=yMax-t*(yMax-yMin),yy=y(value).toFixed(1);return `<line x1="${left}" y1="${yy}" x2="${W-right}" y2="${yy}" stroke="#e7eeeb" stroke-dasharray="4 5"/><text x="${left-9}" y="${Number(yy)+4}" text-anchor="end" font-size="13" fill="#839b94">${value.toFixed(1)}</text>`;}).join('');
  const circles=points.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.waterTemperatureC)}" r="5" fill="#2e827a" stroke="#fff" stroke-width="2"><title>${escapeHTML(formatDay(p.startedAt))}: ${p.waterTemperatureC}°C</title></circle>`).join('');
  target.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Water temperature for ${points.length} most recent recorded dips"><rect width="${W}" height="${H}" rx="10" fill="#fff"/>${ticks}${points.length>1?`<polyline points="${coords.join(' ')}" fill="none" stroke="#2e827a" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`:''}${circles}<text x="${left}" y="${H-6}" font-size="13" fill="#839b94">${escapeHTML(new Intl.DateTimeFormat('en-GB',{month:'short',day:'numeric'}).format(new Date(points[0].startedAt)))}</text><text x="${W-right}" y="${H-6}" text-anchor="end" font-size="13" fill="#839b94">${escapeHTML(new Intl.DateTimeFormat('en-GB',{month:'short',day:'numeric'}).format(new Date(points[points.length-1].startedAt)))}</text></svg>`;
}

function blankFormRecord() {
  return {startedAt:new Date().toISOString(),durationSeconds:0,waterTemperatureC:null,
    location:{name:'',latitude:null,longitude:null,accuracyMeters:null},
    weather:{airTemperatureC:null,windSpeedMs:null,windDirection:'',condition:''},notes:'',source:'manual'};
}
function loadDraft() {return safeJSON(localStorage.getItem(DRAFT_KEY));}
function setFormFromRecord(s){
  $('field-datetime').value=formatLocalInput(s.startedAt);
  $('field-minutes').value=Math.floor((s.durationSeconds||0)/60);
  $('field-seconds').value=Math.round((s.durationSeconds||0)%60);
  $('field-water').value=s.waterTemperatureC??'';
  $('field-place').value=s.location?.name??'';
  $('field-air').value=s.weather?.airTemperatureC??'';
  $('field-wind').value=s.weather?.windSpeedMs??'';
  $('field-direction').value=DIRECTION_VALUES.includes(s.weather?.windDirection)?s.weather.windDirection:'';
  $('field-weather').value=WEATHER_VALUES.includes(s.weather?.condition)?s.weather.condition:'';
  $('field-notes').value=s.notes??'';
  draftGPS=s.location?.latitude!=null&&s.location?.longitude!=null ?
    {latitude:s.location.latitude,longitude:s.location.longitude,accuracyMeters:s.location.accuracyMeters??null}:null;
  renderGPS();
}
function renderGPS(){
  $('clear-location-btn').hidden=!draftGPS;
  $('location-feedback').textContent=draftGPS?`GPS saved: ${Number(draftGPS.latitude).toFixed(5)}, ${Number(draftGPS.longitude).toFixed(5)}${Number.isFinite(draftGPS.accuracyMeters)?` (±${Math.round(draftGPS.accuracyMeters)} m)`:''}`:'Optional — coordinates are only saved if you tap Use GPS location.';
}
function openLog(record=null) {
  editingId=record?.id??null;
  const candidate=record||loadDraft()||blankFormRecord();
  activeSource=candidate.source==='stopwatch'?'stopwatch':'manual';
  $('log-title').innerHTML=editingId?'Edit your <em>dip.</em>':'Log your <em>dip.</em>';
  $('save-session-btn').innerHTML=editingId?'Save changes <span aria-hidden="true">→</span>':'Save dip <span aria-hidden="true">→</span>';
  $('form-error').hidden=true;
  setFormFromRecord(candidate);
  const oldDelete=$('delete-session-btn');if(oldDelete)oldDelete.remove();
  if(editingId){
    const del=document.createElement('button');del.id='delete-session-btn';del.type='button';del.className='quiet-button';del.textContent='Delete this dip';
    del.addEventListener('click',async()=>{
      if(!confirm('Delete this dip? This cannot be undone.'))return;
      try{await removeSession(editingId);await readSessions();editingId=null;showToast('Dip deleted');navigate('history');}
      catch(e){showToast('Could not delete: '+e.message);}
    });
    $('cancel-log-btn').after(del);
  }
  navigate('log');
}
function captureFormRecord(){
  const datetime=$('field-datetime').value;
  const startedDate=datetime?new Date(datetime):new Date(NaN);
  const min=Number($('field-minutes').value),sec=Number($('field-seconds').value);
  if(!datetime||Number.isNaN(startedDate.getTime()))throw new Error('Enter a valid date and time.');
  if(!Number.isInteger(min)||min<0||min>1440||!Number.isInteger(sec)||sec<0||sec>59||min*60+sec<1)throw new Error('Enter a duration of at least one second (seconds must be 0–59).');
  const rangedNumber=(id,minValue,maxValue)=>{
    const raw=$(id).value.trim();if(!raw)return null;
    const val=Number(raw);if(!Number.isFinite(val)||val<minValue||val>maxValue)throw new Error(`${$(id).closest('.field')?.querySelector('span')?.textContent?.trim()||'Measurement'} must be between ${minValue} and ${maxValue}.`);
    return val;
  };
  return {startedAt:startedDate.toISOString(),durationSeconds:min*60+sec,waterTemperatureC:rangedNumber('field-water',-5,45),
    location:{name:$('field-place').value.trim().slice(0,120),latitude:draftGPS?.latitude??null,longitude:draftGPS?.longitude??null,accuracyMeters:draftGPS?.accuracyMeters??null},
    weather:{airTemperatureC:rangedNumber('field-air',-50,55),windSpeedMs:rangedNumber('field-wind',0,80),windDirection:$('field-direction').value,condition:$('field-weather').value},
    notes:$('field-notes').value.trim().slice(0,2000),source:activeSource};
}
function autoSaveDraft() {
  if(editingId!==null||currentView!=='log')return;
  try{localStorage.setItem(DRAFT_KEY,JSON.stringify(captureDraftUnchecked()));}catch(e){/* private mode or exhausted storage; IndexedDB save will surface error */}
}
function captureDraftUnchecked(){
  const s=blankFormRecord();
  const dt=$('field-datetime').value;
  if(dt&&!Number.isNaN(new Date(dt).getTime()))s.startedAt=new Date(dt).toISOString();
  s.durationSeconds=Math.max(0,Number($('field-minutes').value||0)*60+Number($('field-seconds').value||0));
  s.waterTemperatureC=numericOrNull($('field-water').value);
  s.location={name:$('field-place').value,latitude:draftGPS?.latitude??null,longitude:draftGPS?.longitude??null,accuracyMeters:draftGPS?.accuracyMeters??null};
  s.weather={airTemperatureC:numericOrNull($('field-air').value),windSpeedMs:numericOrNull($('field-wind').value),windDirection:$('field-direction').value,condition:$('field-weather').value};
  s.notes=$('field-notes').value;s.source=activeSource;
  return s;
}
async function saveForm(event){
  event.preventDefault();
  $('form-error').hidden=true;
  let payload;
  try{payload=captureFormRecord();}catch(e){$('form-error').textContent=e.message;$('form-error').hidden=false;return;}
  const old=sessions.find(s=>s.id===editingId);
  const now=new Date().toISOString();
  const record={id:old?.id??(crypto.randomUUID?.()||`${now}-${Math.random().toString(36).slice(2)}`),schemaVersion:1,...payload,
    createdAt:old?.createdAt||now,updatedAt:now,timeZone:old?.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'local'};
  $('save-session-btn').disabled=true;
  try{
    await writeSession(record);await readSessions();
    if(!old)localStorage.removeItem(DRAFT_KEY);
    editingId=null;showToast(old?'Dip updated':'Dip logged successfully');navigate('home');
  }catch(e){$('form-error').textContent='Could not save to local storage: '+e.message;$('form-error').hidden=false;}
  finally{$('save-session-btn').disabled=false;}
}
function cancelLog(){
  if(editingId!==null){editingId=null;navigate('history');return;}
  if(loadDraft()&&!confirm('Discard your unsaved dip draft?'))return;
  localStorage.removeItem(DRAFT_KEY);navigate('home');
}
function locate(){
  if(!navigator.geolocation){showToast('GPS is not available in this browser');return;}
  $('get-location-btn').disabled=true;
  $('location-feedback').textContent='Getting GPS position…';
  navigator.geolocation.getCurrentPosition(pos=>{
    draftGPS={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracyMeters:pos.coords.accuracy};
    $('get-location-btn').disabled=false;renderGPS();autoSaveDraft();
  },err=>{
    $('get-location-btn').disabled=false;renderGPS();showToast('GPS unavailable: '+err.message);
  },{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}

const CSV_HEADERS=['id','started_at_utc','date_local','time_local','time_zone','duration_seconds','water_temperature_c','location_name','latitude','longitude','gps_accuracy_m','air_temperature_c','wind_speed_m_s','wind_direction','weather_condition','notes','source','created_at_utc','updated_at_utc'];
function csvCell(v,asText=false){
  if(v===null||v===undefined)return '';
  let s=String(v);
  // Prevent spreadsheet formula execution from user-entered text.
  if(asText&&/^\s*[=+\-@]/.test(s))s="'"+s;
  return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}
function localDateTimeParts(iso, timeZone){
  // Use the original saved timezone, not the export device's current timezone.
  // ISO startedAt always remains the canonical unambiguous timestamp.
  const d=new Date(iso),pad=n=>String(n).padStart(2,'0');
  try {
    const pieces=new Intl.DateTimeFormat('en-GB',{
      timeZone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).formatToParts(d);
    const part=type=>pieces.find(p=>p.type===type)?.value;
    return [`${part('year')}-${part('month')}-${part('day')}`,`${part('hour')}:${part('minute')}:${part('second')}`];
  } catch {
    return [`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`];
  }
}
function makeCSV(rows){
  const records=rows.map(s=>{
    const [day,time]=localDateTimeParts(s.startedAt,s.timeZone);
    return [s.id,s.startedAt,day,time,s.timeZone,s.durationSeconds,s.waterTemperatureC,s.location?.name,s.location?.latitude,s.location?.longitude,s.location?.accuracyMeters,s.weather?.airTemperatureC,s.weather?.windSpeedMs,s.weather?.windDirection,s.weather?.condition,s.notes,s.source,s.createdAt,s.updatedAt];
  });
  return '\uFEFF'+[CSV_HEADERS.join(','),...records.map(r=>r.map((v,i)=>csvCell(v,[0,7,13,14,15,16].includes(i))).join(','))].join('\r\n')+'\r\n';
}
function downloadText(content,type,filename){
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function todayName(){return formatLocalInput().slice(0,10);}
function exportCSV(){downloadText(makeCSV(sessions),'text/csv;charset=utf-8',`dyp-sessions-${todayName()}.csv`);showToast(`Exported ${sessions.length} sessions as CSV`);}
function exportJSON(){
  const backup={format:'dyp-backup',schemaVersion:1,exportedAt:new Date().toISOString(),sessions};
  downloadText(JSON.stringify(backup,null,2),'application/json;charset=utf-8',`dyp-backup-${todayName()}.json`);
  showToast(`Backed up ${sessions.length} sessions`);
}
function validateImportedSession(s){
  if(!s||typeof s!=='object'||typeof s.id!=='string'||s.id.length>150||!s.id||
    typeof s.startedAt!=='string'||Number.isNaN(Date.parse(s.startedAt))||
    !Number.isInteger(s.durationSeconds)||s.durationSeconds<1||s.durationSeconds>86400)return null;
  const validNum=(value,min,max)=>value===null||value===undefined?null:(Number.isFinite(value)&&value>=min&&value<=max?value:NaN);
  const water=validNum(s.waterTemperatureC,-5,45),air=validNum(s.weather?.airTemperatureC,-50,55),wind=validNum(s.weather?.windSpeedMs,0,80),
    lat=validNum(s.location?.latitude,-90,90),lon=validNum(s.location?.longitude,-180,180),accuracy=validNum(s.location?.accuracyMeters,0,1000000);
  if([water,air,wind,lat,lon,accuracy].some(v=>Number.isNaN(v)))return null;
  return {id:s.id,schemaVersion:1,startedAt:new Date(s.startedAt).toISOString(),durationSeconds:s.durationSeconds,
    waterTemperatureC:water,location:{name:typeof s.location?.name==='string'?s.location.name.slice(0,120):'',latitude:lat,longitude:lon,accuracyMeters:accuracy},
    weather:{airTemperatureC:air,windSpeedMs:wind,windDirection:DIRECTION_VALUES.includes(s.weather?.windDirection)?s.weather.windDirection:'',condition:WEATHER_VALUES.includes(s.weather?.condition)?s.weather.condition:''},
    notes:typeof s.notes==='string'?s.notes.slice(0,2000):'',source:s.source==='stopwatch'?'stopwatch':'manual',
    createdAt:typeof s.createdAt==='string'&&!Number.isNaN(Date.parse(s.createdAt))?s.createdAt:new Date().toISOString(),
    updatedAt:typeof s.updatedAt==='string'&&!Number.isNaN(Date.parse(s.updatedAt))?s.updatedAt:new Date().toISOString(),
    timeZone:typeof s.timeZone==='string'?s.timeZone.slice(0,100):'local'};
}
async function importJSON(event){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;
  if(file.size>20_000_000){showToast('Backup is too large (20 MB max)');return;}
  try{
    const backup=JSON.parse(await file.text());
    if(backup?.format!=='dyp-backup'||backup.schemaVersion!==1||!Array.isArray(backup.sessions)||backup.sessions.length>50000)throw new Error('Not a supported DYP v1 backup');
    const seen=new Set(),records=[];
    for(const input of backup.sessions){
      const s=validateImportedSession(input);
      if(!s)throw new Error('Backup contains an invalid session');
      if(seen.has(s.id))throw new Error('Backup contains duplicate session IDs');
      seen.add(s.id);records.push(s);
    }
    const localIDs=new Set(sessions.map(s=>s.id));
    const newRecords=records.filter(s=>!localIDs.has(s.id));
    if(!newRecords.length){showToast('No new sessions to import');return;}
    if(!confirm(`Import ${newRecords.length} new dip${newRecords.length===1?'':'s'}? Existing sessions will not be changed.`))return;
    await putImportedRecords(newRecords);await readSessions();renderHome();showToast(`Imported ${newRecords.length} sessions`);
  }catch(e){showToast('Import failed: '+e.message);}
}
async function renderStorageStatus(){
  const status=$('storage-status');
  if(!database){status.textContent='Local database unavailable.';return;}
  const estimate=await navigator.storage?.estimate?.().catch(()=>null);
  const stored=estimate?.usage?` · Approximately ${(estimate.usage/1024/1024).toFixed(1)} MB used by this site`:'';
  status.textContent=`Local database ready · ${sessions.length} saved dip${sessions.length===1?'':'s'}${stored}`;
}
async function deleteEverything(){
  if(!sessions.length){showToast('No sessions to delete');return;}
  if(prompt(`Type DELETE to remove all ${sessions.length} locally stored dips. Export a backup first.`)!=='DELETE')return;
  try{await clearSessions();await readSessions();renderStorageStatus();navigate('home');showToast('All local sessions deleted');}
  catch(e){showToast('Could not clear data: '+e.message);}
}

function registerEvents(){
  $('brand-btn').addEventListener('click',()=>navigate('home'));
  $('settings-btn').addEventListener('click',()=>navigate('settings'));
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  $('start-dip-btn').addEventListener('click',()=>navigate('timer'));
  $('manual-log-btn').addEventListener('click',()=>openLog());
  $('see-all-btn').addEventListener('click',()=>navigate('history'));
  $('resume-draft-btn').addEventListener('click',()=>openLog());
  $('history-new-btn').addEventListener('click',()=>openLog());
  $('timer-start').addEventListener('click',startTimer);
  $('timer-pause').addEventListener('click',pauseTimer);
  $('timer-resume').addEventListener('click',resumeTimer);
  $('timer-finish').addEventListener('click',finishTimer);
  $('timer-reset').addEventListener('click',resetTimer);
  $('session-form').addEventListener('submit',saveForm);
  $('cancel-log-btn').addEventListener('click',cancelLog);
  $('get-location-btn').addEventListener('click',locate);
  $('clear-location-btn').addEventListener('click',()=>{draftGPS=null;renderGPS();autoSaveDraft();});
  $('session-form').addEventListener('input',autoSaveDraft);
  $('session-form').addEventListener('change',autoSaveDraft);
  $('history-search').addEventListener('input',renderHistory);
  $('history-filter').addEventListener('change',renderHistory);
  for(const id of ['recent-list','history-list']) $(id).addEventListener('click',ev=>{
    const button=ev.target.closest('[data-edit-id]');if(!button)return;
    const s=sessions.find(item=>item.id===button.dataset.editId);if(s)openLog(s);
  });
  $('export-csv').addEventListener('click',exportCSV);
  $('export-json').addEventListener('click',exportJSON);
  $('import-json').addEventListener('change',importJSON);
  $('delete-all-btn').addEventListener('click',deleteEverything);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&currentView==='timer')renderTimer();});
  window.addEventListener('pageshow',()=>{if(currentView==='timer')renderTimer();});
  setInterval(()=>{if(currentView==='timer'&&timer.status==='running')renderTimer();},100);
}

async function init(){
  registerEvents();
  try{
    database=await openDatabase();await readSessions();
    navigate('home');
  }catch(e){
    navigate('home');
    showToast('Local storage unavailable. DYP cannot save sessions here.');
    $('recent-list').innerHTML=emptyMarkup('Local storage unavailable', 'Open DYP in Safari over HTTPS and enable site data.');
    $('save-session-btn').disabled=true;
  }
  if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')){
    navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{/* offline shell may require HTTPS */});
  }
}
init();
