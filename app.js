/* DYP v1.5 — DMI HARMONIE local weather, alternative DMI stations, coastal-aware water. */
'use strict';

const DB_NAME = 'dyp-winter-bathing';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const TIMER_KEY = 'dyp.timer.v1';
const DRAFT_KEY = 'dyp.draft.v1';
// Broad search radius is for listing candidate observations, NOT automatic acceptance.
const WATER_STATION_SEARCH_KM = 110;
const WATER_SOURCE_MODES = ['coastal-first', 'marine-first', 'station-first'];
const WEATHER_SOURCE_MODES = ['dmi-model', 'station-first'];
const DMI_FORECAST_COLLECTION = 'harmonie_dini_sf';
const WATER_STATION_PREF_KEY = 'dyp.water-station-prefs.v1';
const WEATHER_VALUES = ['', 'clear', 'partly-cloudy', 'cloudy', 'rain', 'snow', 'fog', 'other'];
const DIRECTION_VALUES = ['', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const $ = id => document.getElementById(id);
let database = null;
let sessions = [];
let currentView = 'home';
let editingId = null;
let draftGPS = null;
let draftMeasurements = {};
let conditionRequestSerial = 0;
let waterStationCandidates = [];
let candidateLookupStatus = '';
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
// The actual datetime-local input opens the native iOS picker but is visually
// transparent. Mirror its value in the custom field to avoid iOS sizing bugs.
function syncDatetimeDisplay() {
  const input=$('field-datetime');
  const display=$('field-datetime-display');
  if(!input||!display)return;
  const date=input.value?new Date(input.value):null;
  if(!date||!Number.isFinite(date.getTime())){
    display.textContent='Choose date & time';
    return;
  }
  display.textContent=new Intl.DateTimeFormat(navigator.language||'en-GB',{
    day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false
  }).format(date);
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

// Station preferences are local-only. Named places are stable across GPS noise; unnamed places use ~1 km rounded cells.
function bathingSpotKey(coord=draftGPS, name=$('field-place')?.value||''){
  const normalized=String(name||'').normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g,' ').slice(0,100);
  if(normalized)return `place:${normalized}`;
  if(coord&&Number.isFinite(coord.latitude)&&Number.isFinite(coord.longitude))return `gps:${coord.latitude.toFixed(2)}:${coord.longitude.toFixed(2)}`;
  return '';
}
function loadStationPreferences(){
  const parsed=safeJSON(localStorage.getItem(WATER_STATION_PREF_KEY));
  return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
}
function preferredStationId(coord=draftGPS, name=$('field-place')?.value||''){
  const id=loadStationPreferences()[bathingSpotKey(coord,name)]?.stationId;
  return typeof id==='string'?id:'';
}
function setPreferredStation(station){
  const key=bathingSpotKey();
  if(!key||!station?.stationId)return false;
  const data=loadStationPreferences();
  data[key]={stationId:station.stationId,stationName:station.stationName,updatedAt:new Date().toISOString()};
  localStorage.setItem(WATER_STATION_PREF_KEY,JSON.stringify(data));
  return true;
}
function forgetPreferredStation(){
  const key=bathingSpotKey(),data=loadStationPreferences();
  if(!key||!data[key])return false;
  delete data[key];localStorage.setItem(WATER_STATION_PREF_KEY,JSON.stringify(data));return true;
}
// Intentionally limited pilot coastal mapping. We do not infer coastline connectivity from distance.
// Exact area mappings can be expanded only when checked against coastal geography.
const COASTAL_AREAS=[{
  id:'sejero-bugt-ordrup',label:'Sejerø Bugt · Ordrup Strand',center:[55.8311,11.3950],radiusKm:4,
  // Potentially representative stations, if and ONLY if they actually report DMI parameter tw.
  stationIds:['29002'],stationNamePatterns:[/sj[æa]llands?\s*odde/i,/havnebyen/i,/sejer[øo]/i]
}];
function coastalAreaFor(coord){
  if(!coord)return null;
  return COASTAL_AREAS.find(area=>haversineKm(coord.latitude,coord.longitude,...area.center)<=area.radiusKm)||null;
}
function waterStationCoastalMatch(station,area){
  if(!area||!station)return false;
  return area.stationIds.includes(station.stationId)||area.stationNamePatterns.some(p=>p.test(station.stationName));
}
function rankWaterStations(candidates,coord,preferenceId=''){
  const area=coastalAreaFor(coord);
  return [...candidates].map(c=>({...c,coastalMatch:waterStationCoastalMatch(c,area),areaLabel:area?.label||''}))
    .sort((a,b)=>(b.stationId===preferenceId?1:0)-(a.stationId===preferenceId?1:0) ||
      Number(b.coastalMatch)-Number(a.coastalMatch) || a.distance-b.distance || a.lag-b.lag);
}
function chooseWaterStation(candidates,coord,mode,preferenceId=''){
  const ranked=rankWaterStations(candidates,coord,preferenceId),area=coastalAreaFor(coord);
  if(mode==='marine-first')return {candidate:null,reason:'Marine model selected',rule:'marine-only',area};
  const picked=ranked.find(c=>c.stationId===preferenceId);
  if(picked)return {candidate:picked,reason:`Saved station for this bathing spot: ${picked.stationName}. Check that its water is representative.`,rule:'saved-station',area};
  if(mode==='station-first')return {candidate:null,reason:preferenceId?`Saved station ${preferenceId} has no recent DMI water-temperature reading; using marine estimate.`:'Choose a reporting station below to use DMI water temperature.',rule:'saved-station-unavailable',area};
  const matched=ranked.find(c=>c.coastalMatch);
  if(matched)return {candidate:matched,reason:`Provisional ${area.label} coastal match: ${matched.stationName}; not a verified bathing-water measurement.`,rule:'coastal-candidate',area};
  return {candidate:null,reason:area?`No reporting DMI water-temperature station matched ${area.label}; using marine estimate.`:'This coast has no curated station-to-bay mapping yet; using marine estimate. You can select a reporting DMI station below.',rule:'no-curated-match',area};
}
function waterReading(candidate,decision,retrievedAt){
  if(!candidate)return null;
  return {value:candidate.value,meta:{origin:'dmi',provider:'DMI Open Data',stationId:candidate.stationId,
    stationName:candidate.stationName,stationDistanceKm:Math.round(candidate.distance*10)/10,
    observedAt:candidate.time,retrievedAt,selectionRule:decision.rule,
    coastalArea:decision.area?.label||'',coastalMatch:Boolean(candidate.coastalMatch),
    waterSelectionNote:decision.reason}};
}
function renderStationCandidates(){
  const group=$('station-picker'),select=$('field-water-station'),status=$('station-picker-status');
  const pref=preferredStationId(),area=coastalAreaFor(draftGPS);
  $('coastal-area-status').textContent=area?`Coastal area: ${area.label} (pilot mapping, not a bath-temperature guarantee)`:
    draftGPS?'Coastal area: unmapped. DYP defaults to the marine model until you choose a station.':'Use GPS to discover reporting DMI water stations.';
  select.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='Select a reporting station…';select.append(empty);
  for(const c of waterStationCandidates){
    const item=document.createElement('option');item.value=c.stationId;
    item.textContent=`${c.coastalMatch?'◈ ':''}${c.stationName} · ${c.distance.toFixed(1)} km · ${c.value.toFixed(1)}°C`;
    select.append(item);
  }
  // Do not choose a station merely because it ranks first.
  if(pref&&waterStationCandidates.some(c=>c.stationId===pref))select.value=pref;
  else select.value='';
  select.disabled=!waterStationCandidates.length;
  $('save-station-btn').disabled=!waterStationCandidates.length;
  $('clear-station-btn').hidden=!pref;
  group.hidden=!draftGPS;
  status.textContent=waterStationCandidates.length?
    `${waterStationCandidates.length} station${waterStationCandidates.length===1?'':'s'} reporting water temperature (within ${WATER_STATION_SEARCH_KM} km). ◈ = provisional same-coast candidate. Stations without recent observations are not listed.`:
    (candidateLookupStatus||'No recent DMI water-temperature observations were returned.');
  if(pref&&!waterStationCandidates.some(c=>c.stationId===pref))status.textContent+=` Saved station ${pref} is currently not reporting here.`;
}
function applyChosenStation(candidate,rule){
  if(!candidate)return false;
  const reading=waterReading(candidate,{rule,area:coastalAreaFor(draftGPS),reason:'User-selected reporting DMI station; coastal suitability chosen by user.'},new Date().toISOString());
  if(applyAutoField('field-water',reading.value,reading.meta)){renderMeasurementSources();autoSaveDraft();return true;}
  return false;
}
function saveChosenStation(){
  const candidate=waterStationCandidates.find(c=>c.stationId===$('field-water-station').value);
  if(!candidate){showToast('Choose a station from the list first');return;}
  if(!setPreferredStation(candidate)){showToast('Enter a bathing spot name or use GPS first');return;}
  $('field-water-mode').value='station-first';
  if(isAutoMeasurement(draftMeasurements.waterTemperatureC)){$('field-water').value='';delete draftMeasurements.waterTemperatureC;}
  const applied=applyChosenStation(candidate,'saved-station');
  renderStationCandidates();renderMeasurementSources();autoSaveDraft();
  showToast(applied?`Using ${candidate.stationName} for this spot`:'Station saved; your manually entered water temperature was kept');
}
function blankFormRecord() {
  return {waterSourceMode:'coastal-first',weatherSourceMode:'dmi-model',startedAt:new Date().toISOString(),durationSeconds:0,waterTemperatureC:null,
    location:{name:'',latitude:null,longitude:null,accuracyMeters:null},
    weather:{airTemperatureC:null,windSpeedMs:null,windDirection:'',condition:''},measurements:{},notes:'',source:'manual'};
}
function loadDraft() {return safeJSON(localStorage.getItem(DRAFT_KEY));}
function setFormFromRecord(s){
  $('field-datetime').value=formatLocalInput(s.startedAt);
  syncDatetimeDisplay();
  $('field-minutes').value=Math.floor((s.durationSeconds||0)/60);
  $('field-seconds').value=Math.round((s.durationSeconds||0)%60);
  $('field-water').value=s.waterTemperatureC??'';
  $('field-water-mode').value=WATER_SOURCE_MODES.includes(s.waterSourceMode)?s.waterSourceMode:'coastal-first';
  $('field-weather-mode').value=WEATHER_SOURCE_MODES.includes(s.weatherSourceMode)?s.weatherSourceMode:'dmi-model';
  $('field-place').value=s.location?.name??'';
  $('field-air').value=s.weather?.airTemperatureC??'';
  $('field-wind').value=s.weather?.windSpeedMs??'';
  $('field-direction').value=DIRECTION_VALUES.includes(s.weather?.windDirection)?s.weather.windDirection:'';
  $('field-weather').value=WEATHER_VALUES.includes(s.weather?.condition)?s.weather.condition:'';
  $('field-notes').value=s.notes??'';
  draftMeasurements=structuredClone(s.measurements || {});
  draftGPS=s.location?.latitude!=null&&s.location?.longitude!=null ?
    {latitude:s.location.latitude,longitude:s.location.longitude,accuracyMeters:s.location.accuracyMeters??null}:null;
  waterStationCandidates=[];candidateLookupStatus='';
  renderGPS();
  renderStationCandidates();
  renderMeasurementSources();
  setLookupFeedback('Tap Use GPS to fetch DMI observations (where available) and labelled estimates, or enter data manually.');
}
function clearModelledFields(){
  for(const [id,key] of Object.entries(CONDITION_FIELDS)){
    if(isAutoMeasurement(draftMeasurements[key])){
      $(id).value='';
      delete draftMeasurements[key];
    }
  }
  renderMeasurementSources();
}
function renderGPS(){
  $('clear-location-btn').hidden=!draftGPS;
  $('refresh-conditions-btn').hidden=!draftGPS;
  $('location-feedback').textContent=draftGPS?`GPS saved: ${Number(draftGPS.latitude).toFixed(5)}, ${Number(draftGPS.longitude).toFixed(5)}${Number.isFinite(draftGPS.accuracyMeters)?` (±${Math.round(draftGPS.accuracyMeters)} m)`:''}`:'Optional — GPS permission is requested only when you tap the button.';
}
function openLog(record=null) {
  ++conditionRequestSerial;
  $('get-location-btn').disabled=false;
  $('refresh-conditions-btn').disabled=false;
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
    measurements:structuredClone(draftMeasurements),waterSourceMode:$('field-water-mode').value,weatherSourceMode:$('field-weather-mode').value,
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
  s.measurements=structuredClone(draftMeasurements);
  s.waterSourceMode=$('field-water-mode').value;
  s.weatherSourceMode=$('field-weather-mode').value;
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
// On-demand data. Location and session time leave the device ONLY after a user-initiated lookup.
const CONDITION_FIELDS = {'field-water':'waterTemperatureC','field-air':'airTemperatureC',
  'field-wind':'windSpeedMs','field-direction':'windDirection','field-weather':'condition'};
const DMI_ROOT = 'https://opendataapi.dmi.dk/v2';
const DMI_PARAMETERS = [
  ['oceanObs','tw','field-water',WATER_STATION_SEARCH_KM], // Discovery is broad; acceptance is based on saved choice/coastal candidate, not distance.
  ['metObs','temp_dry','field-air',35],
  ['metObs','wind_speed','field-wind',35],
  ['metObs','wind_dir','field-direction',35]
];
function setLookupFeedback(message,status='info') {
  const el=$('conditions-feedback');el.textContent=message;el.dataset.status=status;
}
function isAutoMeasurement(meta){return ['open-meteo','dmi','dmi-model'].includes(meta?.origin);}
function fmtSource(meta){
  if(meta?.origin==='dmi'){
    const distance=Number.isFinite(meta.stationDistanceKm)?` · ${meta.stationDistanceKm.toFixed(1)} km away`:'';
    const stamp=meta.observedAt?`${formatDay(meta.observedAt)} ${formatTime(meta.observedAt)}`:'time unavailable';
    return `DMI measured · ${meta.stationName||`Station ${meta.stationId||'unknown'}`}${distance} · ${stamp}`;
  }
  if(meta?.origin==='dmi-model'){
    const dist=Number.isFinite(meta.gridDistanceKm)?` · grid ${meta.gridDistanceKm.toFixed(1)} km away`:'';
    const land=Number.isFinite(meta.landPercent)?` · grid ${Math.round(meta.landPercent*100)}% land`:'';
    const point=Number.isFinite(meta.gridLatitude)&&Number.isFinite(meta.gridLongitude)?` · ${meta.gridLatitude.toFixed(3)}°N ${meta.gridLongitude.toFixed(3)}°E`:'';
    return `DMI HARMONIE forecast${dist}${land}${point} · valid ${formatDay(meta.modelTime)} ${formatTime(meta.modelTime)}`;
  }
  if(meta?.origin==='open-meteo'){
    const dist=Number.isFinite(meta.gridDistanceKm)?` · grid ~${meta.gridDistanceKm.toFixed(1)} km away`:'';
    const selection=meta.waterSelectionNote?` · ${meta.waterSelectionNote}`:'';
    return `Open-Meteo model estimate${dist} · ${formatDay(meta.modelTime)} ${formatTime(meta.modelTime)}${selection}`;
  }
  return '';
}
function renderMeasurementSources(){
  const water=draftMeasurements.waterTemperatureC,air=draftMeasurements.airTemperatureC,
    wind=draftMeasurements.windSpeedMs,dir=draftMeasurements.windDirection,weather=draftMeasurements.condition;
  $('water-source').textContent=isAutoMeasurement(water)
    ? `${fmtSource(water)}. ${water.origin==='dmi'?(water.waterSelectionNote||'DMI station measurement; not an exact bathing-water temperature.'):'Modelled sea surface, not a bathing-spot measurement.'}`
    : $('field-water').value.trim()?'Manually entered water temperature':'Enter a measurement or use GPS for coastal-aware DMI / marine-model data.';
  $('air-source').textContent=isAutoMeasurement(air)
    ? `${fmtSource(air)}. Editable.`
    : $('field-air').value.trim()?'Manually entered air temperature':'Air temperature: location-specific DMI HARMONIE forecast by default, or nearby DMI observations.';
  $('wind-source').textContent=[wind,dir,weather].some(isAutoMeasurement)
    ? `Wind: ${isAutoMeasurement(wind)?fmtSource(wind):'manual/unavailable'} · Direction: ${isAutoMeasurement(dir)?fmtSource(dir):'manual/unavailable'} · Sky/weather: ${isAutoMeasurement(weather)?fmtSource(weather):'manual/unavailable'}.`
    : 'Wind and sky conditions use DMI HARMONIE by default, with Open-Meteo as a fallback.';
}
function noteManualFieldChange(event){
  const key=CONDITION_FIELDS[event.target?.id];
  if(!key)return;
  delete draftMeasurements[key];
  renderMeasurementSources();
}
function degToCompass(degrees){
  if(!Number.isFinite(degrees))return '';
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(((degrees%360)+360)%360/45)%8];
}
function wmoToWeather(code){
  if(!Number.isFinite(code))return '';
  if(code===0)return 'clear';
  if([1,2].includes(code))return 'partly-cloudy';
  if(code===3)return 'cloudy';
  if([45,48].includes(code))return 'fog';
  if([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code))return 'rain';
  if([71,73,75,77,85,86].includes(code))return 'snow';
  return 'other';
}
function haversineKm(lat1,lon1,lat2,lon2){
  const r=Math.PI/180,dlat=(lat2-lat1)*r,dlon=(lon2-lon1)*r;
  const a=Math.sin(dlat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dlon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function nearestHourly(data,key,targetMs,maxOffsetMs){
  const hourly=data?.hourly;
  if(!Array.isArray(hourly?.time)||!Array.isArray(hourly[key]))return null;
  let best=null;
  hourly.time.forEach((timestamp,i)=>{
    const value=hourly[key][i];
    if(typeof value!=='number'||!Number.isFinite(value))return;
    const time=typeof timestamp==='number'?timestamp*1000:Date.parse(timestamp+'Z');
    const difference=Math.abs(time-targetMs);
    if(!Number.isFinite(time)||difference>maxOffsetMs)return;
    if(!best||difference<best.difference)best={value,time:new Date(time).toISOString(),index:i,difference};
  });
  return best;
}
async function requestModelData(url){
  const controller=new AbortController();
  const id=setTimeout(()=>controller.abort(),13000);
  try{
    const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error('Service returned '+response.status);
    const data=await response.json();
    if(data.error)throw new Error(data.reason||'Service unavailable');
    return data;
  }finally{clearTimeout(id);}
}
function applyAutoField(id,value,meta){
  const field=$(id),name=CONDITION_FIELDS[id];
  if(value===null||value===undefined||value==='')return false;
  // Never overwrite a hand-entered value, even when another service succeeds.
  if(field.value.trim()!==''&&!isAutoMeasurement(draftMeasurements[name]))return false;
  field.value=typeof value==='number'?String(Math.round(value*10)/10):value;
  draftMeasurements[name]=meta;
  return true;
}
function currentLookupDate(){
  const input=$('field-datetime').value;
  const date=input?new Date(input):null;
  if(!date||!Number.isFinite(date.getTime()))throw new Error('Enter a valid session date/time first.');
  const offset=Date.now()-date.getTime();
  if(offset>6.9*86400000)throw new Error('Auto-fill supports only the last 7 days. For older dips, enter conditions manually.');
  if(offset < -300000)throw new Error('Future sessions cannot fetch actual conditions.');
  return date;
}
function isDenmark(lat,lon){return lat>=54.3&&lat<=58.2&&lon>=7.8&&lon<=15.6;}
function dmiBBox(lat,lon,radiusKm){
  const latDelta=radiusKm/111.2,lonDelta=radiusKm/(111.2*Math.max(.15,Math.cos(lat*Math.PI/180)));
  return [lon-lonDelta,lat-latDelta,lon+lonDelta,lat+latDelta].map(v=>v.toFixed(4)).join(',');
}
function dmiUrl(group,collection,query){
  return `${DMI_ROOT}/${group}/collections/${collection}/items?${new URLSearchParams(query)}`;
}
function dmiStationNames(collection,targetDate){
  const names=new Map();
  for(const feature of collection?.features||[]){
    const p=feature?.properties;
    if(!p?.stationId||!p.name)continue;
    const from=Date.parse(p.validFrom||p.operationFrom||'1970-01-01');
    const to=p.validTo?Date.parse(p.validTo):Infinity;
    const when=targetDate.getTime();
    // On boundary or partial station histories, favour the latest available entry.
    if(!names.has(String(p.stationId))||(when>=from&&when<=to))names.set(String(p.stationId),p.name);
  }
  return names;
}
function nearestDmiObservation(data,latitude,longitude,targetMs,maxDistanceKm,maxTimeMs,stations){
  let best=null;
  for(const feature of data?.features||[]){
    const p=feature?.properties,coords=feature?.geometry?.coordinates;
    if(!p||!Array.isArray(coords)||coords.length<2||!Number.isFinite(Number(p.value)))continue;
    if(p.value===null||p.value===''||(p.qcResult!==null&&p.qcResult!==undefined&&p.qcResult!==''&&Number.isFinite(Number(p.qcResult))&&Number(p.qcResult)>=1))continue;
    const [lon,lat]=coords.map(Number),time=Date.parse(p.observed);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(time))continue;
    const distance=haversineKm(latitude,longitude,lat,lon),lag=Math.abs(time-targetMs);
    if(distance>maxDistanceKm||lag>maxTimeMs)continue;
    // Closest valid *reporting* station; timestamp breaks ties within that station.
    if(!best||distance<best.distance-.02||(Math.abs(distance-best.distance)<.02&&lag<best.lag)){
      const id=String(p.stationId||'');
      best={value:Number(p.value),time:new Date(time).toISOString(),distance,lag,
        stationId:id,stationName:stations?.get(id)||`Station ${id}`};
    }
  }
  return best;
}

function dmiWaterCandidates(data,coord,targetMs,stations){
  const byStation=new Map();
  for(const f of data?.features||[]){
    const p=f?.properties,xy=f?.geometry?.coordinates;
    if(!p||!Array.isArray(xy)||xy.length<2||!p.stationId||p.value==null||p.value==='')continue;
    const value=Number(p.value),time=Date.parse(p.observed),lon=Number(xy[0]),lat=Number(xy[1]);
    if(!Number.isFinite(value)||value < -3||value > 35||!Number.isFinite(time)||!Number.isFinite(lat)||!Number.isFinite(lon))continue;
    const lag=Math.abs(time-targetMs),distance=haversineKm(coord.latitude,coord.longitude,lat,lon);
    if(lag>75*60000||distance>WATER_STATION_SEARCH_KM)continue;
    // Do not silently accept quality-control failures.
    if(p.qcResult!==undefined&&p.qcResult!==null&&p.qcResult!==''&&Number(p.qcResult)>=1)continue;
    const stationId=String(p.stationId),old=byStation.get(stationId);
    if(!old||lag<old.lag)byStation.set(stationId,{stationId,stationName:stations?.get(stationId)||`Station ${stationId}`,
      value,time:new Date(time).toISOString(),distance,lag,latitude:lat,longitude:lon});
  }
  return rankWaterStations([...byStation.values()],coord,preferredStationId(coord));
}
async function fetchDmiConditions(coord,date,waterMode='coastal-first'){
  const target=date.getTime();
  const start=new Date(target-75*60000).toISOString(),end=new Date(Math.min(Date.now(),target+75*60000)).toISOString();
  const boxes={oceanObs:dmiBBox(coord.latitude,coord.longitude,WATER_STATION_SEARCH_KM),metObs:dmiBBox(coord.latitude,coord.longitude,40)};
  const items=DMI_PARAMETERS.map(([group,param,id,maxKm])=>({group,param,id,maxKm,
    url:dmiUrl(group,'observation',{parameterId:param,bbox:boxes[group],datetime:`${start}/${end}`,limit:group==='oceanObs'?'5000':'2500'})}));
  const requests=[...items.map(q=>requestModelData(q.url)),
    requestModelData(dmiUrl('oceanObs','station',{bbox:boxes.oceanObs,limit:'1500'})),
    requestModelData(dmiUrl('metObs','station',{bbox:boxes.metObs,limit:'1000'}))];
  const results=await Promise.allSettled(requests);
  const names={oceanObs:dmiStationNames(results[4].status==='fulfilled'?results[4].value:null,date),
    metObs:dmiStationNames(results[5].status==='fulfilled'?results[5].value:null,date)};
  const outputs={},retrievedAt=new Date().toISOString();
  for(let i=0;i<items.length;i++){
    const q=items[i],result=results[i];
    if(q.id==='field-water'){
      if(result.status!=='fulfilled'){
        outputs[q.id]={error:'unavailable',waterDecision:{reason:'DMI water observation API unavailable; using marine model.',rule:'dmi-unavailable',area:coastalAreaFor(coord)},candidates:[]};
        continue;
      }
      const candidates=dmiWaterCandidates(result.value,coord,target,names.oceanObs);
      const decision=chooseWaterStation(candidates,coord,waterMode,preferredStationId(coord));
      outputs[q.id]={...(decision.candidate?waterReading(decision.candidate,decision,retrievedAt):{error:'no-coastal-match'}),
        waterDecision:decision,candidates};
      if(result.value?.links?.some(link=>link.rel==='next')){
        outputs[q.id].waterDecision={...decision,reason:decision.reason+' DMI returned paginated results; station list may be incomplete.'};
      }
      continue;
    }
    if(result.status!=='fulfilled'){outputs[q.id]={error:'unavailable'};continue;}
    const valid={features:(result.value?.features||[]).filter(f=>{
      const v=f?.properties?.value,n=Number(v);
      if(v==null||v==='')return false;
      return q.id==='field-air'?n>=-50&&n<=55:q.id==='field-wind'?n>=0&&n<=70:n>=0&&n<=360;
    })};
    const chosen=nearestDmiObservation(valid,coord.latitude,coord.longitude,target,q.maxKm,75*60000,names[q.group]);
    outputs[q.id]=chosen?{value:q.id==='field-direction'?degToCompass(chosen.value):chosen.value,
      meta:{origin:'dmi',provider:'DMI Open Data',stationId:chosen.stationId,stationName:chosen.stationName,
        stationDistanceKm:Math.round(chosen.distance*10)/10,observedAt:chosen.time,retrievedAt}}:{error:'no-nearby-observation'};
  }
  return outputs;
}
// DMI Open Data EDR: a point request yields the model grid point nearest the GPS coordinates.
// GeoJSON features are time steps; temperatures are K, not degrees C.
function dmiHarmonieUrl(coord,date){
  const qs=new URLSearchParams({coords:`POINT(${coord.longitude.toFixed(5)} ${coord.latitude.toFixed(5)})`,
    crs:'crs84',f:'GeoJSON',
    'parameter-name':'temperature-2m,wind-speed-10m,wind-dir-10m,fraction-of-cloud-cover,rain-precipitation-rate,land-percent',
    datetime:`${new Date(date.getTime()-2*3600000).toISOString()}/${new Date(date.getTime()+2*3600000).toISOString()}`});
  return `https://opendataapi.dmi.dk/v1/forecastedr/collections/${DMI_FORECAST_COLLECTION}/position?${qs}`;
}
function dmiForecastToFields(data,coord,date){
  const target=date.getTime();let best=null;
  for(const feature of data?.features||[]){
    const p=feature?.properties,xy=feature?.geometry?.coordinates;
    if(!p||!Array.isArray(xy)||xy.length<2)continue;
    const ms=Date.parse(p.step||p.validTime||p.time||'');
    const lon=Number(xy[0]),lat=Number(xy[1]);
    const distance=haversineKm(coord.latitude,coord.longitude,lat,lon),difference=Math.abs(ms-target);
    if(!Number.isFinite(ms)||!Number.isFinite(distance)||distance>8||difference>90*60000)continue;
    if(!best||difference<best.difference)best={feature,difference,time:new Date(ms).toISOString(),distance,lat,lon};
  }
  if(!best)return {};
  const p=best.feature.properties,at=new Date().toISOString(),out={};
  const land=Number(p['land-percent']);
  const meta={origin:'dmi-model',provider:'DMI HARMONIE DINI',collection:DMI_FORECAST_COLLECTION,
    modelTime:best.time,retrievedAt:at,gridLatitude:best.lat,gridLongitude:best.lon,
    gridDistanceKm:Math.round(best.distance*100)/100,
    landPercent:p['land-percent']!=null&&Number.isFinite(land)&&land>=0&&land<=1?land:null};
  const put=(id,value)=>{if(value!==''&&value!==null&&value!==undefined)out[id]={value,meta:{...meta}};};
  const kelvin=p['temperature-2m'];
  if(typeof kelvin==='number'&&Number.isFinite(kelvin)){
    const c=kelvin-273.15;
    if(c>=-50&&c<=55)put('field-air',c);
  }
  const speed=p['wind-speed-10m'];
  if(typeof speed==='number'&&Number.isFinite(speed)&&speed>=0&&speed<=80)put('field-wind',speed);
  const dir=p['wind-dir-10m'];
  if(typeof dir==='number'&&Number.isFinite(dir)&&dir>=0&&dir<=360)put('field-direction',degToCompass(dir));
  // Approximate sky descriptor. DMI does not return a WMO weather-code here.
  const cloud=p['fraction-of-cloud-cover'];
  const rain=p['rain-precipitation-rate'];
  if(typeof rain==='number'&&rain>0.00002){put('field-weather','rain');}
  else if(typeof cloud==='number'&&Number.isFinite(cloud)&&cloud>=0&&cloud<=1){
    put('field-weather',cloud>=.75?'cloudy':cloud>=.25?'partly-cloudy':'clear');
  }
  return out;
}
async function fetchDmiForecast(coord,date){
  const raw=await requestModelData(dmiHarmonieUrl(coord,date));
  return dmiForecastToFields(raw,coord,date);
}
async function fetchOpenMeteo(coord,date){
  const lat=coord.latitude.toFixed(5),lon=coord.longitude.toFixed(5);
  const common=`latitude=${lat}&longitude=${lon}&timeformat=unixtime&timezone=GMT&past_days=7&forecast_days=1`;
  const weather=`https://api.open-meteo.com/v1/forecast?${common}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&wind_speed_unit=ms`;
  const marine=`https://marine-api.open-meteo.com/v1/marine?${common}&hourly=sea_surface_temperature&cell_selection=sea`;
  const [air,sea]=await Promise.allSettled([requestModelData(weather),requestModelData(marine)]);
  const target=date.getTime(),retrievedAt=new Date().toISOString(),out={};
  if(air.status==='fulfilled'){
    const data=air.value;
    for(const [field,key,transform] of [
      ['field-air','temperature_2m',v=>v],['field-wind','wind_speed_10m',v=>v],
      ['field-direction','wind_direction_10m',degToCompass],['field-weather','weather_code',wmoToWeather]]){
      const near=nearestHourly(data,key,target,90*60000);
      if(near)out[field]={value:transform(near.value),meta:{origin:'open-meteo',provider:'Open-Meteo Weather',modelTime:near.time,retrievedAt}};
    }
  }
  if(sea.status==='fulfilled'){
    const data=sea.value,near=nearestHourly(data,'sea_surface_temperature',target,4*3600000);
    const km=Number.isFinite(data.latitude)&&Number.isFinite(data.longitude)?
      haversineKm(coord.latitude,coord.longitude,data.latitude,data.longitude):null;
    if(near&&km!==null&&km<=12)out['field-water']={value:near.value,
      meta:{origin:'open-meteo',provider:'Open-Meteo Marine',modelTime:near.time,retrievedAt,gridDistanceKm:km}};
  }
  return out;
}
async function fetchConditions(){
  if(!draftGPS){setLookupFeedback('Get a GPS location before fetching conditions.','error');return;}
  let date;
  try{date=currentLookupDate();}catch(e){setLookupFeedback(e.message,'error');return;}
  if(!navigator.onLine){setLookupFeedback('You are offline. Conditions require internet; manual logging still works.','error');return;}
  const serial=++conditionRequestSerial,coord={...draftGPS},savedDate=$('field-datetime').value,savedPlace=$('field-place').value,
    weatherMode=$('field-weather-mode').value,waterMode=$('field-water-mode').value;
  $('refresh-conditions-btn').disabled=true;$('get-location-btn').disabled=true;
  setLookupFeedback('Fetching coastal water and local DMI HARMONIE weather…','loading');
  const useDmi=isDenmark(coord.latitude,coord.longitude);
  const [dmiResult,harmonieResult,modelResult]=await Promise.allSettled([
    useDmi?fetchDmiConditions(coord,date,waterMode):Promise.resolve({}),
    useDmi?fetchDmiForecast(coord,date):Promise.resolve({}),
    fetchOpenMeteo(coord,date)]);
  if(serial!==conditionRequestSerial||!draftGPS||draftGPS.latitude!==coord.latitude||draftGPS.longitude!==coord.longitude||
    $('field-datetime').value!==savedDate||$('field-place').value!==savedPlace||
    $('field-weather-mode').value!==weatherMode||$('field-water-mode').value!==waterMode){
    $('get-location-btn').disabled=false;$('refresh-conditions-btn').disabled=false;return;
  }
  $('get-location-btn').disabled=false;$('refresh-conditions-btn').disabled=false;
  const dmi=dmiResult.status==='fulfilled'?dmiResult.value:{},
    harmonie=harmonieResult.status==='fulfilled'?harmonieResult.value:{},
    models=modelResult.status==='fulfilled'?modelResult.value:{};
  const waterDecision=dmi['field-water']?.waterDecision;
  waterStationCandidates=rankWaterStations(dmi['field-water']?.candidates||[],coord,preferredStationId(coord));
  candidateLookupStatus=useDmi?(dmiResult.status==='rejected'||dmi['field-water']?.error==='unavailable'?'DMI was unavailable. Try again online.':'No recent DMI water temperature observations returned.'):'Outside Denmark: DMI skipped.';
  renderStationCandidates();
  if(waterDecision&&!waterDecision.candidate&&models['field-water']?.meta){
    models['field-water'].meta.waterSelectionNote=waterDecision.reason;
    models['field-water'].meta.coastalArea=waterDecision.area?.label||'';
    models['field-water'].meta.selectionRule=waterDecision.rule;
  }
  let stationCount=0,harmonieCount=0,modelCount=0,manualCount=0,missingCount=0;
  for(const id of Object.keys(CONDITION_FIELDS)){
    const reading=id==='field-water'?(dmi[id]?.value!==undefined?dmi[id]:models[id]):
      weatherMode==='station-first'?(dmi[id]?.value!==undefined?dmi[id]:harmonie[id]||models[id]):
      harmonie[id]||models[id];
    const previous=$(id).value;
    if(reading&&applyAutoField(id,reading.value,reading.meta)){
      if(reading.meta.origin==='dmi')stationCount++;
      else if(reading.meta.origin==='dmi-model')harmonieCount++;
      else modelCount++;
    }else if(previous.trim()!==''&&!isAutoMeasurement(draftMeasurements[CONDITION_FIELDS[id]]))manualCount++;
    else missingCount++;
  }
  renderMeasurementSources();autoSaveDraft();
  const parts=[];
  if(harmonieCount)parts.push(`${harmonieCount} DMI HARMONIE local weather estimate${harmonieCount===1?'':'s'}`);
  if(stationCount)parts.push(`${stationCount} DMI station observation${stationCount===1?'':'s'}`);
  if(modelCount)parts.push(`${modelCount} Open-Meteo fallback${modelCount===1?'':'s'}`);
  if(manualCount)parts.push(`${manualCount} manual entr${manualCount===1?'y':'ies'} kept`);
  if(missingCount)parts.push(`${missingCount} field${missingCount===1?'':'s'} unavailable`);
  if(useDmi&&harmonieResult.status==='rejected')parts.push('DMI HARMONIE request failed; fallback used where available');
  if(useDmi&&harmonieResult.status==='fulfilled'&&!Object.keys(harmonie).length)parts.push('No DMI forecast step for this session time');
  if(waterDecision&&!waterDecision.candidate)parts.push(waterDecision.reason);
  if(!models['field-water']?.value&&!dmi['field-water']?.value&&!$('field-water').value.trim())parts.push('Water temperature unavailable; enter manually');
  if(modelResult.status==='rejected')parts.push('Open-Meteo unavailable');
  setLookupFeedback(parts.join(' · ')||'No conditions updated.',stationCount||harmonieCount||modelCount?'info':'error');
}

function locate(){
  if(!navigator.geolocation){setLookupFeedback('GPS is not available in this browser.','error');return;}
  // Invalidate any request for an earlier position.
  ++conditionRequestSerial;
  $('get-location-btn').disabled=true;
  setLookupFeedback('Requesting iPhone location…','loading');
  navigator.geolocation.getCurrentPosition(pos=>{
    clearModelledFields();
    draftGPS={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracyMeters:pos.coords.accuracy};
    waterStationCandidates=[];candidateLookupStatus='';renderGPS();renderStationCandidates();autoSaveDraft();
    fetchConditions();
  },err=>{
    $('get-location-btn').disabled=false;renderGPS();
    setLookupFeedback('GPS unavailable: '+err.message,'error');
  },{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}

const CSV_HEADERS=['id','started_at_utc','date_local','time_local','time_zone','duration_seconds','water_temperature_c','location_name','latitude','longitude','gps_accuracy_m','air_temperature_c','wind_speed_m_s','wind_direction','weather_condition','notes','source','created_at_utc','updated_at_utc','water_temperature_origin','water_model_time_utc','water_grid_distance_km','air_temperature_origin','air_model_time_utc','conditions_retrieved_at_utc','water_station_id','water_station_name','water_station_distance_km','water_observed_at_utc','air_station_id','air_station_name','air_station_distance_km','air_observed_at_utc','wind_speed_origin','wind_speed_station_id','wind_speed_station_name','wind_speed_station_distance_km','wind_speed_observed_at_utc','wind_direction_origin','weather_condition_origin','water_source_preference','water_selection_rule','water_area_hint','water_selection_note','water_coastal_match','weather_source_mode','air_grid_latitude','air_grid_longitude','air_grid_distance_km','air_grid_land_fraction','wind_model_time_utc','weather_model_time_utc','weather_grid_latitude','weather_grid_longitude'];
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
    return [s.id,s.startedAt,day,time,s.timeZone,s.durationSeconds,s.waterTemperatureC,s.location?.name,s.location?.latitude,s.location?.longitude,s.location?.accuracyMeters,s.weather?.airTemperatureC,s.weather?.windSpeedMs,s.weather?.windDirection,s.weather?.condition,s.notes,s.source,s.createdAt,s.updatedAt,s.waterTemperatureC!=null?(s.measurements?.waterTemperatureC?.origin||'manual'):'',s.measurements?.waterTemperatureC?.modelTime??'',s.measurements?.waterTemperatureC?.gridDistanceKm??'',s.weather?.airTemperatureC!=null?(s.measurements?.airTemperatureC?.origin||'manual'):'',s.measurements?.airTemperatureC?.modelTime??'',s.measurements?.airTemperatureC?.retrievedAt??s.measurements?.waterTemperatureC?.retrievedAt??'',s.measurements?.waterTemperatureC?.stationId??'',s.measurements?.waterTemperatureC?.stationName??'',s.measurements?.waterTemperatureC?.stationDistanceKm??'',s.measurements?.waterTemperatureC?.observedAt??'',s.measurements?.airTemperatureC?.stationId??'',s.measurements?.airTemperatureC?.stationName??'',s.measurements?.airTemperatureC?.stationDistanceKm??'',s.measurements?.airTemperatureC?.observedAt??'',s.weather?.windSpeedMs!=null?(s.measurements?.windSpeedMs?.origin||'manual'):'',s.measurements?.windSpeedMs?.stationId??'',s.measurements?.windSpeedMs?.stationName??'',s.measurements?.windSpeedMs?.stationDistanceKm??'',s.measurements?.windSpeedMs?.observedAt??'',s.weather?.windDirection?(s.measurements?.windDirection?.origin||'manual'):'',s.weather?.condition?(s.measurements?.condition?.origin||'manual'):'',s.waterSourceMode||'coastal-first',s.measurements?.waterTemperatureC?.selectionRule??'',s.measurements?.waterTemperatureC?.coastalArea??'',s.measurements?.waterTemperatureC?.waterSelectionNote??'',s.measurements?.waterTemperatureC?.coastalMatch??'',s.weatherSourceMode||'dmi-model',s.measurements?.airTemperatureC?.gridLatitude??'',s.measurements?.airTemperatureC?.gridLongitude??'',s.measurements?.airTemperatureC?.gridDistanceKm??'',s.measurements?.airTemperatureC?.landPercent??'',s.measurements?.windSpeedMs?.modelTime??'',s.measurements?.condition?.modelTime??'',s.measurements?.condition?.gridLatitude??'',s.measurements?.condition?.gridLongitude??''];
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
  const backup={format:'dyp-backup',schemaVersion:1,exportedAt:new Date().toISOString(),sessions,waterStationPreferences:loadStationPreferences()};
  downloadText(JSON.stringify(backup,null,2),'application/json;charset=utf-8',`dyp-backup-${todayName()}.json`);
  showToast(`Backed up ${sessions.length} sessions`);
}

function sanitizeMeasurements(input){
  if(!input||typeof input!=='object'||Array.isArray(input))return {};
  const out={};
  const isoOrBlank=text=>typeof text==='string'&&!Number.isNaN(Date.parse(text))?new Date(text).toISOString():'';
  for(const key of ['waterTemperatureC','airTemperatureC','windSpeedMs','windDirection','condition']){
    const m=input[key];
    if(m?.origin==='open-meteo'){
      const at=isoOrBlank(m.modelTime);if(!at)continue;
      out[key]={origin:'open-meteo',provider:key==='waterTemperatureC'?'Open-Meteo Marine':'Open-Meteo Weather',
        modelTime:at,retrievedAt:isoOrBlank(m.retrievedAt),
        gridDistanceKm:Number.isFinite(m.gridDistanceKm)&&m.gridDistanceKm>=0&&m.gridDistanceKm<10000?m.gridDistanceKm:null,
        ...(key==='waterTemperatureC'?{selectionRule:typeof m.selectionRule==='string'?m.selectionRule.slice(0,60):'',
          coastalArea:typeof m.coastalArea==='string'?m.coastalArea.slice(0,120):'',
          coastalMatch:Boolean(m.coastalMatch),
          waterSelectionNote:typeof m.waterSelectionNote==='string'?m.waterSelectionNote.slice(0,240):''}:{}),
        };
    }else if(m?.origin==='dmi-model' && key!=='waterTemperatureC'){
      const at=isoOrBlank(m.modelTime);if(!at)continue;
      const gridLatitude=Number(m.gridLatitude),gridLongitude=Number(m.gridLongitude);
      if(!Number.isFinite(gridLatitude)||gridLatitude < -90||gridLatitude>90||!Number.isFinite(gridLongitude)||gridLongitude < -180||gridLongitude>180)continue;
      const land=Number(m.landPercent);
      out[key]={origin:'dmi-model',provider:'DMI HARMONIE DINI',collection:DMI_FORECAST_COLLECTION,modelTime:at,
        retrievedAt:isoOrBlank(m.retrievedAt),gridLatitude,gridLongitude,
        gridDistanceKm:Number.isFinite(m.gridDistanceKm)&&m.gridDistanceKm>=0&&m.gridDistanceKm<=8?m.gridDistanceKm:null,
        landPercent:m.landPercent!==null&&m.landPercent!==undefined&&Number.isFinite(land)&&land>=0&&land<=1?land:null};
    }else if(m?.origin==='dmi' && key!=='condition'){
      const at=isoOrBlank(m.observedAt);
      if(!at||typeof m.stationId!=='string'||!m.stationId||m.stationId.length>60)continue;
      out[key]={origin:'dmi',provider:'DMI Open Data',observedAt:at,retrievedAt:isoOrBlank(m.retrievedAt),
        stationId:m.stationId,stationName:typeof m.stationName==='string'?m.stationName.slice(0,150):'',
        stationDistanceKm:Number.isFinite(m.stationDistanceKm)&&m.stationDistanceKm>=0&&m.stationDistanceKm<200?m.stationDistanceKm:null,
        ...(key==='waterTemperatureC'?{selectionRule:typeof m.selectionRule==='string'?m.selectionRule.slice(0,60):'',
        coastalArea:typeof m.coastalArea==='string'?m.coastalArea.slice(0,120):'',
        coastalMatch:Boolean(m.coastalMatch),waterSelectionNote:typeof m.waterSelectionNote==='string'?m.waterSelectionNote.slice(0,240):''}:{}),};
    }
  }
  return out;
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
    measurements:sanitizeMeasurements(s.measurements),waterSourceMode:WATER_SOURCE_MODES.includes(s.waterSourceMode)?s.waterSourceMode:'coastal-first',
    weatherSourceMode:WEATHER_SOURCE_MODES.includes(s.weatherSourceMode)?s.weatherSourceMode:'dmi-model',
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
    const restoredPrefs={};
    if(backup.waterStationPreferences&&typeof backup.waterStationPreferences==='object'&&!Array.isArray(backup.waterStationPreferences)){
      for(const [key,pref] of Object.entries(backup.waterStationPreferences).slice(0,1000)){
        if(typeof key==='string'&&key.length<=120&&(key.startsWith('place:')||key.startsWith('gps:'))&&
          typeof pref?.stationId==='string'&&/^[a-z0-9_-]{1,35}$/i.test(pref.stationId)){
          restoredPrefs[key]={stationId:pref.stationId,stationName:typeof pref.stationName==='string'?pref.stationName.slice(0,150):'',updatedAt:new Date().toISOString()};
        }
      }
    }
    const existingPrefs=loadStationPreferences(),newPrefs=Object.fromEntries(Object.entries(restoredPrefs).filter(([k])=>!(k in existingPrefs)));
    if(!newRecords.length&&!Object.keys(newPrefs).length){showToast('Nothing new to import');return;}
    if(!confirm(`Import ${newRecords.length} new dip${newRecords.length===1?'':'s'} and ${Object.keys(newPrefs).length} saved station preference${Object.keys(newPrefs).length===1?'':'s'}? Existing data will not be changed.`))return;
    if(newRecords.length)await putImportedRecords(newRecords);
    if(Object.keys(newPrefs).length)localStorage.setItem(WATER_STATION_PREF_KEY,JSON.stringify({...existingPrefs,...newPrefs}));
    await readSessions();renderHome();showToast(`Imported ${newRecords.length} sessions and ${Object.keys(newPrefs).length} preferences`);
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
  try{await clearSessions();localStorage.removeItem(WATER_STATION_PREF_KEY);await readSessions();renderStorageStatus();navigate('home');showToast('All local sessions and saved stations deleted');}
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
  $('refresh-conditions-btn').addEventListener('click',fetchConditions);
  $('save-station-btn').addEventListener('click',saveChosenStation);
  $('clear-station-btn').addEventListener('click',()=>{
    if(!forgetPreferredStation())return;
    $('field-water-mode').value='coastal-first';
    // No silently stale old station measurement after removing the remembered choice.
    if(isAutoMeasurement(draftMeasurements.waterTemperatureC)){$('field-water').value='';delete draftMeasurements.waterTemperatureC;}
    renderStationCandidates();renderMeasurementSources();autoSaveDraft();
    setLookupFeedback('Saved station cleared. Refresh to apply coastal-aware automatic selection.');
  });
  $('field-place').addEventListener('change',()=>{
    waterStationCandidates=rankWaterStations(waterStationCandidates,draftGPS,preferredStationId());
    renderStationCandidates();
  });
  $('field-water-mode').addEventListener('change',()=>{
    ++conditionRequestSerial;
    // An old *auto-filled* water temperature must not remain under a new selection policy.
    if(isAutoMeasurement(draftMeasurements.waterTemperatureC)){
      $('field-water').value='';delete draftMeasurements.waterTemperatureC;
    }
    renderStationCandidates();renderMeasurementSources();
    setLookupFeedback('Water source preference updated. Tap Refresh conditions for a new reading; manual water entries remain unchanged.');
    autoSaveDraft();
  });
  $('field-weather-mode').addEventListener('change',()=>{
    ++conditionRequestSerial;
    for(const id of ['field-air','field-wind','field-direction','field-weather']){
      const key=CONDITION_FIELDS[id];
      if(isAutoMeasurement(draftMeasurements[key])){$(id).value='';delete draftMeasurements[key];}
    }
    renderMeasurementSources();
    setLookupFeedback('Weather source changed. Tap Refresh conditions to update; manual entries remain untouched.');
    autoSaveDraft();
  });
  $('clear-location-btn').addEventListener('click',()=>{++conditionRequestSerial;draftGPS=null;waterStationCandidates=[];candidateLookupStatus='';clearModelledFields();renderGPS();renderStationCandidates();setLookupFeedback('GPS cleared; previous model estimates removed. Manual entries were kept.');autoSaveDraft();});
  for(const id of Object.keys(CONDITION_FIELDS)){
    $(id).addEventListener('input',noteManualFieldChange);
    $(id).addEventListener('change',noteManualFieldChange);
  }
  $('session-form').addEventListener('input',autoSaveDraft);
  $('session-form').addEventListener('change',autoSaveDraft);
  $('field-datetime').addEventListener('input',syncDatetimeDisplay);
  $('field-datetime').addEventListener('change',()=>{syncDatetimeDisplay();++conditionRequestSerial;clearModelledFields();setLookupFeedback('Session time changed; old estimates removed. Tap Refresh conditions to fetch for the new time.');autoSaveDraft();});
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
