import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";

// ─── SUPABASE ────────────────────────────────────────────────
const SUPA_URL  = "https://xwmnkaioxnxhzbbldzch.supabase.co";
const SUPA_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3bW5rYWlveG54aHpiYmxkemNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxNjY3NjgsImV4cCI6MjA4OTc0Mjc2OH0.mmNWCDeQnvA5p_xI3gm6x3Twc5P78mY0_8zC9fm1nLg";
const supabase  = createClient(SUPA_URL, SUPA_KEY);

// ─── DB HELPERS ──────────────────────────────────────────────
// Převod snake_case řádku z DB → camelCase objekt pro app
function dbToStore(r){
  return {
    id: r.id, name: r.name, hours: r.hours||"",
    breakRules: r.break_rules||[],
    defaultTimes: r.default_times||{},
  };
}
function dbToEmp(r){
  return {
    id: r.id,
    firstName: r.first_name, lastName: r.last_name||"",
    mainStore: r.main_store,
    extraStores: r.extra_stores||[],
    role: r.role||"",
    contractHoursDay: r.contract_hours_day,
    contractHoursWeek: r.contract_hours_week,
    vacHours: r.vac_hours,
    vacAdjustment: r.vac_adjustment||0,
    kpdStart: r.kpd_start||0,
    startDate: r.start_date||null,
    active: r.active,
    customTimes: r.custom_times||{},
  };
}
function empToDB(e){
  return {
    id: e.id,
    first_name: e.firstName, last_name: e.lastName||"",
    main_store: e.mainStore,
    extra_stores: e.extraStores||[],
    role: e.role||"",
    contract_hours_day: e.contractHoursDay,
    contract_hours_week: e.contractHoursWeek,
    vac_hours: e.vacHours,
    vac_adjustment: e.vacAdjustment||0,
    kpd_start: e.kpdStart||0,
    start_date: e.startDate||null,
    active: e.active,
    custom_times: e.customTimes||{},
  };
}
function dbToHoliday(r){
  return { date: r.date, name: r.name, open: r.open, storeHours: r.store_hours||{} };
}
function holidayToDB(h){
  return { date: h.date, name: h.name, open: h.open, store_hours: h.storeHours||{} };
}

// ─── KONFIGURACE ─────────────────────────────────────────────
const APP_START = {year:2026, month:2}; // brezen 2026 (month 0-indexed) – začátek systému
const C = {
  work:"#ffffff", dayOff:"#E8F5E9", vacation:"#E3F2FD", sick:"#F5F5F5",
  ocr:"#FFF9C4", obstacle:"#FFF3E0", holidayOpen:"#F1F8E9", holidayClose:"#FFEBEE",
  modified:"#FFFDE7", mirror:"#F0F4FF", otherStore:"#EDEDF5",
  border:"#E8E8F0", bg:"#F7F8FC", topbar:"#1a1a2e",
};
const TYPE_META = {
  work:        { label:"Práce",           color:C.work,        text:"#1a1a2e" },
  dayOff:      { label:"Volno",           color:C.dayOff,      text:"#2e7d32" },
  vacation:    { label:"Dovolena",        color:C.vacation,    text:"#1565c0" },
  sick:        { label:"Nemoc",           color:C.sick,        text:"#616161" },
  ocr:         { label:"OČR",            color:C.ocr,         text:"#f57f17" },
  obstacle:    { label:"Překážka",        color:C.obstacle,    text:"#e65100" },
  holidayOpen: { label:"Svátek otevřeno", color:C.holidayOpen, text:"#33691e" },
  holidayClose:{ label:"Svátek zavřeno",  color:C.holidayClose,text:"#b71c1c" },
};
const TYPE_SHORT = { vacation:"DOV", sick:"NEM", dayOff:"V", obstacle:"PŘE", holidayOpen:"SV.O", holidayClose:"SV.Z" };
const STORE_SHORT = {1:"ST", 2:"BL", 3:"PE"};

// Převod české diakritiky na ASCII pro PDF export (jsPDF helvetica nepodporuje Unicode)
function cz(s){ return String(s)
  .replace(/[áÁ]/g,"a").replace(/[éÉ]/g,"e").replace(/[íÍ]/g,"i")
  .replace(/[óÓ]/g,"o").replace(/[úÚůŮ]/g,"u").replace(/[ýÝ]/g,"y")
  .replace(/[čČ]/g,"c").replace(/[ďĎ]/g,"d").replace(/[ěĚ]/g,"e")
  .replace(/[ňŇ]/g,"n").replace(/[řŘ]/g,"r").replace(/[šŠ]/g,"s")
  .replace(/[ťŤ]/g,"t").replace(/[žŽ]/g,"z").replace(/[ľĽ]/g,"l")
  .replace(/[ôÔ]/g,"o").replace(/[ä]/g,"a").replace(/[ö]/g,"o");
}
const DOW_LBL = ["Po","Út","St","Čt","Pá","So","Ne"];
const MONTHS = ["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

const HALF_HOURS = [];
for(let h=0;h<24;h++) for(let m=0;m<60;m+=30)
  HALF_HOURS.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

// ─── PŘESTÁVKY ───────────────────────────────────────────────
// Pravidla přestávek per prodejna: [{minMinutes, breakMinutes}] seřazeno od největšího
// Výchozí: <360min=0, 360-480=30, >=480=60
const DEFAULT_BREAK_RULES = [
  { minMinutes: 480, breakMinutes: 60 }, // ≥8h → 60min
  { minMinutes: 360, breakMinutes: 30 }, // ≥6h → 30min
  { minMinutes: 0,   breakMinutes: 0  }, // <6h → 0
];

function calcBreak(from, to, breakRules) {
  if (!from||!to) return 0;
  const [fh,fm]=from.split(":").map(Number), [th,tm]=to.split(":").map(Number);
  const phys=(th*60+tm)-(fh*60+fm);
  const rules=[...breakRules].sort((a,b)=>b.minMinutes-a.minMinutes);
  for(const r of rules) if(phys>=r.minMinutes) return r.breakMinutes;
  return 0;
}
function calcWorked(from, to, breakRules) {
  if(!from||!to) return 0;
  const [fh,fm]=from.split(":").map(Number), [th,tm]=to.split(":").map(Number);
  const phys=(th*60+tm)-(fh*60+fm);
  return Math.max(0,(phys-calcBreak(from,to,breakRules))/60);
}

// Pro split směnu (více segmentů): přestávka se počítá z celkového rozsahu dne
// podle pravidel hlavní prodejny zaměstnance, ne per-segment
function calcSplitWorked(segs, mainStoreId, stores) {
  if(!segs||segs.length===0) return 0;
  if(segs.length===1) return calcWorked(segs[0].from, segs[0].to, getBreakRules(segs[0].locationStoreId||segs[0].loc||mainStoreId, stores));
  // Seřaď segmenty chronologicky
  const sorted = [...segs].sort((a,b)=>{
    const ta=a.from?a.from.split(":").map(Number).reduce((h,m,i)=>i===0?h*60+m:h+m,0):0;
    const tb=b.from?b.from.split(":").map(Number).reduce((h,m,i)=>i===0?h*60+m:h+m,0):0;
    return ta-tb;
  });
  const dayFrom = sorted[0].from;
  const dayTo   = sorted[sorted.length-1].to;
  // Fyzický čas celého dne
  const [fh,fm]=dayFrom.split(":").map(Number), [th,tm]=dayTo.split(":").map(Number);
  const physTotal = (th*60+tm)-(fh*60+fm);
  // Přestávka podle pravidel hlavní prodejny pro celkový rozsah
  const brRules = getBreakRules(mainStoreId, stores);
  const breakMin = calcBreak(dayFrom, dayTo, brRules);
  return Math.max(0, (physTotal - breakMin) / 60);
}
function shiftLabel(from, to) {
  if(!from||!to) return "";
  const fmt=t=>{const[h,m]=t.split(":");return m==="00"?h.replace(/^0/,""):`${h.replace(/^0/,"")}:${m}`;};
  return `${fmt(from)}–${fmt(to)}`;
}

// ─── PRODEJNY ────────────────────────────────────────────────
const INIT_STORES = [
  { id:1, name:"Strakonice", hours:"Po–So 9:00–19:00, Ne 9:00–18:00",
    breakRules: JSON.parse(JSON.stringify(DEFAULT_BREAK_RULES)),
    defaultTimes: {
      h8: { weekday:["09:00","19:00"], saturday:["09:00","19:00"], sunday:["09:00","18:00"] },
      h6: {
        fullDay:   { weekday:["09:00","19:00"], saturday:["09:00","19:00"], sunday:["09:00","18:00"] },
        morning:   { weekday:["09:00","14:00"], saturday:["09:00","14:00"], sunday:["09:00","14:00"] },
        afternoon: { weekday:["14:00","19:00"], saturday:["14:00","19:00"], sunday:["14:00","18:00"] },
        custom1:   { label:"9:00–15:30", weekday:["09:00","15:30"], saturday:["09:00","15:30"], sunday:["09:00","15:30"] },
        custom2:   { label:"9:00–16:30", weekday:["09:00","16:30"], saturday:["09:00","16:30"], sunday:["09:00","16:30"] },
      },
    },
  },
  { id:2, name:"Blatná", hours:"Po–Pá 8:00–17:00, So 8:00–12:00",
    breakRules: JSON.parse(JSON.stringify(DEFAULT_BREAK_RULES)),
    defaultTimes: {
      h8: { weekday:["08:00","17:00"], saturday:["08:00","12:00"], sunday:null },
      h6: {
        fullDay:   { weekday:["08:00","17:00"], saturday:["08:00","12:00"], sunday:null },
        morning:   { weekday:["08:00","13:00"], saturday:["08:00","12:00"], sunday:null },
        afternoon: { weekday:["13:00","17:00"], saturday:null, sunday:null },
        custom1:   { label:"8:00–14:30", weekday:["08:00","14:30"], saturday:["08:00","14:30"], sunday:null },
        custom2:   { label:"8:00–15:30", weekday:["08:00","15:30"], saturday:["08:00","15:30"], sunday:null },
      },
    },
  },
  { id:3, name:"Pelhřimov", hours:"Po–So 9:00–19:00, Ne 9:00–18:00",
    breakRules: JSON.parse(JSON.stringify(DEFAULT_BREAK_RULES)),
    defaultTimes: {
      h8: { weekday:["09:00","19:00"], saturday:["09:00","19:00"], sunday:["09:00","18:00"] },
      h6: {
        fullDay:   { weekday:["09:00","19:00"], saturday:["09:00","19:00"], sunday:["09:00","18:00"] },
        morning:   { weekday:["09:00","14:00"], saturday:["09:00","14:00"], sunday:["09:00","14:00"] },
        afternoon: { weekday:["14:00","19:00"], saturday:["14:00","19:00"], sunday:["14:00","18:00"] },
        custom1:   { label:"9:00–15:30", weekday:["09:00","15:30"], saturday:["09:00","15:30"], sunday:["09:00","15:30"] },
        custom2:   { label:"9:00–16:30", weekday:["09:00","16:30"], saturday:["09:00","16:30"], sunday:["09:00","16:30"] },
      },
    },
  },
];

// ─── ZAMĚSTNANCI ─────────────────────────────────────────────
// customTimes: { [storeId]: { weekday:[from,to], saturday:[from,to], sunday:[from,to] } }
// Pokud customTimes[storeId] existuje → použít místo defaultTimes prodejny
// extraStores: [2,3] → zobrazí se jako read-only v těchto prodejnách, edituje vedoucí mainStore
// contractHoursDay  = hodiny za odpracovaný den (pro výpočet dovolené, přestávek)
// contractHoursWeek = fond hodin za týden (pro výpočet přesčasu)
const INIT_EMPS = [
  {id:1, firstName:"Voneš",     lastName:"",     mainStore:1, extraStores:[],    role:"Vedoucí prodavač",   contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:2, firstName:"Šusta",     lastName:"Petr", mainStore:1, extraStores:[2],   role:"Zástupce vedoucího", contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:3, firstName:"Moláček",   lastName:"",     mainStore:1, extraStores:[],    role:"Prodavač",           contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:4, firstName:"Staněk",    lastName:"",     mainStore:1, extraStores:[],    role:"Prodavač",           contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:5, firstName:"Komínková", lastName:"",     mainStore:1, extraStores:[],    role:"Prodavač",           contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:6, firstName:"Přibová",   lastName:"",     mainStore:1, extraStores:[],    role:"Prodavač",           contractHoursDay:6, contractHoursWeek:30, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:7, firstName:"Havelka",   lastName:"",     mainStore:1, extraStores:[],    role:"Prodavač",           contractHoursDay:6, contractHoursWeek:30, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:8, firstName:"Kříž",      lastName:"",     mainStore:1, extraStores:[2],   role:"Rozvoz",             contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true,
    customTimes:{
      1:{ weekday:["09:00","18:00"], saturday:null, sunday:null },
      2:{ weekday:["08:00","17:00"], saturday:null, sunday:null },
    }
  },
  {id:9, firstName:"Míka",      lastName:"",     mainStore:2, extraStores:[],    role:"Vedoucí prodavač",   contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:10,firstName:"Štefanová", lastName:"",     mainStore:2, extraStores:[],    role:"Prodavač",           contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:11,firstName:"Michálek",  lastName:"",     mainStore:2, extraStores:[],    role:"Prodavač",           contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:12,firstName:"Martinec",  lastName:"",     mainStore:3, extraStores:[],    role:"Vedoucí prodavač",   contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:13,firstName:"Bímon",     lastName:"",     mainStore:3, extraStores:[],    role:"Zástupce vedoucího", contractHoursDay:8, contractHoursWeek:40, vacHours:160, kpdStart:0, active:true, customTimes:{}},
  {id:14,firstName:"Jankovský", lastName:"",     mainStore:1, extraStores:[2,3], role:"Majitel",            contractHoursDay:8, contractHoursWeek:40, vacHours:0,   kpdStart:0, active:true, customTimes:{}},
  {id:15,firstName:"Šustrová",  lastName:"",     mainStore:1, extraStores:[],    role:"Účetní",             contractHoursDay:4, contractHoursWeek:20, vacHours:80,  kpdStart:0, active:true, customTimes:{}},
];

// ─── ČASY SMĚN ───────────────────────────────────────────────
// Vrátí [from,to] pro zaměstnance na daný den.
// Priorita: 1) customTimes zaměstnance pro prodejnu, 2) defaultTimes prodejny
// Pomocník – vrátí contractHoursDay bezpečně (zpětná kompatibilita s "contract")
function empContractDay(emp) { return emp.contractHoursDay ?? emp.contract ?? 8; }
function empContractWeek(emp){ return emp.contractHoursWeek ?? ((emp.contract??8)*5); }

// Priorita: 0) svátek se zkrácenou dobou per prodejna (otevřeno i zavřeno), 1) customTimes zaměstnance, 2) defaultTimes prodejny
function getEmpShiftTimes(emp, storeId, shiftType, dow, stores, patCellObj, holiday) {
  // Svátek se nastaveným časem – nejvyšší priorita (bez ohledu na open/closed)
  const holStore = holiday?.storeHours?.[storeId];
  if(holStore?.from && holStore?.to) return [holStore.from, holStore.to];

  // Pokud je v patCellObj vlastní čas (shift:"custom"), použij ho
  if(patCellObj&&typeof patCellObj==="object"&&patCellObj.shift==="custom"){
    return [patCellObj.from||"", patCellObj.to||""];
  }
  const dk = dow===6?"sunday":dow===5?"saturday":"weekday";
  const ct = emp.customTimes?.[storeId];
  if (ct) {
    const t = ct[dk];
    return t || ["",""];
  }
  const store = stores.find(s=>s.id===storeId);
  if (!store) return ["",""];
  const dt = store.defaultTimes;
  const hd = empContractDay(emp);
  if (hd >= 7) return dt?.h8?.[dk] || ["",""];
  return dt?.h6?.[shiftType]?.[dk] || ["",""];
}

function getBreakRules(storeId, stores) {
  return stores.find(s=>s.id===storeId)?.breakRules || DEFAULT_BREAK_RULES;
}

// ─── VZORY ───────────────────────────────────────────────────
// Buňka: null=volno | "work"|"morning"|"afternoon"|"fullDay"|"custom1"|"custom2"
//   nebo objekt {shift, loc} pro sdílené zaměstnance (loc=storeId kde pracuje)
const makeDefaultPatterns = () => ({
  1: {
    odd: [
      [null,"work","work","work","work",null,null],   // Voneš
      ["work","work","work",null,null,"work","work"], // Šusta
      ["work",null,null,"work","work","work","work"], // Moláček
      [null,"work","work","work","work",null,null],   // Staněk
      ["work","work",null,null,"work","work","work"], // Komínková
      ["afternoon","afternoon","afternoon",null,null,"fullDay","fullDay"], // Přibová
      ["morning",null,"morning","fullDay","fullDay",null,null],            // Havelka
      // Kříž: Po/St/Pá=ST(1), Út/Čt=BL(2), So/Ne=volno
      [{shift:"work",loc:1},{shift:"work",loc:2},{shift:"work",loc:1},{shift:"work",loc:2},{shift:"work",loc:1},null,null],
      [null,null,null,null,null,null,null], // Jankovský
    ],
    even: [
      ["work","work",null,null,"work","work","work"],
      [null,"work","work","work","work",null,null],
      [null,"work","work","work","work",null,null],
      ["work","work","work",null,null,"work","work"],
      ["work",null,"work","work","work",null,null],
      ["morning","morning",null,"fullDay","fullDay",null,null],
      ["afternoon","afternoon","afternoon",null,null,"fullDay","fullDay"],
      [{shift:"work",loc:1},{shift:"work",loc:2},{shift:"work",loc:1},{shift:"work",loc:2},{shift:"work",loc:1},null,null],
      [null,null,null,null,null,null,null],
    ],
  },
  2: {
    flat: [
      ["work","work","work","work","work",null,null], // Míka
      ["work","work","work","work","work",null,null], // Štefanová
      ["work","work","work","work","work",null,null], // Michálek
    ],
  },
  3: { odd:[], even:[] },
});

// ─── HELPERS ────────────────────────────────────────────────
function getIsoWeek(date) {
  const d=new Date(date); d.setHours(0,0,0,0);
  d.setDate(d.getDate()+4-(d.getDay()||7));
  const ys=new Date(d.getFullYear(),0,1);
  return Math.ceil(((d-ys)/86400000+1)/7);
}
function getWeekType(date) { return getIsoWeek(date)%2===1?"odd":"even"; }
const getDim=(y,m)=>new Date(y,m+1,0).getDate();
const getDow=(y,m,d)=>{const w=new Date(y,m,d).getDay();return w===0?6:w-1;};
const fmtDate=(y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const parseDate=s=>{const p=s.split("-");return new Date(+p[0],+p[1]-1,+p[2]);};
// Fond hodin dle ZP: čistý počet Po–Pá v měsíci, svátky se NEodečítají z fondu
// (svátky jsou evidovány zvlášť jako "svátkové hodiny")
function getWorkingDays(y,m,holidays){
  let c=0;
  for(let d=1;d<=getDim(y,m);d++)
    if(getDow(y,m,d)<5) c++;
  return c;
}
// Celkový nárok dovolené = vacHours + vacAdjustment
function empVacTotal(emp){ return (emp.vacHours||0) + (emp.vacAdjustment||0); }

// Vrátí startDate zaměstnance jako Date objekt nebo null
function empStartDate(emp){
  if(!emp.startDate) return null;
  const d = new Date(emp.startDate);
  return isNaN(d) ? null : d;
}
// Vrátí true pokud je zaměstnanec aktivní v daném měsíci (year, month 0-indexed)
function isEmpActiveInMonth(emp, year, month){
  const sd = empStartDate(emp);
  if(!sd) return true;
  const appStart = new Date(2026,1,1);
  if(sd < appStart) return true;
  if(year > sd.getFullYear()) return true;
  if(year === sd.getFullYear() && month >= sd.getMonth()) return true;
  return false;
}
// Vrátí poměrný počet pracovních dní pro nástupní měsíc
function getWorkingDaysFrom(y, m, fromDate, holidays){
  let c=0;
  const startDay = fromDate.getFullYear()===y && fromDate.getMonth()===m ? fromDate.getDate() : 1;
  for(let d=startDay;d<=getDim(y,m);d++)
    if(getDow(y,m,d)<5) c++;
  return c;
}
// Fond hodin s ohledem na datum nástupu
function getEmpFund(emp, year, month, holidays){
  const sd = empStartDate(emp);
  const appStart = new Date(2026,1,1);
  if(!sd || sd < appStart){
    return getWorkingDays(year, month, holidays) * empContractDay(emp);
  }
  if(sd.getFullYear()===year && sd.getMonth()===month){
    return getWorkingDaysFrom(year, month, sd, holidays) * empContractDay(emp);
  }
  return getWorkingDays(year, month, holidays) * empContractDay(emp);
}

// Počet svátků zavřeno v daném měsíci (pro informaci)
function getHolidayDays(y,m,holidays){
  let c=0;
  for(let d=1;d<=getDim(y,m);d++)
    if(getDow(y,m,d)<5&&holidays.find(h=>h.date===fmtDate(y,m,d)&&!h.open)) c++;
  return c;
}
function getPatCell(patterns, storeId, empIdx, date) {
  const pat=patterns[storeId]; if(!pat) return null;
  const wt=storeId===2?"flat":getWeekType(date);
  const rows=pat[wt]; if(!rows||empIdx>=rows.length) return null;
  const dow=date.getDay()===0?6:date.getDay()-1;
  return rows[empIdx]?.[dow]??null;
}
function schedKey(empId,ds,employees){
  const emp=employees.find(e=>e.id===empId);
  return `${emp?.mainStore||1}-${empId}-${ds}`;
}
function getSchedCell(sched,empId,ds,employees){
  return sched[schedKey(empId,ds,employees)]||null;
}

// ─── SVÁTKY ──────────────────────────────────────────────────
const DEFAULT_HOLIDAYS = [
  {date:"2026-01-01",name:"Nový rok",open:false},
  {date:"2026-04-03",name:"Velký pátek",open:true},
  {date:"2026-04-06",name:"Velikonoční pondělí",open:false},
  {date:"2026-05-01",name:"Svátek práce",open:true},
  {date:"2026-05-08",name:"Den vítězství",open:false},
  {date:"2026-07-05",name:"Cyril a Metoděj",open:true},
  {date:"2026-07-06",name:"Jan Hus",open:true},
  {date:"2026-09-28",name:"Den české státnosti",open:false},
  {date:"2026-10-28",name:"Vznik Československa",open:false},
  {date:"2026-11-17",name:"Den svobody",open:true},
  {date:"2026-12-24",name:"Štědrý den",open:true,storeHours:{1:{from:"08:00",to:"12:00"},2:{from:"08:00",to:"12:00"},3:{from:"08:00",to:"12:00"}}},
  {date:"2026-12-25",name:"1. svátek vánoční",open:false},
  {date:"2026-12-26",name:"2. svátek vánoční",open:false},
];

// ─── UI ──────────────────────────────────────────────────────
function Badge({color,textColor,children,style={}}){
  return <span style={{background:color,color:textColor,padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700,border:"1px solid rgba(0,0,0,0.07)",whiteSpace:"nowrap",...style}}>{children}</span>;
}
function Btn({children,onClick,variant="primary",small,style={},disabled,active}){
  const v={
    primary:{background:C.topbar,color:"#fff",border:"none"},
    secondary:{background:"#f5f5f5",color:"#333",border:`1.5px solid ${C.border}`},
    ghost:{background:"transparent",color:"#555",border:`1.5px solid ${C.border}`},
    danger:{background:"#ffebee",color:"#c62828",border:"1.5px solid #ffcdd2"},
    store:{background:active?"#1a1a2e":"#fff",color:active?"#fff":"#555",border:`1.5px solid ${active?"#1a1a2e":C.border}`},
  };
  return <button onClick={onClick} disabled={disabled} style={{padding:small?"4px 12px":"8px 18px",borderRadius:8,fontSize:small?12:14,fontWeight:600,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,transition:"all 0.12s",...v[variant],...style}}>{children}</button>;
}
function Modal({open,onClose,title,children,width=520}){
  if(!open) return null;
  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,padding:12}}>
    <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:14,padding:28,width,maxWidth:"96vw",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.18)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <h3 style={{margin:0,fontSize:18,fontWeight:800,color:C.topbar}}>{title}</h3>
        <button onClick={onClose} style={{border:"none",background:"none",fontSize:24,cursor:"pointer",color:"#bbb",lineHeight:1}}>×</button>
      </div>
      {children}
    </div>
  </div>;
}
function FLabel({children,style={}}){
  return <label style={{fontSize:11,fontWeight:700,color:"#888",display:"block",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.06em",...style}}>{children}</label>;
}
function FInput({label,value,onChange,type="text",placeholder,style={},inputStyle={}}){
  return <div style={style}><FLabel>{label}</FLabel>
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{padding:"7px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:14,width:"100%",boxSizing:"border-box",...inputStyle}}/>
  </div>;
}
function FSel({label,value,onChange,options,style={}}){
  return <div style={style}><FLabel>{label}</FLabel>
    <select value={value} onChange={e=>onChange(e.target.value)}
      style={{padding:"7px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:14,background:"#fff",width:"100%",boxSizing:"border-box"}}>
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>;
}
function TimeSelect({value,onChange,style={}}){
  const opts=[{value:"",label:"—"},...HALF_HOURS.filter(t=>{const h=parseInt(t);return h>=6&&h<=22;}).map(t=>({value:t,label:t}))];
  return <select value={value||""} onChange={e=>onChange(e.target.value||"")}
    style={{padding:"5px 6px",borderRadius:6,border:`1.5px solid ${C.border}`,fontSize:13,background:"#fff",...style}}>
    {opts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
  </select>;
}

// ─── EMPLOYEE FORM ───────────────────────────────────────────
function EmployeeForm({initial, stores, onSave, onClose}){
  const [form, setForm] = useState({...initial, customTimes:{...initial.customTimes}});
  const [tab, setTab] = useState("basic");

  const upd=(f,v)=>setForm(p=>({...p,[f]:v}));
  const updCT=(storeId,dk,idx,val)=>{
    setForm(p=>{
      const ct={...p.customTimes};
      if(!ct[storeId]) ct[storeId]={weekday:["",""],saturday:["",""],sunday:["",""]};
      else ct[storeId]={...ct[storeId]};
      const arr=[...(ct[storeId][dk]||["",""])];
      arr[idx]=val;
      ct[storeId]={...ct[storeId],[dk]:arr};
      return {...p,customTimes:ct};
    });
  };
  const toggleCT=(storeId)=>{
    setForm(p=>{
      const ct={...p.customTimes};
      if(ct[storeId]) { const n={...ct}; delete n[storeId]; return {...p,customTimes:n}; }
      const store=stores.find(s=>s.id===storeId);
      const def=store?.defaultTimes?.h8||{};
      ct[storeId]={
        weekday:[...(def.weekday||["",""])],
        saturday:[...(def.saturday||["",""])],
        sunday:[...(def.sunday||["",""])],
      };
      return {...p,customTimes:ct};
    });
  };

  const allStores = stores;
  const extraPossible = allStores.filter(s=>s.id!==form.mainStore);

  const tabs=[{key:"basic",label:"Základní"},{key:"times",label:"⏰ Časy směn"}];

  return <div>
    <div style={{display:"flex",gap:4,marginBottom:20,borderBottom:`1.5px solid ${C.border}`,paddingBottom:0}}>
      {tabs.map(t=><button key={t.key} onClick={()=>setTab(t.key)}
        style={{padding:"8px 16px",background:"none",border:"none",cursor:"pointer",fontWeight:tab===t.key?700:500,fontSize:13,color:tab===t.key?C.topbar:"#888",borderBottom:tab===t.key?"2px solid #4f8ef7":"2px solid transparent",marginBottom:-1.5}}>
        {t.label}
      </button>)}
    </div>

    {tab==="basic"&&<div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{display:"flex",gap:10}}>
        <FInput label="Jméno"    value={form.firstName} onChange={v=>upd("firstName",v)} style={{flex:1}}/>
        <FInput label="Příjmení" value={form.lastName}  onChange={v=>upd("lastName",v)}  style={{flex:1}}/>
      </div>
      <FInput label="Role" value={form.role} onChange={v=>upd("role",v)} placeholder="Vedoucí / Prodavač..."/>
      <FSel label="Hlavní prodejna" value={form.mainStore} onChange={v=>upd("mainStore",Number(v))} options={stores.map(s=>({value:s.id,label:s.name}))}/>
      <div>
        <FLabel>Může pracovat také v <span style={{color:"#bbb",fontWeight:400,fontSize:10}}>(zobrazí se jako sdílený read-only)</span></FLabel>
        <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:4}}>
          {extraPossible.map(s=><label key={s.id} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:13,padding:"6px 10px",background:"#f8f9ff",borderRadius:6,border:`1px solid ${(form.extraStores||[]).includes(s.id)?"#4f8ef7":C.border}`}}>
            <input type="checkbox" checked={(form.extraStores||[]).includes(s.id)}
              onChange={e=>upd("extraStores",e.target.checked?[...(form.extraStores||[]),s.id]:(form.extraStores||[]).filter(i=>i!==s.id))}/>
            <span style={{fontWeight:600}}>{s.name}</span>
            <span style={{fontSize:10,color:"#aaa"}}>{STORE_SHORT[s.id]}</span>
          </label>)}
        </div>
        {(form.extraStores||[]).length>0&&<div style={{fontSize:11,color:"#1565c0",marginTop:6,padding:"4px 8px",background:"#e8f0fe",borderRadius:5}}>
          ✅ Rozvrh edituje vedoucí <strong>{stores.find(s=>s.id===form.mainStore)?.name}</strong> – změny se propíší do dalších prodejen.
        </div>}
      </div>
      <div style={{padding:"12px 14px",background:"#f8f9ff",borderRadius:8,display:"flex",flexDirection:"column",gap:10}}>
        <FLabel>Pracovní úvazek</FLabel>
        <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>
          <FInput label="Hodin / den" type="number" value={form.contractHoursDay??form.contract??8}
            onChange={v=>upd("contractHoursDay",Number(v))} inputStyle={{width:80}} style={{flex:"0 0 auto"}}/>
          <FInput label="Hodin / týden" type="number" value={form.contractHoursWeek??((form.contract??8)*5)}
            onChange={v=>upd("contractHoursWeek",Number(v))} inputStyle={{width:90}} style={{flex:"0 0 auto"}}/>
          <div style={{fontSize:12,color:"#aaa",paddingBottom:8,flex:1}}>
            Fond = pracovní dny × h/den. Přesčas = plánováno − fond.
          </div>
        </div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {[[8,40],[6,30],[4,20],[3,15]].map(([d,w])=><button key={d} onClick={()=>{upd("contractHoursDay",d);upd("contractHoursWeek",w);}}
            style={{padding:"3px 10px",borderRadius:6,border:`1px solid ${C.border}`,background:"#fff",fontSize:12,cursor:"pointer",color:"#555",fontWeight:600}}>
            {d}h/den · {w}h/týden
          </button>)}
        </div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        <FInput label="Dovolená (h/rok)" type="number" value={form.vacHours} onChange={v=>upd("vacHours",Number(v))} style={{flex:1}}/>
        <FInput label="Korekce dovolené (h)" type="number" value={form.vacAdjustment||0} onChange={v=>upd("vacAdjustment",Number(v))} style={{flex:1}}/>
      </div>
      <div style={{fontSize:11,color:"#888",marginTop:-8}}>Celkový nárok: <strong>{(Number(form.vacHours)||0)+(Number(form.vacAdjustment)||0)}h</strong></div>
      <FInput label="Počáteční KPD (hodiny)" type="number" value={form.kpdStart} onChange={v=>upd("kpdStart",Number(v))}/>
      <FInput label="Datum nástupu" type="date" value={form.startDate||""} onChange={v=>upd("startDate",v||null)}/>
      <div style={{fontSize:11,color:"#888",marginTop:-8}}>Pouze u nových zaměstnanců nastoupivších po spuštění aplikace. Před tímto datem se nezobrazuje.</div>
      {initial.id&&<label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:600,cursor:"pointer",padding:"8px 0"}}>
        <input type="checkbox" checked={form.active} onChange={e=>upd("active",e.target.checked)}/>
        Aktivní zaměstnanec
      </label>}
    </div>}

    {tab==="times"&&<div>
      <div style={{fontSize:13,color:"#888",marginBottom:16,padding:"10px 14px",background:"#f8f9ff",borderRadius:8,lineHeight:1.7}}>
        Pokud má zaměstnanec <strong>jiné časy než prodejna</strong> (např. Kříž 9:00–18:00 místo 9:00–19:00),
        zaškrtněte prodejnu a zadejte jeho osobní časy.
        Nezaškrtnuté prodejny používají výchozí časy prodejny.
      </div>
      {stores.map(store=>{
        const hasCT=!!(form.customTimes?.[store.id]);
        const ct=form.customTimes?.[store.id]||{};
        return <div key={store.id} style={{marginBottom:16,border:`1.5px solid ${hasCT?"#4f8ef7":C.border}`,borderRadius:10,overflow:"hidden"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:hasCT?"#eef2ff":"#f8f9ff",cursor:"pointer"}} onClick={()=>toggleCT(store.id)}>
            <input type="checkbox" checked={hasCT} onChange={()=>toggleCT(store.id)} onClick={e=>e.stopPropagation()}/>
            <span style={{fontWeight:700,fontSize:14,color:hasCT?C.topbar:"#888"}}>{store.name}</span>
            {!hasCT&&<span style={{fontSize:11,color:"#bbb"}}>– používá výchozí časy prodejny</span>}
            {hasCT&&<span style={{fontSize:11,color:"#4f8ef7",fontWeight:600}}>– vlastní časy aktivní</span>}
          </div>
          {hasCT&&<div style={{padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
            {[
              {key:"weekday",label:"Pracovní den"},
              {key:"saturday",label:"Sobota"},
              {key:"sunday",label:"Neděle"},
            ].map(({key,label})=>{
              const pair=ct[key]||["",""];
              const w=calcWorked(pair[0],pair[1],getBreakRules(store.id,[...INIT_STORES]));
              return <div key={key} style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{minWidth:110,fontSize:13,color:"#555",fontWeight:600}}>{label}</span>
                <TimeSelect value={pair[0]} onChange={v=>updCT(store.id,key,0,v)}/>
                <span style={{color:"#aaa"}}>–</span>
                <TimeSelect value={pair[1]} onChange={v=>updCT(store.id,key,1,v)}/>
                {pair[0]&&pair[1]&&<span style={{fontSize:11,color:"#aaa",minWidth:60}}>= {w%1===0?w:w.toFixed(1)}h prac.</span>}
                <Btn small variant="ghost" onClick={()=>updCT(store.id,key,0,"") || updCT(store.id,key,1,"")}>Volno</Btn>
              </div>;
            })}
          </div>}
        </div>;
      })}
    </div>}

    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn onClick={()=>onSave(form)} style={{flex:1}}>Uložit</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1}}>Zrušit</Btn>
    </div>
  </div>;
}

// ─── BREAK RULES EDITOR ──────────────────────────────────────
// minMinutes je interně stále v minutách, ale UI zobrazuje hodiny (6, 6.5, 7...)
const HOUR_OPTIONS = [];
for(let h=0;h<=12;h++){
  HOUR_OPTIONS.push({value:h*60, label:`${h}h`});
  if(h<12) HOUR_OPTIONS.push({value:h*60+30, label:`${h}h 30min`});
}

function BreakRulesEditor({rules, onChange}){
  const sorted=[...rules].sort((a,b)=>b.minMinutes-a.minMinutes);
  const fmtH=min=>{ const h=Math.floor(min/60),m=min%60; return m>0?`${h}h ${m}min`:`${h}h`; };
  return <div>
    <div style={{fontSize:12,color:"#888",marginBottom:10,lineHeight:1.6}}>
      Nastavte délku směny (v hodinách) a odpovídající přestávku (v minutách). Pravidla se vyhodnocují od nejvyššího prahu.
    </div>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
      <thead><tr style={{background:"#f8f9ff"}}>
        <th style={{padding:"6px 10px",textAlign:"left",fontWeight:700,color:"#888",fontSize:11,borderBottom:`1.5px solid ${C.border}`}}>Délka směny ≥</th>
        <th style={{padding:"6px 10px",textAlign:"center",fontWeight:700,color:"#888",fontSize:11,borderBottom:`1.5px solid ${C.border}`}}>Přestávka (min)</th>
        <th style={{padding:"6px 10px",textAlign:"center",fontWeight:700,color:"#888",fontSize:11,borderBottom:`1.5px solid ${C.border}`}}>Odpracováno příklad</th>
        <th style={{borderBottom:`1.5px solid ${C.border}`,width:30}}></th>
      </tr></thead>
      <tbody>{sorted.map((r,i)=>{
        const exNet=r.minMinutes-r.breakMinutes;
        const exH=exNet/60;
        return <tr key={i} style={{background:i%2===0?"#fff":"#fafafe"}}>
          <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}>
            <select value={r.minMinutes} onChange={e=>{
              const nr=sorted.map((x,j)=>j===i?{...x,minMinutes:Number(e.target.value)}:x);
              onChange(nr);
            }} style={{padding:"5px 8px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,background:"#fff",minWidth:110}}>
              {HOUR_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </td>
          <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`}}>
            <input type="number" value={r.breakMinutes} min={0} max={120} step={5}
              onChange={e=>{
                const nr=sorted.map((x,j)=>j===i?{...x,breakMinutes:Number(e.target.value)}:x);
                onChange(nr);
              }} style={{width:64,padding:"5px 6px",borderRadius:6,border:`1px solid ${C.border}`,fontSize:13,textAlign:"center"}}/>
            <span style={{fontSize:11,color:"#aaa",marginLeft:4}}>min</span>
          </td>
          <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#555",fontSize:12}}>
            {fmtH(r.minMinutes)} − {r.breakMinutes}min přest. = <strong>{exH%1===0?exH:exH.toFixed(1)}h</strong> prac.
          </td>
          <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`,textAlign:"center"}}>
            {sorted.length>1&&<button onClick={()=>onChange(sorted.filter((_,j)=>j!==i))}
              style={{border:"none",background:"none",color:"#e57373",cursor:"pointer",fontSize:18,fontWeight:700,lineHeight:1}}>×</button>}
          </td>
        </tr>;
      })}</tbody>
    </table>
    <button onClick={()=>onChange([...sorted,{minMinutes:360,breakMinutes:0}])}
      style={{marginTop:10,border:"none",background:"none",color:"#4f8ef7",fontWeight:700,fontSize:13,cursor:"pointer",padding:"4px 0"}}>
      + Přidat pravidlo
    </button>
    <div style={{marginTop:12,padding:"8px 12px",background:"#f8f9ff",borderRadius:7,fontSize:12,color:"#888"}}>
      💡 Výchozí: ≥8h → 60min · ≥6h → 30min · &lt;6h → 0min
    </div>
  </div>;
}

// ─── PATTERN CELL ────────────────────────────────────────────
function PatternCellComp({value, emp, storeId, dow, stores, onChange}){
  const isShared=(emp.extraStores||[]).length>0;
  const isObj=value&&typeof value==="object";
  // Vlastní čas v vzoru: {shift:"custom",loc,from,to}
  const isCustomTime=isObj&&value.shift==="custom";
  const shiftType=isObj?(value.shift||"work"):(value||"__volno__");
  const locId=isObj?(value.loc||storeId):storeId;
  const isVolno=!value;
  const store=stores.find(s=>s.id===storeId);
  const dk=dow===6?"sunday":dow===5?"saturday":"weekday";
  const dt=store?.defaultTimes;
  const hd=empContractDay(emp);

  // Pro 4h úvazek nebo jiné nestandardní: přidat "Vlastní čas"
  const shiftOpts=hd>=7
    ?[
        {value:"__volno__",label:"Volno"},
        {value:"work",     label:"Práce"},
        {value:"custom",   label:"Vlastní čas…"},
      ]
    :[
        {value:"__volno__",label:"Volno"},
        {value:"fullDay",  label:"Celý den"},
        {value:"morning",  label:"Dopoledne"},
        {value:"afternoon",label:"Odpoledne"},
        {value:"custom1",  label:dt?.h6?.custom1?.label||"Vlastní 1"},
        {value:"custom2",  label:dt?.h6?.custom2?.label||"Vlastní 2"},
        {value:"custom",   label:"Vlastní čas…"},
      ];

  const handleShift=v=>{
    if(v==="__volno__"){onChange(null);return;}
    if(v==="custom"){
      // Prefill z defaultTimes pro tento den
      const def=hd>=7?(dt?.h8?.[dk]||["",""]):(dt?.h6?.fullDay?.[dk]||["",""]);
      onChange({shift:"custom",loc:locId,from:def[0]||"",to:def[1]||""});
      return;
    }
    onChange(isShared?{shift:v,loc:locId}:v);
  };
  const handleLoc=v=>onChange({...(isObj?value:{shift:shiftType}),loc:Number(v)});
  const handleCustomTime=(f,v)=>onChange({...value,[f]:v});

  // Zobrazit výsledný čas pod buňkou
  const showTime=()=>{
    if(!value) return null;
    let fr,to;
    if(isCustomTime){fr=value.from;to=value.to;}
    else {
      const st=isObj?value.shift||"work":value;
      const lId=isObj?(value.loc||storeId):storeId;
      [fr,to]=getEmpShiftTimes({...emp},lId,st,dow,stores);
    }
    if(!fr||!to) return null;
    const lId=isObj?(value.loc||storeId):storeId;
    const h=calcWorked(fr,to,getBreakRules(lId,stores));
    return <div style={{fontSize:9,color:"#aaa",textAlign:"center",marginTop:1}}>
      {shiftLabel(fr,to)} = {h%1===0?h:h.toFixed(1)}h
    </div>;
  };

  const tOpts=HALF_HOURS.filter(t=>{const h=parseInt(t);return h>=5&&h<=22;});

  return <div style={{display:"flex",flexDirection:"column",gap:2}}>
    <select value={isVolno?"__volno__":shiftType} onChange={e=>handleShift(e.target.value)}
      style={{fontSize:11,padding:"3px 4px",borderRadius:5,border:`1px solid ${C.border}`,background:isVolno?"#e8f5e9":isCustomTime?"#fff8e1":"#fff",color:isVolno?"#2e7d32":isCustomTime?"#e65100":"#1a1a2e",fontWeight:700,width:"100%"}}>
      {shiftOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
    {isCustomTime&&<div style={{display:"flex",gap:2,marginTop:1}}>
      <select value={value.from||""} onChange={e=>handleCustomTime("from",e.target.value)}
        style={{fontSize:10,padding:"2px 3px",borderRadius:4,border:`1px solid ${C.border}`,flex:1,background:"#fff8e1"}}>
        <option value="">Od</option>
        {tOpts.map(t=><option key={t} value={t}>{t}</option>)}
      </select>
      <select value={value.to||""} onChange={e=>handleCustomTime("to",e.target.value)}
        style={{fontSize:10,padding:"2px 3px",borderRadius:4,border:`1px solid ${C.border}`,flex:1,background:"#fff8e1"}}>
        <option value="">Do</option>
        {tOpts.map(t=><option key={t} value={t}>{t}</option>)}
      </select>
    </div>}
    {isShared&&!isVolno&&<select value={locId} onChange={e=>handleLoc(e.target.value)}
      style={{fontSize:10,padding:"2px 4px",borderRadius:4,border:`1px solid ${C.border}`,background:"#f0f4ff",color:"#1565c0",fontWeight:700,width:"100%"}}>
      {[emp.mainStore,...(emp.extraStores||[])].map(sid=><option key={sid} value={sid}>{STORE_SHORT[sid]} – {stores.find(s=>s.id===sid)?.name}</option>)}
    </select>}
    {showTime()}
  </div>;
}

// ─── PATTERN EDITOR ──────────────────────────────────────────
function PatternEditor({storeId, employees, patterns, stores, onSave, onClose}){
  const emps=employees.filter(e=>e.active&&e.mainStore===storeId);
  const isBlatna=storeId===2;
  const init=patterns[storeId]||{odd:[],even:[],flat:[]};
  const fill=rows=>{
    const r=rows.map(row=>[...(row||[])]);
    while(r.length<emps.length) r.push(Array(7).fill(null));
    return r.map(row=>{while(row.length<7) row.push(null);return row;});
  };
  const [odd,setOdd]=useState(()=>fill(init.odd||[]));
  const [even,setEven]=useState(()=>fill(init.even||[]));
  const [flat,setFlat]=useState(()=>fill(init.flat||[]));
  const [wk,setWk]=useState("odd");

  const rows=isBlatna?flat:(wk==="odd"?odd:even);
  const setRows=isBlatna?setFlat:(wk==="odd"?setOdd:setEven);
  const updCell=(ei,di,val)=>setRows(r=>{const nr=r.map(row=>[...row]);nr[ei][di]=val;return nr;});

  const weekH=(rows,emp)=>{
    const ei=emps.indexOf(emp); if(!rows[ei]) return 0;
    return rows[ei].reduce((s,v,di)=>{
      if(!v) return s;
      const st=typeof v==="object"?v.shift||"work":v;
      const lId=typeof v==="object"?(v.loc||storeId):storeId;
      const[fr,to]=getEmpShiftTimes(emp,lId,st,di,stores,typeof v==="object"?v:null);
      return s+calcWorked(fr,to,getBreakRules(lId,stores));
    },0);
  };

  return <div>
    {!isBlatna&&<div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center"}}>
      <Btn variant={wk==="odd"?"primary":"ghost"} onClick={()=>setWk("odd")}>Lichý (T1)</Btn>
      <Btn variant={wk==="even"?"primary":"ghost"} onClick={()=>setWk("even")}>Sudý (T2)</Btn>
      <Btn variant="ghost" small style={{marginLeft:"auto"}} onClick={()=>{if(window.confirm("Kopírovat T1 → T2?")) setEven(odd.map(r=>[...r]));}}>Kopírovat T1→T2</Btn>
    </div>}
    {isBlatna&&<div style={{marginBottom:12,padding:"8px 14px",background:"#e8f5e9",borderRadius:8,fontSize:12,color:"#2e7d32",fontWeight:600}}>✅ Blatná – jeden pevný vzor</div>}
    <div style={{marginBottom:12,padding:"8px 14px",background:"#fff8e1",borderRadius:8,fontSize:12,color:"#795548"}}>
      ⏱️ Přestávky se počítají dle pravidel prodejny. Pod buňkou vidíte výsledné hodiny.
    </div>
    <div style={{overflowX:"auto"}}>
      <table style={{borderCollapse:"collapse",width:"100%",fontSize:12}}>
        <thead><tr style={{background:"#f8f9ff"}}>
          <th style={{padding:"8px 10px",textAlign:"left",minWidth:130,borderBottom:`2px solid ${C.border}`,fontSize:11,fontWeight:700,color:"#888"}}>Zaměstnanec</th>
          {DOW_LBL.map((d,i)=><th key={i} style={{padding:"8px 6px",textAlign:"center",minWidth:108,borderBottom:`2px solid ${C.border}`,fontSize:11,fontWeight:700,color:i>=5?"#c62828":"#888",background:i>=5?"#fff8f8":"transparent"}}>{d}</th>)}
          <th style={{padding:"8px 6px",textAlign:"center",minWidth:60,borderBottom:`2px solid ${C.border}`,fontSize:11,fontWeight:700,color:"#888"}}>h/týden</th>
        </tr></thead>
        <tbody>{emps.map((emp,ei)=>{
          const isShared=(emp.extraStores||[]).length>0;
          const wh=weekH(rows,emp).toFixed(1);
          const hasCustom=!!(emp.customTimes?.[storeId]);
          return <tr key={emp.id} style={{background:ei%2===0?"#fff":"#fafafe"}}>
            <td style={{padding:"6px 10px",fontWeight:600,fontSize:12,color:C.topbar,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                {emp.lastName} {emp.firstName}
                {isShared&&<span style={{fontSize:9,background:"#e8f0fe",color:"#1565c0",padding:"1px 4px",borderRadius:3,fontWeight:700}}>SD</span>}
                {hasCustom&&<span style={{fontSize:9,background:"#fff3e0",color:"#e65100",padding:"1px 4px",borderRadius:3,fontWeight:700}}>CT</span>}
              </div>
              <div style={{fontSize:10,color:"#bbb",fontWeight:400}}>{empContractDay(emp)}h/den úvazek</div>
            </td>
            {DOW_LBL.map((_,di)=><td key={di} style={{padding:"3px",borderBottom:`1px solid ${C.border}`,background:di>=5?"#fff8f8":"transparent",verticalAlign:"top"}}>
              <PatternCellComp value={rows[ei]?.[di]??null} emp={emp} storeId={storeId} dow={di} stores={stores} onChange={v=>updCell(ei,di,v)}/>
            </td>)}
            <td style={{padding:"6px",textAlign:"center",fontWeight:800,color:Number(wh)>42?"#c62828":Number(wh)>=30?"#2e7d32":"#555",borderBottom:`1px solid ${C.border}`}}>{wh}h</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div style={{display:"flex",gap:10,marginTop:20}}>
      <Btn onClick={()=>{onSave(storeId,isBlatna?{flat,odd:[],even:[]}:{odd,even,flat:[]});onClose();}} style={{flex:1}}>💾 Uložit vzor</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1}}>Zrušit</Btn>
    </div>
  </div>;
}

// ─── CELL EDITOR (klik v rozvrhu) ────────────────────────────
function CellEditor({emp, date, year, month, current, viewStoreId, stores, employees, patterns, onSave, onClose, onRangeApply, onRangeDelete}){
  const isShared=(emp.extraStores||[]).length>0;
  const ownerStore=stores.find(s=>s.id===emp.mainStore);
  const locOptions=[emp.mainStore,...(emp.extraStores||[])].map(sid=>({value:sid,label:`${STORE_SHORT[sid]} – ${stores.find(s=>s.id===sid)?.name}`}));
  const dow=date.getDay()===0?6:date.getDay()-1;

  const getPatternHours=()=>{
    const mainStoreEmps=employees.filter(e=>e.active&&e.mainStore===emp.mainStore);
    const empIdx=mainStoreEmps.findIndex(e=>e.id===emp.id);
    const pc=getPatCell(patterns,emp.mainStore,empIdx,date);
    if(!pc) return empContractDay(emp);
    const st=typeof pc==="object"?pc.shift||"work":pc;
    const lId=typeof pc==="object"?(pc.loc||emp.mainStore):emp.mainStore;
    const [fr,to]=getEmpShiftTimes(emp,lId,st,dow,stores,typeof pc==="object"?pc:null);
    const h=calcWorked(fr,to,getBreakRules(lId,stores));
    return h>0?h:empContractDay(emp);
  };

  const initSegs=current?.length?current:[{type:"work",from:"",to:"",locationStoreId:viewStoreId}];
  const [segs,setSegs]=useState(initSegs);
  const [rangeMode,setRangeMode]=useState(false);
  const [rangeType,setRangeType]=useState("vacation");
  const [rangeFrom,setRangeFrom]=useState(fmtDate(year,month,date.getDate()));
  const [rangeTo,setRangeTo]=useState(fmtDate(year,month,date.getDate()));
  const [rangeHours,setRangeHours]=useState(()=>getPatternHours());

  const typeOpts=[
    {value:"work",     label:"Práce"},
    {value:"dayOff",   label:"Volno"},
    {value:"vacation", label:"Dovolená"},
    {value:"sick",     label:"Nemoc"},
    {value:"ocr",      label:"OČR"},
    {value:"obstacle", label:"Překážka"},
  ];
  const tOpts=[{value:"",label:"—"},...HALF_HOURS.map(t=>({value:t,label:t}))];
  const updSeg=(i,f,v)=>setSegs(s=>s.map((x,j)=>j===i?{...x,[f]:v}:x));
  const delSeg=i=>setSegs(s=>s.filter((_,j)=>j!==i));
  const brkSeg=seg=>calcBreak(seg.from,seg.to,getBreakRules(seg.locationStoreId||emp.mainStore,stores));
  const wkdSeg=seg=>calcWorked(seg.from,seg.to,getBreakRules(seg.locationStoreId||emp.mainStore,stores));

  const vacHOpts=[];
  for(let h=0.5;h<=12;h+=0.5) vacHOpts.push({value:String(h),label:`${h%1===0?h:h.toFixed(1)}h`});

  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <div style={{fontSize:13,fontWeight:600,color:"#888"}}>
      {DOW_LBL[dow]} {date.getDate()}.{month+1}.{year} — <strong style={{color:C.topbar}}>{emp.lastName} {emp.firstName}</strong>
    </div>
    {isShared&&<div style={{padding:"8px 12px",background:"#e8f0fe",borderRadius:8,fontSize:12,color:"#1565c0",fontWeight:600}}>
      🔗 Sdílený – edituje vedoucí <strong>{ownerStore?.name}</strong>. Propíše se do: {(emp.extraStores||[]).map(id=>stores.find(s=>s.id===id)?.name).join(", ")}
    </div>}
    {segs.map((seg,i)=><div key={i} style={{background:"#f8f9ff",borderRadius:8,padding:12,display:"flex",flexDirection:"column",gap:8,border:`1.5px solid ${C.border}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:11,fontWeight:700,color:"#aaa"}}>ČÁST {i+1}</span>
        {segs.length>1&&<button onClick={()=>delSeg(i)} style={{border:"none",background:"none",color:"#e57373",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>}
      </div>
      <FSel label="Typ" value={seg.type} onChange={v=>{
        updSeg(i,"type",v);
        if((v==="vacation"||v==="sick"||v==="ocr"||v==="obstacle")&&!seg.hours) updSeg(i,"hours",getPatternHours());
      }} options={typeOpts}/>
      {isShared&&seg.type==="work"&&<FSel label="Prodejna" value={seg.locationStoreId||emp.mainStore}
        onChange={v=>updSeg(i,"locationStoreId",Number(v))} options={locOptions}/>}
      {seg.type==="work"&&<div style={{display:"flex",gap:8}}>
        <FSel label="Od" value={seg.from||""} onChange={v=>updSeg(i,"from",v)} options={tOpts} style={{flex:1}}/>
        <FSel label="Do" value={seg.to||""}   onChange={v=>updSeg(i,"to",v)}   options={tOpts} style={{flex:1}}/>
      </div>}
      {seg.type==="work"&&seg.from&&seg.to&&<div style={{fontSize:11,color:"#888",background:"#fff",padding:"5px 8px",borderRadius:5,display:"flex",gap:12}}>
        <span>⏱️ Odprac.: <strong>{wkdSeg(seg).toFixed(1)}h</strong></span>
        {brkSeg(seg)>0&&<span style={{color:"#bbb"}}>Přest.: {brkSeg(seg)} min</span>}
      </div>}
      {(seg.type==="vacation"||seg.type==="sick"||seg.type==="ocr"||seg.type==="obstacle")&&<div style={{display:"flex",alignItems:"center",gap:8,background:"#fff",padding:"6px 10px",borderRadius:6}}>
        <span style={{fontSize:12,fontWeight:600,color:"#555",whiteSpace:"nowrap"}}>Hodin tento den:</span>
        <select value={String(seg.hours??getPatternHours())} onChange={e=>updSeg(i,"hours",Number(e.target.value))}
          style={{padding:"4px 8px",borderRadius:6,border:`1.5px solid ${C.border}`,fontSize:13,background:"#fff"}}>
          {vacHOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{fontSize:11,color:"#aaa"}}>(vzor: {getPatternHours()}h)</span>
      </div>}
    </div>)}
    <Btn variant="ghost" small onClick={()=>setSegs(s=>[...s,{type:"work",from:"",to:"",locationStoreId:isShared?emp.mainStore:viewStoreId}])}>
      {isShared?"+ Přidat část dne (jiná prodejna)":"+ Přidat část dne"}
    </Btn>
    <div style={{borderTop:`1.5px solid ${C.border}`,paddingTop:12}}>
      <button onClick={()=>setRangeMode(r=>!r)} style={{background:"none",border:"none",color:"#1565c0",fontWeight:700,fontSize:13,cursor:"pointer",padding:0}}>
        {rangeMode?"▲":"▼"} Zadat rozsah (dovolená / nemoc)
      </button>
      {rangeMode&&<div style={{marginTop:12,display:"flex",flexDirection:"column",gap:10}}>
        {isShared&&<div style={{fontSize:12,color:"#e65100",fontWeight:600,padding:"6px 10px",background:"#fff8f0",borderRadius:6}}>
          ⚠️ Propíše se automaticky do všech prodejen zaměstnance.
        </div>}
        <FSel label="Typ" value={rangeType} onChange={setRangeType} options={[{value:"vacation",label:"Dovolena"},{value:"sick",label:"Nemoc"}]}/>
        <div style={{display:"flex",gap:8}}>
          <FInput label="Od" type="date" value={rangeFrom} onChange={setRangeFrom} style={{flex:1}}/>
          <FInput label="Do" type="date" value={rangeTo}   onChange={setRangeTo}   style={{flex:1}}/>
        </div>
        <div style={{fontSize:11,color:"#888",padding:"6px 10px",background:"#f0f4ff",borderRadius:6}}>
          ℹ️ Víkendy bez naplánované směny se přeskočí. Hodiny se načtou ze vzoru pro každý den zvlášť.
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={()=>{onRangeApply(rangeType,rangeFrom,rangeTo,emp);onClose();}} style={{flex:1}}>✅ Aplikovat rozsah</Btn>
          <Btn variant="danger" onClick={()=>{onRangeDelete(rangeFrom,rangeTo,emp);onClose();}} style={{flex:1}}>🗑 Smazat rozsah</Btn>
        </div>
      </div>}
    </div>
    <div style={{display:"flex",gap:8}}>
      <Btn onClick={()=>onSave(segs.filter(s=>s.type))} style={{flex:1}}>Uložit den</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1}}>Zrušit</Btn>
    </div>
  </div>;
}

// ─── SCHEDULE VIEW ───────────────────────────────────────────
function ScheduleView({storeId,employees,year,month,sched,onCellEdit,actions,holidays,stores,patterns}){
  const mainEmps=employees.filter(e=>e.active&&e.mainStore===storeId&&isEmpActiveInMonth(e,year,month));

  // Sdílení zaměstnanci se zobrazí pokud mají v tomto měsíci alespoň jednu směnu (nebo část směny) v této prodejně
  const mirrorEmps=employees.filter(e=>{
    if(!e.active||e.mainStore===storeId) return false;
    if(!(e.extraStores||[]).includes(storeId)) return false;
    const dim=getDim(year,month);
    const mainStoreEmps=employees.filter(x=>x.active&&x.mainStore===e.mainStore);
    const empIdx=mainStoreEmps.findIndex(x=>x.id===e.id);
    for(let d=1;d<=dim;d++){
      const date=new Date(year,month,d);
      const dateStr=fmtDate(year,month,d);
      // Zkontroluj ruční zadání – jakýkoli work segment pro tuto prodejnu
      const cell=getSchedCell(sched,e.id,dateStr,employees);
      if(cell?.length){
        const hasSegHere=cell.some(s=>s.type==="work"&&(s.locationStoreId||s.loc||e.mainStore)===storeId);
        if(hasSegHere) return true;
      }
      // Zkontroluj vzor
      const patCell=getPatCell(patterns,e.mainStore,empIdx,date);
      if(patCell){
        const locId=typeof patCell==="object"?(patCell.loc||e.mainStore):e.mainStore;
        if(locId===storeId) return true;
      }
    }
    return false;
  });

  const allEmps=[...mainEmps,...mirrorEmps];

  const dim=getDim(year,month);
  const calStart=new Date(year,month,1-getDow(year,month,1));
  const calEnd=new Date(year,month,dim+(6-getDow(year,month,dim)));
  const calDays=[]; for(let d=new Date(calStart);d<=calEnd;d.setDate(d.getDate()+1)) calDays.push(new Date(d));
  const weeks=[]; for(let i=0;i<calDays.length;i+=7) weeks.push(calDays.slice(i,i+7));

  const isCur=d=>d.getMonth()===month&&d.getFullYear()===year;
  const ds=d=>fmtDate(d.getFullYear(),d.getMonth(),d.getDate());
  const getHol=d=>isCur(d)?holidays.find(h=>h.date===ds(d)):null;
  const isAct=d=>actions.some(a=>{const s=ds(d);return s>=a.from&&s<=a.to;});
  const isBlatna=storeId===2;

  // Pomocná: získá co vzor říká pro zaměstnance v daný den (from, to, loc) nebo null
  const getPatternForDay=(emp,d)=>{
    const dow=d.getDay()===0?6:d.getDay()-1;
    const hol=getHol(d);
    const mainStoreEmps=employees.filter(e=>e.active&&e.mainStore===emp.mainStore);
    const empIdx=mainStoreEmps.findIndex(e=>e.id===emp.id);
    const patCell=getPatCell(patterns,emp.mainStore,empIdx,d);
    if(!patCell) return null;
    const isObj=typeof patCell==="object";
    const patShift=isObj?(patCell.shift||"work"):(patCell||"work");
    if(!patShift||patShift==="null") return null;
    const patLoc=isObj?(patCell.loc||emp.mainStore):emp.mainStore;
    if(isObj&&patCell.shift==="custom"&&!(hol?.holidayFrom)){
      return {from:patCell.from,to:patCell.to,loc:patLoc};
    }
    const [from,to]=getEmpShiftTimes(emp,patLoc,patShift,dow,stores,isObj?patCell:null,hol);
    return from&&to?{from,to,loc:patLoc}:null;
  };

  // Vyhodnotí co zobrazit v buňce
  const evalCell=(emp,d)=>{
    if(!isCur(d)) return {bg:"#fafafa",lines:[],hrs:null,txtColor:"#ddd",clickable:false};
    const sd=empStartDate(emp);
    const appStart=new Date(2026,1,1);
    if(sd && sd>=appStart){
      const cellDate=new Date(d.getFullYear(),d.getMonth(),d.getDate());
      if(cellDate<sd) return {bg:"#f0f0f0",lines:[""],hrs:null,txtColor:"#ddd",clickable:false};
    }
    const dow=d.getDay()===0?6:d.getDay()-1;
    const dateStr=ds(d);
    const hol=getHol(d);
    const isMirrorRow=emp.mainStore!==storeId;
    const canEditRow=emp.mainStore===storeId;

    const cell=getSchedCell(sched,emp.id,dateStr,employees);
    const patternDay=getPatternForDay(emp,d);
    const showLoc=(emp.extraStores||[]).length>0;

    let bg=C.work, lines=[], hrs=null, txtColor="#1a1a2e", clickable=canEditRow;
    let isModified=false; // změna oproti vzoru

    if(cell?.length){
      const workSegs=cell.filter(s=>s.type==="work");
      const vacSeg=cell.find(s=>s.type==="vacation"||s.type==="sick");
      const otherAbsSeg=cell.find(s=>s.type!=="work"&&s.type!=="vacation"&&s.type!=="sick"&&s.type!=="dayOff");
      const dayOffSeg=cell.find(s=>s.type==="dayOff");
      const absSeg=vacSeg||otherAbsSeg;

      if(!workSegs.length&&!vacSeg&&!otherAbsSeg&&dayOffSeg){
        bg=C.dayOff; lines=["V"]; txtColor="#81c784";
      } else if(workSegs.length&&vacSeg){
        // Práce + Dovolená/Nemoc – zobraz práci a DOV Xh
        const totalH=calcSplitWorked(workSegs,emp.mainStore,stores);
        lines=workSegs.map(seg=>{
          const loc=seg.locationStoreId||seg.loc||emp.mainStore;
          const lbl=shiftLabel(seg.from,seg.to);
          return showLoc?`${lbl} ${STORE_SHORT[loc]||""}`:lbl;
        });
        const dovH=vacSeg.hours||0;
        lines.push(`${TYPE_SHORT[vacSeg.type]||"DOV"}${dovH>0?` ${dovH%1===0?dovH:dovH.toFixed(1)}h`:""}`);
        hrs=totalH>0?totalH:null;
        bg=C.modified;
      } else if(absSeg){
        // Čistá absence (dovolená/nemoc/jiné)
        const patWasWork=patternDay!==null;
        const dovH=absSeg.hours||0;
        const dovLabel=`${TYPE_SHORT[absSeg.type]||"–"}${dovH>0?` ${dovH%1===0?dovH:dovH.toFixed(1)}h`:""}`;
        if(patWasWork){
          // Změna oproti vzoru → žlutě
          bg=C.modified;
          lines=[dovLabel];
        } else {
          // Volno ze vzoru → barva typu + "DOV Xh" + "V" pod tím
          bg=TYPE_META[absSeg.type]?.color||C.dayOff;
          lines=[dovLabel,"V"];
        }
        txtColor=TYPE_META[absSeg.type]?.text||"#333";
      } else if(workSegs.length){
        const totalH=calcSplitWorked(workSegs,emp.mainStore,stores);
        if(isMirrorRow){
          lines=workSegs.map(seg=>{
            const loc=seg.locationStoreId||seg.loc||emp.mainStore;
            return `${shiftLabel(seg.from,seg.to)} ${STORE_SHORT[loc]||""}`;
          });
          hrs=totalH>0?totalH:null;
          const schedFrom=workSegs[0].from, schedTo=workSegs[workSegs.length-1].to;
          if(!patternDay) isModified=true;
          else if(patternDay.from!==schedFrom||patternDay.to!==schedTo) isModified=true;
          bg=isModified?C.modified:C.work;
        } else {
          lines=workSegs.map(seg=>{
            const loc=seg.locationStoreId||seg.loc||emp.mainStore;
            const lbl=shiftLabel(seg.from,seg.to);
            return showLoc?`${lbl} ${STORE_SHORT[loc]||""}`:lbl;
          });
          hrs=totalH>0?totalH:null;
          const schedFrom=workSegs[0].from, schedTo=workSegs[workSegs.length-1].to;
          if(!patternDay) isModified=true;
          else if(patternDay.from!==schedFrom||patternDay.to!==schedTo) isModified=true;
          bg=isModified?C.modified:C.work;
        }
      }
    } else if(patternDay){
      // Ze vzoru
      const {from,to,loc:patLoc}=patternDay;
      const physHere=patLoc===storeId;
      if(!physHere&&isMirrorRow){ bg=C.otherStore; lines=[STORE_SHORT[patLoc]||"?"]; txtColor="#bbb"; }
      else if(!physHere){ bg=C.otherStore; lines=[STORE_SHORT[patLoc]||"?"]; txtColor="#bbb"; }
      else {
        const h=calcWorked(from,to,getBreakRules(patLoc,stores));
        const lbl=shiftLabel(from,to)+(showLoc?` ${STORE_SHORT[patLoc]||""}`:"")||"Práce";
        lines=[lbl]; hrs=h>0?h:null;
        // Ze vzoru = žádná změna → bílá
        bg=C.work;
      }
    } else {
      bg=C.dayOff; lines=["V"]; txtColor="#81c784";
    }

    if(hol) bg=hol.open?C.holidayOpen:C.holidayClose;
    if(isMirrorRow) clickable=false;

    return {bg, lines, hrs, txtColor, clickable};
  };

  return <div style={{overflowX:"auto"}}>
    {weeks.map((wDays,wi)=>{
      const fc=wDays.find(d=>isCur(d)); if(!fc) return null;
      const wt=isBlatna?"":getWeekType(fc);
      const isoW=getIsoWeek(fc);
      return <div key={wi} style={{marginBottom:22}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,paddingLeft:152}}>
          <span style={{fontSize:11,fontWeight:700,color:"#ccc"}}>Týden {isoW}</span>
          {!isBlatna&&<span style={{background:wt==="odd"?"#e3f2fd":"#f3e5f5",color:wt==="odd"?"#1565c0":"#6a1b9a",padding:"2px 10px",borderRadius:4,fontSize:11,fontWeight:800}}>
            {wt==="odd"?"Lichý (T1)":"Sudý (T2)"}
          </span>}
        </div>
        <table style={{borderCollapse:"collapse",width:"100%"}}>
          <thead><tr>
            <th style={{width:150,padding:"5px 10px",textAlign:"left",fontSize:11,color:"#bbb",fontWeight:600,borderBottom:`2px solid ${C.border}`}}>Zaměstnanec</th>
            {wDays.map((d,di)=>{
              const cur=isCur(d),dow=d.getDay()===0?6:d.getDay()-1,isWE=dow>=5;
              const hol=getHol(d),act=isAct(d);
              const dc=!cur?"#ddd":act?"#c62828":hol?(hol.open?"#33691e":"#b71c1c"):isWE?"#bbb":"#1a1a2e";
              return <th key={di} style={{padding:"4px 3px",textAlign:"center",borderBottom:`2px solid ${C.border}`,minWidth:72,background:!cur?"#fafafa":isWE?"#fff8f8":"transparent"}}>
                <div style={{fontSize:10,color:cur?(isWE?"#ccc":"#bbb"):"#ddd"}}>{DOW_LBL[dow]}</div>
                <div style={{fontSize:13,fontWeight:800,color:dc}}>{d.getDate()}.</div>
                {hol&&cur&&<div style={{fontSize:8,color:hol.open?"#558b2f":"#c62828",fontWeight:700,overflow:"hidden",whiteSpace:"nowrap",maxWidth:70}}>{hol.name}</div>}
              </th>;
            })}
          </tr></thead>
          <tbody>{allEmps.map((emp,ei)=>{
            const isMirrorRow=emp.mainStore!==storeId;
            return <tr key={emp.id} style={{background:ei%2===0?"#fff":"#fafafe"}}>
              <td style={{padding:"4px 10px",fontSize:12,fontWeight:600,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>
                <div style={{color:isMirrorRow?"#888":C.topbar,display:"flex",alignItems:"center",gap:4}}>
                  {emp.lastName} {emp.firstName}
                  {isMirrorRow&&<span style={{fontSize:9,background:"#e8f0fe",color:"#1565c0",padding:"1px 4px",borderRadius:3,fontWeight:700}}>SD</span>}
                </div>
                <div style={{fontSize:10,color:"#bbb",fontWeight:400}}>{emp.role} · {empContractDay(emp)}h/den</div>
              </td>
              {wDays.map((d,di)=>{
                const {bg,lines,hrs,txtColor,clickable}=evalCell(emp,d);
                return <td key={di}
                  onClick={()=>isCur(d)&&clickable&&onCellEdit&&onCellEdit(emp,d)}
                  title={!isCur(d)?"":(clickable&&onCellEdit)?"Kliknutím upravíte":"Pouze prohlížení"}
                  style={{padding:"3px 2px",textAlign:"center",borderBottom:`1px solid ${C.border}`,borderLeft:"1px solid #f5f5f5",background:bg,cursor:(isCur(d)&&clickable&&onCellEdit)?"pointer":"default",minWidth:72,height:lines?.length>1?52:46,verticalAlign:"middle"}}>
                  {(lines||[]).map((l,li)=><div key={li} style={{fontSize:10,fontWeight:700,color:txtColor,lineHeight:1.25}}>{l}</div>)}
                  {hrs&&<div style={{fontSize:9,color:"#bbb",marginTop:1}}>({hrs%1===0?hrs:hrs.toFixed(1)}h)</div>}
                </td>;
              })}
            </tr>;
          })}</tbody>
        </table>
      </div>;
    })}
  </div>;
}

// ─── SETTINGS ────────────────────────────────────────────────
function SettingsView({holidays,setHolidays,actions,setActions,stores,setStores,employees,patterns,setPatterns}){
  const [section,setSection]=useState("pattern");
  const [editHol,setEditHol]=useState(null);
  const [showActModal,setShowActModal]=useState(false);
  const [newAct,setNewAct]=useState({name:"",month:0,from:"",to:""});
  const [editPatStore,setEditPatStore]=useState(null);
  const [editBreakStore,setEditBreakStore]=useState(null);

  const secs=[
    {key:"pattern", label:"📋 Rozvrh VZOR"},
    {key:"breaks",  label:"⏱️ Přestávky"},
    {key:"holidays",label:"🗓️ Státní svátky"},
    {key:"actions", label:"🎯 Akce"},
  ];

  return <div style={{display:"flex",gap:0,minHeight:500}}>
    <div style={{width:200,borderRight:`1.5px solid ${C.border}`,flexShrink:0}}>
      {secs.map(s=><button key={s.key} onClick={()=>setSection(s.key)}
        style={{display:"block",width:"100%",textAlign:"left",padding:"12px 18px",background:section===s.key?"#eef2ff":"transparent",color:section===s.key?C.topbar:"#666",fontWeight:section===s.key?700:500,fontSize:13,border:"none",cursor:"pointer",borderLeft:section===s.key?"3px solid #4f8ef7":"3px solid transparent"}}>
        {s.label}
      </button>)}
    </div>
    <div style={{flex:1,paddingLeft:28,overflowX:"auto"}}>

      {section==="pattern"&&<div>
        <div style={{fontWeight:800,fontSize:16,marginBottom:8,color:C.topbar}}>Rozvrh VZOR</div>
        <div style={{fontSize:13,color:"#888",marginBottom:16,padding:"10px 14px",background:"#f8f9ff",borderRadius:8,lineHeight:1.7}}>
          Strakonice &amp; Pelhřimov: <strong>Lichý (T1) ↔ Sudý (T2)</strong>. &nbsp;
          Blatná: <strong>jeden pevný vzor</strong>.<br/>
          Sdílení zaměstnanci (extraStores ≠ ∅): v buňce volíte i prodejnu.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {stores.map(s=><div key={s.id} onClick={()=>setEditPatStore(s)}
            style={{display:"flex",alignItems:"center",gap:16,padding:"14px 20px",background:"#fff",border:`1.5px solid ${C.border}`,borderRadius:10,cursor:"pointer"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor="#4f8ef7"}
            onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
            <div style={{width:40,height:40,background:"#eef2ff",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:4}}>
              <img src="/logo.png" alt="logo" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,fontSize:14,color:C.topbar}}>{s.name}</div>
              <div style={{fontSize:12,color:"#aaa"}}>{employees.filter(e=>e.active&&e.mainStore===s.id).length} zaměstnanců · {s.id===2?"Jeden vzor":"T1/T2"}</div>
            </div>
            <span style={{fontSize:12,color:"#4f8ef7",fontWeight:700}}>Upravit →</span>
          </div>)}
        </div>
        <Modal open={!!editPatStore} onClose={()=>setEditPatStore(null)} title={`Vzor – ${editPatStore?.name}`} width={1040}>
          {editPatStore&&<PatternEditor storeId={editPatStore.id} employees={employees} patterns={patterns} stores={stores}
            onSave={(sid,pat)=>setPatterns(p=>({...p,[sid]:pat}))} onClose={()=>setEditPatStore(null)}/>}
        </Modal>
      </div>}

      {section==="breaks"&&<div>
        <div style={{fontWeight:800,fontSize:16,marginBottom:8,color:C.topbar}}>Pravidla přestávek</div>
        <div style={{fontSize:13,color:"#888",marginBottom:16,padding:"10px 14px",background:"#f8f9ff",borderRadius:8}}>
          Nastavte přestávky pro každou prodejnu samostatně.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {stores.map(s=><div key={s.id} style={{border:`1.5px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",background:"#f8f9ff",cursor:"pointer"}} onClick={()=>setEditBreakStore(editBreakStore===s.id?null:s.id)}>
              <span style={{fontSize:16}}>⏱️</span>
              <span style={{fontWeight:700,fontSize:14,color:C.topbar}}>{s.name}</span>
              <span style={{fontSize:12,color:"#aaa",flex:1}}>{[...s.breakRules].sort((a,b)=>b.minMinutes-a.minMinutes).map(r=>{const h=Math.floor(r.minMinutes/60),m=r.minMinutes%60;const lbl=m>0?`${h}h${m}min`:`${h}h`;return `≥${lbl}→${r.breakMinutes}min`;}).join(" · ")}</span>
              <span style={{fontSize:12,color:"#4f8ef7",fontWeight:700}}>{editBreakStore===s.id?"▲ Zavřít":"▼ Upravit"}</span>
            </div>
            {editBreakStore===s.id&&<div style={{padding:"16px 18px",borderTop:`1px solid ${C.border}`}}>
              <BreakRulesEditor rules={s.breakRules} onChange={rules=>{
                setStores(prev=>prev.map(x=>x.id===s.id?{...x,breakRules:rules}:x));
              }}/>
            </div>}
          </div>)}
        </div>
      </div>}

      {section==="holidays"&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:800,fontSize:16,color:C.topbar}}>Státní svátky</div>
          <Btn small onClick={()=>setEditHol({date:"",name:"",open:false,idx:-1})}>+ Přidat svátek</Btn>
        </div>
        {[...holidays].sort((a,b)=>a.date.localeCompare(b.date)).map((h,i)=>{
          const origIdx=holidays.findIndex(x=>x.date===h.date&&x.name===h.name);
          const anyHours=h.storeHours&&Object.values(h.storeHours).some(s=>s?.from&&s?.to);
          return <div key={i} style={{display:"flex",alignItems:"center",gap:10,marginBottom:7,padding:"9px 14px",background:"#f8f9ff",borderRadius:8}}>
            <span style={{color:"#aaa",minWidth:90,fontSize:12,fontWeight:600}}>{h.date}</span>
            <span style={{flex:1,fontSize:13}}>{h.name}</span>
            {anyHours&&<div style={{display:"flex",gap:4}}>
              {[1,2,3].map(sid=>{
                const sh=h.storeHours?.[sid];
                if(!sh?.from) return null;
                return <Badge key={sid} color={h.open?"#fff3e0":"#fce4ec"} textColor={h.open?"#e65100":"#b71c1c"}>{STORE_SHORT[sid]}: {sh.from}–{sh.to}</Badge>;
              })}
            </div>}
            <Badge color={h.open?C.holidayOpen:C.holidayClose} textColor={h.open?"#33691e":"#b71c1c"}>{h.open?"Otevřeno":"Zavřeno"}</Badge>
            <Btn small variant="ghost" onClick={()=>setEditHol({...h, storeHours:h.storeHours?{...h.storeHours}:{}, idx:origIdx})}>Upravit</Btn>
            <Btn small variant="danger" onClick={()=>{if(window.confirm(`Smazat svátek "${h.name}"?`)) setHolidays(hs=>hs.filter((_,j)=>j!==origIdx));}}>✕</Btn>
          </div>;
        })}
        <Modal open={!!editHol} onClose={()=>setEditHol(null)} title={editHol?.idx===-1?"Přidat svátek":"Upravit svátek"}>
          {editHol&&<div style={{display:"flex",flexDirection:"column",gap:14}}>
            <FInput label="Datum" type="date" value={editHol.date} onChange={v=>setEditHol(h=>({...h,date:v}))}/>
            <FInput label="Název" value={editHol.name} onChange={v=>setEditHol(h=>({...h,name:v}))} placeholder="Název svátku..."/>
            <FSel label="Prodejna v tento den" value={editHol.open?"open":"closed"}
              onChange={v=>setEditHol(h=>({...h,open:v==="open",storeHours:h.storeHours||{}}))}
              options={[{value:"closed",label:"Zavřeno"},{value:"open",label:"Otevřeno"}]}/>
            <div style={{background:editHol.open?"#fff8e1":"#fce4ec",borderRadius:8,padding:"12px 14px",border:`1px solid ${editHol.open?"#ffe082":"#ef9a9a"}`}}>
              <div style={{fontSize:12,fontWeight:700,color:editHol.open?"#e65100":"#b71c1c",marginBottom:12}}>
                ⏰ {editHol.open?"Zkrácená otevírací doba":"Pracovní doba pro výkaz"} per prodejna (volitelné)
              </div>
              {[{id:1,name:"Strakonice"},{id:2,name:"Blatná"},{id:3,name:"Pelhřimov"}].map(st=>{
                const sh=editHol.storeHours?.[st.id]||{};
                const updSH=(field,val)=>setEditHol(h=>({...h,storeHours:{...(h.storeHours||{}),[st.id]:{...(h.storeHours?.[st.id]||{}),[field]:val}}}));
                return <div key={st.id} style={{marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:6}}>{STORE_SHORT[st.id]} – {st.name}</div>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    <FSel label="Od" value={sh.from||""} onChange={v=>updSH("from",v)}
                      options={[{value:"",label:"— ze vzoru"},...HALF_HOURS.map(t=>({value:t,label:t}))]}/>
                    <FSel label="Do" value={sh.to||""} onChange={v=>updSH("to",v)}
                      options={[{value:"",label:"— ze vzoru"},...HALF_HOURS.map(t=>({value:t,label:t}))]}/>
                    {sh.from&&sh.to&&<span style={{fontSize:11,color:editHol.open?"#e65100":"#b71c1c",marginTop:14}}>
                      {((sh.to.split(":").map(Number).reduce((a,b,i)=>i===0?a*60+b:a+b,0))-(sh.from.split(":").map(Number).reduce((a,b,i)=>i===0?a*60+b:a+b,0)))/60}h
                    </span>}
                  </div>
                </div>;
              })}
            </div>
            <Btn onClick={()=>{
              if(!editHol.date||!editHol.name) return;
              const rec={date:editHol.date,name:editHol.name,open:editHol.open};
              if(editHol.storeHours) rec.storeHours=editHol.storeHours;
              if(editHol.idx===-1) setHolidays(hs=>[...hs,rec]);
              else setHolidays(hs=>hs.map((x,j)=>j===editHol.idx?rec:x));
              setEditHol(null);
            }}>Uložit</Btn>
          </div>}
        </Modal>
      </div>}

      {section==="actions"&&<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:800,fontSize:16,color:C.topbar}}>Marketingové akce</div>
          <Btn small onClick={()=>{setNewAct({name:"",month:new Date().getMonth(),from:"",to:""});setShowActModal(true);}}>+ Přidat</Btn>
        </div>
        {actions.length===0&&<div style={{color:"#bbb",padding:"24px 0",textAlign:"center"}}>Zatím žádné akce.</div>}
        {MONTHS.map((mn,mi)=>{
          const ma=actions.filter(a=>a.month===mi); if(!ma.length) return null;
          return <div key={mi} style={{marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:800,color:"#aaa",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>{mn}</div>
            {ma.map((a,ai)=><div key={ai} style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,padding:"10px 14px",background:"#fff5f5",border:"1.5px solid #ffcdd2",borderRadius:8}}>
              <span>🎯</span><span style={{flex:1,fontWeight:700,color:"#c62828",fontSize:13}}>{a.name}</span>
              <span style={{fontSize:12,color:"#aaa"}}>{a.from} – {a.to}</span>
              <Btn small variant="danger" onClick={()=>setActions(ac=>ac.filter(x=>x!==a))}>✕</Btn>
            </div>)}
          </div>;
        })}
        <Modal open={showActModal} onClose={()=>setShowActModal(false)} title="Přidat akci">
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <FInput label="Název" value={newAct.name} onChange={v=>setNewAct(a=>({...a,name:v}))} placeholder="Jarní výprodej..."/>
            <FSel label="Měsíc" value={newAct.month} onChange={v=>setNewAct(a=>({...a,month:Number(v)}))} options={MONTHS.map((m,i)=>({value:i,label:m}))}/>
            <div style={{display:"flex",gap:8}}>
              <FInput label="Od" type="date" value={newAct.from} onChange={v=>setNewAct(a=>({...a,from:v}))} style={{flex:1}}/>
              <FInput label="Do" type="date" value={newAct.to}   onChange={v=>setNewAct(a=>({...a,to:v}))}   style={{flex:1}}/>
            </div>
            <Btn onClick={()=>{if(newAct.name&&newAct.from&&newAct.to){setActions(a=>[...a,{...newAct,id:Date.now()}]);setShowActModal(false);}}}>Přidat</Btn>
          </div>
        </Modal>
      </div>}
    </div>
  </div>;
}

// ─── EMPLOYEES VIEW ──────────────────────────────────────────
function LoginModal({emp, onClose}){
  const [appUser, setAppUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loginVal, setLoginVal] = useState("");
  const [pwd1, setPwd1] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(()=>{
    (async()=>{
      const {data} = await supabase.from("app_users").select("login,role,store_ids").eq("emp_id", emp.id).single();
      setAppUser(data||null);
      setLoginVal(data?.login || (emp.lastName||emp.firstName||"").toLowerCase().replace(/\s+/g,""));
      setLoading(false);
    })();
  },[emp.id]);

  const roleOpts = [{value:"zamestnanec",label:"Prodavač"},{value:"vedouci",label:"Vedoucí"},{value:"admin",label:"Admin"}];
  const [role, setRole] = useState(appUser?.role||"zamestnanec");
  useEffect(()=>{ if(appUser) setRole(appUser.role); },[appUser]);

  const handleSave = async()=>{
    if(!loginVal.trim()){setMsg({err:true,text:"Zadejte přihlašovací jméno."});return;}
    if(pwd1 && pwd1!==pwd2){setMsg({err:true,text:"Hesla se neshodují."});return;}
    if(pwd1 && pwd1.length<4){setMsg({err:true,text:"Heslo musí mít alespoň 4 znaky."});return;}
    setSaving(true); setMsg(null);
    const storeIds = [emp.mainStore,...(emp.extraStores||[])];
    const oldLogin = appUser?.login||null;
    // Upsert přihlašovacích údajů
    const hash = pwd1 ? await sha256hex(pwd1) : null;
    const upsertData = {
      emp_id: emp.id, login: loginVal.trim().toLowerCase(),
      role, name: (emp.lastName+" "+emp.firstName).trim(),
      store_ids: storeIds,
    };
    if(hash) upsertData.password_hash = hash;
    // Pokud existuje starý záznam a login se mění, smaž starý
    if(oldLogin && oldLogin !== upsertData.login){
      await supabase.from("app_users").delete().eq("login", oldLogin);
    }
    if(!hash && !appUser){
      setMsg({err:true,text:"Nový účet musí mít heslo."});setSaving(false);return;
    }
    let error;
    if(appUser){
      // Existující účet – update
      const updateData = {login:upsertData.login, role, name:upsertData.name, store_ids:storeIds};
      if(hash) updateData.password_hash = hash;
      ({error} = await supabase.from("app_users").update(updateData).eq("emp_id", emp.id));
    } else {
      // Nový účet – insert
      ({error} = await supabase.from("app_users").insert({...upsertData, password_hash: hash}));
    }
    setSaving(false);
    if(error){ setMsg({err:true,text:"Chyba: "+error.message}); }
    else { setMsg({err:false,text:"Uloženo ✓"}); setPwd1(""); setPwd2(""); setAppUser(u=>({...u,...upsertData})); }
  };

  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    {loading
      ? <div style={{textAlign:"center",padding:20,color:"#aaa"}}>Načítám...</div>
      : <>
        <div style={{padding:"10px 14px",background:appUser?"#e8f5e9":"#fff8e1",borderRadius:8,fontSize:13,color:appUser?"#2e7d32":"#e65100",fontWeight:600}}>
          {appUser ? `✅ Účet existuje — login: ${appUser.login}` : "⚠️ Zaměstnanec zatím nemá přihlašovací účet"}
        </div>
        <FInput label="Přihlašovací jméno" value={loginVal} onChange={setLoginVal} placeholder="např. novak"/>
        <div>
          <FLabel>Role</FLabel>
          <select value={role} onChange={e=>setRole(e.target.value)}
            style={{padding:"7px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:14,background:"#fff",width:"100%",boxSizing:"border-box"}}>
            {roleOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{padding:"12px 14px",background:"#f8f9ff",borderRadius:8,display:"flex",flexDirection:"column",gap:10}}>
          <FLabel>{appUser?"Změna hesla (ponech prázdné pro beze změny)":"Heslo *"}</FLabel>
          <input type="password" value={pwd1} onChange={e=>setPwd1(e.target.value)} placeholder="Nové heslo"
            style={{padding:"7px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:14,width:"100%",boxSizing:"border-box"}}/>
          <input type="password" value={pwd2} onChange={e=>setPwd2(e.target.value)} placeholder="Zopakujte heslo"
            style={{padding:"7px 10px",borderRadius:7,border:`1.5px solid ${C.border}`,fontSize:14,width:"100%",boxSizing:"border-box"}}/>
        </div>
        {msg&&<div style={{padding:"8px 12px",borderRadius:7,background:msg.err?"#ffebee":"#e8f5e9",color:msg.err?"#c62828":"#2e7d32",fontSize:13,fontWeight:600}}>{msg.text}</div>}
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <Btn onClick={handleSave} disabled={saving} style={{flex:1}}>{saving?"Ukládám...":"Uložit"}</Btn>
          <Btn variant="secondary" onClick={onClose} style={{flex:1}}>Zavřít</Btn>
        </div>
      </>}
  </div>;
}

function EmployeesView({employees,setEmployees,stores}){
  const [editEmp,setEditEmp]=useState(null);
  const [showNew,setShowNew]=useState(false);
  const [loginEmp,setLoginEmp]=useState(null);
  const newEmpTemplate={firstName:"",lastName:"",mainStore:1,extraStores:[],role:"",contractHoursDay:8,contractHoursWeek:40,vacHours:160,kpdStart:0,active:true,customTimes:{}};

  return <div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
      <h2 style={{margin:0,fontSize:20,fontWeight:800,color:C.topbar}}>Zaměstnanci</h2>
      <Btn onClick={()=>setShowNew(true)}>+ Přidat zaměstnance</Btn>
    </div>
    {stores.map(store=>{
      const emps=employees.filter(e=>e.mainStore===store.id);
      return <div key={store.id} style={{marginBottom:28}}>
        <div style={{fontSize:11,fontWeight:800,color:"#aaa",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,padding:"4px 10px",background:"#f8f9ff",borderRadius:5,display:"inline-block"}}>{store.name} · {emps.length}</div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#f8f9ff"}}>
            {["Jméno","Role","Úvazek","Hlavní prodejna","Sdílení do","Vlastní časy","Dov. nárok","Stav",""].map(h=>
              <th key={h} style={{padding:"7px 10px",textAlign:"left",fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase",borderBottom:`2px solid ${C.border}`,whiteSpace:"nowrap"}}>{h}</th>)}
          </tr></thead>
          <tbody>{emps.map((emp,i)=>{
            const shared=(emp.extraStores||[]).length>0;
            const hasCT=Object.keys(emp.customTimes||{}).length>0;
            return <tr key={emp.id} style={{background:i%2===0?"#fff":"#fafafe"}}>
              <td style={{padding:"8px 10px",fontWeight:600,color:C.topbar,borderBottom:`1px solid ${C.border}`}}>{emp.lastName} {emp.firstName}</td>
              <td style={{padding:"8px 10px",color:"#666",borderBottom:`1px solid ${C.border}`}}>{emp.role}</td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}><Badge color="#e8f5e9" textColor="#2e7d32">{empContractDay(emp)}h / {empContractWeek(emp)}h týdně</Badge></td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}>{stores.find(s=>s.id===emp.mainStore)?.name}</td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}>
                {shared
                  ?<Badge color="#e8f0fe" textColor="#1565c0">{(emp.extraStores||[]).map(id=>stores.find(s=>s.id===id)?.name).join(", ")}</Badge>
                  :<span style={{color:"#ddd"}}>—</span>}
              </td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}>
                {hasCT
                  ?<Badge color="#fff3e0" textColor="#e65100">{Object.keys(emp.customTimes||{}).map(id=>STORE_SHORT[id]).join(", ")}</Badge>
                  :<span style={{color:"#ddd"}}>—</span>}
              </td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}>{emp.vacHours}h/rok</td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`}}><Badge color={emp.active?"#e8f5e9":"#ffebee"} textColor={emp.active?"#2e7d32":"#c62828"}>{emp.active?"Aktivní":"Neaktivní"}</Badge></td>
              <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>
                <Btn small variant="secondary" onClick={()=>setEditEmp(emp)} style={{marginRight:6}}>Upravit</Btn>
                <Btn small variant="ghost" onClick={()=>setLoginEmp(emp)}>🔑 Přihlášení</Btn>
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>;
    })}
    <Modal open={!!editEmp} onClose={()=>setEditEmp(null)} title={`Upravit – ${editEmp?.lastName} ${editEmp?.firstName}`} width={600}>
      {editEmp&&<EmployeeForm initial={editEmp} stores={stores}
        onSave={f=>{setEmployees(p=>p.map(e=>e.id===editEmp.id?{...e,...f}:e));setEditEmp(null);}}
        onClose={()=>setEditEmp(null)}/>}
    </Modal>
    <Modal open={!!loginEmp} onClose={()=>setLoginEmp(null)} title={`Přihlašovací údaje – ${loginEmp?.lastName} ${loginEmp?.firstName}`} width={480}>
      {loginEmp&&<LoginModal emp={loginEmp} onClose={()=>setLoginEmp(null)}/>}
    </Modal>
    <Modal open={showNew} onClose={()=>setShowNew(false)} title="Přidat zaměstnance" width={600}>
      <EmployeeForm initial={newEmpTemplate} stores={stores}
        onSave={async f=>{
          // Sestav DB radek BEZ id – Supabase (serial/sequence) prideli id automaticky
          const rowData = {
            first_name: f.firstName, last_name: f.lastName||"",
            main_store: f.mainStore,
            extra_stores: f.extraStores||[],
            role: f.role||"",
            contract_hours_day: f.contractHoursDay,
            contract_hours_week: f.contractHoursWeek,
            vac_hours: f.vacHours,
            kpd_start: f.kpdStart||0,
            active: f.active,
            custom_times: f.customTimes||{},
          };
          // Zadne id = Supabase priradi automaticky (bez chyby duplicate key)
          const {data, error} = await supabase
            .from("employees")
            .insert(rowData)
            .select()
            .single();
          if (data) {
            setEmployees(p => [...p, dbToEmp(data)]);
            setShowNew(false);
          } else {
            console.error("Chyba pri pridavani zamestnance:", error);
            alert("Nepodarilo se pridat zamestnance: " + (error?.message || "Neznama chyba"));
          }
        }}
        onClose={()=>setShowNew(false)}/>
    </Modal>
  </div>;
}

// ─── TIMESHEET ───────────────────────────────────────────────
function TimesheetView({employee, year, month, holidays, stores, sched, employees, patterns, rows, onRowChange, timesheetData, onKdpPaidChange, canEditKdp=true, tsStatus="draft", onSubmit, onApprove, onReturn, isVedouci=false}){
  const dim = getDim(year, month);
  const brRules = getBreakRules(employee.mainStore, stores);
  const fund = getEmpFund(employee, year, month, holidays);
  const holidayDays = getHolidayDays(year, month, holidays);
  const upd = (d,f,v) => onRowChange(d,f,v);
  const contractDay = empContractDay(employee);

  const tOpts = [{value:"",label:"—"},...HALF_HOURS.map(t=>({value:t,label:t}))];
  const adminOpts = [{value:"",label:"—"},...Array.from({length:24},(_,i)=>(i+1)*0.5).map(v=>({value:v,label:v%1===0?`${v}h`:`${v}h 30m`}))];
  const rozOpts  = [{value:"",label:"—"},...Array.from({length:200},(_,i)=>i+1).map(v=>({value:v,label:`${v}×`}))];

  const typeOpts = [
    {value:"work",          label:"Pracovní den"},
    {value:"vacation",      label:"Dovolena"},
    {value:"work+vacation", label:"Práce + Dovolená"},
    {value:"sick",          label:"Nemoc"},
    {value:"holidayOpen",   label:"Svátek otevřeno"},
    {value:"holidayClose",  label:"Svátek zavřeno"},
    {value:"dayOff",        label:"Volno"},
    {value:"ocr",           label:"OČR"},
    {value:"other",         label:"Jiné"},
  ];
  const typeColor = {
    work:"#1a1a2e", "work+vacation":"#6a1b9a", vacation:"#1565c0",
    sick:"#616161", holidayOpen:"#2e7d32", holidayClose:"#b71c1c",
    dayOff:"#aaa", ocr:"#e65100", other:"#e65100",
  };

  const ss = {width:"100%",border:"none",background:"transparent",textAlign:"center",fontSize:11,padding:"2px 1px",outline:"none"};

  // ── Délka směny ze vzoru pro daný den (pro výpočet dovolené/nemoci/svátku) ──
  const getPatternShiftHours = (d) => {
    const date = new Date(year, month, d);
    const dow  = getDow(year, month, d);
    const mainStoreEmps = employees.filter(e=>e.active && e.mainStore===employee.mainStore);
    const empIdx = mainStoreEmps.findIndex(e=>e.id===employee.id);
    const pc = getPatCell(patterns, employee.mainStore, empIdx, date);
    if(!pc) return 0;
    const st  = typeof pc==="object"?pc.shift||"work":pc;
    if(!st || st==="null") return 0;
    const lId = typeof pc==="object"?(pc.loc||employee.mainStore):employee.mainStore;
    if(typeof pc==="object" && pc.shift==="custom" && pc.from && pc.to)
      return calcWorked(pc.from, pc.to, getBreakRules(lId, stores));
    const [fr,to] = getEmpShiftTimes(employee, lId, st, dow, stores, typeof pc==="object"?pc:null);
    return fr && to ? calcWorked(fr, to, getBreakRules(lId, stores)) : 0;
  };

  // ── Rozvrh pro daný den – včetně split směn ──
  const getScheduleForDay = (d) => {
    const date = new Date(year, month, d);
    const dow  = getDow(year, month, d);
    const dateStr = fmtDate(year, month, d);
    const hol = holidays.find(h=>h.date===dateStr);
    const mainStoreEmps = employees.filter(e=>e.active && e.mainStore===employee.mainStore);
    const empIdx = mainStoreEmps.findIndex(e=>e.id===employee.id);
    const cell = getSchedCell(sched, employee.id, dateStr, employees);
    if(cell?.length){
      const workSegs = cell.filter(s=>s.type==="work" && s.from && s.to);
      const vacSeg   = cell.find(s=>s.type==="vacation");
      const sickSeg  = cell.find(s=>s.type==="sick");
      if(workSegs.length>1){
        return {type:"work", segments:workSegs, split:true};
      }
      if(workSegs.length===1 && vacSeg) return {type:"work+vacation", from:workSegs[0].from, to:workSegs[0].to, vacHours:vacSeg.hours||0};
      if(workSegs.length===1) return {type:"work", from:workSegs[0].from, to:workSegs[0].to};
      if(vacSeg)  return {type:"vacation", vacHours:vacSeg.hours||0};
      if(sickSeg) return {type:"sick", vacHours:sickSeg.hours||0};
      const ocrSeg      = cell.find(s=>s.type==="ocr");
      const obstacleSeg = cell.find(s=>s.type==="obstacle");
      if(ocrSeg)      return {type:"ocr",      vacHours:ocrSeg.hours||0};
      if(obstacleSeg) return {type:"obstacle", vacHours:obstacleSeg.hours||0};
      return null;
    }
    const pc = getPatCell(patterns, employee.mainStore, empIdx, date);
    if(!pc) return null;
    const st = typeof pc==="object"?pc.shift||"work":pc;
    if(!st || st==="null") return null;
    const lId = typeof pc==="object"?(pc.loc||employee.mainStore):employee.mainStore;
    if(typeof pc==="object" && pc.shift==="custom") {
      // Svátek přebije i custom čas
      const holStore=hol?.storeHours?.[lId];
      if(holStore?.from&&holStore?.to) return {type:"work", from:holStore.from, to:holStore.to};
      return {type:"work", from:pc.from, to:pc.to};
    }
    const [fr,to] = getEmpShiftTimes(employee, lId, st, dow, stores, typeof pc==="object"?pc:null, hol);
    if(fr && to) return {type:"work", from:fr, to:to};
    return null;
  };

  // ── Odvodit výchozí typ dne ──
  const deriveType = (d) => {
    const dow = getDow(year, month, d);
    const hol = holidays.find(h=>h.date===fmtDate(year,month,d));
    const patHours = getPatternShiftHours(d);
    // Svátek – jen pokud měl zaměstnanec naplánovanou směnu, jinak volno
    if(hol){
      const sd = getScheduleForDay(d);
      const hasShift = patHours > 0 || sd?.type === "work";
      if(!hol.open) return hasShift ? "holidayClose" : "dayOff";
      if(hol.open)  return hasShift ? "holidayOpen"  : "dayOff";
    }
    // Víkend i pracovní den: má-li vzor směnu → pracovní den, jinak volno
    const sd = getScheduleForDay(d);
    if(!sd) return "dayOff";
    return sd.type || "work";
  };

  // ── Výpočet hodin ze záznamu ──
  const calcRow = (row) => {
    if(!row.arrival || !row.departure) return {worked:0, breakMin:0, autoBreak:false};
    const [ah,am]=row.arrival.split(":").map(Number);
    const [dh,dm]=row.departure.split(":").map(Number);
    const physical=(dh*60+dm)-(ah*60+am);
    let breakMin=0, autoBreak=false;
    if(row.breakFrom && row.breakTo){
      const [bfh,bfm]=row.breakFrom.split(":").map(Number);
      const [bth,btm]=row.breakTo.split(":").map(Number);
      breakMin=Math.max(0,(bth*60+btm)-(bfh*60+bfm));
    } else {
      breakMin=calcBreak(row.arrival,row.departure,brRules);
      autoBreak=breakMin>0;
    }
    return {worked:Math.max(0,(physical-breakMin)/60), breakMin, autoBreak};
  };

  // ── Porovnání s rozvrhem ──
  const compareWithSchedule = (row, d, effectiveType) => {
    const sd = getScheduleForDay(d);
    const hasEntry = row.arrival && row.departure;
    if(effectiveType==="holidayClose") return {status:"ok"};
    if(effectiveType==="dayOff" && hasEntry) return {status:"extra"};
    if(effectiveType==="dayOff") return {status:"ok"};
    if(!sd && hasEntry) return {status:"extra"};
    if(sd?.type==="vacation"||sd?.type==="sick") return {status:"ok"};
    if(sd?.from && !hasEntry && (effectiveType==="work"||effectiveType==="holidayOpen")) return {status:"missing", schedFrom:sd.from, schedTo:sd.to};
    if(sd?.from && hasEntry){
      const diff=t=>{const[h,m]=t.split(":").map(Number);return h*60+m;};
      if(Math.abs(diff(row.arrival)-diff(sd.from))>15||Math.abs(diff(row.departure)-diff(sd.to))>15)
        return {status:"warn"};
    }
    return {status:"ok"};
  };

  // ── Sestavení dat řádků ──
  let totWorked=0,totVac=0,totSick=0,totHolClose=0,totHolOpen=0,totOcr=0,totOther=0;
  let soH=0,neH=0,tix=0,totAdmin=0,totRoz1=0,totRoz2=0;

  const rowData = Array.from({length:dim},(_,i)=>i+1).map(d=>{
    const dow = getDow(year,month,d);
    const hol = holidays.find(h=>h.date===fmtDate(year,month,d));
    const row = rows[d];
    const {worked, breakMin, autoBreak} = calcRow(row);
    const schedDay = getScheduleForDay(d);
    const isWE = dow>=5;

    // Efektivní typ: ručně zadaný má přednost, jinak odvozený z rozvrhu
    const effectiveType = row.type || deriveType(d);
    const isAutoType = !row.type;

    const patHours = getPatternShiftHours(d);
    const schedInfo = compareWithSchedule(row, d, effectiveType);

    // DOV hodiny: přímo ze sched záznamu (co vedoucí zadal)
    const schedVacH = schedDay?.vacHours||0;
    const vacH = effectiveType==="work+vacation"
      ? (row.vacHours!==undefined && row.vacHours!=="" ? Number(row.vacHours) : schedVacH||Math.max(0, patHours - worked))
      : 0;

    // Hodiny pro svátek zavřeno: ze storeHours svátku pokud nastaven, jinak ze vzoru
    const holStoreH = hol?.storeHours?.[employee.mainStore];
    const holCloseH = holStoreH?.from && holStoreH?.to
      ? calcWorked(holStoreH.from, holStoreH.to, getBreakRules(employee.mainStore, stores))
      : patHours;

    // Součty
    let wc=0,vc=0,sc=0,hcc=0,hoc=0,oc=0,otc=0;
    switch(effectiveType){
      case "vacation":      vc  = schedVacH||patHours; break;
      case "work+vacation": wc  = worked; vc = vacH; break;
      case "sick":          sc  = schedVacH||patHours; break;
      case "holidayClose":  hcc = holCloseH; break;
      case "holidayOpen":   hoc = worked; wc = worked; break;
      case "ocr":           oc  = patHours; break;
      case "other":         otc = worked||patHours; break;
      case "dayOff":        wc  = worked; break;
      default:              wc  = worked;
    }
    totWorked+=wc; totVac+=vc; totSick+=sc; totHolClose+=hcc; totHolOpen+=hoc;
    totOcr+=oc; totOther+=otc;
    if(wc>0&&dow===5) soH+=wc;
    if(wc>0&&dow===6) neH+=wc;
    // Stravenka: ≥5h odpracováno bez ohledu na typ (včetně "extra" mimo rozvrh)
    if(worked>=5) tix++;
    const admin = row.admin ? Number(row.admin) : 0;
    const roz1  = row.roz1  ? Number(row.roz1)  : 0;
    const roz2  = row.roz2  ? Number(row.roz2)  : 0;
    totAdmin+=admin; totRoz1+=roz1; totRoz2+=roz2;

    return {d,dow,hol,row,worked,breakMin,autoBreak,effectiveType,isAutoType,schedInfo,schedDay,vacH,schedVacH,patHours,isWE};
  });

  const totAll = totWorked+totVac+totSick+totHolClose+totOcr+totOther;
  const overtime = totAll - fund;
  const fmtH = h => h===0?"—":(h%1===0?`${h}h`:`${h.toFixed(1)}h`);
  const fmtHsign = h => h===0?"0h":((h>0?"+":"-")+Math.abs(h%1===0?h:+h.toFixed(1))+"h");

  // KPD výpočet pro tento výkaz
  // KPD vstup = kumulativní KPD ke konci předchozího měsíce
  const prevMonthY = month===0?year-1:year;
  const prevMonthM = month===0?11:month-1;
  const isFirstMonth = year===APP_START.year && month===APP_START.month;
  const kdpVstup = isFirstMonth
    ? (employee.kpdStart||0)
    : calcKpdCumulative(employee, prevMonthY, prevMonthM, sched, holidays, stores, patterns, employees, timesheetData);
  const tsKeyThis = `${employee.id}-${year}-${month+1}`;
  const kpdPaidThis = Number(timesheetData?.[tsKeyThis]?.kpdPaid || 0);
  const kdpVystup = kdpVstup + overtime - kpdPaidThis;

  // ── Export Excel s barvami (ExcelJS) ──
  const exportExcel = async () => {
    if(!ExcelJS){ alert("Excel export se načítá, zkuste za chvíli."); return; }
    const fmtHx = h => h>0?(h%1===0?`${h}h`:`${h.toFixed(1)}h`):"";
    const storeName = stores.find(s=>s.id===employee.mainStore)?.name||"";

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${MONTHS[month]} ${year}`);

    // Šířky sloupců
    ws.columns = [
      {width:6},{width:10},{width:14},{width:9},{width:9},
      {width:9},{width:9},{width:9},{width:8},{width:8},
      {width:7},{width:7},{width:16},
    ];

    // Řádek 1 – název
    const r1 = ws.addRow([`Výkaz práce – ${employee.lastName} ${employee.firstName}`]);
    r1.getCell(1).font = {bold:true, size:13};
    ws.mergeCells(1,1,1,13);

    // Řádek 2 – info
    ws.addRow([`${MONTHS[month]} ${year}  |  Fond: ${fund}h  |  Prodejna: ${storeName}  |  Role: ${employee.role}`]);
    ws.mergeCells(2,1,2,13);

    // Řádek 3 – prázdný
    ws.addRow([]);

    // Řádek 4 – záhlaví tabulky
    const hdrRow = ws.addRow(["Den","Datum","Rozvrh","Příchod","Odchod","Přest.od","Přest.do","Odprac.","DOV h","Admin","Roz.1","Roz.2","Typ dne"]);
    hdrRow.eachCell(cell=>{
      cell.fill = {type:"pattern", pattern:"solid", fgColor:{argb:"FF1A1A2E"}};
      cell.font = {bold:true, color:{argb:"FFFFFFFF"}, size:9};
      cell.alignment = {horizontal:"center", vertical:"middle"};
      cell.border = {bottom:{style:"thin", color:{argb:"FF444466"}}};
    });
    hdrRow.height = 16;

    // Barvy řádků dle typu dne
    const xlColors = {
      work:            null,
      dayOff:          "FFE8F5E9",
      vacation:        "FFE3F2FD",
      sick:            "FFF5F5F5",
      obstacle:        "FFFFF3E0",
      holidayOpen:     "FFF1F8E9",
      holidayClose:    "FFFFEBEE",
      "work+vacation": "FFEDE7F6",
      ocr:             "FFFFF9C4",
      other:           "FFFFF9C4",
    };
    const weekendArgb = "FFFFF8F8";

    // Datové řádky
    rowData.forEach(({d,dow,row,worked,effectiveType,schedDay,vacH,schedVacH})=>{
      const schedLbl = schedDay?.from?`${schedDay.from}–${schedDay.to}`:(schedDay?.type==="vacation"?"DOV":schedDay?.type==="sick"?"NEM":"");
      const dovH = (effectiveType==="work+vacation"||effectiveType==="vacation"||effectiveType==="sick")
        ? (effectiveType==="work+vacation"?vacH:schedVacH)||0 : 0;
      const dataRow = ws.addRow([
        DOW_LBL[dow],
        `${d}.${month+1}.${year}`,
        schedLbl,
        row.arrival||"", row.departure||"",
        row.breakFrom||"", row.breakTo||"",
        worked>0?fmtHx(worked):"",
        dovH>0?fmtHx(dovH):"",
        row.admin?`${row.admin}h`:"",
        row.roz1?`${row.roz1}×`:"",
        row.roz2?`${row.roz2}×`:"",
        TYPE_META[effectiveType]?.label||effectiveType,
      ]);
      // Barva pozadí
      let argb = xlColors[effectiveType] || null;
      if(!argb && dow>=5) argb = weekendArgb;
      if(argb){
        dataRow.eachCell({includeEmpty:true}, cell=>{
          cell.fill = {type:"pattern", pattern:"solid", fgColor:{argb}};
        });
      }
      // So/Ne – tučné písmo
      if(dow>=5) dataRow.getCell(1).font = {bold:true, color:{argb:"FFCC2222"}};
      dataRow.height = 14;
    });

    // Prázdný řádek + souhrn
    ws.addRow([]);
    const sHdr = ws.addRow(["SOUHRN"]);
    sHdr.getCell(1).font = {bold:true, size:10};

    const sumRows = [
      ["Fond hodin", `${fund}h`],
      ["Odpracováno", fmtHx(totWorked)],
      ["Dovolená", fmtHx(totVac)],
      ["Nemoc", fmtHx(totSick)],
      ["Svátek zavřeno", fmtHx(totHolClose)],
      ["Svátek otevřeno", fmtHx(totHolOpen)],
      ["Víkendy", fmtHx(soH+neH)],
      ["Celkem hod.", fmtHx(totAll)],
      ["Přesčas / minus", (overtime>=0?"+":"")+fmtHx(Math.abs(overtime))],
      ["Admin práce", totAdmin>0?`${totAdmin}h`:"—"],
      ["Rozvoz 1", totRoz1>0?`${totRoz1}×`:"—"],
      ["Rozvoz 2", totRoz2>0?`${totRoz2}×`:"—"],
      ["Stravenky", tix>0?`${tix} ks`:"—"],
      [],
      ["KPD vstup", fmtHsign(kdpVstup)],
      ["KPD proplaceno", kpdPaidThis>0?`${kpdPaidThis}h`:"—"],
      ["KPD výstup", fmtHsign(kdpVystup)],
    ];
    sumRows.forEach(r=>{
      const row = ws.addRow(r);
      if(r.length>0) row.getCell(1).font = {bold:true};
    });

    // Ulož soubor
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Vykaz_${employee.firstName}_${employee.lastName}_${MONTHS[month]}_${year}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Export PDF – A4 na výšku, jedna stránka ──
  const exportPdf = () => {
    // cz() je globální funkce definovaná níže
    const jsPDFLib = jsPDF;
    // A4 portrait: 210 x 297 mm, použitelná šířka ~182 mm (margin 14 mm)
    const doc = new jsPDFLib({ orientation:"portrait", unit:"mm", format:"a4" });
    const storeName = stores.find(s=>s.id===employee.mainStore)?.name||"";
    const pageW = 210;
    const marginL = 14;
    const usableW = pageW - marginL * 2; // 182 mm

    // ── Záhlaví ──
    doc.setFont("helvetica","bold");
    doc.setFontSize(13);
    doc.text(cz(`Výkaz práce – ${employee.lastName} ${employee.firstName}`), marginL, 14);
    doc.setFont("helvetica","normal");
    doc.setFontSize(8);
    doc.text(cz(`${MONTHS[month]} ${year}  |  Fond: ${fund}h  |  Prodejna: ${storeName}  |  Role: ${employee.role}`), marginL, 20);
    // Oddělovací linka
    doc.setDrawColor(200,200,210);
    doc.line(marginL, 22, pageW - marginL, 22);

    // ── Zkrácené popisky typů dne ──
    const typeLabelShort = {
      work:         "Prace",
      dayOff:       "Volno",
      vacation:     "Dovolena",
      sick:         "Nemoc",
      obstacle:     "Prekazka",
      holidayOpen:  "Sv.otevreno",
      holidayClose: "Sv.zavreno",
      "work+vacation": "Prace+DOV",
      ocr:          "OCR",
      other:        "Jine",
    };

    // ── Tabulka dnů ──
    const fmtHx = h => h===0?"—":(h%1===0?`${h}h`:`${h.toFixed(1)}h`);
    const head = [["Den","Datum","Rozvrh","Prichod","Odchod","Pr.od","Pr.do","Odprac.","DOV","Adm.","R1","R2","Typ dne"]];
    const body = rowData.map(({d,dow,row,worked,effectiveType,schedDay,vacH,schedVacH})=>{
      const schedLbl = schedDay?.from?`${schedDay.from}–${schedDay.to}`:(schedDay?.type==="vacation"?"DOV":schedDay?.type==="sick"?"NEM":"—");
      const dovH = (effectiveType==="work+vacation"||effectiveType==="vacation"||effectiveType==="sick")
        ? (effectiveType==="work+vacation"?vacH:schedVacH)||0 : 0;
      return [
        DOW_LBL[dow],
        `${d}.${month+1}.`,
        schedLbl,
        row.arrival||"—", row.departure||"—",
        row.breakFrom||"—", row.breakTo||"—",
        worked>0?fmtHx(worked):"—",
        dovH>0?fmtHx(dovH):"—",
        row.admin?`${row.admin}h`:"—",
        row.roz1?`${row.roz1}×`:"—",
        row.roz2?`${row.roz2}×`:"—",
        typeLabelShort[effectiveType]||effectiveType,
      ];
    });

    autoTable(doc, {
      head, body,
      startY: 25,
      margin:{ left: marginL, right: marginL },
      styles:{ fontSize:7, cellPadding:1.2, font:"helvetica", overflow:"linebreak" },
      headStyles:{ fillColor:[26,26,46], textColor:255, fontStyle:"bold", fontSize:6.5, cellPadding:1.5 },
      columnStyles:{
        0:{cellWidth:8},   // Den
        1:{cellWidth:12},  // Datum
        2:{cellWidth:20},  // Rozvrh
        3:{cellWidth:14},  // Příchod
        4:{cellWidth:14},  // Odchod
        5:{cellWidth:12},  // Př.od
        6:{cellWidth:12},  // Př.do
        7:{cellWidth:14},  // Odprac.
        8:{cellWidth:11},  // DOV
        9:{cellWidth:10},  // Adm.
        10:{cellWidth:9},  // R1
        11:{cellWidth:9},  // R2
        12:{cellWidth:37}, // Typ dne – zbytek
      },
      alternateRowStyles:{ fillColor:[247,248,252] },
      didParseCell:(data)=>{
        if(data.section==="body"){
          const dow = rowData[data.row.index]?.dow;
          const et  = rowData[data.row.index]?.effectiveType;
          if(dow>=5)                            data.cell.styles.fillColor=[255,248,248];
          if(et==="vacation"||et==="sick")      data.cell.styles.fillColor=[232,244,253];
          if(et==="holidayClose")               data.cell.styles.fillColor=[255,235,238];
          if(et==="holidayOpen")                data.cell.styles.fillColor=[241,248,233];
          if(et==="dayOff")                     data.cell.styles.fillColor=[232,245,233];
        }
      },
    });

    // ── Souhrn měsíce – barevné dlaždice jako na webu ──
    const sy = (doc.lastAutoTable?.finalY || 150) + 5;
    const tileH   = 12;   // výška dlaždice
    const tileGap = 2;    // mezera
    const cols1   = 6;    // počet dlaždic v řadě 1
    const tileW   = (usableW - (cols1-1)*tileGap) / cols1;

    // Nadpis sekce
    doc.setFont("helvetica","bold"); doc.setFontSize(8.5);
    doc.setTextColor(26,26,46);
    doc.text("Souhrn mesice", marginL, sy);

    const tiles1 = [
      { label:"Fond hodin",    val:fmtHx(fund),                        bg:[227,242,253], tc:[21,101,192] },
      { label:"Odpracovano",   val:fmtHx(totWorked),                   bg:[232,245,233], tc:[46,125,50]  },
      { label:"Dovolena",      val:fmtHx(totVac),                      bg:[232,234,246], tc:[57,73,171]  },
      { label:"Nemoc",         val:fmtHx(totSick),                     bg:[245,245,245], tc:[97,97,97]   },
      { label:"Sv.zavreno",    val:fmtHx(totHolClose),                 bg:[255,235,238], tc:[198,40,40]  },
      { label:"Sv.otevreno",   val:fmtHx(totHolOpen),                  bg:[241,248,233], tc:[51,105,30]  },
    ];
    const tiles2 = [
      { label:"Vikendy",       val:fmtHx(soH+neH),                     bg:[252,228,236], tc:[194,24,91]  },
      { label:"OCR + Jine",    val:fmtHx(totOcr+totOther),             bg:[255,243,224], tc:[230,81,0]   },
      { label:"Celkem hod.",   val:fmtHx(totAll),                      bg:[237,231,246], tc:[69,39,160]  },
      { label:"Presc./minus", val:(overtime>=0?"+":"")+fmtHx(Math.abs(overtime)), bg:overtime>=0?[232,245,233]:[255,235,238], tc:overtime>=0?[46,125,50]:[198,40,40] },
      { label:"Admin prace",   val:totAdmin>0?fmtHx(totAdmin):"—",     bg:[241,248,241], tc:[46,125,50]  },
      { label:"Stravenky",     val:tix>0?`${tix} ks`:"—",              bg:[249,251,231], tc:[130,119,23] },
    ];

    const drawTiles = (tiles, startX, startY) => {
      tiles.forEach((t, i)=>{
        const tx = startX + i*(tileW+tileGap);
        // Barevné pozadí
        doc.setFillColor(...t.bg);
        doc.roundedRect(tx, startY+1, tileW, tileH, 1, 1, "F");
        // Label
        doc.setFont("helvetica","normal"); doc.setFontSize(5.5);
        doc.setTextColor(...t.tc);
        doc.text(cz(t.label).toUpperCase(), tx+tileW/2, startY+4.5, {align:"center"});
        // Hodnota
        doc.setFont("helvetica","bold"); doc.setFontSize(9);
        doc.text(cz(t.val), tx+tileW/2, startY+10, {align:"center"});
      });
    };

    drawTiles(tiles1, marginL, sy+1);
    drawTiles(tiles2, marginL, sy+1+tileH+tileGap);

    // ── KPD – vizuální blok ──
    const ky = sy + 1 + (tileH+tileGap)*2 + 6;
    doc.setFont("helvetica","bold"); doc.setFontSize(8.5);
    doc.setTextColor(26,26,46);
    doc.text(cz("KPD – Konto presc. hodin"), marginL, ky);

    const kdpTiles = [
      { label:"KPD vstup (z min. mes.)", val:fmtHsign(kdpVstup),   bg:[232,234,246], tc:[57,73,171]  },
      { label:"Presc. tento mesic",       val:fmtHsign(overtime),   bg:overtime>=0?[232,245,233]:[255,235,238], tc:overtime>=0?[46,125,50]:[198,40,40] },
      { label:"KPD proplaceno",            val:kpdPaidThis>0?`${kpdPaidThis}h`:"— (nic)", bg:[255,243,224], tc:[230,81,0] },
      { label:"KPD vystup (pristi mes.)", val:fmtHsign(kdpVystup),  bg:kdpVystup>=0?[227,242,253]:[255,235,238], tc:kdpVystup>=0?[21,101,192]:[198,40,40] },
    ];
    const kdpTileW = (usableW - 3*tileGap) / 4;
    kdpTiles.forEach((t, i)=>{
      const tx = marginL + i*(kdpTileW+tileGap);
      doc.setFillColor(...t.bg);
      doc.roundedRect(tx, ky+2, kdpTileW, tileH+2, 1, 1, "F");
      doc.setFont("helvetica","normal"); doc.setFontSize(5.5);
      doc.setTextColor(...t.tc);
      doc.text(cz(t.label).toUpperCase(), tx+kdpTileW/2, ky+6, {align:"center"});
      doc.setFont("helvetica","bold"); doc.setFontSize(10);
      doc.text(cz(t.val), tx+kdpTileW/2, ky+12, {align:"center"});
    });

    // ── Podpis – pravý dolní roh ──
    const pageH = 297;
    doc.setFont("helvetica","normal"); doc.setFontSize(8);
    doc.setTextColor(100,100,100);
    // "Podpis zamestnance: " + čára hned za textem
    const podpisLabel = "Podpis zamestnance: ";
    const podpisLabelW = doc.getTextWidth(podpisLabel);
    const podpisX = pageW - marginL - 80;
    doc.text(podpisLabel, podpisX, pageH - 14);
    doc.setDrawColor(80,80,80);
    doc.line(podpisX + podpisLabelW + 1, pageH - 14, pageW - marginL, pageH - 14);
    doc.setFontSize(7);
    doc.setTextColor(160,160,160);
    doc.text(cz(`${employee.lastName} ${employee.firstName}`), podpisX + podpisLabelW + 1, pageH - 10);

    doc.save(`Vykaz_${employee.firstName}_${employee.lastName}_${MONTHS[month]}_${year}.pdf`);
  };

  return <div>
    {/* Hlavička */}
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
      <div style={{fontSize:20,fontWeight:800,color:C.topbar}}>{employee.lastName} {employee.firstName}</div>
      <Badge color="#e3f2fd" textColor="#1565c0">{MONTHS[month]} {year}</Badge>
      <Badge color="#f3e5f5" textColor="#6a1b9a">Fond: {fund}h</Badge>
      {holidayDays>0&&<Badge color="#ffebee" textColor="#c62828">Svátky zavřeno: {holidayDays} dní</Badge>}
    </div>

    {/* Legenda */}
    <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap",fontSize:11,color:"#888",padding:"6px 10px",background:"#f8f9ff",borderRadius:6,alignItems:"center"}}>
      <strong>Rozvrh:</strong>
      <span><span style={{color:"#c62828",fontWeight:700}}>⚠</span> <span style={{color:"#c62828"}}>červeně</span> = nevyplněno / mimo rozvrh</span>
      <span><span style={{color:"#f57f17",fontWeight:700}}>⚡</span> <span style={{color:"#f57f17"}}>žlutě</span> = odlišný čas &gt;15 min</span>
      <span style={{color:"#bbb"}}>│</span>
      <strong>Typ:</strong>
      <span style={{color:"#9c27b0",fontStyle:"italic"}}>kurzíva = z rozvrhu</span>
      <span>tučné = ručně</span>
    </div>

    <div style={{overflowX:"auto"}}>
      <table style={{borderCollapse:"collapse",fontSize:11,width:"100%",minWidth:980}}>
        <thead>
          <tr style={{background:C.topbar,color:"#fff"}}>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:26}}>Den</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:42}}>Datum</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:58}}>Rozvrh</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:66}}>Příchod</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:66}}>Odchod</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:60}}>Přest.od</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:60}}>Přest.do</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:50,background:"#2a3f6f"}}>Odprac.</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:50,background:"#1a3a5c"}}>DOV h</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:58,background:"#1e3a1e"}}>Admin</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:46,background:"#2d2a1a"}}>Roz.1</th>
            <th style={{padding:"6px 5px",whiteSpace:"nowrap",fontWeight:600,width:46,background:"#2d2a1a"}}>Roz.2</th>
            <th style={{padding:"6px 4px",whiteSpace:"nowrap",fontWeight:600,minWidth:118}}>Typ dne</th>
          </tr>
        </thead>
        <tbody>{rowData.map(({d,dow,hol,row,worked,breakMin,autoBreak,effectiveType,isAutoType,schedInfo,schedDay,vacH,schedVacH,patHours,isWE})=>{
          const isInactive = ["holidayClose","vacation","sick","ocr"].includes(effectiveType);
          // Barva řádku
          let rbg="#fff";
          if(effectiveType==="holidayClose")     rbg=C.holidayClose;
          else if(effectiveType==="holidayOpen") rbg=C.holidayOpen;
          else if(effectiveType==="vacation")    rbg="#e8f4fd";
          else if(effectiveType==="sick")        rbg="#f5f5f5";
          else if(effectiveType==="dayOff")      rbg=C.dayOff;   // světle zelená = volno
          else if(isWE)                          rbg="#f0f0f0";   // víkend = šedá

          // Sloupec Rozvrh – podporuje split
          const schedCol = ()=>{
            if(schedInfo.status==="extra")
              return <span style={{color:"#c62828",fontWeight:700,lineHeight:1.4,fontSize:10}}>⚠ —<br/><span style={{fontSize:9,fontWeight:400}}>mimo rozvrh</span></span>;
            if(!schedDay) return <span style={{color:"#ddd"}}>—</span>;
            if(schedDay.type==="vacation") return <span style={{color:"#1565c0",fontSize:10}}>DOV{schedDay.vacHours>0?` ${schedDay.vacHours%1===0?schedDay.vacHours:schedDay.vacHours.toFixed(1)}h`:""}</span>;
            if(schedDay.type==="sick")     return <span style={{color:"#888",fontSize:10}}>NEM{schedDay.vacHours>0?` ${schedDay.vacHours%1===0?schedDay.vacHours:schedDay.vacHours.toFixed(1)}h`:""}</span>;
            if(schedDay.type==="ocr")      return <span style={{color:"#e65100",fontSize:10}}>OČR{schedDay.vacHours>0?` ${schedDay.vacHours%1===0?schedDay.vacHours:schedDay.vacHours.toFixed(1)}h`:""}</span>;
            if(schedDay.type==="obstacle") return <span style={{color:"#f57f17",fontSize:10}}>PŘE{schedDay.vacHours>0?` ${schedDay.vacHours%1===0?schedDay.vacHours:schedDay.vacHours.toFixed(1)}h`:""}</span>;
            // Split směna – více segmentů
            if(schedDay.split && schedDay.segments){
              const labels = schedDay.segments.map(seg=>{
                const storeName = STORE_SHORT[seg.locationStoreId||seg.loc||employee.mainStore]||"";
                return shiftLabel(seg.from,seg.to)+(storeName?` ${storeName}`:"");
              });
              const isMissing = !row.arrival && !row.departure;
              const color = isMissing ? "#c62828" : "#555";
              return <span style={{color,fontSize:10,lineHeight:1.5,fontWeight:isMissing?700:400}}>
                {isMissing&&"⚠ "}{labels.map((l,i)=><span key={i}>{l}{i<labels.length-1&&<br/>}</span>)}
              </span>;
            }
            if(!schedDay.from) return <span style={{color:"#ddd"}}>—</span>;
            const lbl = shiftLabel(schedDay.from, schedDay.to);
            if(schedInfo.status==="missing")
              return <span style={{color:"#c62828",fontWeight:700,lineHeight:1.4,fontSize:10}}>⚠ {lbl}<br/><span style={{fontSize:9,fontWeight:400}}>nevyplněno</span></span>;
            if(schedInfo.status==="warn")
              return <span style={{color:"#f57f17",fontWeight:700,lineHeight:1.4,fontSize:10}}>⚡ {lbl}<br/><span style={{fontSize:9,fontWeight:400}}>odl. čas</span></span>;
            return <span style={{color:"#bbb",fontSize:10}}>{lbl}{schedDay.type==="work+vacation"&&<span style={{color:"#9c27b0"}}><br/>+DOV{schedDay.vacHours>0?` ${schedDay.vacHours%1===0?schedDay.vacHours:schedDay.vacHours.toFixed(1)}h`:""}</span>}</span>;
          };

          return <tr key={d} style={{background:rbg,borderBottom:"1px solid #f0f0f0"}}>
            {/* Den */}
            <td style={{padding:"2px 5px",textAlign:"center",fontWeight:700,color:isWE?"#e57373":"#aaa",fontSize:11}}>{DOW_LBL[dow]}</td>
            {/* Datum */}
            <td style={{padding:"2px 5px",textAlign:"center",fontWeight:700,color:isWE?"#e57373":C.topbar,whiteSpace:"nowrap",fontSize:11}}>{d}.{month+1}.</td>
            {/* Rozvrh */}
            <td style={{padding:"2px 4px",textAlign:"center",lineHeight:1.3}}>{schedCol()}</td>
            {/* Příchod */}
            <td style={{opacity:isInactive?0.3:1}}>
              <select value={row.arrival} onChange={e=>upd(d,"arrival",e.target.value)} style={{...ss,width:60}} disabled={isInactive}>
                {tOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Odchod */}
            <td style={{opacity:isInactive?0.3:1}}>
              <select value={row.departure} onChange={e=>upd(d,"departure",e.target.value)} style={{...ss,width:60}} disabled={isInactive}>
                {tOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Přest od */}
            <td>
              <select value={row.breakFrom||""} onChange={e=>upd(d,"breakFrom",e.target.value)} style={{...ss,width:57,color:row.breakFrom?"#e65100":"#ccc"}} disabled={isInactive}>
                {tOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Přest do */}
            <td>
              <select value={row.breakTo||""} onChange={e=>upd(d,"breakTo",e.target.value)} style={{...ss,width:57,color:row.breakTo?"#e65100":"#ccc"}} disabled={isInactive}>
                {tOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Odpracováno */}
            <td style={{textAlign:"center",fontWeight:800,background:"#f0f4ff",minWidth:46,padding:"2px 3px"}}>
              {worked>0
                ? <span style={{color:"#1565c0",fontSize:12}}>{worked%1===0?worked:worked.toFixed(1)}h</span>
                : <span style={{color:"#ddd",fontSize:11}}>—</span>}
              {breakMin>0&&<div style={{fontSize:9,color:autoBreak?"#ccc":"#e65100",fontWeight:400}}>−{breakMin}m{autoBreak?" aut":""}</div>}
            </td>
            {/* DOV hodiny – read-only ze sched záznamu */}
            <td style={{textAlign:"center",background:"#f3e5f5",minWidth:48,padding:"2px 3px"}}>
              {(effectiveType==="work+vacation"||effectiveType==="vacation"||effectiveType==="sick")&&(schedVacH>0||vacH>0)
                ? <span style={{color:"#6a1b9a",fontWeight:700,fontSize:11}}>
                    {(effectiveType==="work+vacation"?vacH:schedVacH)%1===0
                      ? `${effectiveType==="work+vacation"?vacH:schedVacH}h`
                      : `${(effectiveType==="work+vacation"?vacH:schedVacH).toFixed(1)}h`}
                  </span>
                : <span style={{color:"#ddd",fontSize:10}}>—</span>}
            </td>
            {/* Admin práce */}
            <td style={{textAlign:"center",background:"#f1f8f1",minWidth:55,padding:"2px 3px"}}>
              <select value={row.admin||""} onChange={e=>upd(d,"admin",e.target.value===""?"":Number(e.target.value))} style={{...ss,width:53,color:row.admin?"#2e7d32":"#ccc",fontWeight:row.admin?700:400,fontSize:11}}>
                {adminOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Rozvoz 1 */}
            <td style={{textAlign:"center",background:"#fffde7",minWidth:44,padding:"2px 2px"}}>
              <select value={row.roz1||""} onChange={e=>upd(d,"roz1",e.target.value===""?"":Number(e.target.value))} style={{...ss,width:42,color:row.roz1?"#f57f17":"#ccc",fontWeight:row.roz1?700:400,fontSize:11}}>
                {rozOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Rozvoz 2 */}
            <td style={{textAlign:"center",background:"#fff8e1",minWidth:44,padding:"2px 2px"}}>
              <select value={row.roz2||""} onChange={e=>upd(d,"roz2",e.target.value===""?"":Number(e.target.value))} style={{...ss,width:42,color:row.roz2?"#e65100":"#ccc",fontWeight:row.roz2?700:400,fontSize:11}}>
                {rozOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </td>
            {/* Typ dne – užší */}
            <td style={{padding:"2px 4px",minWidth:118}}>
              <select
                value={effectiveType}
                onChange={e=>upd(d,"type",e.target.value)}
                style={{...ss,minWidth:114,fontStyle:isAutoType?"italic":"normal",color:typeColor[effectiveType]||"#333",fontWeight:isAutoType?400:700,fontSize:11}}
              >
                {typeOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {isAutoType&&<div style={{fontSize:8,color:"#ccc",textAlign:"center",lineHeight:1,marginTop:1}}>z rozvrhu</div>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>

    {/* Souhrnný panel */}
    <div style={{marginTop:16,background:"#fff",borderRadius:10,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
      <div style={{background:C.topbar,color:"#fff",padding:"8px 16px",fontWeight:700,fontSize:13}}>📊 Souhrn měsíce</div>
      <div style={{padding:"12px 14px",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:8}}>
        {[
          {label:"Fond hodin",         val:fund,             color:"#e3f2fd",tc:"#1565c0"},
          {label:"Odpracovano",        val:totWorked,        color:"#e8f5e9",tc:"#2e7d32"},
          {label:"Dovolena",           val:totVac,           color:"#e8eaf6",tc:"#3949ab"},
          {label:"Nemoc",              val:totSick,          color:"#f5f5f5",tc:"#616161"},
          {label:"Svátek zavřeno",     val:totHolClose,      color:"#ffebee",tc:"#c62828"},
          {label:"Svátek otevřeno",    val:totHolOpen,       color:"#f1f8e9",tc:"#33691e"},
          {label:"Vikendy",             val:soH+neH,          color:"#fce4ec",tc:"#c2185b"},
          {label:"OCR + Jine",         val:totOcr+totOther,  color:"#fff3e0",tc:"#e65100"},
          {label:"Celkem hod.",         val:totAll,           color:"#ede7f6",tc:"#4527a0"},
          {label:"Přesčas / minus",    val:overtime,         color:overtime>=0?"#e8f5e9":"#ffebee",tc:overtime>=0?"#2e7d32":"#c62828",sign:true},
          {label:"Admin prace",        val:totAdmin,         color:"#f1f8f1",tc:"#2e7d32",unit:"h"},
          {label:"Rozvoz 1",           val:totRoz1,          color:"#fffde7",tc:"#f57f17",unit:"×"},
          {label:"Rozvoz 2",           val:totRoz2,          color:"#fff8e1",tc:"#e65100",unit:"×"},
          {label:"Stravenky",          val:tix,              color:"#f9fbe7",tc:"#827717",unit:"ks"},
        ].map(item=>{
          const display = item.sign
            ? (overtime>=0?"+":"")+(Math.abs(overtime)%1===0?`${Math.abs(overtime)}h`:`${Math.abs(overtime).toFixed(1)}h`)
            : item.unit==="×"
              ? (item.val===0?"—":`${item.val}×`)
            : item.unit==="ks"
              ? (item.val===0?"—":`${item.val} ks`)
            : fmtH(item.val);
          return <div key={item.label} style={{background:item.color,borderRadius:8,padding:"9px 10px",textAlign:"center"}}>
            <div style={{fontSize:9,color:item.tc,fontWeight:700,textTransform:"uppercase",marginBottom:3,lineHeight:1.3}}>{item.label}</div>
            <div style={{fontSize:16,fontWeight:800,color:item.tc}}>{display}</div>
          </div>;
        })}
      </div>
      <div style={{padding:"6px 16px",background:"#f8f9ff",fontSize:11,color:"#aaa",borderTop:`1px solid ${C.border}`}}>
        Celkem = Odprac. + Dovolená + Nemoc + Sv.zavřeno + OČR + Jiné &nbsp;│&nbsp;
        So: {fmtH(soH)} &nbsp;│&nbsp; Ne: {fmtH(neH)}
      </div>
      {/* KPD sekce */}
      <div style={{borderTop:`2px solid ${C.border}`,padding:"14px 16px",background:"#f0f4ff"}}>
        <div style={{fontSize:12,fontWeight:800,color:C.topbar,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.06em"}}>📈 KPD – Konto přesčasových hodin</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,alignItems:"end"}}>
          {/* KPD vstup */}
          <div style={{background:"#e8eaf6",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontSize:9,fontWeight:700,color:"#3949ab",textTransform:"uppercase",marginBottom:4}}>KPD vstup (z min. měsíce)</div>
            <div style={{fontSize:18,fontWeight:800,color:kdpVstup>=0?"#3949ab":"#c62828"}}>{fmtHsign(kdpVstup)}</div>
          </div>
          {/* Přesčas tento měsíc – odkaz na stávající hodnotu */}
          <div style={{background:overtime>=0?"#e8f5e9":"#ffebee",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontSize:9,fontWeight:700,color:overtime>=0?"#2e7d32":"#c62828",textTransform:"uppercase",marginBottom:4}}>Přesčas / minus tento měsíc</div>
            <div style={{fontSize:18,fontWeight:800,color:overtime>=0?"#2e7d32":"#c62828"}}>{fmtHsign(overtime)}</div>
          </div>
          {/* KPD proplaceno – editovatelné pro vedoucího, read-only pro prodavače */}
          <div style={{background:"#fff3e0",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
            <div style={{fontSize:9,fontWeight:700,color:"#e65100",textTransform:"uppercase",marginBottom:6}}>KPD proplaceno (vedoucí)</div>
            {canEditKdp
              ? <select
                  value={kpdPaidThis}
                  onChange={e=>onKdpPaidChange(Number(e.target.value))}
                  style={{padding:"5px 8px",borderRadius:6,border:`1.5px solid #ffcc80`,fontSize:14,fontWeight:700,color:"#e65100",background:"#fff",width:"100%",textAlign:"center"}}
                >
                  {[0,0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,9,10,12,14,16,20,24,32,40].map(v=>(
                    <option key={v} value={v}>{v===0?"— (nic)":v%1===0?`${v}h`:`${v}h`}</option>
                  ))}
                </select>
              : <div style={{fontSize:16,fontWeight:800,color:"#e65100",padding:"4px 0"}}>
                  {kpdPaidThis===0?"— (nic)":kpdPaidThis%1===0?`${kpdPaidThis}h`:`${kpdPaidThis}h`}
                </div>
            }
          </div>
          {/* KPD výstup */}
          <div style={{background:kdpVystup>=0?"#e3f2fd":"#ffebee",borderRadius:8,padding:"10px 12px",textAlign:"center",border:`2px solid ${kdpVystup>=0?"#90caf9":"#ef9a9a"}`}}>
            <div style={{fontSize:9,fontWeight:700,color:kdpVystup>=0?"#1565c0":"#c62828",textTransform:"uppercase",marginBottom:4}}>KPD výstup (do příštího měsíce)</div>
            <div style={{fontSize:20,fontWeight:800,color:kdpVystup>=0?"#1565c0":"#c62828"}}>{fmtHsign(kdpVystup)}</div>
            <div style={{fontSize:9,color:"#aaa",marginTop:2}}>= vstup {fmtHsign(kdpVstup)} + přesčas {fmtHsign(overtime)}{kpdPaidThis>0?` − proplaceno ${kpdPaidThis}h`:""}</div>
          </div>
        </div>
      </div>
    </div>

    {/* Status výkazu + akční tlačítka */}
    <div style={{marginTop:12,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
      {/* Stavový štítek */}
      {tsStatus==="submitted"&&<span style={{padding:"6px 14px",borderRadius:20,background:"#fff8e1",color:"#f57f17",fontWeight:700,fontSize:13,border:"1.5px solid #ffe082"}}>🟡 Čeká na schválení</span>}
      {tsStatus==="approved"&&<span style={{padding:"6px 14px",borderRadius:20,background:"#e8f5e9",color:"#2e7d32",fontWeight:700,fontSize:13,border:"1.5px solid #a5d6a7"}}>✅ Schváleno</span>}
      {tsStatus==="returned"&&<span style={{padding:"6px 14px",borderRadius:20,background:"#ffebee",color:"#c62828",fontWeight:700,fontSize:13,border:"1.5px solid #ffcdd2"}}>🔴 Vráceno k opravě</span>}
      {(tsStatus==="draft"||!tsStatus)&&<span style={{padding:"6px 14px",borderRadius:20,background:"#f5f5f5",color:"#888",fontWeight:600,fontSize:13,border:"1.5px solid #e0e0e0"}}>✏️ Rozpracováno</span>}

      {/* Tlačítka pro zaměstnance */}
      {!isVedouci&&(tsStatus==="draft"||!tsStatus||tsStatus==="returned")&&
        <Btn onClick={onSubmit}>📤 Odeslat ke schválení</Btn>}

      {/* Tlačítka pro vedoucího */}
      {isVedouci&&tsStatus==="submitted"&&<>
        <Btn onClick={onApprove} style={{background:"#2e7d32",color:"#fff",border:"none"}}>✅ Schválit</Btn>
        <Btn variant="danger" onClick={onReturn}>🔴 Vrátit k opravě</Btn>
      </>}
      {isVedouci&&tsStatus==="approved"&&
        <Btn variant="secondary" onClick={onReturn}>↩️ Zrušit schválení</Btn>}

      <Btn variant="secondary" onClick={exportPdf}>🖨️ Export PDF</Btn>
      <Btn variant="secondary" onClick={exportExcel}>📊 Export Excel</Btn>
    </div>
  </div>;
}


// ─── SUMMARY TABLE ───────────────────────────────────────────
// ─── KPD HELPER ──────────────────────────────────────────────
// Vypočítá kumulativní KPD pro zaměstnance k danému měsíci (včetně).
// Prochází všechny měsíce od APP_START do (year,month) a sčítá přesčas − proplaceno.
function calcKpdCumulative(emp, toYear, toMonth, sched, holidays, stores, patterns, employees, timesheetData){
  let kdp = emp.kpdStart || 0;
  // Začni od data nástupu zaměstnance (pokud je novější než APP_START)
  let y = APP_START.year, m = APP_START.month;
  if(emp.startDate){
    const sd = new Date(emp.startDate);
    const sy = sd.getFullYear(), sm = sd.getMonth();
    if(sy > y || (sy === y && sm > m)){ y = sy; m = sm; }
  }
  while(y < toYear || (y === toYear && m <= toMonth)){
    const dim = getDim(y, m);
    const wd  = getWorkingDays(y, m, holidays);
    const fund = wd * empContractDay(emp);
    const mainStoreEmps = employees.filter(e=>e.active && e.mainStore===emp.mainStore);
    const empIdx = mainStoreEmps.findIndex(e=>e.id===emp.id);
    let planned = 0;
    for(let d=1;d<=dim;d++){
      const date = new Date(y,m,d);
      const dow  = getDow(y,m,d);
      const ds   = fmtDate(y,m,d);
      const hol  = holidays.find(h=>h.date===ds);
      const cell = getSchedCell(sched, emp.id, ds, employees);
      if(cell?.length){
        const workSegs = cell.filter(s=>s.type==="work" && s.from && s.to);
        const vacSeg   = cell.find(s=>s.type==="vacation"||s.type==="sick");
        const otherAbs = cell.find(s=>s.type!=="work"&&s.type!=="vacation"&&s.type!=="sick"&&s.type!=="dayOff");
        if(workSegs.length){ planned += calcSplitWorked(workSegs, emp.mainStore, stores); if(vacSeg) planned += (vacSeg.hours||0); }
        else if(vacSeg||otherAbs){ planned += ((vacSeg||otherAbs).hours||0); }
      } else {
        const pc = getPatCell(patterns, emp.mainStore, empIdx, date);
        if(pc){
          const st  = typeof pc==="object"?pc.shift||"work":pc;
          const lId = typeof pc==="object"?(pc.loc||emp.mainStore):emp.mainStore;
          const [fr,to] = getEmpShiftTimes(emp, lId, st, dow, stores, typeof pc==="object"?pc:null, hol);
          if(fr&&to) planned += calcWorked(fr, to, getBreakRules(lId, stores));
        }
      }
    }
    const overtime = planned - fund;
    // KPD proplaceno z timesheetData pro tento měsíc
    const tsKey = `${emp.id}-${y}-${m+1}`;
    const tsMonth = timesheetData?.[tsKey] || {};
    const paid = Number(tsMonth.kpdPaid || 0);
    kdp += overtime - paid;
    // posun na další měsíc
    if(m===11){y++;m=0;}else{m++;}
  }
  return kdp;
}

function SummaryTable({storeId, employees, year, month, sched, holidays, stores, patterns, timesheetData}){
  const emps = employees.filter(e=>e.active && e.mainStore===storeId && isEmpActiveInMonth(e,year,month));
  const dim  = getDim(year, month);
  const wd   = getWorkingDays(year, month, holidays);

  const fmtH = h => h===0?"0h":(h%1===0?`${h}h`:`${h.toFixed(1)}h`);
  const colStyle = (val, pos="#2e7d32", neg="#c62828") => ({
    padding:"8px 10px", textAlign:"center", borderBottom:`1px solid ${C.border}`,
    fontWeight:700, color: val>0?pos: val<0?neg:"#aaa"
  });

  const headers = [
    "Zaměstnanec",
    "Měsíční fond",
    "Naplánováno",
    "Přesčas",
    "KPD zůstatek",
    "Dovolená nárok",
    "Dovolená čerpáno",
    "Dovolená zbývá",
  ];

  return <div style={{overflowX:"auto"}}>
    <table style={{borderCollapse:"collapse", width:"100%", fontSize:13}}>
      <thead>
        <tr style={{background:"#f8f9ff"}}>
          {headers.map(h=><th key={h} style={{
            padding:"8px 10px", textAlign: h==="Zaměstnanec"?"left":"center",
            fontSize:11, fontWeight:700, color:"#888", textTransform:"uppercase",
            letterSpacing:"0.05em", borderBottom:`2px solid ${C.border}`, whiteSpace:"nowrap"
          }}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {emps.map((emp, i)=>{
          const fund = getEmpFund(emp, year, month, holidays);

          // Naplánované hodiny – vzor + ruční změny v rozvrhu
          const mainStoreEmps = employees.filter(e=>e.active&&e.mainStore===storeId);
          const empIdx = mainStoreEmps.findIndex(e=>e.id===emp.id);
          let planned = 0;
          for(let d=1;d<=dim;d++){
            const date = new Date(year,month,d);
            const dow  = getDow(year,month,d);
            const ds   = fmtDate(year,month,d);
            const cell = getSchedCell(sched, emp.id, ds, employees);

            if(cell?.length){
              // Ruční záznam má přednost
              const workSegs = cell.filter(s=>s.type==="work" && s.from && s.to);
              const vacSeg   = cell.find(s=>s.type==="vacation"||s.type==="sick");
              const otherAbs = cell.find(s=>s.type!=="work"&&s.type!=="vacation"&&s.type!=="sick"&&s.type!=="dayOff");

              if(workSegs.length){
                // Práce (případně i s dovolenou) – reálné hodiny práce
                planned += calcSplitWorked(workSegs, emp.mainStore, stores);
                // Dovolená část (seg.hours přímo ze záznamu)
                if(vacSeg) planned += (vacSeg.hours||0);
              } else if(vacSeg||otherAbs){
                // Čistá absence – přičti seg.hours přímo ze záznamu (co vedoucí zadal)
                const abs = vacSeg||otherAbs;
                planned += (abs.hours||0);
              }
            } else {
              // Ze vzoru – respektuj sváteční čas
              const hol = holidays.find(h=>h.date===ds);
              const pc = getPatCell(patterns, storeId, empIdx, date);
              if(pc){
                const st  = typeof pc==="object"?pc.shift||"work":pc;
                const lId = typeof pc==="object"?(pc.loc||storeId):storeId;
                const [fr,to] = getEmpShiftTimes(emp, lId, st, dow, stores, typeof pc==="object"?pc:null, hol);
                if(fr&&to) planned += calcWorked(fr, to, getBreakRules(lId, stores));
              }
            }
          }

          // Ze sched: dovolená hodiny
          let vacUsed = 0;
          for(let d=1;d<=dim;d++){
            const ds  = fmtDate(year,month,d);
            const cell= getSchedCell(sched, emp.id, ds, employees);
            if(!cell) continue;
            for(const seg of cell){
              if(seg.type==="vacation") vacUsed += (seg.hours||0);
            }
          }

          const overtime   = planned - fund;
          const beforeStart = year<APP_START.year||(year===APP_START.year&&month<APP_START.month);
          const kdp        = beforeStart ? null : calcKpdCumulative(emp, year, month, sched, holidays, stores, patterns, employees, timesheetData);
          const kpdPaid    = 0;
          const kdpBalance = kdp!==null ? kdp : null;
          const vacNarok = (emp.vacHours||0)+(emp.vacAdjustment||0); const vacLeft    = vacNarok - vacUsed;
          const kdpFmt = v => v===null?"—":(v>0?"+":v<0?"-":"")+fmtH(Math.abs(v));
          const kdpStyle = v => v===null
            ? {padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#ccc"}
            : colStyle(v,"#1565c0","#c62828");

          return <tr key={emp.id} style={{background: i%2===0?"#fff":"#fafafe"}}>
            <td style={{padding:"8px 10px", fontWeight:700, color:C.topbar, borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap"}}>
              {emp.lastName} {emp.firstName}
              <div style={{fontSize:10,color:"#bbb",fontWeight:400}}>{emp.role} · {empContractDay(emp)}h/den · {empContractWeek(emp)}h/týden</div>
            </td>
            <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#555"}}>{fmtH(fund)}</td>
            <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#1a1a2e",fontWeight:600}}>{fmtH(planned)}</td>
            <td style={colStyle(overtime)}>{overtime>0?"+":""}{fmtH(overtime)}</td>
            <td style={kdpStyle(kdp)}>{kdpFmt(kdp)}</td>
            <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#555"}}>{fmtH((emp.vacHours||0)+(emp.vacAdjustment||0))}</td>
            <td style={{padding:"8px 10px",textAlign:"center",borderBottom:`1px solid ${C.border}`,color:"#1565c0",fontWeight:600}}>{fmtH(vacUsed)}</td>
            <td style={colStyle(vacLeft, "#2e7d32", "#c62828")}>{fmtH(vacLeft)}</td>
          </tr>;
        })}
      </tbody>
    </table>
    <div style={{marginTop:10,fontSize:11,color:"#bbb",padding:"6px 0"}}>
      * KPD zaplacené – bude dostupné po napojení na výplatní evidenci. Přesčas = Naplánováno − Fond.
    </div>
  </div>;
}

// ─── MAIN APP ────────────────────────────────────────────────
// ─── UŽIVATELÉ / PŘIHLÁŠENÍ ──────────────────────────────────
async function sha256hex(str){
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// Přihlášení z Supabase tabulky app_users
async function verifyLogin(login, password){
  const loginNorm = login.toLowerCase().trim();
  const inputHash = await sha256hex(password);
  const {data, error} = await supabase
    .from("app_users")
    .select("login,password_hash,role,name,store_ids,emp_id")
    .eq("login", loginNorm)
    .single();
  if(error || !data) return null;
  if(data.password_hash !== inputHash) return null;
  return {
    login: data.login,
    role:  data.role,
    name:  data.name,
    storeIds: data.store_ids || [],
    empId: data.emp_id,
  };
}

// Uložení nového hesla do DB (volá vedoucí)
async function saveUserPassword(login, newPassword){
  const hash = await sha256hex(newPassword);
  const {error} = await supabase
    .from("app_users")
    .update({password_hash: hash})
    .eq("login", login);
  return !error;
}

// Uložení loginu do DB
async function saveUserLogin(oldLogin, newLogin, empId, role, name, storeIds){
  const {error} = await supabase
    .from("app_users")
    .upsert({login: newLogin, emp_id: empId, role, name, store_ids: storeIds}, {onConflict:"login"});
  if(!error && oldLogin !== newLogin){
    await supabase.from("app_users").delete().eq("login", oldLogin);
  }
  return !error;
}

function LoginScreen({onLogin}){
  const [login,setLogin]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const handle=async()=>{
    if(!login||!password){setError("Vyplňte jméno a heslo.");return;}
    setLoading(true);setError("");
    const user=await verifyLogin(login,password);
    setLoading(false);
    if(user) onLogin(user);
    else setError("Nesprávné jméno nebo heslo.");
  };
  return(
    <div style={{minHeight:"100vh",background:"#1a1a2e",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#fff",borderRadius:16,padding:40,width:"100%",maxWidth:400,boxShadow:"0 32px 80px rgba(0,0,0,0.4)"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <img src="/logo.png" alt="ELEKTRO Jankovský" style={{width:240,marginBottom:8}}/>
          <div style={{fontSize:18,fontWeight:800,color:"#1a1a2e",marginTop:4}}>Rozvrh směn</div>
          <div style={{fontSize:13,color:"#aaa",marginTop:2}}>ELEKTRO Jankovský s.r.o.</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div>
            <label style={{fontSize:11,fontWeight:700,color:"#888",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.06em"}}>Přihlašovací jméno</label>
            <input value={login} onChange={e=>setLogin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()}
              placeholder="např. jankovský" autoFocus
              style={{width:"100%",padding:"11px 13px",borderRadius:8,border:"1.5px solid #E8E8F0",fontSize:15,boxSizing:"border-box",outline:"none"}}/>
          </div>
          <div>
            <label style={{fontSize:11,fontWeight:700,color:"#888",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.06em"}}>Heslo</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()}
              placeholder="••••••••"
              style={{width:"100%",padding:"11px 13px",borderRadius:8,border:"1.5px solid #E8E8F0",fontSize:15,boxSizing:"border-box",outline:"none"}}/>
          </div>
          {error&&<div style={{background:"#ffebee",color:"#c62828",padding:"9px 13px",borderRadius:7,fontSize:13,fontWeight:600}}>⚠️ {error}</div>}
          <button onClick={handle} disabled={loading}
            style={{background:"#1a1a2e",color:"#fff",border:"none",borderRadius:9,padding:"13px",fontSize:15,fontWeight:700,cursor:loading?"not-allowed":"pointer",opacity:loading?0.7:1,marginTop:4}}>
            {loading?"Ověřuji...":"Přihlásit se →"}
          </button>
        </div>
        <div style={{marginTop:24,fontSize:11,color:"#ccc",textAlign:"center"}}>Zapomenuté heslo? Kontaktujte Jankovského.</div>
      </div>
    </div>
  );
}

function MainApp({currentUser, handleLogout}){
  const [tab,setTab]=useState("schedule");
  const [storeId,setStoreId]=useState(currentUser?.storeIds?.[0]??1);
  // Výchozí měsíc = aktuální
  const _now = new Date();
  const [year,setYear]=useState(_now.getFullYear());
  const [month,setMonth]=useState(_now.getMonth());

  // ─── DATA STATE ──────────────────────────────────────────────
  const [employees,setEmployees]=useState(INIT_EMPS);
  const [stores,setStores]=useState(INIT_STORES);
  const [sched,setSched]=useState({});
  const [holidays,setHolidays]=useState(DEFAULT_HOLIDAYS);
  const [actions,setActions]=useState([]);
  const [patterns,setPatterns]=useState(makeDefaultPatterns());
  const [timesheetData,setTimesheetData]=useState({});
  const [dbReady,setDbReady]=useState(false);
  const [dbError,setDbError]=useState(null);
  const [saving,setSaving]=useState(false);
  const [showResetConfirm,setShowResetConfirm]=useState(false);
  const [showResetTsConfirm,setShowResetTsConfirm]=useState(false);

  // Debounce timery pro úspory volání DB
  const saveTimers=useRef({});

  // ─── INITIAL LOAD ────────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        // Paralelní načtení všech tabulek
        const [
          {data:storesD,  error:e1},
          {data:empsD,    error:e2},
          {data:holsD,    error:e3},
          {data:actsD,    error:e4},
          {data:patsD,    error:e5},
          {data:schedD,   error:e6},
          {data:tsD,      error:e7},
        ] = await Promise.all([
          supabase.from("stores").select("*").order("id"),
          supabase.from("employees").select("*").order("id"),
          supabase.from("holidays").select("*").order("date"),
          supabase.from("actions").select("*").order("id"),
          supabase.from("patterns").select("*"),
          supabase.from("schedule").select("*"),
          supabase.from("timesheets").select("*"),
        ]);
        if(e1||e2||e3) throw new Error((e1||e2||e3).message);

        // Prodejny
        if(storesD?.length) setStores(storesD.map(dbToStore));

        // Zaměstnanci
        if(empsD?.length) setEmployees(empsD.map(dbToEmp));

        // Svátky
        if(holsD?.length) setHolidays(holsD.map(dbToHoliday));

        // Akce
        if(actsD?.length) setActions(actsD.map(r=>({
          id:r.id, name:r.name, month:r.month,
          from:r.from_date, to:r.to_date,
        })));

        // Vzory
        if(patsD?.length){
          const pats=makeDefaultPatterns();
          for(const r of patsD){
            if(!pats[r.store_id]) pats[r.store_id]={odd:[],even:[],flat:[]};
            const wt=r.week_type;
            while(pats[r.store_id][wt].length<=r.emp_index)
              pats[r.store_id][wt].push(Array(7).fill(null));
            pats[r.store_id][wt][r.emp_index]=r.row_data;
          }
          setPatterns(pats);
        }

        // Rozvrh – převod na {key: segs[]}
        if(schedD?.length){
          const s={};
          for(const r of schedD){
            // Klíč: mainStore-empId-date (stejný formát jako schedKey)
            const emp=empsD?.find(e=>e.id===r.emp_id);
            const ms=emp?.main_store||1;
            s[`${ms}-${r.emp_id}-${r.date}`]=r.segments;
          }
          setSched(s);
        }

        // Výkazy – převod do {empId-year-month: {day: {arrival,...}, _status, kpdPaid}}
        if(tsD?.length){
          const td={};
          for(const r of tsD){
            const k=`${r.emp_id}-${r.year}-${r.month}`;
            if(!td[k]) td[k]={};
            // Den=0 je metadata (kpdPaid, status) – neukladame ho jako normalni den
            if(r.day > 0){
              td[k][r.day]={
                arrival:r.arrival||"", departure:r.departure||"",
                breakFrom:r.break_from||"", breakTo:r.break_to||"",
                type:r.day_type||"",
                admin:r.admin||"", roz1:r.roz1||"", roz2:r.roz2||"",
              };
            }
            // KPD proplaceno – čte se z libovolného řádku kde je nastaveno
            if(r.kpd_paid && Number(r.kpd_paid)>0) td[k].kpdPaid = Number(r.kpd_paid);
            // Status výkazu
            if(r.status && r.status!=="draft") td[k]._status = r.status;
          }
          setTimesheetData(td);
        }

        setDbReady(true);
      } catch(err){
        console.error("DB load error:", err);
        setDbError(err.message);
        setDbReady(true); // pokračuj s výchozími daty
      }
    })();
  },[]);

  // ─── SAVE HELPERS ────────────────────────────────────────────
  const dbSaveEmployees=useCallback(async(emps)=>{
    const existing=emps.filter(e=>e.id&&typeof e.id==="number"&&e.id<1000000000);
    if(existing.length) await supabase.from("employees").upsert(existing.map(empToDB),{onConflict:"id"});
  },[]);

  const dbSaveStores=useCallback(async(sts)=>{
    for(const s of sts){
      await supabase.from("stores").update({
        name:s.name, hours:s.hours,
        break_rules:s.breakRules,
        default_times:s.defaultTimes,
      }).eq("id",s.id);
    }
  },[]);

  const dbSaveHolidays=useCallback(async(hols)=>{
    await supabase.from("holidays").delete().neq("id",0);
    if(hols.length) await supabase.from("holidays").insert(hols.map(holidayToDB));
  },[]);

  const dbSaveActions=useCallback(async(acts)=>{
    await supabase.from("actions").delete().neq("id",0);
    if(acts.length) await supabase.from("actions").insert(acts.map(a=>({
      name:a.name, month:a.month,
      from_date:a.from, to_date:a.to,
    })));
  },[]);

  const dbSavePatterns=useCallback(async(pats)=>{
    const rows=[];
    for(const [storeIdStr,pat] of Object.entries(pats)){
      const sid=Number(storeIdStr);
      for(const wt of ["odd","even","flat"]){
        const arr=pat[wt]||[];
        arr.forEach((row,idx)=>{
          if(row) rows.push({store_id:sid,week_type:wt,emp_index:idx,row_data:row});
        });
      }
    }
    await supabase.from("patterns").delete().neq("id",0);
    if(rows.length) await supabase.from("patterns").insert(rows);
  },[]);

  const dbSaveSchedCell=useCallback(async(key,segs,empList)=>{
    // key = "mainStore-empId-date"
    const parts=key.split("-");
    const empId=Number(parts[1]);
    const date=`${parts[2]}-${parts[3]}-${parts[4]}`;
    if(!segs||segs.length===0){
      await supabase.from("schedule").delete().eq("emp_id",empId).eq("date",date);
    } else {
      await supabase.from("schedule").upsert({emp_id:empId,date,segments:segs},{onConflict:"emp_id,date"});
    }
  },[]);

  const dbSaveTimesheetRow=useCallback(async(empId,y,m,day,rowData)=>{
    const {arrival,departure,breakFrom,breakTo,type,admin,roz1,roz2}=rowData;
    await supabase.from("timesheets").upsert({
      emp_id:empId, year:y, month:m, day,
      arrival:arrival||null, departure:departure||null,
      break_from:breakFrom||null, break_to:breakTo||null,
      day_type:type||null,
      admin:admin||null, roz1:roz1||null, roz2:roz2||null,
    },{onConflict:"emp_id,year,month,day"});
  },[]);

  // Uložení KPD proplaceno do DB – ukládá se na speciální den=0
  const dbSaveKdpPaid=useCallback(async(empId,y,m,kpdPaid)=>{
    await supabase.from("timesheets").upsert({
      emp_id:empId, year:y, month:m, day:0,
      kpd_paid: kpdPaid,
    },{onConflict:"emp_id,year,month,day"});
  },[]);

  // Uložení statusu výkazu – aktualizuje všechny řádky daného emp/year/month
  const dbSaveTimesheetStatus=useCallback(async(empId,y,m,status)=>{
    await supabase.from("timesheets")
      .update({status})
      .eq("emp_id",empId).eq("year",y).eq("month",m);
    // Pokud výkaz ještě nemá žádné řádky, vlož alespoň jeden pro uložení statusu
    const {data} = await supabase.from("timesheets")
      .select("id").eq("emp_id",empId).eq("year",y).eq("month",m).limit(1);
    if(!data?.length){
      await supabase.from("timesheets").insert({
        emp_id:empId, year:y, month:m, day:1, status
      });
    }
  },[]);

  // Debounced save – sloučí rychlé změny do 1 DB volání
  const debounceSave=(key,fn,delay=800)=>{
    if(saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key]=setTimeout(fn,delay);
  };

  // ─── SETTERY S AUTO-SAVE ─────────────────────────────────────
  const setEmployeesDB=useCallback((updater)=>{
    setEmployees(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      debounceSave("employees",()=>dbSaveEmployees(next));
      return next;
    });
  },[dbSaveEmployees]);

  const setStoresDB=useCallback((updater)=>{
    setStores(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      debounceSave("stores",()=>dbSaveStores(next));
      return next;
    });
  },[dbSaveStores]);

  const setHolidaysDB=useCallback((updater)=>{
    setHolidays(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      debounceSave("holidays",()=>dbSaveHolidays(next));
      return next;
    });
  },[dbSaveHolidays]);

  const setActionsDB=useCallback((updater)=>{
    setActions(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      debounceSave("actions",()=>dbSaveActions(next));
      return next;
    });
  },[dbSaveActions]);

  const setPatternsDB=useCallback((updater)=>{
    setPatterns(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      debounceSave("patterns",()=>dbSavePatterns(next),1200);
      return next;
    });
  },[dbSavePatterns]);

  // Knihovny jsou načteny v index.html ve správném pořadí – nic nedělat
  // XLSX, ExcelJS, jsPDF, jspdf-autotable jsou dostupné jako window.XLSX atd.

  const [editCell,setEditCell]=useState(null);
  const [tsEmp,setTsEmp]=useState(()=>{
    // Prodavač vidí pouze svůj výkaz – auto-select při načtení
    if(currentUser.role==="zamestnanec"){
      // empId je uloženo v currentUser (z app_users.emp_id)
      if(currentUser.empId) return currentUser.empId;
    }
    return null;
  });

  const canEdit=currentUser.role==="admin"||currentUser.role==="vedouci";

  const tsKey=(empId,y,m)=>`${empId}-${y}-${m}`;
  const updTimesheetRow=(empId,y,m,day,field,value)=>{
    const k=tsKey(empId,y,m);
    setTimesheetData(prev=>{
      const mdata=prev[k]||{};
      const newRow={...(mdata[day]||{}),[field]:value};
      const next={...prev,[k]:{...mdata,[day]:newRow}};
      // Uložit do DB (debounced)
      debounceSave(`ts-${empId}-${y}-${m}-${day}`,()=>dbSaveTimesheetRow(empId,y,m,day,newRow),600);
      return next;
    });
  };
  const getTimesheetRows=(empId,y,m)=>{
    const k=tsKey(empId,y,m);
    const dim=getDim(y,m-1);
    const stored=timesheetData[k]||{};
    const rows={};
    for(let d=1;d<=dim;d++) rows[d]={arrival:"",departure:"",breakFrom:"",breakTo:"",type:"",...(stored[d]||{})};
    return rows;
  };

  const isAtStart = year===APP_START.year && month===APP_START.month;
  const isBeforeStart = (y,m) => y<APP_START.year||(y===APP_START.year&&m<APP_START.month);
  const prevM=()=>{if(isAtStart) return; const d=new Date(year,month-1,1);setYear(d.getFullYear());setMonth(d.getMonth());};
  const nextM=()=>{const d=new Date(year,month+1,1);setYear(d.getFullYear());setMonth(d.getMonth());};

  const onCellEdit=(emp,date)=>{
    const ds=fmtDate(date.getFullYear(),date.getMonth(),date.getDate());
    const k=schedKey(emp.id,ds,employees);
    setEditCell({emp,date,ds,k,cur:sched[k]||null});
  };
  const onCellSave=segs=>{
    const k=editCell.k;
    const newSegs=segs.length?segs:undefined;
    setSched(p=>({...p,[k]:newSegs}));
    dbSaveSchedCell(k,newSegs,employees);
    setEditCell(null);
  };
  const onRangeApply=(type,fromStr,toStr,emp)=>{
    const from=parseDate(fromStr), to=parseDate(toStr);
    const updates={};
    const mainStoreEmps=employees.filter(e=>e.active&&e.mainStore===emp.mainStore);
    const empIdx=mainStoreEmps.findIndex(e=>e.id===emp.id);
    for(let d=new Date(from);d<=to;d.setDate(d.getDate()+1)){
      const dow=d.getDay()===0?6:d.getDay()-1;
      const ds=fmtDate(d.getFullYear(),d.getMonth(),d.getDate());
      const patCell=getPatCell(patterns,emp.mainStore,empIdx,d);
      if(!patCell){
        updates[schedKey(emp.id,ds,employees)]=[{type,hours:0}];
        continue;
      }
      const isObj=typeof patCell==="object";
      const patShift=isObj?(patCell.shift||"work"):(patCell||"work");
      const patLoc=isObj?(patCell.loc||emp.mainStore):emp.mainStore;
      const [fr,to2]=getEmpShiftTimes(emp,patLoc,patShift,dow,stores,isObj?patCell:null);
      const h=calcWorked(fr,to2,getBreakRules(patLoc,stores));
      const hoursThisDay=h>0?h:empContractDay(emp);
      updates[schedKey(emp.id,ds,employees)]=[{type,hours:hoursThisDay}];
    }
    setSched(p=>({...p,...updates}));
    // Uložit do DB
    Object.entries(updates).forEach(([k,segs])=>dbSaveSchedCell(k,segs,employees));
  };

  const onRangeDelete=(fromStr,toStr,emp)=>{
    const from=parseDate(fromStr), to=parseDate(toStr);
    setSched(p=>{
      const next={...p};
      for(let d=new Date(from);d<=to;d.setDate(d.getDate()+1)){
        const ds=fmtDate(d.getFullYear(),d.getMonth(),d.getDate());
        const k=schedKey(emp.id,ds,employees);
        delete next[k];
        dbSaveSchedCell(k,null,employees);
      }
      return next;
    });
  };

  // Reset rozvrhu – smaže všechny ruční úpravy pro danou prodejnu a měsíc
  const onResetMonth=useCallback(async()=>{
    const dim=getDim(year,month);
    const storeEmps=employees.filter(e=>e.active&&e.mainStore===storeId);
    const empIds=storeEmps.map(e=>e.id);
    // Smaž z DB – všechny záznamy pro zaměstnance prodejny v daném měsíci
    const dateFrom=fmtDate(year,month,1);
    const dateTo=fmtDate(year,month,dim);
    await supabase.from("schedule")
      .delete()
      .in("emp_id", empIds)
      .gte("date", dateFrom)
      .lte("date", dateTo);
    // Smaž z lokálního state
    setSched(prev=>{
      const next={...prev};
      for(const emp of storeEmps){
        for(let d=1;d<=dim;d++){
          const ds=fmtDate(year,month,d);
          const k=schedKey(emp.id,ds,employees);
          delete next[k];
        }
      }
      return next;
    });
    setShowResetConfirm(false);
  },[year,month,storeId,employees]);

  // Reset výkazu – smaže záznamy timesheets pro daného zaměstnance a měsíc
  const onResetTimesheet=useCallback(async()=>{
    if(!tsEmp) return;
    const m=month+1; // timesheets používají month 1-12
    await supabase.from("timesheets")
      .delete()
      .eq("emp_id", tsEmp)
      .eq("year", year)
      .eq("month", m);
    // Smaž z lokálního state
    const k=tsKey(tsEmp, year, m);
    setTimesheetData(prev=>{
      const next={...prev};
      delete next[k];
      return next;
    });
    setShowResetTsConfirm(false);
  },[tsEmp,year,month]);

  // ── Export rozvrhu do Excelu ──
  const exportSchedExcel = async () => {
    const storeName = stores.find(s=>s.id===storeId)?.name||"";
    const dim = getDim(year,month);
    const mainEmps = employees.filter(e=>e.active&&e.mainStore===storeId&&isEmpActiveInMonth(e,year,month));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${MONTHS[month]} ${year}`);

    // Barvy bunek – argb
    const cellArgb=(label,dow)=>{
      if(label==="DOV") return "FFE3F2FD";
      if(label==="NEM") return "FFF5F5F5";
      if(label==="SZ")  return "FFFFEBEE";
      if(label==="SO")  return "FFF1F8E9";
      if(label==="V")   return "FFE8F5E9";
      if(dow>=5)        return "FFFFF8F8";
      return null;
    };
    const cellFont=(label,dow)=>{
      if(label==="DOV") return {color:{argb:"FF1565C0"},bold:true};
      if(label==="NEM") return {color:{argb:"FF616161"}};
      if(label==="SZ")  return {color:{argb:"FFC62828"},bold:true};
      if(label==="SO")  return {color:{argb:"FF33691E"},bold:true};
      if(label==="V")   return {color:{argb:"FF2E7D32"}};
      if(dow>=5)        return {color:{argb:"FFB71C1C"},bold:true};
      if(label&&label.includes("-")) return {bold:true};
      return {};
    };

    // Zahlavi listu
    ws.getColumn(1).width=22; // Jmeno+role
    ws.getColumn(2).width=14; // Role
    for(let i=3;i<=9;i++) ws.getColumn(i).width=9; // 7 dni

    // Nadpis
    const titleRow=ws.addRow([`Rozvrh – ${storeName} – ${MONTHS[month]} ${year}`]);
    titleRow.getCell(1).font={bold:true,size:13,color:{argb:"FF1A1A2E"}};
    ws.mergeCells(1,1,1,9);
    titleRow.height=18;

    const wd=getWorkingDays(year,month,holidays);
    const subRow=ws.addRow([`${wd} pracovnich dni  |  fond ${wd*8}h`]);
    subRow.getCell(1).font={size:9,color:{argb:"FF888888"}};
    ws.mergeCells(2,1,2,9);
    subRow.height=13;
    ws.addRow([]); // prazdny radek

    // Generuj tydny
    const weeks=[];
    const firstDow=getDow(year,month,1);
    let calStart=1-firstDow;
    while(true){
      const wDays=[];
      for(let i=0;i<7;i++) wDays.push(calStart+i);
      if(wDays.some(d=>d>=1&&d<=dim)) weeks.push(wDays);
      calStart+=7;
      if(calStart>dim+1) break;
    }

    // Kresli kazdy tyden
    weeks.forEach((wDays,wi)=>{
      // Tyden label
      const firstInMonth=wDays.find(d=>d>=1&&d<=dim)||1;
      const firstDate=new Date(year,month,Math.max(1,firstInMonth));
      const wType=storeId===2?"flat":getWeekType(firstDate);
      const wLabel=wType==="odd"?"Lichy (T1)":wType==="even"?"Sudy (T2)":"Vzor";
      const isoW=getIsoWeek(firstDate);
      const wlRow=ws.addRow([`Tyden ${isoW}  ${wLabel}`]);
      wlRow.getCell(1).font={size:9,bold:true,color:{argb:wType==="odd"?"FF1565C0":"FF2E7D32"}};
      ws.mergeCells(wlRow.number,1,wlRow.number,9);
      wlRow.height=13;

      // Zahlavi dnu: Jmeno | Role | Po | Ut | St | Ct | Pa | So | Ne
      const hdrCells=["Jmeno","Role",...wDays.map(d=>{
        const inMonth=d>=1&&d<=dim;
        if(!inMonth) return "—";
        const dow=getDow(year,month,d);
        const ds=fmtDate(year,month,d);
        const hol=holidays.find(h=>h.date===ds);
        return `${DOW_LBL[dow]}
${d}${hol?"!":"."}`;
      })];
      const hRow=ws.addRow(hdrCells);
      hRow.height=24;
      hRow.eachCell((cell,cn)=>{
        const inMonth=cn>2&&wDays[cn-3]>=1&&wDays[cn-3]<=dim;
        const d=cn>2?wDays[cn-3]:null;
        const dow=inMonth?getDow(year,month,d):null;
        const ds=inMonth?fmtDate(year,month,d):null;
        const hol=inMonth?holidays.find(h=>h.date===ds):null;
        let bg="FF1A1A2E";
        if(cn>2&&!inMonth) bg="FF3A3A4A";
        else if(hol&&!hol.open) bg="FF8C1E1E";
        else if(dow>=5) bg="FF4A2A34";
        cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:bg}};
        cell.font={bold:true,color:{argb:"FFFFFFFF"},size:8};
        cell.alignment={horizontal:"center",vertical:"middle",wrapText:true};
        cell.border={bottom:{style:"thin",color:{argb:"FF444466"}}};
      });

      // Radky zamestnancu
      mainEmps.forEach((emp,ri)=>{
        const empIdx=mainEmps.findIndex(e=>e.id===emp.id);
        const rowCells=[`${emp.lastName} ${emp.firstName}`,emp.role];
        const rowColors=[];
        const rowFonts=[];
        for(let di=0;di<7;di++){
          const d=wDays[di];
          const inMonth=d>=1&&d<=dim;
          if(!inMonth){ rowCells.push(""); rowColors.push("FFF8F8FA"); rowFonts.push({}); continue; }
          const date=new Date(year,month,d);
          const dow=getDow(year,month,d);
          const ds=fmtDate(year,month,d);
          const hol=holidays.find(h=>h.date===ds);
          const cell=getSchedCell(sched,emp.id,ds,employees);
          let label="";
          if(cell?.length){
            const ws2=cell.filter(s=>s.type==="work");
            if(ws2.length) label=ws2.map(s=>s.from&&s.to?`${s.from.replace(":00","")}-${s.to.replace(":00","")}`:"Pr").join("/");
            else{const ab=cell[0];label=TYPE_SHORT[ab.type]||ab.type||"V";}
          } else {
            const pc=getPatCell(patterns,storeId,empIdx,date);
            if(!pc) label=dow>=5?"":"V";
            else if(pc==="work"||typeof pc==="object"){
              const st=typeof pc==="object"?pc.shift||"work":pc;
              const lId=typeof pc==="object"?(pc.loc||storeId):storeId;
              const[fr,to]=getEmpShiftTimes(emp,lId,st,dow,stores,typeof pc==="object"?pc:null,hol);
              label=fr&&to?`${fr.replace(":00","")}-${to.replace(":00","")}`:"Pr";
            } else label=pc==="vacation"?"DOV":pc==="sick"?"NEM":"V";
          }
          if(hol&&!hol.open&&!["DOV","NEM"].includes(label)) label="SZ";
          if(hol&&hol.open&&!label) label="SO";
          rowCells.push(label);
          rowColors.push(cellArgb(label,dow)||( ri%2===0?"FFFFFFFF":"FFF8F9FC"));
          rowFonts.push(cellFont(label,dow));
        }
        const dRow=ws.addRow(rowCells);
        dRow.height=15;
        dRow.eachCell((cell,cn)=>{
          const altBg=ri%2===0?"FFFFFFFF":"FFF8F9FC";
          if(cn===1){
            cell.font={bold:true,size:9,color:{argb:"FF1A1A2E"}};
            cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:altBg}};
          } else if(cn===2){
            cell.font={size:8,color:{argb:"FF888888"}};
            cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:altBg}};
          } else {
            const argb=rowColors[cn-3];
            cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:argb||altBg}};
            const f=rowFonts[cn-3]||{};
            cell.font={size:8,...f};
          }
          cell.alignment={horizontal:cn<=2?"left":"center",vertical:"middle"};
          cell.border={bottom:{style:"hair",color:{argb:"FFD8DAE8"}}};
        });
      });
      // Prazdny radek mezi tydny
      if(wi<weeks.length-1) ws.addRow([]).height=5;
    });

    // ── SOUHRN MESICE ──
    ws.addRow([]);
    const sumTitleRow=ws.addRow(["SOUHRN MESICE"]);
    sumTitleRow.getCell(1).font={bold:true,size:11,color:{argb:"FF1A1A2E"}};
    ws.mergeCells(sumTitleRow.number,1,sumTitleRow.number,9);
    sumTitleRow.height=16;

    // Zahlavi souhrnu
    const sumHdrs=["Zamestnanec","Fond","Naplanováno","Presc.","KPD","Dov.nárok","Dov.cerpano","Dov.zbývá"];
    const sumHRow=ws.addRow(sumHdrs);
    sumHRow.height=14;
    sumHRow.eachCell(cell=>{
      cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF1A1A2E"}};
      cell.font={bold:true,color:{argb:"FFFFFFFF"},size:8};
      cell.alignment={horizontal:"center",vertical:"middle"};
    });
    sumHRow.getCell(1).alignment={horizontal:"left",vertical:"middle"};

    const fmtH2=h=>h===0?"0h":(h%1===0?`${h}h`:`${h.toFixed(1)}h`);
    const fmtHs=v=>v===null?"—":(v>=0?"+":"")+fmtH2(v||0);
    const wd2=getWorkingDays(year,month,holidays);

    mainEmps.forEach((emp,ri)=>{
      const empIdx=mainEmps.findIndex(e=>e.id===emp.id);
      let planned=0; let vacUsed=0;
      for(let d=1;d<=dim;d++){
        const dow=getDow(year,month,d);
        const ds=fmtDate(year,month,d);
        const cell=getSchedCell(sched,emp.id,ds,employees);
        if(cell?.length){
          const ws2=cell.filter(s=>s.type==="work"&&s.from&&s.to);
          const vac=cell.find(s=>s.type==="vacation"||s.type==="sick");
          const oth=cell.find(s=>s.type!=="work"&&s.type!=="vacation"&&s.type!=="sick"&&s.type!=="dayOff");
          if(ws2.length){ planned+=calcSplitWorked(ws2,emp.mainStore,stores); if(vac) planned+=(vac.hours||0); }
          else if(vac||oth) planned+=((vac||oth).hours||0);
          for(const seg of cell) if(seg.type==="vacation") vacUsed+=(seg.hours||0);
        } else {
          const hol=holidays.find(h=>h.date===ds);
          const pc=getPatCell(patterns,storeId,empIdx,new Date(year,month,d));
          if(pc){ const st=typeof pc==="object"?pc.shift||"work":pc; const lId=typeof pc==="object"?(pc.loc||storeId):storeId; const[fr,to]=getEmpShiftTimes(emp,lId,st,dow,stores,typeof pc==="object"?pc:null,hol); if(fr&&to) planned+=calcWorked(fr,to,getBreakRules(lId,stores)); }
        }
      }
      const fund2=wd2*empContractDay(emp);
      const ot=planned-fund2;
      const kdp=calcKpdCumulative(emp,year,month,sched,holidays,stores,patterns,employees,timesheetData);
      const vacLeft=(emp.vacHours||0)+(emp.vacAdjustment||0)-vacUsed;
      const altBg=ri%2===0?"FFFFFFFF":"FFF8F9FC";
      const sRow=ws.addRow([
        `${emp.lastName} ${emp.firstName}`,
        fmtH2(fund2), fmtH2(planned),
        (ot>=0?"+":"")+fmtH2(ot),
        fmtHs(kdp),
        fmtH2((emp.vacHours||0)+(emp.vacAdjustment||0)), fmtH2(vacUsed), fmtH2(vacLeft),
      ]);
      sRow.height=13;
      sRow.eachCell((cell,cn)=>{
        cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:altBg}};
        cell.alignment={horizontal:cn===1?"left":"center",vertical:"middle"};
        cell.border={bottom:{style:"hair",color:{argb:"FFD8DAE8"}}};
        const otColor=ot>0?"FF2E7D32":ot<0?"FFC62828":"FF888888";
        const kdpColor=kdp>0?"FF1565C0":kdp<0?"FFC62828":"FF888888";
        const vacColor=vacLeft>0?"FF2E7D32":"FFC62828";
        if(cn===1) cell.font={bold:true,size:9};
        else if(cn===2) cell.font={size:8,color:{argb:"FF555577"}};
        else if(cn===3) cell.font={size:8,bold:true};
        else if(cn===4) cell.font={size:8,bold:true,color:{argb:otColor}};
        else if(cn===5) cell.font={size:8,bold:true,color:{argb:kdpColor}};
        else if(cn===6) cell.font={size:8,color:{argb:"FF555577"}};
        else if(cn===7) cell.font={size:8,color:{argb:"FF1565C0"}};
        else if(cn===8) cell.font={size:8,bold:true,color:{argb:vacColor}};
      });
    });

    // Sirky sloupcu pro souhrn
    ws.getColumn(1).width=24;
    ws.getColumn(2).width=10;
    ws.getColumn(3).width=12;
    ws.getColumn(4).width=10;
    ws.getColumn(5).width=12;
    ws.getColumn(6).width=12;
    ws.getColumn(7).width=13;
    ws.getColumn(8).width=12;

    const buf=await wb.xlsx.writeBuffer();
    const blob=new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`Rozvrh_${storeName}_${MONTHS[month]}_${year}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Export rozvrhu do PDF ──
  const exportSchedPdf = () => {
    const storeName = stores.find(s=>s.id===storeId)?.name||"";
    const dim = getDim(year,month);
    const mainEmps = employees.filter(e=>e.active&&e.mainStore===storeId&&isEmpActiveInMonth(e,year,month));
    const doc = new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
    const pageW=210; const pageH=297;
    const mL=8; const mR=8; const mT=8; const mB=6;
    const usableW=pageW-mL-mR; // 194mm
    const DOW_PDF=["Po","Ut","St","Ct","Pa","So","Ne"];

    const cellBg=(label,dow)=>{
      if(!label) return dow>=5?[255,246,246]:[255,255,255];
      if(label==="DOV") return [227,242,253];
      if(label==="NEM") return [245,245,245];
      if(label==="SZ")  return [255,235,238];
      if(label==="SO")  return [241,248,233];
      if(label==="V")   return [232,245,233];
      if(dow>=5)        return [255,246,246];
      return [255,255,255];
    };
    const cellTc=(label,dow)=>{
      if(label==="DOV") return [21,101,192];
      if(label==="NEM") return [97,97,97];
      if(label==="SZ")  return [198,40,40];
      if(label==="SO")  return [51,105,30];
      if(label==="V")   return [46,125,50];
      if(dow>=5)        return [170,40,40];
      return [26,26,46];
    };

    // Data pro vsechny dny
    const empDays=mainEmps.map(emp=>{
      const empIdx=mainEmps.findIndex(e=>e.id===emp.id);
      const days=[];
      for(let d=1;d<=dim;d++){
        const date=new Date(year,month,d);
        const dow=getDow(year,month,d);
        const ds=fmtDate(year,month,d);
        const hol=holidays.find(h=>h.date===ds);
        const cell=getSchedCell(sched,emp.id,ds,employees);
        let label="";
        if(cell?.length){
          const ws2=cell.filter(s=>s.type==="work");
          if(ws2.length) label=ws2.map(s=>s.from&&s.to?shiftLabel(s.from,s.to):"Pr").join("/");
          else { const ab=cell[0]; label=TYPE_SHORT[ab.type]||"V"; }
        } else {
          const pc=getPatCell(patterns,storeId,empIdx,date);
          if(!pc){ label=dow>=5?"":"V"; }
          else if(pc==="work"||typeof pc==="object"){
            const st=typeof pc==="object"?pc.shift||"work":pc;
            const lId=typeof pc==="object"?(pc.loc||storeId):storeId;
            const[fr,to]=getEmpShiftTimes(emp,lId,st,dow,stores,typeof pc==="object"?pc:null,hol);
            if(fr&&to) label=shiftLabel(fr,to);
          } else { label=pc==="vacation"?"DOV":pc==="sick"?"NEM":"V"; }
        }
        if(hol&&!hol.open&&!["DOV","NEM"].includes(label)) label="SZ";
        if(hol&&hol.open&&!label) label="SO";
        days.push({label,dow,d,hol});
      }
      return {emp,days};
    });

    // Generuj tydny
    const weeks=[];
    const firstDow=getDow(year,month,1);
    let calStart=1-firstDow;
    while(true){
      const wDays=[];
      for(let i=0;i<7;i++) wDays.push(calStart+i);
      if(wDays.some(d=>d>=1&&d<=dim)) weeks.push(wDays);
      calStart+=7;
      if(calStart>dim+1) break;
    }

    // Dynamicky vypocet rozmerun – vse se vejde na 1 stranku
    const pageHeaderH=12;
    const legendH=7;
    const gapH=2;
    const nameW=42;
    const dayW=(usableW-nameW)/7;
    const weekLabelH=4;
    const hdrH=8;
    const available=pageH-mT-mB-pageHeaderH-legendH-(weeks.length-1)*gapH;
    const oneWeekH=available/weeks.length;
    const rowH=(oneWeekH-weekLabelH-hdrH)/mainEmps.length;
    // Fonty podle rowH
    const fNameSize=Math.min(6.5, rowH*1.2);
    const fCellSize=Math.min(6, rowH*1.1);

    // === STRANA 1: ROZVRH ===
    // Zahlavi stranky
    doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(26,26,46);
    doc.text(cz(`Rozvrh – ${storeName} – ${MONTHS[month]} ${year}`), mL, mT+5);
    doc.setFont("helvetica","normal"); doc.setFontSize(6.5); doc.setTextColor(90,90,110);
    const wd=getWorkingDays(year,month,holidays);
    doc.text(cz(`${wd} pracovnich dni  |  fond ${wd*8}h  |  ${mainEmps.length} zamestnancu`), mL, mT+10);
    doc.setDrawColor(190,192,210);
    doc.line(mL, mT+11.5, pageW-mR, mT+11.5);

    let curY=mT+pageHeaderH;

    weeks.forEach((wDays,wi)=>{
      if(wi>0) curY+=gapH;

      // Tyden label
      const firstInMonth=wDays.find(d=>d>=1&&d<=dim)||1;
      const firstDate=new Date(year,month,Math.max(1,firstInMonth));
      const wType=storeId===2?"flat":getWeekType(firstDate);
      const wLabel=wType==="odd"?"Lichy (T1)":wType==="even"?"Sudy (T2)":"Vzor";
      const isoW=getIsoWeek(firstDate);
      doc.setFont("helvetica","normal"); doc.setFontSize(5.5); doc.setTextColor(140,140,165);
      doc.text(`Tyden ${isoW}`, mL, curY+3);
      doc.setFont("helvetica","bold"); doc.setFontSize(5.5);
      if(wType==="odd") doc.setTextColor(30,100,180); else doc.setTextColor(40,140,60);
      doc.text(wLabel, mL+17, curY+3);
      curY+=weekLabelH;

      // Zahlavi: jmeno sloupec
      doc.setFillColor(26,26,46);
      doc.rect(mL, curY, nameW, hdrH, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(6); doc.setTextColor(255,255,255);
      doc.text("Zamestnanec", mL+2, curY+5.5);

      // Zahlavi: 7 dnu
      for(let di=0;di<7;di++){
        const d=wDays[di];
        const inMonth=d>=1&&d<=dim;
        const dow=inMonth?getDow(year,month,d):di;
        const ds=inMonth?fmtDate(year,month,d):"";
        const hol=inMonth?holidays.find(h=>h.date===ds):null;
        const x=mL+nameW+di*dayW;
        if(!inMonth) doc.setFillColor(55,55,70);
        else if(hol&&!hol.open) doc.setFillColor(140,30,30);
        else if(dow>=5) doc.setFillColor(75,45,55);
        else doc.setFillColor(26,26,46);
        doc.rect(x, curY, dayW, hdrH, "F");
        if(inMonth){
          doc.setFont("helvetica","bold"); doc.setFontSize(5.5); doc.setTextColor(255,255,255);
          doc.text(DOW_PDF[dow], x+dayW/2, curY+3.5, {align:"center"});
          doc.setFontSize(6.5);
          doc.text(`${d}${hol?"!":"."}`, x+dayW/2, curY+7, {align:"center"});
        } else {
          doc.setFontSize(5.5); doc.setTextColor(130,130,145);
          doc.text("—", x+dayW/2, curY+5, {align:"center"});
        }
      }
      curY+=hdrH;

      // Radky zamestnancu
      empDays.forEach(({emp,days},ri)=>{
        const y=curY+ri*rowH;
        const altBg=ri%2===0?[255,255,255]:[248,249,253];
        // Jmeno
        doc.setFillColor(altBg[0],altBg[1],altBg[2]);
        doc.rect(mL, y, nameW, rowH, "F");
        doc.setFont("helvetica","bold"); doc.setFontSize(fNameSize); doc.setTextColor(26,26,46);
        doc.text(cz(`${emp.lastName} ${emp.firstName}`).substring(0,20), mL+2, y+rowH*0.65);
        // 7 dnu
        for(let di=0;di<7;di++){
          const d=wDays[di];
          const inMonth=d>=1&&d<=dim;
          const x=mL+nameW+di*dayW;
          if(!inMonth){
            doc.setFillColor(251,251,254);
            doc.rect(x, y, dayW, rowH, "F");
          } else {
            const{label,dow}=days[d-1];
            const bg=cellBg(label,dow);
            const tc=cellTc(label,dow);
            doc.setFillColor(bg[0],bg[1],bg[2]);
            doc.rect(x, y, dayW, rowH, "F");
            if(label){
              doc.setTextColor(tc[0],tc[1],tc[2]);
              doc.setFont("helvetica",label.includes("–")?"bold":"normal");
              doc.setFontSize(fCellSize);
              doc.text(label, x+dayW/2, y+rowH*0.65, {align:"center"});
            }
          }
        }
        // Horizontalni linka
        doc.setDrawColor(218,220,230);
        doc.line(mL, y+rowH, mL+usableW, y+rowH);
      });

      // Ohraniceni tydne
      const tblH=hdrH+mainEmps.length*rowH;
      doc.setDrawColor(85,88,118);
      doc.rect(mL, curY-hdrH, usableW, tblH);
      doc.setDrawColor(155,158,190);
      doc.line(mL+nameW, curY-hdrH, mL+nameW, curY-hdrH+tblH);
      doc.setDrawColor(212,214,228);
      for(let di=1;di<7;di++) doc.line(mL+nameW+di*dayW, curY-hdrH, mL+nameW+di*dayW, curY-hdrH+tblH);
      curY+=mainEmps.length*rowH;
    });

    // Legenda
    curY+=3;
    const legendItems=[
      {l:"Prace",bg:[255,255,255]},{l:"Vikend",bg:[255,246,246]},
      {l:"Dovolena",bg:[227,242,253]},{l:"Nemoc",bg:[245,245,245]},
      {l:"Sv.zavreno",bg:[255,235,238]},{l:"Sv.otevreno",bg:[241,248,233]},
      {l:"Volno",bg:[232,245,233]},
    ];
    let lx=mL;
    legendItems.forEach(({l,bg})=>{
      doc.setFillColor(bg[0],bg[1],bg[2]);
      doc.rect(lx,curY,3,3,"F");
      doc.setDrawColor(162,164,178); doc.rect(lx,curY,3,3);
      doc.setFont("helvetica","normal"); doc.setFontSize(5.5); doc.setTextColor(60,62,80);
      doc.text(l, lx+4, curY+2.3);
      lx+=doc.getTextWidth(l)+9;
    });

    // === STRANA 2: PREHLED HODIN ===
    doc.addPage();
    doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(26,26,46);
    doc.text(cz(`Prehled hodin – ${storeName} – ${MONTHS[month]} ${year}`), mL, mT+6);
    doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(90,90,110);
    doc.text(cz(`${wd} pracovnich dni  |  fond ${wd*8}h  |  ${mainEmps.length} zamestnancu`), mL, mT+12);
    doc.setDrawColor(190,192,210);
    doc.line(mL, mT+14, pageW-mR, mT+14);

    const sHdrs=["Zamestnanec","Fond","Naplan.","Presc.","KPD","Dov.narok","Dov.cerp.","Dov.zbyva"];
    const sColW=[52,18,20,18,20,22,22,22];
    const totalSW=sColW.reduce((a,b)=>a+b,0);
    const sRowH=10; let sx=mL; let sy=mT+19;
    sHdrs.forEach((h,hi)=>{
      doc.setFillColor(26,26,46);
      doc.rect(sx,sy,sColW[hi],9,"F");
      doc.setFont("helvetica","bold"); doc.setFontSize(6.5); doc.setTextColor(255,255,255);
      doc.text(cz(h), sx+sColW[hi]/2, sy+6.2, {align:"center"});
      sx+=sColW[hi];
    });
    sy+=9;

    const fmtH2=h=>h===0?"0h":(h%1===0?`${h}h`:`${h.toFixed(1)}h`);
    const fmtHs=v=>v===null?"—":(v>=0?"+":"")+fmtH2(v||0);

    mainEmps.forEach((emp,ri)=>{
      const empIdx=mainEmps.findIndex(e=>e.id===emp.id);
      let planned=0; let vacUsed=0;
      for(let d=1;d<=dim;d++){
        const dow=getDow(year,month,d);
        const ds=fmtDate(year,month,d);
        const cell=getSchedCell(sched,emp.id,ds,employees);
        if(cell?.length){
          const ws=cell.filter(s=>s.type==="work"&&s.from&&s.to);
          const vac=cell.find(s=>s.type==="vacation"||s.type==="sick");
          const oth=cell.find(s=>s.type!=="work"&&s.type!=="vacation"&&s.type!=="sick"&&s.type!=="dayOff");
          if(ws.length){ planned+=calcSplitWorked(ws,emp.mainStore,stores); if(vac) planned+=(vac.hours||0); }
          else if(vac||oth) planned+=((vac||oth).hours||0);
          for(const seg of cell) if(seg.type==="vacation") vacUsed+=(seg.hours||0);
        } else {
          const hol=holidays.find(h=>h.date===ds);
          const pc=getPatCell(patterns,storeId,empIdx,new Date(year,month,d));
          if(pc){ const st=typeof pc==="object"?pc.shift||"work":pc; const lId=typeof pc==="object"?(pc.loc||storeId):storeId; const[fr,to]=getEmpShiftTimes(emp,lId,st,dow,stores,typeof pc==="object"?pc:null,hol); if(fr&&to) planned+=calcWorked(fr,to,getBreakRules(lId,stores)); }
        }
      }
      const fund2=wd*empContractDay(emp);
      const ot=planned-fund2;
      const kdp=calcKpdCumulative(emp,year,month,sched,holidays,stores,patterns,employees,timesheetData);
      const vacLeft=(emp.vacHours||0)+(emp.vacAdjustment||0)-vacUsed;
      const altBg=ri%2===0?[255,255,255]:[248,249,252];
      sx=mL;
      const vals=[cz(`${emp.lastName} ${emp.firstName}`),fmtH2(fund2),fmtH2(planned),(ot>=0?"+":"")+fmtH2(ot),fmtHs(kdp),fmtH2(empVacTotal(emp)),fmtH2(vacUsed),fmtH2(vacLeft)];
      const tcs=[[26,26,46],[80,82,100],[26,26,46],ot>0?[46,125,50]:ot<0?[198,40,40]:[120,120,130],kdp>0?[21,101,192]:kdp<0?[198,40,40]:[120,120,130],[80,82,100],[21,101,192],vacLeft>0?[46,125,50]:[198,40,40]];
      sHdrs.forEach((_,hi)=>{
        doc.setFillColor(altBg[0],altBg[1],altBg[2]);
        doc.rect(sx,sy,sColW[hi],sRowH,"F");
        doc.setFont("helvetica",hi===0?"bold":"normal"); doc.setFontSize(hi===0?8:8);
        doc.setTextColor(tcs[hi][0],tcs[hi][1],tcs[hi][2]);
        doc.text(vals[hi].substring(0,hi===0?26:8), sx+(hi===0?2:sColW[hi]/2), sy+6.8, {align:hi===0?"left":"center"});
        doc.setDrawColor(210,212,222);
        doc.line(sx,sy+sRowH,sx+sColW[hi],sy+sRowH);
        sx+=sColW[hi];
      });
      sy+=sRowH;
    });
    doc.setDrawColor(80,85,115);
    doc.rect(mL, mT+28, totalSW, mainEmps.length*sRowH+9);

    doc.save(`Rozvrh_${storeName}_${MONTHS[month]}_${year}.pdf`);
  };

  const mOpts=MONTHS.map((m,i)=>({value:i,label:m})).filter(o=>!(year===APP_START.year&&o.value<APP_START.month));
  const curYear=new Date().getFullYear();
  const yOpts=Array.from({length:curYear+2-APP_START.year+1},(_,i)=>APP_START.year+i).map(y=>({value:y,label:String(y)}));
  const isVedouci = currentUser.role==="admin"||currentUser.role==="vedouci";
  const isZamestnanec = currentUser.role==="zamestnanec";

  // Filtruj zaměstnance pro výkaz dle role
  const tsEmpList = (() => {
    if(currentUser.role==="admin") return employees.filter(e=>e.active && isEmpActiveInMonth(e,year,month));
    if(currentUser.role==="vedouci") return employees.filter(e=>e.active && e.mainStore===storeId && isEmpActiveInMonth(e,year,month));
    // Zamestnanec – jen sám sebe, primárně podle empId z app_users
    const me = employees.find(e=>
      // 1. Primární: podle ID uloženého v app_users.emp_id
      (currentUser.empId && e.id===currentUser.empId) ||
      // 2. Fallback: celé jméno "firstName lastName" nebo "lastName firstName"
      (currentUser.name && (
        `${e.lastName} ${e.firstName}`.trim().toLowerCase()===currentUser.name.toLowerCase() ||
        `${e.lastName} ${e.firstName}`.trim().toLowerCase()===currentUser.name.toLowerCase()
      ))
    );
    return me ? [me] : [];
  })();
  const eOpts=[{value:"",label:"— vyberte zaměstnance —"},...tsEmpList.map(e=>({value:e.id,label:`${e.lastName} ${e.firstName}`}))];
  const tabs=[
    {key:"schedule",  label:"📅 Rozvrh"},
    {key:"timesheet", label:"📋 Výkaz"},
    ...(isVedouci?[{key:"employees",label:"👥 Zaměstnanci"},{key:"settings",label:"⚙️ Nastavení"}]:[]),
    ...(currentUser.role==="admin"?[{key:"provize",label:"💰 Provize"}]:[]),
  ];


  if(!dbReady) return(
    <div style={{minHeight:"100vh",background:"#1a1a2e",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <img src="/logo.png" alt="logo" style={{height:28,filter:"brightness(0) invert(1)"}}/>
      <div style={{color:"rgba(255,255,255,0.5)",fontSize:13}}>Načítám data z databáze…</div>
      <div style={{width:180,height:3,background:"rgba(255,255,255,0.1)",borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",background:"#4f8ef7",borderRadius:2,animation:"sfpulse 1.2s ease-in-out infinite"}}/>
      </div>
      <style>{`@keyframes sfpulse{0%,100%{width:30%}50%{width:80%}}`}</style>
    </div>
  );
  return <div style={{fontFamily:"'Segoe UI',system-ui,sans-serif",background:C.bg,minHeight:"100vh"}}>
    {dbError&&<div style={{background:"#fff3cd",borderBottom:"1px solid #ffc107",padding:"6px 20px",fontSize:12,color:"#856404",display:"flex",gap:8,alignItems:"center"}}>
      ⚠️ Nepodařilo se načíst data z databáze – zobrazuji výchozí data. ({dbError})
    </div>}
    <div style={{background:C.topbar,boxShadow:"0 2px 12px rgba(0,0,0,0.18)"}}>
      <div style={{display:"flex",alignItems:"center",padding:"0 20px",gap:16}}>
        <img src="/logo.png" alt="logo" style={{height:22,filter:"brightness(0) invert(1)",padding:"14px 0"}}/>
        <div style={{flex:1,display:"flex",justifyContent:"center",gap:6,padding:"10px 0"}}>
          {stores.map(s=><Btn key={s.id} variant="store" active={storeId===s.id} small onClick={()=>setStoreId(s.id)} style={{minWidth:90}}>{s.name}</Btn>)}
        </div>
        <div style={{color:"rgba(255,255,255,0.55)",fontSize:12,display:"flex",alignItems:"center",gap:8}}>
          <span>👤 {currentUser.name}</span>
          <span style={{background:"rgba(255,255,255,0.15)",color:"rgba(255,255,255,0.9)",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700}}>
            {currentUser.role==="admin"?"Admin":currentUser.role==="vedouci"?"Vedoucí":"Prodavač"}
          </span>
          <button onClick={handleLogout} style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.7)",borderRadius:5,padding:"3px 9px",fontSize:11,cursor:"pointer",fontWeight:600}}>Odhlásit</button>
        </div>
      </div>
      <div style={{display:"flex",padding:"0 20px",borderTop:"1px solid rgba(255,255,255,0.08)"}}>
        {tabs.map(t=><button key={t.key} onClick={()=>setTab(t.key)} style={{padding:"11px 18px",background:"none",border:"none",color:tab===t.key?"#fff":"rgba(255,255,255,0.45)",fontWeight:tab===t.key?700:500,fontSize:13,cursor:"pointer",borderBottom:tab===t.key?"3px solid #4f8ef7":"3px solid transparent",whiteSpace:"nowrap"}}>{t.label}</button>)}
      </div>
    </div>

    <div style={{padding:"20px",maxWidth:1500,margin:"0 auto"}}>
      {tab==="schedule"&&<div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:4,background:"#fff",borderRadius:8,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
            <button onClick={prevM} disabled={isAtStart} style={{padding:"8px 14px",border:"none",background:"none",cursor:isAtStart?"not-allowed":"pointer",fontSize:18,color:isAtStart?"#ddd":"#555",lineHeight:1}}>‹</button>
            <select value={month} onChange={e=>setMonth(Number(e.target.value))} style={{border:"none",fontSize:15,fontWeight:700,color:C.topbar,background:"transparent",cursor:"pointer",padding:"0 4px"}}>
              {mOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={year} onChange={e=>setYear(Number(e.target.value))} style={{border:"none",fontSize:15,fontWeight:700,color:C.topbar,background:"transparent",cursor:"pointer",padding:"0 4px"}}>
              {yOpts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={nextM} style={{padding:"8px 14px",border:"none",background:"none",cursor:"pointer",fontSize:18,color:"#555",lineHeight:1}}>›</button>
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:8}}>
            {isVedouci&&<Btn small variant="danger" onClick={()=>setShowResetConfirm(true)}>🔄 Reset měsíce</Btn>}
            <Btn small variant="secondary" onClick={exportSchedExcel}>📊 Export Excel</Btn>
            <Btn small variant="secondary" onClick={exportSchedPdf}>🖨️ Export PDF</Btn>
          </div>
        </div>
        <div style={{background:"#fff",borderRadius:10,padding:"10px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
          <div style={{fontWeight:800,fontSize:15,color:C.topbar}}>{stores.find(s=>s.id===storeId)?.name}</div>
          <div style={{fontSize:12,color:"#aaa"}}>{stores.find(s=>s.id===storeId)?.hours}</div>
          <Badge color="#e3f2fd" textColor="#1565c0">{MONTHS[month]} {year}</Badge>
          <Badge color="#f3e5f5" textColor="#6a1b9a">{getWorkingDays(year,month,holidays)} prac. dní · {getWorkingDays(year,month,holidays)*8}h fond</Badge>
          {getHolidayDays(year,month,holidays)>0&&<Badge color="#ffebee" textColor="#c62828">🗓️ {getHolidayDays(year,month,holidays)} svátek zavřeno</Badge>}
          {actions.filter(a=>a.month===month).map(a=><Badge key={a.id} color="#FFCDD2" textColor="#c62828">🎯 {a.name}</Badge>)}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14,padding:"8px 14px",background:"#fff",borderRadius:8,border:`1px solid ${C.border}`,alignItems:"center"}}>
          {Object.entries(TYPE_META).map(([k,v])=><Badge key={k} color={v.color} textColor={v.text}>{v.label}</Badge>)}
          <Badge color={C.modified} textColor="#b8860b">Změna oproti vzoru</Badge>
          <Badge color={C.mirror} textColor="#1565c0">Sdílený (čtení)</Badge>
          <Badge color={C.otherStore} textColor="#888">Jiná prodejna</Badge>
          <span style={{marginLeft:"auto",fontSize:11,color:"#bbb"}}>▼ = odprac. hodiny po přestávce</span>
        </div>
        <div style={{background:"#fff",borderRadius:10,padding:"20px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)",marginBottom:20}}>
          <ScheduleView storeId={storeId} employees={employees} year={year} month={month}
            sched={sched} onCellEdit={isVedouci?onCellEdit:null} actions={actions} holidays={holidays}
            stores={stores} patterns={patterns}/>
        </div>
        <div style={{background:"#fff",borderRadius:10,padding:"20px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)",marginBottom:20}}>
          <div style={{fontSize:15,fontWeight:800,color:C.topbar,marginBottom:14}}>📊 Přehled hodin – {MONTHS[month]} {year}</div>
          <SummaryTable storeId={storeId} employees={employees} year={year} month={month}
            sched={sched} holidays={holidays} stores={stores} patterns={patterns} timesheetData={timesheetData}/>
        </div>
      </div>}

      {tab==="timesheet"&&<div style={{background:"#fff",borderRadius:10,padding:"24px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-end",marginBottom:20,flexWrap:"wrap"}}>
          {/* Prodavač vidí jen sebe – bez selectu */}
          {!isZamestnanec&&<FSel label="Zaměstnanec" value={tsEmp||""} onChange={v=>setTsEmp(v?Number(v):null)} options={eOpts} style={{minWidth:220}}/>}
          {isZamestnanec&&tsEmp&&<div style={{padding:"7px 14px",background:"#f8f9ff",borderRadius:8,border:`1.5px solid ${C.border}`,fontSize:14,fontWeight:600,color:C.topbar}}>
            👤 {tsEmpList[0]?.lastName} {tsEmpList[0]?.firstName}
          </div>}
          <FSel label="Měsíc" value={month} onChange={v=>setMonth(Number(v))} options={mOpts} style={{minWidth:130}}/>
          <FSel label="Rok" value={year} onChange={v=>setYear(Number(v))} options={yOpts} style={{minWidth:90}}/>
          {isVedouci&&tsEmp&&<Btn small variant="danger" onClick={()=>setShowResetTsConfirm(true)}>🔄 Reset výkazu</Btn>}
        </div>

        {/* Přehled čekajících výkazů pro vedoucího */}
        {isVedouci&&(()=>{
          const pending = employees.filter(e=>e.active&&e.mainStore===storeId).filter(e=>{
            const k=tsKey(e.id,year,month+1);
            return timesheetData[k]?._status==="submitted";
          });
          if(!pending.length) return null;
          return <div style={{marginBottom:16,padding:"12px 16px",background:"#fff8e1",borderRadius:10,border:"1.5px solid #ffe082"}}>
            <div style={{fontWeight:700,color:"#f57f17",marginBottom:8,fontSize:13}}>🟡 Výkazy čekající na schválení ({pending.length})</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {pending.map(e=><button key={e.id} onClick={()=>setTsEmp(e.id)}
                style={{padding:"4px 12px",borderRadius:20,background:"#fff",border:"1.5px solid #ffb300",color:"#e65100",fontWeight:600,fontSize:12,cursor:"pointer"}}>
                {e.lastName} {e.firstName}
              </button>)}
            </div>
          </div>;
        })()}

        {tsEmp?(()=>{
          const k = tsKey(tsEmp,year,month+1);
          const tsStatus = timesheetData[k]?._status || "draft";
          const isLocked = tsStatus==="submitted"||tsStatus==="approved";
          const handleSubmit = async()=>{
            if(!window.confirm(`Opravdu odeslat výkaz ${MONTHS[month]} ${year} ke schválení? Po odeslání nebude možné výkaz upravovat.`)) return;
            await dbSaveTimesheetStatus(tsEmp,year,month+1,"submitted");
            setTimesheetData(prev=>({...prev,[k]:{...(prev[k]||{}),_status:"submitted"}}));
          };
          const handleApprove = async()=>{
            await dbSaveTimesheetStatus(tsEmp,year,month+1,"approved");
            setTimesheetData(prev=>({...prev,[k]:{...(prev[k]||{}),_status:"approved"}}));
          };
          const handleReturn = async()=>{
            const reason = window.prompt("Důvod vrácení (nepovinné):");
            await dbSaveTimesheetStatus(tsEmp,year,month+1,"returned");
            setTimesheetData(prev=>({...prev,[k]:{...(prev[k]||{}),_status:"returned"}}));
          };
          return <TimesheetView
            employee={employees.find(e=>e.id===tsEmp)} year={year} month={month}
            holidays={holidays} stores={stores} sched={sched} employees={employees} patterns={patterns}
            rows={getTimesheetRows(tsEmp,year,month+1)}
            onRowChange={isLocked?null:(day,field,value)=>updTimesheetRow(tsEmp,year,month+1,day,field,value)}
            timesheetData={timesheetData}
            canEditKdp={isVedouci}
            tsStatus={tsStatus}
            isVedouci={isVedouci}
            onSubmit={handleSubmit}
            onApprove={handleApprove}
            onReturn={handleReturn}
            onKdpPaidChange={isLocked&&!isVedouci?null:async v=>{
              const k2=tsKey(tsEmp,year,month+1);
              setTimesheetData(prev=>({...prev,[k2]:{...(prev[k2]||{}),kpdPaid:v}}));
              // Ulož do DB ihned
              await dbSaveKdpPaid(tsEmp, year, month+1, v);
            }}/>;
        })()
          :<div style={{textAlign:"center",padding:"60px 0",color:"#ccc",fontSize:16}}>Vyberte zaměstnance</div>}
      </div>}

      {tab==="employees"&&<div style={{background:"#fff",borderRadius:10,padding:"24px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
        {isVedouci
          ? <EmployeesView employees={employees} setEmployees={setEmployeesDB} stores={stores}/>
          : <div style={{textAlign:"center",padding:"60px 0",color:"#bbb",fontSize:16}}>🔒 Přístup pouze pro vedoucí</div>}
      </div>}

      {tab==="settings"&&<div style={{background:"#fff",borderRadius:10,padding:"24px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
        {isVedouci
          ? <><h2 style={{margin:"0 0 20px 0",fontSize:20,fontWeight:800,color:C.topbar}}>Nastavení</h2>
              <SettingsView holidays={holidays} setHolidays={setHolidaysDB} actions={actions} setActions={setActionsDB}
                stores={stores} setStores={setStoresDB} employees={employees} patterns={patterns} setPatterns={setPatternsDB}/></>
          : <div style={{textAlign:"center",padding:"60px 0",color:"#bbb",fontSize:16}}>🔒 Přístup pouze pro vedoucí</div>}
      </div>}

      {tab==="provize"&&currentUser.role==="admin"&&<div style={{background:"#fff",borderRadius:10,padding:"24px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
        <h2 style={{margin:"0 0 20px 0",fontSize:20,fontWeight:800,color:"#1B4F8A"}}>💰 Provizní modul</h2>
        <CommissionModule employees={employees} stores={stores} currentUser={currentUser} sched={sched} holidays={holidays} patterns={patterns}/>
      </div>}
    </div>

    {editCell&&<Modal open={!!editCell} onClose={()=>setEditCell(null)} title="Upravit směnu" width={520}>
      <CellEditor emp={editCell.emp} date={editCell.date} year={editCell.date.getFullYear()} month={editCell.date.getMonth()}
        current={editCell.cur} viewStoreId={storeId} stores={stores} employees={employees} patterns={patterns}
        onSave={onCellSave} onClose={()=>setEditCell(null)} onRangeApply={onRangeApply} onRangeDelete={onRangeDelete}/>
    </Modal>}

    <Modal open={showResetConfirm} onClose={()=>setShowResetConfirm(false)} title="Reset rozvrhu" width={440}>
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <div style={{fontSize:15,color:"#333",lineHeight:1.6}}>
          Opravdu chcete resetovat rozvrh <strong>{stores.find(s=>s.id===storeId)?.name}</strong> pro{" "}
          <strong>{MONTHS[month]} {year}</strong>?
        </div>
        <div style={{padding:"10px 14px",background:"#fff8e1",borderRadius:8,fontSize:13,color:"#e65100",fontWeight:600}}>
          ⚠️ Všechny ruční úpravy tohoto měsíce budou smazány. Vzor zůstane nedotčen.
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn variant="danger" onClick={onResetMonth} style={{flex:1}}>✅ Ano, resetovat</Btn>
          <Btn variant="secondary" onClick={()=>setShowResetConfirm(false)} style={{flex:1}}>Zrušit</Btn>
        </div>
      </div>
    </Modal>

    <Modal open={showResetTsConfirm} onClose={()=>setShowResetTsConfirm(false)} title="Reset výkazu" width={440}>
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <div style={{fontSize:15,color:"#333",lineHeight:1.6}}>
          Opravdu chcete resetovat výkaz zaměstnance <strong>{employees.find(e=>e.id===tsEmp)?.lastName} {employees.find(e=>e.id===tsEmp)?.firstName}</strong> pro{" "}
          <strong>{MONTHS[month]} {year}</strong>?
        </div>
        <div style={{padding:"10px 14px",background:"#fff8e1",borderRadius:8,fontSize:13,color:"#e65100",fontWeight:600}}>
          ⚠️ Všechny zadané příchody, odchody a přestávky za tento měsíc budou smazány.
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn variant="danger" onClick={onResetTimesheet} style={{flex:1}}>✅ Ano, resetovat</Btn>
          <Btn variant="secondary" onClick={()=>setShowResetTsConfirm(false)} style={{flex:1}}>Zrušit</Btn>
        </div>
      </div>
    </Modal>
  </div>;
}

// ═══════════════════════════════════════════════════════════════
// PROVIZNÍ MODUL – viditelný POUZE pro roli admin
// ═══════════════════════════════════════════════════════════════

// ── Výpočetní jádro ──────────────────────────────────────────
function calcKoefKraceni(plneni, kraceni){
  // kraceni = [{od: 0-1, koef: 0-1}] seřazeno od největšího
  if(kraceni && kraceni.length){
    const sorted = [...kraceni].sort((a,b)=>b.od-a.od);
    for(const r of sorted){
      if(plneni >= r.od/100) return r.koef/100;
    }
    return 0;
  }
  // Výchozí tabulka (fallback)
  if(plneni>=0.99) return 1.00;
  if(plneni>=0.79) return 0.90;
  if(plneni>=0.49) return 0.50;
  if(plneni>=0.24) return 0.30;
  if(plneni>=0.10) return 0.15;
  return 0.00;
}

// Role které se v provizním systému nezobrazují vůbec
const COMMISSION_HIDDEN_ROLES = new Set(["Admin","Majitel"]);
// Role se speciálním režimem (bez plánu, bez krácení, provize rovnou 100%)
const COMMISSION_SPECIAL_ROLES = new Set(["Rozvoz","Účetní","Brigádník"]);

function calcCommission(emp, settings, allEmpsData, penetraceOverride, globalSettings){
  const s = settings;
  const g = globalSettings || {};
  const empRole = emp.role || "";

  // Speciální režim: Rozvoz, Účetní, Brigádník – bez plánu, bez krácení, 100% koef
  if(COMMISSION_SPECIAL_ROLES.has(empRole)){
    const trzba_pz = Number(emp.trzba_pz)||0;
    const sazbaPz  = Number(s.sazba_pz)||0.10;
    const provizePz = trzba_pz * sazbaPz;

    const trzba_sluzby = Number(emp.trzba_sluzby)||0;
    const sazbaSluzby  = Number(s.sazba_sluzby)||0.10;
    const stropSluzby  = Number(s.strop_sluzby)||1500;
    const provizeSluzby = Math.min(trzba_sluzby * sazbaSluzby, stropSluzby);

    const obrat_prislusenství = Number(emp.obrat_prislusenstvi)||0;
    const sazbaPrisl4 = Number(s.sazba_prisl_4)||0.038;
    const stropPrisl  = Number(s.strop_prislusenstvi)||4000;
    const provizePrislusenství = Math.min(obrat_prislusenství * sazbaPrisl4, stropPrisl);

    const obrat = Number(emp.obrat)||0;
    const obratKoef = (Number(emp.hodiny)||0) >= 160 ? (Number(s.obrat_koef_plny)||0.004) : (Number(s.obrat_koef_zkraceny)||0.003);
    const provizeObrat = Math.min(obrat * obratKoef, Number(s.obrat_strop)||3000);

    const korunovaMot = Number(emp.korunova_motivace)||0;

    // Rozvoz+Admin odměny
    const rozv1 = Number(emp.rozvoz1)||0;
    const rozv2 = Number(emp.rozvoz2)||0;
    const adminH = Number(emp.admin_prace)||0;
    const sazbaRoz1  = Number(g.sazba_rozvoz1)||0;
    const sazbaRoz2  = Number(g.sazba_rozvoz2)||0;
    const sazbaAdmin = Number(g.sazba_admin)||0;
    const provizeRozvozAdmin = rozv1*sazbaRoz1 + rozv2*sazbaRoz2 + adminH*sazbaAdmin;

    const vyslednaProvize = provizeObrat + provizePz + provizeSluzby + provizePrislusenství + korunovaMot + provizeRozvozAdmin;
    return {
      isSpecialRole: true,
      provizeObrat, plneniObrat:null, bonusObrat:0,
      provizePz, plneniPz:null, sazbaPz,
      provizeSluzby, plneniSluzby:null, stropSluzby,
      provizePrislusenství, plneniPrislusenství:null, stropPrislusenství:stropPrisl,
      korunovaMot, rozv1, rozv2, adminH, provizeRozvozAdmin,
      planObrat:null, planPz:null, planSluzby:null, planPrislusenství:null,
      celkPlneni:1, koef:1, zaklad:vyslednaProvize,
      vyslednaProvize, hrubaMzda:22000+vyslednaProvize,
    };
  }

  const soucetHodin = allEmpsData.reduce((a,e)=>a+(Number(e.hodiny)||0),0);
  if(!soucetHodin) return null;
  const podil = (Number(emp.hodiny)||0) / soucetHodin;
  const plan = Number(emp.plan_prodejny)||0;

  const koefPrislusenství = penetraceOverride != null ? penetraceOverride : (Number(s.koef_prislusenstvi)||0.1465);

  const planObrat = plan * podil;
  const planPz    = plan * (Number(s.koef_pz)||0.025) * podil;
  const planSluzby = plan * (Number(s.koef_sluzby)||0.012) * podil;
  const planPrislusenství = planObrat * koefPrislusenství;

  const hodiny = Number(emp.hodiny)||0;
  const obratKoef = hodiny >= 160 ? (Number(s.obrat_koef_plny)||0.004) : (Number(s.obrat_koef_zkraceny)||0.003);
  const obrat = Number(emp.obrat)||0;
  const provizeObratRaw = obrat * obratKoef;
  const provizeObrat = Math.min(provizeObratRaw, Number(s.obrat_strop)||3000);
  const plneniObrat = planObrat > 0 ? obrat / planObrat : 0;
  const bonusObrat110 = Number(s.bonus_obrat_110)||500;
  const bonusObrat120 = Number(s.bonus_obrat_120)||1000;
  const bonusObrat = plneniObrat >= 1.2 ? bonusObrat120 : plneniObrat >= 1.1 ? bonusObrat110 : 0;

  const trzba_pz = Number(emp.trzba_pz)||0;
  const sazbaPz = Number(s.sazba_pz)||0.10;
  const provizePz = trzba_pz * sazbaPz;
  const plneniPz = planPz > 0 ? trzba_pz / planPz : 0;

  const trzba_sluzby = Number(emp.trzba_sluzby)||0;
  const sazbaSluzby = Number(s.sazba_sluzby)||0.10;
  const stropSluzby = Number(s.strop_sluzby)||1500;
  const provizeSluzby = Math.min(trzba_sluzby * sazbaSluzby, stropSluzby);
  const plneniSluzby = planSluzby > 0 ? trzba_sluzby / planSluzby : 0;

  const obrat_prislusenství = Number(emp.obrat_prislusenstvi)||0;
  const plneniPrislusenství = planPrislusenství > 0 ? obrat_prislusenství / planPrislusenství : 0;
  const stropPrislusenství = Number(s.strop_prislusenstvi)||4000;
  const sazbaPrisl1 = Number(s.sazba_prisl_1)||0.01;
  const sazbaPrisl2 = Number(s.sazba_prisl_2)||0.02;
  const sazbaPrisl3 = Number(s.sazba_prisl_3)||0.03;
  const sazbaPrisl4 = Number(s.sazba_prisl_4)||0.038;
  let sazbaPrisl = 0;
  if(plneniPrislusenství >= 1.00)      sazbaPrisl = sazbaPrisl4;
  else if(plneniPrislusenství >= 0.61) sazbaPrisl = sazbaPrisl3;
  else if(plneniPrislusenství >= 0.26) sazbaPrisl = sazbaPrisl2;
  else if(plneniPrislusenství >= 0.11) sazbaPrisl = sazbaPrisl1;
  const provizePrislusenství = Math.min(obrat_prislusenství * sazbaPrisl, stropPrislusenství);

  const korunovaMot = Number(emp.korunova_motivace)||0;

  // Rozvoz+Admin – platí pro VŠECHNY role
  const rozv1 = Number(emp.rozvoz1)||0;
  const rozv2 = Number(emp.rozvoz2)||0;
  const adminH = Number(emp.admin_prace)||0;
  const sazbaRoz1  = Number(g.sazba_rozvoz1)||0;
  const sazbaRoz2  = Number(g.sazba_rozvoz2)||0;
  const sazbaAdmin = Number(g.sazba_admin)||0;
  const provizeRozvozAdmin = rozv1*sazbaRoz1 + rozv2*sazbaRoz2 + adminH*sazbaAdmin;

  // Celkové plnění (PZ váha 4×)
  const vahaPz    = Number(g.vaha_pz)||4;
  const vahaObrat = Number(g.vaha_obrat)||1;
  const vahaSluzby= Number(g.vaha_sluzby)||1;
  const vahaPrisl = Number(g.vaha_prisl)||1;
  const vahaSouc  = vahaPz + vahaObrat + vahaSluzby + vahaPrisl;
  const celkPlneni = (Math.min(plneniPz,1)*vahaPz + Math.min(plneniObrat,1)*vahaObrat + Math.min(plneniSluzby,1)*vahaSluzby + Math.min(plneniPrislusenství,1)*vahaPrisl) / vahaSouc;
  const koef = calcKoefKraceni(celkPlneni, g.kraceni);

  const zaklad = (provizeObrat + provizePz + provizeSluzby + provizePrislusenství + korunovaMot + provizeRozvozAdmin) * koef;
  const vyslednaProvize = zaklad + bonusObrat;
  const hrubaMzda = 22000 + vyslednaProvize;

  return {
    planObrat, planPz, planSluzby, planPrislusenství,
    provizeObrat, plneniObrat, bonusObrat,
    provizePz, plneniPz, sazbaPz,
    provizeSluzby, plneniSluzby, stropSluzby,
    provizePrislusenství, plneniPrislusenství, stropPrislusenství,
    korunovaMot, rozv1, rozv2, adminH, provizeRozvozAdmin,
    celkPlneni, koef,
    zaklad, vyslednaProvize, hrubaMzda,
  };
}

function pct(v){ return `${Math.round((v||0)*100)} %`; }
function czk(v){ return `${Math.round(v||0).toLocaleString("cs-CZ")} Kč`; }

function PlneniDot({v}){
  const pv = (v||0);
  const bg = pv >= 0.8 ? "#16a34a" : pv >= 0.5 ? "#f97316" : "#dc2626";
  return <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",background:bg,marginRight:5,flexShrink:0}}/>;
}

// ── Pomocník: spočítej plánované hodiny z rozvrhu ────────────
// Pro provize: počítáme jen work + vacation + sick, NE dayOff/obstacle
// POZOR: month je 0-based (stejně jako v JS Date)
function calcPlannedHours(emp, storeId, year, month, sched, holidays, stores, patterns, employees){
  const dim = getDim(year, month);
  let planned = 0;
  const mainEmps = employees.filter(e=>e.active && e.mainStore===storeId);
  const empIdx = mainEmps.findIndex(e=>e.id===emp.id);
  for(let d=1; d<=dim; d++){
    const dow = getDow(year, month, d);
    const ds = fmtDate(year, month, d);
    const cell = getSchedCell(sched, emp.id, ds, employees);
    if(cell?.length){
      const ws = cell.filter(s=>s.type==="work"&&s.from&&s.to);
      const vac = cell.find(s=>s.type==="vacation"||s.type==="sick");
      // Pro provize: dayOff, obstacle a jiné absence NEPOČÍTÁME
      // (zaměstnanec nebyl přítomen, neměl příležitost prodávat)
      if(ws.length){
        planned += calcSplitWorked(ws, emp.mainStore, stores);
        if(vac) planned += (vac.hours||0);
      } else if(vac){
        // Pouze dovolená/nemoc se počítá do hodinového fondu pro provize
        planned += (vac.hours||0);
      }
      // dayOff, obstacle → 0 hodin pro provize
    } else {
      // Ze vzoru
      const hol = holidays.find(h=>h.date===ds);
      const date = new Date(year, month, d);
      const pc = getPatCell(patterns, storeId, empIdx, date);
      if(pc){
        const st = typeof pc==="object"?pc.shift||"work":pc;
        const lId = typeof pc==="object"?(pc.loc||storeId):storeId;
        const [fr,to] = getEmpShiftTimes(emp, lId, st, dow, stores, typeof pc==="object"?pc:null, hol);
        if(fr&&to) planned += calcWorked(fr, to, getBreakRules(lId, stores));
      }
      // pc===null → vzor říká volno → 0
    }
  }
  return Math.round(planned * 10) / 10;
}

// ── Pomocník: parsování xlsx v prohlížeči přes SheetJS ────────
// Vrátí { obrat, trzba_pz, trzba_sluzby, obrat_prislusenstvi, korunova_motivace }
// klíčováno podle jména prodejce (příjmení lowercase)
async function loadXLSX(){
  if(window.XLSX) return window.XLSX;
  return new Promise((resolve,reject)=>{
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload=()=>resolve(window.XLSX);
    s.onerror=()=>reject(new Error("Nepodařilo se načíst SheetJS"));
    document.head.appendChild(s);
  });
}

async function parseVzorPodklady(file){
  return new Promise(async(resolve, reject)=>{
    let XLSX;
    try { XLSX = await loadXLSX(); } catch(e){ reject(e); return; }
    const reader = new FileReader();
    reader.onload = (e)=>{
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, {type:"array"});

        // Načte řádky, vrátí mapu: "id_XXXX" → hodnota, + příjmení NFC + ASCII fallback
        // Detekce dat: řádek kde col[0] obsahuje [číselné ID]
        const norm = s => String(s||"").trim().normalize("NFC").toLowerCase();
        const toAscii = s => norm(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"");

        const parseSheet = (sheetName, colIdx)=>{
          const ws = wb.Sheets[sheetName];
          if(!ws) return {};
          const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
          const result = {};
          for(let i=0; i<rows.length; i++){
            const nameRaw = rows[i]?.[0];
            if(!nameRaw) continue;
            const nameStr = String(nameRaw).trim();
            const idM = nameStr.match(/\[(\d+)\]/);
            if(!idM) continue; // přeskočíme řádky bez [ID] (záhlaví, součty)
            const val = rows[i]?.[colIdx];
            const numVal = (val != null && !isNaN(Number(val))) ? Number(val) : 0;
            result[`id_${idM[1]}`] = numVal;
            result[norm(nameStr.split(" ")[0])] = numVal;
            result[toAscii(nameStr.split(" ")[0])] = numVal;
          }
          return result;
        };

        const parseKorunova = ()=>{
          const ws = wb.Sheets["Korunová motivace"];
          if(!ws) return {};
          const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
          const result = {};
          for(let i=0; i<rows.length; i++){
            const nameRaw = rows[i]?.[0];
            if(!nameRaw) continue;
            const nameStr = String(nameRaw).trim();
            const idM = nameStr.match(/\[(\d+)\]/);
            if(!idM) continue;
            const total = (Number(rows[i]?.[1])||0) + (Number(rows[i]?.[2])||0);
            result[`id_${idM[1]}`] = total;
            result[norm(nameStr.split(" ")[0])] = total;
            result[toAscii(nameStr.split(" ")[0])] = total;
          }
          return result;
        };

        const obratMap    = parseSheet("Obrat Kč", 1);
        const pzMap       = parseSheet("PZ", 2);
        const sluzbyMap   = parseSheet("Služby", 2);
        const prislMap    = parseSheet("Příslušenství", 1);
        const korunovaMap = parseKorunova();

        resolve({ obratMap, pzMap, sluzbyMap, prislMap, korunovaMap });
      } catch(err){ reject(err); }
    };
    reader.onerror = ()=>reject(new Error("Chyba čtení souboru"));
    reader.readAsArrayBuffer(file);
  });
}

// ── Obrazovka 1: Zadat výsledky ───────────────────────────────
function CommissionInput({employees, stores, currentUser, sched, holidays, patterns}){
  const now = new Date();
  const ALL_STORES = 0; // speciální hodnota pro "Všechny prodejny"
  const [storeId, setStoreId] = useState(ALL_STORES);
  const [month, setMonth] = useState(now.getMonth()+1);
  const [year, setYear] = useState(now.getFullYear());
  // planyPoboček: { storeId: "číslo jako string" }
  const [planyPoboček, setPlanyPoboček] = useState({});
  const [rows, setRows] = useState([]); // pro single-store pohled
  const [saving, setSaving] = useState(false);
  const [savingPlans, setSavingPlans] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedPlans, setSavedPlans] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const importRef = useRef(null);
  const MONTHS_CZ = ["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
  const inputS = {padding:"6px 9px",borderRadius:7,border:"1.5px solid #E8E8F0",fontSize:13,width:"100%",boxSizing:"border-box"};
  const thS = {padding:"8px 10px",textAlign:"left",fontWeight:700,color:"#fff",fontSize:12,whiteSpace:"nowrap",background:"#1B4F8A"};

  // Načti plány pro všechny pobočky při změně měsíce/roku
  useEffect(()=>{
    (async()=>{
      // Načti existující plány z DB (každá prodejna má svůj plán)
      const {data:planD} = await supabase.from("commission_store_plans")
        .select("*").eq("month",month).eq("year",year);
      const pm = {};
      stores.forEach(s=>{ pm[s.id] = ""; });
      (planD||[]).forEach(r=>{ pm[r.store_id] = String(r.plan_prodejny||""); });
      setPlanyPoboček(pm);
    })();
  },[month,year]);

  // Načti data pro single-store pohled
  useEffect(()=>{
    if(storeId===ALL_STORES) { setRows([]); return; }
    if(!month||!year) return;
    (async()=>{
      setLoadingData(true); setImportStatus(null);
      const emps = employees.filter(e=>e.active && e.mainStore===storeId);
      const {data:commD} = await supabase.from("commission_data")
        .select("*").eq("store_id",storeId).eq("month",month).eq("year",year);
      const newRows = emps.map(e=>{
        const savedD = commD?.find(d=>d.employee_id===e.id);
        const schedH = calcPlannedHours(e, storeId, year, month-1, sched, holidays, stores, patterns, employees);
        const prijmeniSrc = (e.lastName && e.lastName.trim()) ? e.lastName : e.firstName;
        return {
          employee_id: e.id,
          name: `${e.lastName} ${e.firstName}`.trim(),
          prijmeni: prijmeniSrc.normalize("NFC").toLowerCase(),
          prijmeniFallback: ((e.lastName&&e.lastName.trim())?e.firstName:"").normalize("NFC").toLowerCase(),
          locked: savedD?.locked===true,
          hodiny: savedD ? String(savedD.hodiny) : schedH>0 ? String(schedH) : "",
          hodiny_source: savedD ? "saved" : schedH>0 ? "rozvrh" : "manual",
          obrat: savedD ? String(savedD.obrat) : "",
          trzba_pz: savedD ? String(savedD.trzba_pz) : "",
          trzba_sluzby: savedD ? String(savedD.trzba_sluzby) : "",
          obrat_prislusenstvi: savedD ? String(savedD.obrat_prislusenstvi) : "",
          korunova_motivace: savedD ? String(savedD.korunova_motivace) : "",
        };
      });
      setRows(newRows);
      setLoadingData(false);
    })();
  },[storeId, month, year]);

  const updRow=(idx,field,val)=>{
    setRows(prev=>prev.map((r,i)=>i===idx?{...r,[field]:val}:r));
  };

  const isLocked = storeId!==ALL_STORES && rows.length>0 && rows.every(r=>r.locked);

  // Ulož plány poboček (vždy editovatelné, nezávisle na zamčení)
  const handleSavePlans = async()=>{
    setSavingPlans(true);
    for(const s of stores){
      const plan = Number(planyPoboček[s.id])||0;
      if(!plan) continue;
      await supabase.from("commission_store_plans").upsert(
        {store_id:s.id, month, year, plan_prodejny:plan},
        {onConflict:"store_id,month,year"}
      );
    }
    setSavingPlans(false); setSavedPlans(true); setTimeout(()=>setSavedPlans(false),2500);
  };

  // Ulož aktuální prodejnu ručně
  const handleSave = async()=>{
    const plan = Number(planyPoboček[storeId])||0;
    if(!plan){ alert("Zadejte Plán prodejny!"); return; }
    setSaving(true);
    for(const r of rows){
      const {error} = await supabase.from("commission_data").upsert({
        store_id:storeId, employee_id:r.employee_id, month, year,
        plan_prodejny:plan,
        hodiny:Number(r.hodiny)||0, obrat:Number(r.obrat)||0,
        trzba_pz:Number(r.trzba_pz)||0, trzba_sluzby:Number(r.trzba_sluzby)||0,
        obrat_prislusenstvi:Number(r.obrat_prislusenstvi)||0,
        korunova_motivace:Number(r.korunova_motivace)||0,
      },{onConflict:"store_id,employee_id,month,year"});
      if(!error){
        await supabase.from("commission_data")
          .update({locked:true})
          .eq("store_id",storeId).eq("employee_id",r.employee_id)
          .eq("month",month).eq("year",year);
      }
    }
    setSaving(false); setSaved(true); setTimeout(()=>setSaved(false),2500);
    setRows(prev=>prev.map(r=>({...r,locked:true})));
  };

  const handleUnlock = async()=>{
    if(!window.confirm("Opravdu odemknout data pro úpravy?")) return;
    for(const r of rows){
      await supabase.from("commission_data")
        .update({locked:false})
        .eq("store_id",storeId).eq("employee_id",r.employee_id).eq("month",month).eq("year",year);
    }
    setRows(prev=>prev.map(r=>({...r,locked:false})));
  };

  // Hromadný import – vždy pro všechny pobočky
  const handleImportAndSave = async(file)=>{
    try {
      setImporting(true);
      // Zkontroluj jestli jsou zadané plány
      const missingPlans = stores.filter(s=>!Number(planyPoboček[s.id]));
      if(missingPlans.length){
        const names = missingPlans.map(s=>s.name).join(", ");
        if(!window.confirm(`Chybí plán pro: ${names}\nPokračovat bez nich?`)) { setImporting(false); return; }
      }

      const {obratMap,pzMap,sluzbyMap,prislMap,korunovaMap} = await parseVzorPodklady(file);
      const toAsciiStr = s => String(s||"").normalize("NFC").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      const findKey = (r,map)=>{
        for(const p of [r.prijmeni,r.prijmeniFallback].filter(Boolean)){
          if(p in map) return p;
          const asc=toAsciiStr(p);
          const found=Object.keys(map).find(k=>toAsciiStr(k)===asc);
          if(found) return found;
        }
        return null;
      };

      const ok=[], warn=[], statByStore={};
      stores.forEach(s=>{ statByStore[s.id]={name:s.name, count:0}; });
      const diagKeys=Object.keys(obratMap).filter(k=>!k.startsWith("id_")).sort();

      const allActiveEmps = employees.filter(e=>e.active);
      const importRows = allActiveEmps.map(e=>{
        const prijmeniSrc = (e.lastName&&e.lastName.trim()) ? e.lastName : e.firstName;
        const fakeRow = {
          prijmeni: prijmeniSrc.normalize("NFC").toLowerCase(),
          prijmeniFallback: ((e.lastName&&e.lastName.trim())?e.firstName:"").normalize("NFC").toLowerCase(),
        };
        const mk = findKey(fakeRow, obratMap);
        const schedH = calcPlannedHours(e, e.mainStore, year, month-1, sched, holidays, stores, patterns, employees);
        const plan = Number(planyPoboček[e.mainStore])||0;
        if(!mk){ warn.push(`${e.lastName} ${e.firstName}`.trim()); return null; }
        ok.push(`${e.lastName} ${e.firstName}`.trim());
        if(statByStore[e.mainStore]) statByStore[e.mainStore].count++;
        return {
          store_id:e.mainStore, employee_id:e.id, month, year,
          plan_prodejny:plan,
          hodiny:schedH>0?schedH:0,
          obrat:Math.round(obratMap[mk]||0),
          trzba_pz:Math.round(pzMap[mk]||0),
          trzba_sluzby:Math.round(sluzbyMap[mk]||0),
          obrat_prislusenstvi:Math.round(prislMap[mk]||0),
          korunova_motivace:Math.round(korunovaMap[mk]||0),
          // locked se nastaví separátním updatem po uložení dat
        };
      }).filter(Boolean);

      // Ulož plány poboček do commission_store_plans
      for(const s of stores){
        const plan = Number(planyPoboček[s.id])||0;
        if(!plan) continue;
        await supabase.from("commission_store_plans").upsert(
          {store_id:s.id, month, year, plan_prodejny:plan},
          {onConflict:"store_id,month,year"}
        );
      }

      // Ulož výsledky všech zaměstnanců – sekvenčně pro spolehlivost
      const dbErrors = [];
      for(const ur of importRows){
        const {error} = await supabase.from("commission_data")
          .upsert(ur, {onConflict:"store_id,employee_id,month,year"});
        if(error){
          dbErrors.push(`emp${ur.employee_id}(store${ur.store_id}): ${error.message}`);
        } else {
          // Pokus o nastavení locked – ignoruj chybu pokud sloupec neexistuje
          await supabase.from("commission_data")
            .update({locked:true})
            .eq("store_id",ur.store_id).eq("employee_id",ur.employee_id)
            .eq("month",ur.month).eq("year",ur.year);
        }
      }

      // Přenačti aktuálně zobrazené rows
      if(storeId!==ALL_STORES){
        const {data:freshD} = await supabase.from("commission_data")
          .select("*").eq("store_id",storeId).eq("month",month).eq("year",year);
        setRows(prev=>prev.map(r=>{
          const d=freshD?.find(x=>x.employee_id===r.employee_id);
          if(!d) return r;
          return {...r, hodiny:String(d.hodiny), obrat:String(d.obrat),
            trzba_pz:String(d.trzba_pz), trzba_sluzby:String(d.trzba_sluzby),
            obrat_prislusenstvi:String(d.obrat_prislusenstvi),
            korunova_motivace:String(d.korunova_motivace), locked:true};
        }));
      }

      const statStr = Object.values(statByStore).filter(s=>s.count>0).map(s=>`${s.name}: ${s.count}`).join(", ");
      setImportStatus({ok, warn, diagKeys,
        info:`Uloženo ${importRows.length} zaměstnanců – ${statStr}`,
        dbErrors: dbErrors.length ? dbErrors : null,
      });
      setImporting(false);
    } catch(err){ setImporting(false); alert("Chyba importu: "+err.message); }
  };

  const handleImport = async(e)=>{
    const file=e.target.files?.[0]; if(!file) return;
    e.target.value="";
    await handleImportAndSave(file);
  };

  // ── RENDER ──────────────────────────────────────────────────
  return <div>
    {/* Selektory */}
    <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16,alignItems:"flex-end"}}>
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>POBOČKA</div>
        <select value={storeId} onChange={e=>setStoreId(Number(e.target.value))}
          style={{...inputS,width:"auto",minWidth:150}}>
          <option value={ALL_STORES}>📋 Všechny prodejny</option>
          {stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>MĚSÍC</div>
        <select value={month} onChange={e=>setMonth(Number(e.target.value))}
          style={{...inputS,width:"auto",minWidth:120}}>
          {MONTHS_CZ.map((m,i)=><option key={i+1} value={i+1}>{m}</option>)}
        </select>
      </div>
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>ROK</div>
        <select value={year} onChange={e=>setYear(Number(e.target.value))}
          style={{...inputS,width:"auto",minWidth:90}}>
          {[2025,2026,2027].map(y=><option key={y} value={y}>{y}</option>)}
        </select>
      </div>
    </div>

    {/* Plány poboček – vždy editovatelné */}
    <div style={{marginBottom:16,padding:"14px 16px",background:"#f8f9ff",borderRadius:10,border:"1.5px solid #e8e8f0"}}>
      <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:10,fontSize:13}}>
        📋 Plán prodejny na {MONTHS_CZ[month-1]} {year}
        <span style={{fontSize:11,fontWeight:400,color:"#888",marginLeft:8}}>— zadej pro každou prodejnu zvlášť</span>
      </div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end"}}>
        {stores.map(s=>(
          <div key={s.id}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>{s.name.toUpperCase()}</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <input type="number" min="0" placeholder="např. 3500000"
                value={planyPoboček[s.id]||""}
                onChange={e=>setPlanyPoboček(prev=>({...prev,[s.id]:e.target.value}))}
                style={{...inputS,width:150,border:planyPoboček[s.id]?"1.5px solid #86efac":"1.5px solid #E8E8F0"}}/>
              <span style={{fontSize:12,color:"#888"}}>Kč</span>
            </div>
          </div>
        ))}
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={handleSavePlans} disabled={savingPlans}
            style={{padding:"8px 18px",borderRadius:7,background:"#1B4F8A",color:"#fff",border:"none",fontWeight:700,fontSize:13,cursor:savingPlans?"not-allowed":"pointer",opacity:savingPlans?0.7:1}}>
            {savingPlans?"Ukládám…":"💾 Uložit plány"}
          </button>
          {savedPlans&&<span style={{color:"#16a34a",fontWeight:700,fontSize:13}}>✅ Plány uloženy!</span>}
        </div>
      </div>
    </div>

    {/* Import – vždy viditelný */}
    <div style={{marginBottom:16,padding:"12px 16px",background:"#f0f9ff",borderRadius:10,border:"1.5px solid #93c5fd",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <div style={{flex:1}}>
        <div style={{fontWeight:700,color:"#1B4F8A",fontSize:13}}>📂 Hromadný import dat</div>
        <div style={{fontSize:12,color:"#555",marginTop:2}}>
          Nahraje výsledky pro <strong>všechny prodejny najednou</strong>. Plány musí být uloženy výše.
        </div>
      </div>
      <input ref={importRef} type="file" accept=".xlsx" style={{display:"none"}} onChange={handleImport}/>
      <button onClick={()=>importRef.current?.click()} disabled={importing}
        style={{padding:"9px 20px",borderRadius:7,border:"1.5px solid #1B4F8A",background:importing?"#e0e7ff":"#eef4ff",color:"#1B4F8A",fontWeight:700,fontSize:13,cursor:importing?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
        {importing?"⏳ Nahrávám…":"📂 Nahrát Vzor_podklady.xlsx"}
      </button>
    </div>

    {/* Status importu */}
    {importStatus&&<div style={{marginBottom:14,padding:"10px 14px",borderRadius:8,
      background:importStatus.warn.length?"#fff8e1":"#f0fdf4",
      border:`1.5px solid ${importStatus.warn.length?"#fbbf24":"#86efac"}`,fontSize:13}}>
      {importStatus.info&&<div style={{color:"#166534",fontWeight:700,marginBottom:4}}>✅ {importStatus.info}</div>}
      {importStatus.ok.length>0&&<div style={{color:"#166534"}}>Nalezeno: {importStatus.ok.join(", ")}</div>}
      {importStatus.warn.length>0&&<div style={{color:"#92400e",fontWeight:600,marginTop:4}}>⚠️ Nenalezeno: {importStatus.warn.join(", ")}</div>}
      {importStatus.warn.length>0&&importStatus.diagKeys&&<div style={{color:"#666",fontSize:11,marginTop:4}}>Klíče v souboru: {importStatus.diagKeys.join(", ")}</div>}
      {importStatus.dbErrors&&<div style={{color:"#dc2626",fontWeight:600,marginTop:4,fontSize:12}}>⛔ Chyby DB: {importStatus.dbErrors.join(" | ")}</div>}
    </div>}

    {/* Detail jedné prodejny */}
    {storeId===ALL_STORES
      ? <div style={{textAlign:"center",padding:40,color:"#888",background:"#f8f9ff",borderRadius:10,border:"1.5px dashed #e8e8f0"}}>
          <div style={{fontSize:32,marginBottom:8}}>📋</div>
          <div style={{fontWeight:700,fontSize:15,marginBottom:4}}>Zobrazení všech poboček</div>
          <div style={{fontSize:13}}>Pro detail a ruční úpravy vyber konkrétní prodejnu v selectoru nahoře.</div>
          <div style={{fontSize:13,marginTop:4,color:"#1B4F8A"}}>Import xlsx funguje pro všechny prodejny najednou bez ohledu na výběr.</div>
        </div>
      : loadingData
        ? <div style={{textAlign:"center",padding:40,color:"#aaa"}}>Načítám data…</div>
        : rows.length===0
          ? <div style={{textAlign:"center",padding:40,color:"#bbb"}}>Žádní aktivní prodejci na této pobočce.</div>
          : <>
              {/* Lock banner */}
              {isLocked&&<div style={{marginBottom:14,padding:"10px 16px",borderRadius:8,background:"#f0fdf4",border:"1.5px solid #86efac",fontSize:13,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>🔒</span>
                <span style={{fontWeight:600,color:"#166534"}}>Data jsou uložena a zamčena. Pro úpravy klikněte na „Odemknout".</span>
              </div>}
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead>
                    <tr>
                      <th style={thS}>Prodejce</th>
                      <th style={{...thS,textAlign:"center"}}>Hodiny<div style={{fontSize:10,fontWeight:400,opacity:0.8}}>z rozvrhu</div></th>
                      {["Obrat (Kč)","Tržba PZ (Kč)","Tržba služeb (Kč)","Obrat přísl. (Kč)","Kor. motivace (Kč)"].map(h=>(
                        <th key={h} style={thS}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r,i)=><tr key={r.employee_id} style={{background:i%2===0?"#fff":"#f8f9ff"}}>
                      <td style={{padding:"8px 10px",fontWeight:700,color:"#1a1a2e",whiteSpace:"nowrap"}}>
                        {r.locked&&<span title="Zamčeno" style={{marginRight:5,fontSize:11}}>🔒</span>}
                        {r.name}
                      </td>
                      <td style={{padding:"4px 6px"}}>
                        <div style={{position:"relative"}}>
                          <input type="number" value={r.hodiny} readOnly={isLocked}
                            onChange={e=>!isLocked&&updRow(i,"hodiny",e.target.value)}
                            style={{...inputS,textAlign:"right",
                              background:isLocked?"#f3f4f6":r.hodiny_source==="rozvrh"?"#f0fdf4":r.hodiny_source==="saved"?"#f0f9ff":"#fff",
                              border:isLocked?"1.5px solid #d1d5db":r.hodiny_source==="rozvrh"?"1.5px solid #86efac":r.hodiny_source==="saved"?"1.5px solid #93c5fd":"1.5px solid #E8E8F0",
                              cursor:isLocked?"not-allowed":"text"}} min="0"/>
                          {!isLocked&&r.hodiny_source==="rozvrh"&&<span title="Převzato z rozvrhu" style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#16a34a",pointerEvents:"none"}}>📅</span>}
                        </div>
                      </td>
                      {["obrat","trzba_pz","trzba_sluzby","obrat_prislusenstvi","korunova_motivace"].map(f=>(
                        <td key={f} style={{padding:"4px 6px"}}>
                          <input type="number" value={r[f]} readOnly={isLocked}
                            onChange={e=>!isLocked&&updRow(i,f,e.target.value)}
                            style={{...inputS,textAlign:"right",background:isLocked?"#f3f4f6":"#fff",cursor:isLocked?"not-allowed":"text"}} min="0"/>
                        </td>
                      ))}
                    </tr>)}
                  </tbody>
                </table>
              </div>
              {!isLocked&&<div style={{marginTop:8,fontSize:11,color:"#888",display:"flex",gap:16,flexWrap:"wrap"}}>
                <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:"#f0fdf4",border:"1px solid #86efac",marginRight:4}}/>📅 Hodiny z rozvrhu</span>
                <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:"#f0f9ff",border:"1px solid #93c5fd",marginRight:4}}/>Hodiny z uloženého záznamu</span>
              </div>}
              <div style={{marginTop:14,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                {!isLocked&&<button onClick={handleSave} disabled={saving}
                  style={{background:"#6b7280",color:"#fff",border:"none",borderRadius:9,padding:"11px 28px",fontSize:14,fontWeight:700,cursor:saving?"not-allowed":"pointer",opacity:saving?0.7:1}}>
                  {saving?"Ukládám…":"💾 Uložit ručně a zamknout"}
                </button>}
                {isLocked&&<button onClick={handleUnlock}
                  style={{background:"#fff7ed",color:"#c2410c",border:"1.5px solid #f97316",borderRadius:9,padding:"11px 28px",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  🔓 Odemknout pro úpravy
                </button>}
                {saved&&<span style={{color:"#16a34a",fontWeight:700,fontSize:13}}>✅ Uloženo a zamčeno!</span>}
                {!isLocked&&!saving&&<span style={{fontSize:12,color:"#aaa"}}>💡 Import xlsx uloží a zamkne automaticky</span>}
              </div>
            </>
    }
  </div>;
}

// ── Obrazovka 2: Výsledky týmu ────────────────────────────────
function ProgressBar({value, max, color}){
  const pct = max>0 ? Math.min(100, Math.round(value/max*100)) : 0;
  const bg = pct>=80?"#16a34a":pct>=50?"#f97316":"#dc2626";
  return <div style={{width:"100%",background:"#e5e7eb",borderRadius:99,height:8,overflow:"hidden"}}>
    <div style={{width:`${pct}%`,background:color||bg,borderRadius:99,height:"100%",transition:"width 0.4s"}}/>
  </div>;
}

function CommissionResults({employees, stores}){
  const now = new Date();
  const [storeId, setStoreId] = useState(stores[0]?.id||1);
  const [month, setMonth] = useState(now.getMonth()+1);
  const [year, setYear] = useState(now.getFullYear());
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [loadTs] = useState(()=>Date.now());
  const MONTHS_CZ = ["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

  useEffect(()=>{
    setResults([]); setExpandedRow(null);
    (async()=>{
      setLoading(true);
      const {data:sD} = await supabase.from("commission_settings").select("*").eq("store_id",storeId);
      const settings = sD?.[0] || {koef_pz:0.025,koef_sluzby:0.012,koef_prislusenstvi:0.1465,prumerna_cena_pz:storeId===2?1775:storeId===3?1710:1630,obrat_koef_plny:0.004,obrat_koef_zkraceny:0.003,obrat_strop:3000};
      const {data:gD} = await supabase.from("commission_global").select("*").single();
      const globalSett = gD || {vaha_pz:4,vaha_obrat:1,vaha_sluzby:1,vaha_prisl:1,kraceni:null};
      const {data:penD} = await supabase.from("commission_penetrace")
        .select("koef_prislusenstvi").eq("store_id",storeId).eq("month",month);
      const penetraceOverride = penD?.[0]?.koef_prislusenstvi ?? null;
      const {data:commD} = await supabase.from("commission_data")
        .select("*").eq("store_id",storeId).eq("month",month).eq("year",year);
      if(!commD?.length){ setLoading(false); return; }

      // Načti Rozvoz+Admin z výkazů zaměstnanců
      const empIds = commD.map(d=>d.employee_id);
      const {data:tsD} = await supabase.from("timesheets")
        .select("emp_id,day,roz1,roz2,admin")
        .in("emp_id", empIds).eq("year",year).eq("month",month);

      // Agreguj Rozvoz+Admin per zaměstnanec
      const rozvozMap = {};
      (tsD||[]).forEach(r=>{
        const id = r.emp_id;
        if(!rozvozMap[id]) rozvozMap[id] = {roz1:0,roz2:0,adminPrace:0};
        rozvozMap[id].roz1 += Number(r.roz1)||0;
        rozvozMap[id].roz2 += Number(r.roz2)||0;
        rozvozMap[id].adminPrace += Number(r.admin)||0;
      });

      // Filtruj skryté role, přidej role k datům
      const emps = employees.filter(e=>e.active&&e.mainStore===storeId&&!COMMISSION_HIDDEN_ROLES.has(e.role));
      const dataWithNames = commD
        .filter(d=>emps.some(e=>e.id===d.employee_id))
        .map(d=>{
          const emp = emps.find(e=>e.id===d.employee_id);
          const roz = rozvozMap[d.employee_id]||{roz1:0,roz2:0,adminPrace:0};
          return {
            ...d,
            role: emp?.role||"",
            name: `${emp?.firstName||""} ${emp?.lastName||""}`.trim(),
            rozvoz1: roz.roz1,
            rozvoz2: roz.roz2,
            admin_prace: roz.adminPrace,
          };
        });

      // Pro výpočet celkového plnění: speciální role se nepočítají do soucetHodin
      const normalCommD = commD.filter(d=>{
        const emp = employees.find(e=>e.id===d.employee_id);
        return emp && !COMMISSION_HIDDEN_ROLES.has(emp.role) && !COMMISSION_SPECIAL_ROLES.has(emp.role);
      });

      const calcs = dataWithNames.map(d=>({
        name: d.name||`#${d.employee_id}`,
        data: d,
        settings,
        globalSett,
        penetraceOverride,
        calc: calcCommission(d, settings, normalCommD, penetraceOverride, globalSett),
        penetraceZdroj: penetraceOverride!=null ? `import (${(penetraceOverride*100).toFixed(2)} %)` : `výchozí (${((Number(settings.koef_prislusenstvi)||0.1465)*100).toFixed(2)} %)`,
      })).sort((a,b)=>{
        // Speciální role vždy na konec
        const aSpec = COMMISSION_SPECIAL_ROLES.has(a.data.role)?1:0;
        const bSpec = COMMISSION_SPECIAL_ROLES.has(b.data.role)?1:0;
        if(aSpec!==bSpec) return aSpec-bSpec;
        return (b.calc?.celkPlneni||0)-(a.calc?.celkPlneni||0);
      });
      setResults(calcs);
      setLoading(false);
    })();
  },[storeId,month,year,loadTs]);

  const exportXlsx = async()=>{
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Provize ${MONTHS_CZ[month-1]} ${year}`);

    // Záhlaví
    const cols = ["Prodejce","Plnění PZ %","Plnění obratu %","Plnění služeb %","Plnění přísl. %","Celkové plnění %","Koeficient %","Provize Kč"];
    ws.addRow(cols);
    ws.getRow(1).font = {bold:true, color:{argb:"FFFFFFFF"}};
    ws.getRow(1).fill = {type:"pattern", pattern:"solid", fgColor:{argb:"FF1B4F8A"}};
    ws.getRow(1).alignment = {horizontal:"center"};

    // Data
    results.forEach((r,i)=>{
      const c = r.calc;
      if(!c) return;
      const row = ws.addRow([
        r.name,
        Math.round(c.plneniPz*100),
        Math.round(c.plneniObrat*100),
        Math.round(c.plneniSluzby*100),
        Math.round(c.plneniPrislusenství*100),
        Math.round(c.celkPlneni*100),
        Math.round(c.koef*100),
        Math.round(c.vyslednaProvize),
      ]);
      row.getCell(1).font = {bold:true};
      // Barevné indikátory plnění (sloupce 2–6)
      [2,3,4,5,6].forEach(ci=>{
        const val = row.getCell(ci).value;
        row.getCell(ci).fill = {type:"pattern", pattern:"solid",
          fgColor:{argb: val>=80?"FFD1FAE5": val>=50?"FFFED7AA":"FFFECACA"}};
      });
      // Provize tučně modře
      row.getCell(8).font = {bold:true, color:{argb:"FF1B4F8A"}};
      // Střídavé řádky
      if(i%2===1) row.eachCell(cell=>{ if(!cell.fill?.fgColor?.argb) cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF8F9FF"}}; });
    });

    // Šířky sloupců
    ws.getColumn(1).width = 22;
    [2,3,4,5,6,7,8].forEach(ci=>{ ws.getColumn(ci).width = 14; ws.getColumn(ci).alignment={horizontal:"center"}; });

    // Stáhnout
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=`provize_${stores.find(s=>s.id===storeId)?.name||storeId}_${MONTHS_CZ[month-1]}_${year}.xlsx`;
    a.click();
  };

  const inputS={padding:"6px 9px",borderRadius:7,border:"1.5px solid #E8E8F0",fontSize:13,width:"auto"};
  const pctColor = v => v>=0.8?"#16a34a":v>=0.5?"#f97316":"#dc2626";
  const medal = (i) => i===0?"🥇":i===1?"🥈":i===2?"🥉":"";

  return <div>
    <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:20,alignItems:"flex-end"}}>
      <div><div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>POBOČKA</div>
        <select value={storeId} onChange={e=>setStoreId(Number(e.target.value))} style={{...inputS,minWidth:140}}>
          {stores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select></div>
      <div><div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>MĚSÍC</div>
        <select value={month} onChange={e=>setMonth(Number(e.target.value))} style={{...inputS,minWidth:120}}>
          {MONTHS_CZ.map((m,i)=><option key={i+1} value={i+1}>{m}</option>)}
        </select></div>
      <div><div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>ROK</div>
        <select value={year} onChange={e=>setYear(Number(e.target.value))} style={{...inputS,minWidth:90}}>
          {[2025,2026,2027].map(y=><option key={y} value={y}>{y}</option>)}
        </select></div>
      {results.length>0&&<button onClick={exportXlsx}
        style={{padding:"8px 18px",borderRadius:7,border:"1.5px solid #1B4F8A",background:"#fff",color:"#1B4F8A",fontWeight:700,fontSize:13,cursor:"pointer",marginLeft:"auto",alignSelf:"flex-end"}}>
        📊 Export Excel
      </button>}
    </div>

    {loading ? <div style={{textAlign:"center",padding:40,color:"#aaa"}}>Načítám výsledky…</div>
    : results.length===0 ? <div style={{textAlign:"center",padding:40,color:"#bbb"}}>Nejsou zadána data pro tento měsíc.</div>
    : <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {results.map((r,i)=>{
          const c = r.calc;
          const isExp = expandedRow===i;
          if(!c) return null;
          const isSpecial = COMMISSION_SPECIAL_ROLES.has(r.data?.role||"");

          // ── Speciální role: holé číslo, bez progress barů ──
          if(isSpecial) return <div key={i} style={{border:"1.5px solid #e8e8f0",borderRadius:12,background:"#fff",overflow:"hidden"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",flexWrap:"wrap",cursor:"pointer"}}
              onClick={()=>setExpandedRow(isExp?null:i)}>
              <div style={{minWidth:160,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,background:"#f0f0f0",color:"#666",borderRadius:4,padding:"1px 6px",fontWeight:700}}>{r.data.role}</span>
                <span style={{fontWeight:800,fontSize:15,color:"#1a1a2e"}}>{r.name}</span>
              </div>
              <div style={{flex:1,fontSize:12,color:"#aaa"}}>Bez plánu · koef. 100 %</div>
              <div style={{textAlign:"center",marginRight:8}}>
                <div style={{fontSize:10,color:"#aaa",fontWeight:600}}>PROVIZE</div>
                <div style={{fontSize:16,fontWeight:800,color:"#1B4F8A"}}>{czk(c.vyslednaProvize)}</div>
              </div>
              <span style={{fontSize:16,color:"#ccc"}}>{isExp?"▲":"▼"}</span>
            </div>
            {isExp&&<div style={{borderTop:"1px solid #e8e8f0",padding:"12px 18px",background:"#fafafe"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
                {[
                  {label:"Obrat",         val:czk(r.data.obrat||0),              provize:c.provizeObrat},
                  {label:"Záruky (PZ)",   val:czk(r.data.trzba_pz||0),           provize:c.provizePz},
                  {label:"Služby",        val:czk(r.data.trzba_sluzby||0),       provize:c.provizeSluzby},
                  {label:"Příslušenství", val:czk(r.data.obrat_prislusenstvi||0),provize:c.provizePrislusenství},
                  {label:"Kor. motivace", val:czk(c.korunovaMot||0),             provize:c.korunovaMot},
                  ...(c.provizeRozvozAdmin>0?[{label:"Rozvoz+Admin",val:`R1: ${c.rozv1}× · R2: ${c.rozv2}× · Admin: ${c.adminH}h`,provize:c.provizeRozvozAdmin}]:[]),
                ].map((it,xi)=><div key={xi} style={{background:"#fff",borderRadius:8,padding:"10px 12px",border:"1px solid #e8e8f0"}}>
                  <div style={{fontWeight:700,fontSize:12,color:"#555",marginBottom:4}}>{it.label}</div>
                  <div style={{fontSize:12,color:"#888"}}>Skutečnost: <strong>{it.val}</strong></div>
                  <div style={{fontSize:12,color:"#1B4F8A",marginTop:2}}>Provize: <strong>{czk(it.provize)}</strong></div>
                </div>)}
              </div>
            </div>}
          </div>;

          // ── Normální role: plný výpočet s progress bary ──
          const items = [
            {
              label:"Záruky (PZ)", done:c.plneniPz, provize:c.provizePz,
              plan:c.planPz, actual:r.data.trzba_pz,
              chybi:Math.max(0,(c.planPz||0)-r.data.trzba_pz), jednotka:"Kč tržby", weight:"4×",
              moznyZiskSlozky: Math.max(0, (c.planPz||0) - r.data.trzba_pz) * (Number(r.settings?.sazba_pz)||0.10),
            },
            {
              label:"Obrat", done:c.plneniObrat, provize:c.provizeObrat,
              plan:c.planObrat, actual:r.data.obrat,
              chybi:Math.max(0,(c.planObrat||0)-r.data.obrat), jednotka:"Kč", weight:"1×",
              moznyZiskSlozky: Math.max(0,
                Math.min((c.planObrat||0) * (Number(r.settings?.obrat_koef_plny)||0.004), Number(r.settings?.obrat_strop)||3000)
                - c.provizeObrat
              ),
            },
            {
              label:"Služby", done:c.plneniSluzby, provize:c.provizeSluzby,
              plan:c.planSluzby, actual:r.data.trzba_sluzby,
              chybi:Math.max(0,(c.planSluzby||0)-r.data.trzba_sluzby), jednotka:"Kč tržby", weight:"1×",
              moznyZiskSlozky: Math.min(
                Math.max(0, (c.planSluzby||0) - r.data.trzba_sluzby) * (Number(r.settings?.sazba_sluzby)||0.10),
                Math.max(0, (Number(r.settings?.strop_sluzby)||1500) - c.provizeSluzby)
              ),
            },
            {
              label:"Příslušenství", done:c.plneniPrislusenství, provize:c.provizePrislusenství,
              plan:c.planPrislusenství, actual:r.data.obrat_prislusenstvi,
              chybi:Math.max(0,(c.planPrislusenství||0)-r.data.obrat_prislusenstvi), jednotka:"Kč", weight:"1×",
              moznyZiskSlozky: Math.min(
                Math.max(0, (c.planPrislusenství||0) * (Number(r.settings?.sazba_prisl_4)||0.038) - c.provizePrislusenství),
                Math.max(0, (Number(r.settings?.strop_prislusenstvi)||4000) - c.provizePrislusenství)
              ),
              penetraceInfo: r.penetraceOverride != null
                ? `${(r.penetraceOverride*100).toFixed(2)} % (import)`
                : `${((Number(r.settings?.koef_prislusenstvi)||0.1465)*100).toFixed(2)} % (výchozí)`,
            },
          ];

          // Výpočet možného zisku – přímý, bez simulace
          // 1) Provize ze složek při 100 % plnění
          const sett = r.settings || {};
          const sazbaPzS    = Number(sett.sazba_pz)||0.10;
          const sazbaSluzbyS= Number(sett.sazba_sluzby)||0.10;
          const stropSluzbyS= Number(sett.strop_sluzby)||1500;
          const obratKoefS  = (Number(r.data.hodiny)||0)>=160 ? (Number(sett.obrat_koef_plny)||0.004) : (Number(sett.obrat_koef_zkraceny)||0.003);
          const obratStropS = Number(sett.obrat_strop)||3000;
          const sazbaPrisl4S= Number(sett.sazba_prisl_4)||0.038;
          const stropPrislS = Number(sett.strop_prislusenstvi)||4000;

          const pz100    = c.planPz * sazbaPzS;                                           // PZ: plán × sazba (bez stropu)
          const obrat100 = Math.min(c.planObrat * obratKoefS, obratStropS);               // Obrat: plán × sazba, max strop
          const sluzby100= Math.min(c.planSluzby * sazbaSluzbyS, stropSluzbyS);           // Služby: plán × sazba, max strop
          const prisl100 = Math.min(c.planPrislusenství * sazbaPrisl4S, stropPrislS);     // Přísl: plán × sazba4, max strop
          const koru100  = c.korunovaMot;                                                  // Korunová: beze změny

          const zaklad100 = pz100 + obrat100 + sluzby100 + prisl100 + koru100;
          // koef při 100 % = nejvyšší pásmo v tabulce krácení
          const koef100 = calcKoefKraceni(1.0, r.globalSett?.kraceni);
          const provize100= zaklad100 * koef100;

          const zakladAkt = c.provizeObrat + c.provizePz + c.provizeSluzby + c.provizePrislusenství + c.korunovaMot;
          // Rozklad: přírůstek ze složek (× koef100=1) + skok koeficientu na aktuální základ
          // moznyZisk = (zaklad100 − zakladAkt)×1.0 + zakladAkt×(1.0 − c.koef)
          const moznyZProvizi  = Math.round(Math.max(0, zaklad100 - zakladAkt));        // přírůstek provizí ze složek
          const moznyZKoef     = Math.round(Math.max(0, zakladAkt * (1.0 - c.koef)));  // přínos skoku koeficientu
          const moznyZisk      = Math.round(Math.max(0, provize100 - c.vyslednaProvize));

          const celkPct = Math.round(c.celkPlneni*100);
          const koefPct = Math.round(c.koef*100);
          const cardBg = i===0?"#f0fdf4":i===results.length-1?"#fff7ed":"#fff";
          const borderColor = i===0?"#86efac":i===results.length-1?"#fed7aa":"#e8e8f0";

          return <div key={i} style={{border:`1.5px solid ${borderColor}`,borderRadius:12,background:cardBg,overflow:"hidden"}}>
            {/* Hlavička karty */}
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",cursor:"pointer",flexWrap:"wrap"}}
              onClick={()=>setExpandedRow(isExp?null:i)}>
              {/* Medaile + jméno */}
              <div style={{minWidth:160,display:"flex",alignItems:"center",gap:8}}>
                {medal(i)&&<span style={{fontSize:20}}>{medal(i)}</span>}
                {!medal(i)&&<span style={{fontSize:13,color:"#aaa",fontWeight:700,minWidth:20,textAlign:"center"}}>{i+1}.</span>}
                <span style={{fontWeight:800,fontSize:15,color:"#1a1a2e"}}>{r.name}</span>
              </div>

              {/* Celkové plnění – progress */}
              <div style={{flex:1,minWidth:160}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:"#888",fontWeight:600}}>Celkové plnění</span>
                  <span style={{fontSize:13,fontWeight:800,color:pctColor(c.celkPlneni)}}>{celkPct} %</span>
                </div>
                <ProgressBar value={c.celkPlneni} max={1} color={pctColor(c.celkPlneni)}/>
              </div>

              {/* Koef + provize */}
              <div style={{display:"flex",gap:16,alignItems:"center",flexShrink:0}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#aaa",fontWeight:600}}>KOEFICIENT</div>
                  <div style={{fontSize:16,fontWeight:800,color:koefPct>=90?"#16a34a":koefPct>=50?"#f97316":"#dc2626"}}>{koefPct} %</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#aaa",fontWeight:600}}>PROVIZE</div>
                  <div style={{fontSize:16,fontWeight:800,color:"#1B4F8A"}}>{czk(c.vyslednaProvize)}</div>
                </div>
                {c.bonusObrat>0&&<div style={{textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#aaa",fontWeight:600}}>BONUS</div>
                  <div style={{fontSize:14,fontWeight:800,color:"#16a34a"}}>+{czk(c.bonusObrat)}</div>
                </div>}
                {moznyZisk>50&&<div style={{textAlign:"center",background:"#fef9c3",borderRadius:8,padding:"4px 8px",border:"1px solid #fde047"}}>
                  <div style={{fontSize:10,color:"#854d0e",fontWeight:600}}>MOŽNÝ ZISK</div>
                  <div style={{fontSize:14,fontWeight:800,color:"#854d0e"}}>+{czk(moznyZisk)}</div>
                </div>}
                <div style={{color:"#bbb",fontSize:18,marginLeft:4}}>{isExp?"▲":"▼"}</div>
              </div>
            </div>

            {/* Rozbalený detail */}
            {isExp&&<div style={{borderTop:"1px solid #e8e8f0",padding:"14px 18px",background:"#fafafe"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12,marginBottom:16}}>
                {items.map((it,xi)=>{
                  const pct=Math.round(it.done*100);
                  const barColor=pctColor(it.done);
                  const mozny = Math.round(it.moznyZiskSlozky||0);
                  return <div key={xi} style={{background:"#fff",borderRadius:10,padding:"12px 14px",border:`1px solid ${it.done>=1?"#86efac":it.done>=0.5?"#fed7aa":"#fecaca"}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                      <span style={{fontWeight:700,fontSize:13,color:"#1a1a2e"}}>{it.label}</span>
                      <span style={{fontSize:11,color:"#aaa",fontWeight:600}}>váha {it.weight}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,color:"#888"}}>Splněno</span>
                      <span style={{fontSize:13,fontWeight:700,color:barColor}}>{pct} %</span>
                    </div>
                    <ProgressBar value={it.done} max={1} color={barColor}/>
                    <div style={{marginTop:8,display:"flex",justifyContent:"space-between",fontSize:12}}>
                      <span style={{color:"#666"}}>Skutečnost: <strong>{czk(it.actual)}</strong></span>
                      <span style={{color:"#666"}}>Plán: <strong>{czk(it.plan)}</strong></span>
                    </div>
                    {it.penetraceInfo&&<div style={{marginTop:4,fontSize:11,color:"#888",background:"#f8f9ff",borderRadius:4,padding:"2px 6px",display:"inline-block"}}>
                      📊 Penetrace: {it.penetraceInfo}
                    </div>}
                    {it.chybi>0
                      ? <div style={{marginTop:4,fontSize:12,color:"#dc2626",fontWeight:600}}>
                          Chybí: {czk(it.chybi)} {it.jednotka}
                          {mozny>0&&<span style={{color:"#f97316",fontWeight:700,marginLeft:6}}>→ +{czk(mozny)} provize</span>}
                        </div>
                      : <div style={{marginTop:4,fontSize:12,color:"#16a34a",fontWeight:700}}>✅ Plán splněn!</div>
                    }
                    <div style={{marginTop:4,fontSize:12,color:"#1B4F8A"}}>Provize: <strong>{czk(it.provize)}</strong></div>
                  </div>;
                })}

                {/* Korunová motivace – kartička */}
                <div style={{background:"#fff",borderRadius:10,padding:"12px 14px",border:"1px solid #e8e8f0"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#1a1a2e"}}>💰 Korunová motivace</span>
                    <span style={{fontSize:11,color:"#aaa",fontWeight:600}}>mimo plnění</span>
                  </div>
                  <div style={{marginTop:4,fontSize:13,color:"#1B4F8A",fontWeight:700}}>{czk(c.korunovaMot)}</div>
                  <div style={{marginTop:4,fontSize:11,color:"#aaa"}}>Dodavatelské provize · nekrátí se</div>
                </div>

                {/* Rozvoz+Admin – zobrazí se jen pokud má hodnotu */}
                {(c.rozv1>0||c.rozv2>0||c.adminH>0)&&<div style={{background:"#fff",borderRadius:10,padding:"12px 14px",border:"1px solid #e8e8f0"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#1a1a2e"}}>🚚 Rozvoz+Admin</span>
                    <span style={{fontSize:11,color:"#aaa",fontWeight:600}}>mimo krácení</span>
                  </div>
                  <div style={{fontSize:12,color:"#888",marginBottom:4}}>
                    {c.rozv1>0&&<div>Rozvoz 1: <strong>{c.rozv1}×</strong></div>}
                    {c.rozv2>0&&<div>Rozvoz 2: <strong>{c.rozv2}×</strong></div>}
                    {c.adminH>0&&<div>Admin práce: <strong>{c.adminH}h</strong></div>}
                  </div>
                  <div style={{marginTop:4,fontSize:13,color:"#1B4F8A",fontWeight:700}}>{czk(c.provizeRozvozAdmin)}</div>
                </div>}
              </div>
              {/* Motivační banner */}
              {moznyZisk>50&&<div style={{marginBottom:12,padding:"14px 16px",background:"#fef9c3",borderRadius:8,border:"1px solid #fde047"}}>
                <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:11,color:"#854d0e",fontWeight:700,marginBottom:2}}>💡 SPLNĚNÍM PLÁNU VE VŠECH SLOŽKÁCH ZÍSKÁŠ NAVÍC</div>
                    <div style={{fontSize:22,fontWeight:900,color:"#854d0e"}}>+{czk(moznyZisk)}</div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:4,fontSize:12,color:"#713f12"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{background:"#fde68a",borderRadius:4,padding:"2px 8px",fontWeight:700,minWidth:80,textAlign:"right"}}>+{czk(Math.max(0,moznyZProvizi))}</span>
                      <span>z vyšších provizí jednotlivých složek</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{background:"#fde68a",borderRadius:4,padding:"2px 8px",fontWeight:700,minWidth:80,textAlign:"right"}}>+{czk(Math.max(0,moznyZKoef))}</span>
                      <span>ze skoku koeficientu {Math.round(c.koef*100)} % → 100 %</span>
                    </div>
                  </div>
                </div>
              </div>}
              {/* Výpočet provize */}
              <div style={{background:"#fff",borderRadius:8,padding:"10px 14px",border:"1px solid #e8e8f0",fontSize:12,color:"#555",lineHeight:2}}>
                <span style={{fontWeight:700,color:"#1a1a2e"}}>Výpočet: </span>
                ({czk(c.provizeObrat)} + {czk(c.provizePz)} + {czk(c.provizeSluzby)} + {czk(c.provizePrislusenství)} + {czk(c.korunovaMot)}{c.provizeRozvozAdmin>0&&` + ${czk(c.provizeRozvozAdmin)} R+A`})
                × {koefPct} % = {czk(c.zaklad)}
                {c.bonusObrat>0&&<> + bonus {czk(c.bonusObrat)}</>}
                {" "}= <strong style={{color:"#1B4F8A"}}>{czk(c.vyslednaProvize)}</strong>
              </div>
            </div>}
          </div>;
        })}
        <div style={{marginTop:4,fontSize:11,color:"#aaa",display:"flex",gap:16,flexWrap:"wrap",padding:"4px"}}>
          <span>🥇🥈🥉 = pořadí v týmu · kliknutím na kartu zobrazíte detail</span>
          {results[0]?.penetraceZdroj&&<span style={{marginLeft:"auto",color:"#1B4F8A"}}>📊 Koef. příslušenství: {results[0].penetraceZdroj}</span>}
        </div>
      </div>
    }
  </div>;
}

// ── Obrazovka 3: Nastavení koeficientů ───────────────────────
function CommissionSettings({stores, onSettingsSaved}){
  const [displayData, setDisplayData] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [importingPenetrace, setImportingPenetrace] = useState(false);
  const [penetraceStatus, setPenetraceStatus] = useState(null);
  const [penetraceTable, setPenetraceTable] = useState([]);
  const [editingPen, setEditingPen] = useState({});
  const [savingPen, setSavingPen] = useState(false);
  const penetraceRef = useRef(null);

  // Globální nastavení (sdílené pro všechny pobočky)
  const [globalSettings, setGlobalSettings] = useState({
    prislusenství_prirazka: "0.5",
    vaha_pz: "4", vaha_obrat: "1", vaha_sluzby: "1", vaha_prisl: "1",
    kraceni: [
      {od:0, koef:0}, {od:10, koef:15}, {od:24, koef:30},
      {od:49, koef:50}, {od:79, koef:90}, {od:99, koef:100},
    ],
    sazba_rozvoz1: "0",   // Kč za jízdu Rozvoz 1
    sazba_rozvoz2: "0",   // Kč za jízdu Rozvoz 2
    sazba_admin:   "0",   // Kč za hodinu Admin práce
  });
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savedGlobal, setSavedGlobal] = useState(false);

  const PCT_FIELDS = new Set([
    "koef_pz","koef_sluzby","koef_prislusenstvi","obrat_koef_plny","obrat_koef_zkraceny",
    "sazba_pz","sazba_sluzby","sazba_prisl_1","sazba_prisl_2","sazba_prisl_3","sazba_prisl_4",
  ]);

  const DEFAULTS_DB = {
    koef_pz:0.025, koef_sluzby:0.012, koef_prislusenstvi:0.1465,
    obrat_koef_plny:0.004, obrat_koef_zkraceny:0.003, obrat_strop:3000,
    bonus_obrat_110:500, bonus_obrat_120:1000,
    sazba_pz:0.10, sazba_sluzby:0.10, strop_sluzby:1500,
    sazba_prisl_1:0.01, sazba_prisl_2:0.02, sazba_prisl_3:0.03, sazba_prisl_4:0.038,
    strop_prislusenstvi:4000,
  };
  const PZ_DEFAULTS = {1:1630, 2:1775, 3:1710};
  const STORE_NAME_MAP = {"strakonice":1,"blatná":2,"blatna":2,"pelhřimov":3,"pelhrimov":3};
  const MONTHS_CZ = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

  const dbToDisplay = (key, dbVal, defaultDbVal) => {
    let num = (dbVal === null || dbVal === undefined) ? defaultDbVal : Number(dbVal);
    if(PCT_FIELDS.has(key) && num === 0 && defaultDbVal) num = defaultDbVal;
    if(PCT_FIELDS.has(key)) return String(Math.round(num * 10000) / 100);
    if(num === 0 && defaultDbVal) return String(defaultDbVal);
    return String(num || "");
  };
  const displayToDB = (key, displayVal) => {
    const num = Number(displayVal)||0;
    if(PCT_FIELDS.has(key)) return num / 100;
    return num;
  };

  const loadAll = async()=>{
    // Per-pobočka nastavení
    const {data:sD} = await supabase.from("commission_settings").select("*");
    const disp = {};
    stores.forEach(s=>{
      const found = sD?.find(r=>r.store_id===s.id);
      const dbRow = found || {...DEFAULTS_DB, prumerna_cena_pz: PZ_DEFAULTS[s.id]||1630};
      disp[s.id] = {};
      Object.keys(DEFAULTS_DB).forEach(key=>{
        disp[s.id][key] = dbToDisplay(key, dbRow[key], DEFAULTS_DB[key]);
      });
      disp[s.id]["prumerna_cena_pz"] = String(dbRow.prumerna_cena_pz || PZ_DEFAULTS[s.id]||1630);
    });
    setDisplayData(disp);

    // Globální nastavení z DB
    const {data:gD} = await supabase.from("commission_global").select("*").single();
    if(gD){
      // Přirážka může být 0 – nepouží || ale explicitní null check
      const prirazkaDB = gD.prislusenství_prirazka;
      const prirazkaDisplay = (prirazkaDB === null || prirazkaDB === undefined)
        ? "0.5"
        : String(Math.round(prirazkaDB * 10000) / 100); // 0 → "0", 0.005 → "0.5"
      setGlobalSettings({
        prislusenství_prirazka: prirazkaDisplay,
        vaha_pz: String(gD.vaha_pz||4),
        vaha_obrat: String(gD.vaha_obrat||1),
        vaha_sluzby: String(gD.vaha_sluzby||1),
        vaha_prisl: String(gD.vaha_prisl||1),
        kraceni: gD.kraceni || [{od:0,koef:0},{od:10,koef:15},{od:24,koef:30},{od:49,koef:50},{od:79,koef:90},{od:99,koef:100}],
        sazba_rozvoz1: String(gD.sazba_rozvoz1||0),
        sazba_rozvoz2: String(gD.sazba_rozvoz2||0),
        sazba_admin:   String(gD.sazba_admin||0),
      });
    }

    // Penetrace
    const {data:penD} = await supabase.from("commission_penetrace").select("*").order("month");
    setPenetraceTable(penD||[]);
    // editingPen zobrazuje loňskou penetraci (read-only) – editovatelná je jen přirážka
    setEditingPen({});
  };

  useEffect(()=>{ loadAll(); },[]);

  const upd = (storeId, field, val) =>
    setDisplayData(prev=>({...prev,[storeId]:{...prev[storeId],[field]:val}}));
  const updGlobal = (field, val) =>
    setGlobalSettings(prev=>({...prev,[field]:val}));
  const updKraceni = (idx, field, val) =>
    setGlobalSettings(prev=>({
      ...prev,
      kraceni: prev.kraceni.map((r,i)=>i===idx?{...r,[field]:Number(val)}:r)
    }));

  const handleSave = async()=>{
    setSaving(true);
    for(const s of stores){
      const d = displayData[s.id]; if(!d) continue;
      await supabase.from("commission_settings").upsert({
        store_id:s.id,
        koef_pz:displayToDB("koef_pz",d.koef_pz), koef_sluzby:displayToDB("koef_sluzby",d.koef_sluzby),
        koef_prislusenstvi:displayToDB("koef_prislusenstvi",d.koef_prislusenstvi),
        prumerna_cena_pz:Number(d.prumerna_cena_pz)||PZ_DEFAULTS[s.id]||1630,
        obrat_koef_plny:displayToDB("obrat_koef_plny",d.obrat_koef_plny),
        obrat_koef_zkraceny:displayToDB("obrat_koef_zkraceny",d.obrat_koef_zkraceny),
        obrat_strop:Number(d.obrat_strop)||3000, bonus_obrat_110:Number(d.bonus_obrat_110)||500,
        bonus_obrat_120:Number(d.bonus_obrat_120)||1000,
        sazba_pz:displayToDB("sazba_pz",d.sazba_pz), sazba_sluzby:displayToDB("sazba_sluzby",d.sazba_sluzby),
        strop_sluzby:Number(d.strop_sluzby)||1500,
        sazba_prisl_1:displayToDB("sazba_prisl_1",d.sazba_prisl_1), sazba_prisl_2:displayToDB("sazba_prisl_2",d.sazba_prisl_2),
        sazba_prisl_3:displayToDB("sazba_prisl_3",d.sazba_prisl_3), sazba_prisl_4:displayToDB("sazba_prisl_4",d.sazba_prisl_4),
        strop_prislusenstvi:Number(d.strop_prislusenstvi)||4000,
        updated_at:new Date().toISOString(),
      },{onConflict:"store_id"});
    }
    setSaving(false); setSaved(true); setTimeout(()=>setSaved(false),2500);
    if(onSettingsSaved) onSettingsSaved();
  };

  const handleSaveGlobal = async()=>{
    setSavingGlobal(true);
    const prirazkaDisplay = globalSettings.prislusenství_prirazka;
    const prirazkaDB = (prirazkaDisplay===""||prirazkaDisplay==null) ? 0.005 : Number(prirazkaDisplay)/100;
    await supabase.from("commission_global").upsert({
      id:1,
      prislusenství_prirazka: prirazkaDB,
      vaha_pz: Number(globalSettings.vaha_pz)||4,
      vaha_obrat: Number(globalSettings.vaha_obrat)||1,
      vaha_sluzby: Number(globalSettings.vaha_sluzby)||1,
      vaha_prisl: Number(globalSettings.vaha_prisl)||1,
      kraceni: globalSettings.kraceni,
      sazba_rozvoz1: Number(globalSettings.sazba_rozvoz1)||0,
      sazba_rozvoz2: Number(globalSettings.sazba_rozvoz2)||0,
      sazba_admin:   Number(globalSettings.sazba_admin)||0,
    },{onConflict:"id"});
    setSavingGlobal(false); setSavedGlobal(true); setTimeout(()=>setSavedGlobal(false),2500);
    if(onSettingsSaved) onSettingsSaved();
  };

  const handleSavePenetrace = async()=>{
    // Přirážka může být 0 – nepouží || ale explicitní null check
    const prirazkaDisplay = globalSettings.prislusenství_prirazka;
    const prirazka = (prirazkaDisplay === "" || prirazkaDisplay === null || prirazkaDisplay === undefined)
      ? 0.005  // default 0.5% jen pokud pole je prázdné
      : Number(prirazkaDisplay) / 100;  // 0 je validní hodnota
    setSavingPen(true);
    // 1) Ulož přirážku do commission_global aby přežila reload
    await supabase.from("commission_global").upsert({
      id:1,
      prislusenství_prirazka: prirazka,
      vaha_pz: Number(globalSettings.vaha_pz)||4,
      vaha_obrat: Number(globalSettings.vaha_obrat)||1,
      vaha_sluzby: Number(globalSettings.vaha_sluzby)||1,
      vaha_prisl: Number(globalSettings.vaha_prisl)||1,
      kraceni: globalSettings.kraceni,
      sazba_rozvoz1: Number(globalSettings.sazba_rozvoz1)||0,
      sazba_rozvoz2: Number(globalSettings.sazba_rozvoz2)||0,
      sazba_admin:   Number(globalSettings.sazba_admin)||0,
    },{onConflict:"id"});
    // 2) Přepočítej koeficienty v commission_penetrace
    for(const rec of penetraceTable){
      const koef = Math.round(((rec.penetrace_loni||0) + prirazka) * 100000) / 100000;
      await supabase.from("commission_penetrace").upsert(
        {store_id:rec.store_id, month:rec.month, koef_prislusenstvi:koef, penetrace_loni:rec.penetrace_loni},
        {onConflict:"store_id,month"});
    }
    setSavingPen(false); await loadAll();
    if(onSettingsSaved) onSettingsSaved();
  };

  const handlePenetraceImport=async(e)=>{
    const file=e.target.files?.[0]; if(!file) return;
    e.target.value=""; setImportingPenetrace(true); setPenetraceStatus(null);
    try {
      const XLSX=await loadXLSX();
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(new Uint8Array(buf),{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null});
      const saved=[]; let currentMonth=null;
      for(let i=0;i<rows.length;i++){
        const r=rows[i]; if(!r) continue;
        const c0=String(r[0]||"").trim();
        if(c0==="Fiskální datum RMD"){ const mv=r[1]; if(mv!=null) currentMonth=Number(mv); continue; }
        if(c0.toLowerCase().startsWith("prodejna")&&currentMonth!=null){
          const storePart=c0.toLowerCase().replace("prodejna","").trim();
          const storeId=STORE_NAME_MAP[storePart]; if(!storeId) continue;
          const pen=r[11]; if(pen==null||isNaN(Number(pen))) continue;
          const penNum=Number(pen);
          const koef=Math.round((penNum+0.005)*10000)/10000;
          const {error}=await supabase.from("commission_penetrace").upsert(
            {store_id:storeId,month:currentMonth,koef_prislusenstvi:koef,penetrace_loni:penNum},
            {onConflict:"store_id,month"});
          if(!error) saved.push(`${c0} (${String(currentMonth).padStart(2,"0")}): ${(penNum*100).toFixed(2)} % → ${(koef*100).toFixed(2)} %`);
        }
      }
      setPenetraceStatus({saved}); setImportingPenetrace(false); await loadAll();
      if(onSettingsSaved) onSettingsSaved();
    } catch(err){ setImportingPenetrace(false); alert("Chyba importu: "+err.message); }
  };

  const inputS={padding:"6px 9px",borderRadius:7,border:"1.5px solid #E8E8F0",fontSize:13,width:90,textAlign:"right"};
  const thS={padding:"9px 10px",textAlign:"left",fontWeight:700,color:"#fff",fontSize:12,background:"#1B4F8A"};
  const tdS={padding:"8px 10px",fontSize:13};
  const fieldGroups = [
    {
      title: "📊 Plánové koeficienty",
      subtitle: "Určují plán každé složky jako % z plánu prodejny",
      fields: [
        {key:"koef_pz",          label:"PZ – koef. plánu",  help:"Plán PZ = X % z plánu prodejny",     suffix:"%"},
        {key:"koef_sluzby",      label:"Služby – koef. plánu", help:"Plán služeb = X % z plánu prodejny", suffix:"%"},
        {key:"prumerna_cena_pz", label:"Průměrná cena PZ",   help:"STR 1 630, BL 1 775, PE 1 710 Kč",  suffix:"Kč"},
      ]
    },
    {
      title: "💰 Sazby provizí",
      subtitle: "Procentní sazby pro výpočet provize z každé složky",
      fields: [
        {key:"sazba_pz",           label:"PZ – sazba provize",          help:"% z tržby prodaných záruk",               suffix:"%"},
        {key:"sazba_sluzby",       label:"Služby – sazba provize",      help:"% z tržby služeb",                        suffix:"%"},
        {key:"strop_sluzby",       label:"Služby – strop provize",      help:"Max. provize za služby",                  suffix:"Kč"},
      ]
    },
    {
      title: "📦 Příslušenství – stupňovité sazby",
      subtitle: "Sazba závisí na % splnění plánu příslušenství",
      fields: [
        {key:"sazba_prisl_1",      label:"Sazba 11–25 % plnění",        help:"Pásmo 11–25 % splnění plánu",             suffix:"%"},
        {key:"sazba_prisl_2",      label:"Sazba 26–60 % plnění",        help:"Pásmo 26–60 % splnění plánu",             suffix:"%"},
        {key:"sazba_prisl_3",      label:"Sazba 61–99 % plnění",        help:"Pásmo 61–99 % splnění plánu",             suffix:"%"},
        {key:"sazba_prisl_4",      label:"Sazba 100 %+ plnění",         help:"Při splnění nebo překročení plánu",        suffix:"%"},
        {key:"strop_prislusenstvi",label:"Příslušenství – strop provize",help:"Max. provize za příslušenství",           suffix:"Kč"},
      ]
    },
    {
      title: "📈 Obrat",
      subtitle: "Sazby a bonusy za obrat",
      fields: [
        {key:"obrat_koef_plny",    label:"Sazba plný úvazek (≥160h)",   help:"% z obratu prodejce – plný úvazek",       suffix:"%"},
        {key:"obrat_koef_zkraceny",label:"Sazba zkrácený úvazek (<160h)",help:"% z obratu prodejce – zkrácený úvazek",  suffix:"%"},
        {key:"obrat_strop",        label:"Strop obratové provize",       help:"Max. provize za obrat (před bonusem)",    suffix:"Kč"},
        {key:"bonus_obrat_110",    label:"Bonus za 110–119 % obratu",    help:"Bonus se nekrátí, vyplácí se vždy",       suffix:"Kč"},
        {key:"bonus_obrat_120",    label:"Bonus za 120 %+ obratu",       help:"Bonus se nekrátí, vyplácí se vždy",       suffix:"Kč"},
      ]
    },
  ];

  // Měsíce 1–12 jsou fiskální měsíce, hodnoty > 12 jsou roční souhrny (2025 apod.) – skryjeme je
  const allMonths = [...new Set(penetraceTable.map(r=>r.month))].filter(m=>m>=1&&m<=12).sort((a,b)=>a-b);

  return <div>
    {/* Import penetrace */}
    <div style={{marginBottom:24,padding:"16px 20px",background:"#f0f9ff",borderRadius:10,border:"1.5px solid #93c5fd"}}>
      <div style={{fontWeight:700,color:"#1B4F8A",marginBottom:6,fontSize:14}}>📊 Import penetrace příslušenství</div>
      <div style={{fontSize:13,color:"#555",marginBottom:12,lineHeight:1.6}}>
        Nahraj <strong>Příslušenství_data.xlsx</strong> jednou ročně. Koeficienty se uloží per pobočka × měsíc a lze je níže ručně korigovat.
      </div>
      <input ref={penetraceRef} type="file" accept=".xlsx" style={{display:"none"}} onChange={handlePenetraceImport}/>
      <button onClick={()=>penetraceRef.current?.click()} disabled={importingPenetrace}
        style={{padding:"9px 20px",borderRadius:7,border:"1.5px solid #1B4F8A",background:"#1B4F8A",color:"#fff",fontWeight:700,fontSize:13,cursor:importingPenetrace?"not-allowed":"pointer",opacity:importingPenetrace?0.7:1}}>
        {importingPenetrace?"Zpracovávám…":"📂 Nahrát Příslušenství_data.xlsx"}
      </button>
      {penetraceStatus&&<div style={{marginTop:12,fontSize:12,color:"#166534",background:"#f0fdf4",borderRadius:7,padding:"10px 14px",border:"1px solid #86efac"}}>
        <strong>✅ Importováno {penetraceStatus.saved.length} záznamů</strong>
        <div style={{maxHeight:100,overflowY:"auto",lineHeight:1.8,marginTop:4}}>
          {penetraceStatus.saved.map((s,i)=><div key={i}>{s}</div>)}
        </div>
      </div>}
    </div>

    {/* Přehled penetrace – read-only s přirážkou */}
    {allMonths.length>0&&<div style={{marginBottom:24}}>
      <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:6,fontSize:14}}>
        📈 Přehled penetrace příslušenství
      </div>
      {/* Přirážka – jedna globální hodnota */}
      <div style={{marginBottom:12,padding:"12px 16px",background:"#f0fdf4",borderRadius:8,border:"1.5px solid #86efac",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <div style={{fontSize:13,color:"#1a1a2e"}}>
          <strong>Přirážka k loňské penetraci</strong>
          <div style={{fontSize:11,color:"#888",marginTop:2}}>Přičte se ke každé loňské hodnotě → výsledný koeficient pro daný měsíc</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:13,color:"#555"}}>loňská penetrace +</span>
          <input type="number" step="0.01" value={globalSettings.prislusenství_prirazka}
            onChange={e=>updGlobal("prislusenství_prirazka",e.target.value)}
            style={{...inputS,width:70,border:"1.5px solid #86efac"}}/>
          <span style={{fontSize:13,color:"#555"}}>% = výsledný koeficient</span>
        </div>
        <button onClick={handleSavePenetrace} disabled={savingPen}
          style={{padding:"7px 16px",borderRadius:7,border:"none",background:"#16a34a",color:"#fff",fontWeight:700,fontSize:13,cursor:savingPen?"not-allowed":"pointer",opacity:savingPen?0.7:1}}>
          {savingPen?"Přepočítávám…":"🔄 Přepočítat a uložit koeficienty"}
        </button>
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr>
            <th style={thS}>Měsíc</th>
            {stores.map(s=><th key={s.id} style={{...thS,textAlign:"center"}}>
              {s.name}
              <div style={{display:"flex",justifyContent:"center",gap:4,marginTop:2,fontSize:10,fontWeight:400}}>
                <span style={{opacity:0.7}}>loni %</span>
                <span style={{opacity:0.4}}>→</span>
                <span style={{opacity:0.9}}>koef. %</span>
              </div>
            </th>)}
          </tr></thead>
          <tbody>
            {allMonths.map(mon=><tr key={mon} style={{borderBottom:"1px solid #eee"}}>
              <td style={{...tdS,fontWeight:600}}>{MONTHS_CZ[mon]||mon}</td>
              {stores.map((s,si)=>{
                const rec = penetraceTable.find(r=>r.store_id===s.id&&r.month===mon);
                const penLoni = rec?.penetrace_loni;
                const koefUlozeny = rec?.koef_prislusenstvi; // skutečně uložená hodnota v DB
                const prirazkaDisplay = globalSettings.prislusenství_prirazka;
                const prirazka = (prirazkaDisplay === "" || prirazkaDisplay == null)
                  ? 0.005 : Number(prirazkaDisplay) / 100;
                const koefVypocet = penLoni != null ? penLoni + prirazka : null; // co by bylo při aktuální přirážce
                const sedí = koefUlozeny!=null && koefVypocet!=null && Math.abs(koefUlozeny-koefVypocet)<0.0002;
                return <td key={s.id} style={{...tdS,textAlign:"center",background:si%2===0?"#fff":"#f8f9ff"}}>
                  {penLoni!=null
                    ? <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontSize:13}}>
                        <span style={{color:"#888"}}>{(penLoni*100).toFixed(2)} %</span>
                        <span style={{color:"#bbb"}}>→</span>
                        <span style={{fontWeight:700,color: sedí?"#1B4F8A":"#f97316"}}>
                          {koefUlozeny!=null?(koefUlozeny*100).toFixed(2):"-"} %
                        </span>
                        {!sedí&&koefUlozeny!=null&&<span title={`Liší se od výpočtu (${koefVypocet!=null?(koefVypocet*100).toFixed(2):"-"} %)`} style={{fontSize:10,color:"#f97316",cursor:"help"}}>✎</span>}
                      </div>
                    : <span style={{color:"#ddd"}}>–</span>
                  }
                </td>;
              })}
            </tr>)}
          </tbody>
        </table>
      </div>
      <div style={{marginTop:8,fontSize:11,color:"#aaa"}}>
        ✎ = hodnota byla ručně upravena a liší se od výpočtu (loňská + přirážka)
      </div>
    </div>}

    {/* Globální nastavení – váhy a tabulka krácení */}
    <div style={{marginBottom:24,border:"1.5px solid #e8e8f0",borderRadius:10,overflow:"hidden"}}>
      <div style={{background:"#1B4F8A",padding:"10px 16px"}}>
        <div style={{fontWeight:700,color:"#fff",fontSize:13}}>⚖️ Celkové plnění – váhy složek a tabulka krácení</div>
        <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:2}}>Globální nastavení – platí pro všechny pobočky</div>
      </div>
      <div style={{padding:"16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        {/* Váhy složek */}
        <div>
          <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:10,fontSize:13}}>Váhy složek ve vzorci celkového plnění</div>
          <div style={{fontSize:11,color:"#888",marginBottom:10}}>
            Vzorec: (PZ×váha + Obrat×váha + Služby×váha + Přísl.×váha) ÷ součet vah
          </div>
          {[
            {key:"vaha_pz",     label:"Záruky (PZ)"},
            {key:"vaha_obrat",  label:"Obrat"},
            {key:"vaha_sluzby", label:"Služby"},
            {key:"vaha_prisl",  label:"Příslušenství"},
          ].map(f=>{
            const total = (Number(globalSettings.vaha_pz)||4)+(Number(globalSettings.vaha_obrat)||1)+(Number(globalSettings.vaha_sluzby)||1)+(Number(globalSettings.vaha_prisl)||1);
            const pct = Math.round((Number(globalSettings[f.key])||0)/total*100);
            return <div key={f.key} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <span style={{minWidth:120,fontSize:13,color:"#555"}}>{f.label}</span>
              <input type="number" step="1" min="0" value={globalSettings[f.key]}
                onChange={e=>updGlobal(f.key,e.target.value)}
                style={{...inputS,width:60}}/>
              <span style={{fontSize:11,color:"#aaa",minWidth:40}}>({pct} %)</span>
            </div>;
          })}
          <div style={{marginTop:8,fontSize:11,color:"#888",padding:"6px 10px",background:"#f8f9ff",borderRadius:6}}>
            Součet vah: {(Number(globalSettings.vaha_pz)||4)+(Number(globalSettings.vaha_obrat)||1)+(Number(globalSettings.vaha_sluzby)||1)+(Number(globalSettings.vaha_prisl)||1)}
          </div>
        </div>

        {/* Tabulka krácení */}
        <div>
          <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:10,fontSize:13}}>Tabulka krácení provize</div>
          <div style={{fontSize:11,color:"#888",marginBottom:10}}>Při celkovém plnění ≥ X % se použije koeficient Y %</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead><tr style={{background:"#f0f4ff"}}>
              <th style={{padding:"6px 10px",textAlign:"left",fontWeight:700,color:"#1B4F8A",fontSize:12}}>Od plnění %</th>
              <th style={{padding:"6px 10px",textAlign:"left",fontWeight:700,color:"#1B4F8A",fontSize:12}}>Koeficient %</th>
            </tr></thead>
            <tbody>
              {globalSettings.kraceni.map((r,idx)=>(
                <tr key={idx} style={{borderBottom:"1px solid #eee"}}>
                  <td style={{padding:"4px 6px"}}>
                    <input type="number" step="1" min="0" max="100" value={r.od}
                      onChange={e=>updKraceni(idx,"od",e.target.value)}
                      style={{...inputS,width:70}}/>
                    <span style={{marginLeft:4,fontSize:12,color:"#888"}}>%</span>
                  </td>
                  <td style={{padding:"4px 6px"}}>
                    <input type="number" step="1" min="0" max="100" value={r.koef}
                      onChange={e=>updKraceni(idx,"koef",e.target.value)}
                      style={{...inputS,width:70}}/>
                    <span style={{marginLeft:4,fontSize:12,color:"#888"}}>%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sazby Rozvoz+Admin – speciální role */}
      <div style={{padding:"0 16px 16px",borderTop:"1px solid #e8e8f0",paddingTop:14}}>
        <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:8,fontSize:13}}>🚚 Odměny Rozvoz+Admin (pro role: Rozvoz, Účetní, Brigádník)</div>
        <div style={{fontSize:11,color:"#888",marginBottom:10}}>Fixní sazby – Rozvoz 1 a 2 v Kč/jízda, Admin v Kč/hodinu. Hodnoty se načítají automaticky z výkazu zaměstnance.</div>
        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
          {[
            {key:"sazba_rozvoz1", label:"Rozvoz 1", jednotka:"Kč/jízda"},
            {key:"sazba_rozvoz2", label:"Rozvoz 2", jednotka:"Kč/jízda"},
            {key:"sazba_admin",   label:"Admin práce", jednotka:"Kč/hodinu"},
          ].map(f=><div key={f.key}>
            <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:4}}>{f.label.toUpperCase()}</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <input type="number" step="1" min="0" value={globalSettings[f.key]||"0"}
                onChange={e=>updGlobal(f.key,e.target.value)}
                style={{...inputS,width:100}}/>
              <span style={{fontSize:12,color:"#888"}}>{f.jednotka}</span>
            </div>
          </div>)}
        </div>
      </div>

      <div style={{padding:"0 16px 16px",display:"flex",gap:10,alignItems:"center"}}>
        <button onClick={handleSaveGlobal} disabled={savingGlobal}
          style={{background:"#1B4F8A",color:"#fff",border:"none",borderRadius:9,padding:"10px 24px",fontSize:14,fontWeight:700,cursor:savingGlobal?"not-allowed":"pointer",opacity:savingGlobal?0.7:1}}>
          {savingGlobal?"Ukládám…":"💾 Uložit globální nastavení"}
        </button>
        {savedGlobal&&<span style={{color:"#16a34a",fontWeight:700,fontSize:13}}>✅ Uloženo!</span>}
        <span style={{fontSize:11,color:"#aaa",marginLeft:8}}>Po uložení se výsledky přepočítají automaticky</span>
      </div>
    </div>

    {/* Výchozí koeficienty – rozděleno do sekcí */}
    <div style={{fontWeight:700,color:"#1a1a2e",marginBottom:14,fontSize:14}}>⚙️ Sazby a koeficienty per pobočka</div>
    {fieldGroups.map(group=>(
      <div key={group.title} style={{marginBottom:20,border:"1.5px solid #e8e8f0",borderRadius:10,overflow:"hidden"}}>
        <div style={{background:"#1B4F8A",padding:"10px 16px"}}>
          <div style={{fontWeight:700,color:"#fff",fontSize:13}}>{group.title}</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginTop:2}}>{group.subtitle}</div>
        </div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#eef4ff"}}>
            <th style={{...thS,background:"#eef4ff",color:"#1B4F8A",fontWeight:700,padding:"8px 14px"}}>Parametr</th>
            {stores.map(s=><th key={s.id} style={{...thS,background:"#eef4ff",color:"#1B4F8A",textAlign:"center",padding:"8px 14px"}}>{s.name}</th>)}
          </tr></thead>
          <tbody>
            {group.fields.map(f=><tr key={f.key} style={{borderBottom:"1px solid #f0f0f0"}}>
              <td style={{...tdS,paddingLeft:14}}>
                <div style={{fontWeight:600,color:"#1a1a2e"}}>{f.label}</div>
                <div style={{fontSize:11,color:"#aaa"}}>{f.help}</div>
              </td>
              {stores.map((s,si)=><td key={s.id} style={{...tdS,textAlign:"center",background:si%2===0?"#fff":"#f8f9ff"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                  <input
                    type="number"
                    step={f.suffix==="%"?"0.01":"1"}
                    value={displayData[s.id]?.[f.key] ?? ""}
                    onChange={e=>upd(s.id, f.key, e.target.value)}
                    style={inputS}
                  />
                  <span style={{fontSize:12,color:"#888",minWidth:20}}>{f.suffix}</span>
                </div>
              </td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    ))}
    <div style={{marginTop:16,display:"flex",gap:10,alignItems:"center"}}>
      <button onClick={handleSave} disabled={saving}
        style={{background:"#1B4F8A",color:"#fff",border:"none",borderRadius:9,padding:"11px 28px",fontSize:14,fontWeight:700,cursor:saving?"not-allowed":"pointer",opacity:saving?0.7:1}}>
        {saving?"Ukládám…":"💾 Uložit nastavení"}
      </button>
      {saved&&<span style={{color:"#16a34a",fontWeight:700,fontSize:13}}>✅ Uloženo!</span>}
    </div>
  </div>;
}

// ── Hlavní kontejner provizního modulu ───────────────────────
function CommissionModule({employees, stores, currentUser, sched, holidays, patterns}){
  if(currentUser?.role !== "admin") return null;
  const [subTab, setSubTab] = useState("input");
  const [resultsKey, setResultsKey] = useState(0); // increment to force re-fetch
  const subTabs=[
    {key:"input",   label:"📝 Zadat výsledky"},
    {key:"results", label:"📊 Výsledky týmu"},
    {key:"settings",label:"⚙️ Nastavení koeficientů"},
  ];
  const handleSettingsSaved = ()=>{
    // Po uložení koeficientů přepneme na Výsledky a přinutíme je k přenačtení
    setResultsKey(k=>k+1);
    setSubTab("results");
  };
  return <div>
    <div style={{display:"flex",gap:4,marginBottom:20,borderBottom:"2px solid #e8e8f0",paddingBottom:0}}>
      {subTabs.map(t=><button key={t.key} onClick={()=>setSubTab(t.key)}
        style={{padding:"9px 18px",background:"none",border:"none",borderBottom:subTab===t.key?"3px solid #1B4F8A":"3px solid transparent",color:subTab===t.key?"#1B4F8A":"#888",fontWeight:subTab===t.key?700:500,fontSize:13,cursor:"pointer",marginBottom:-2}}>
        {t.label}
      </button>)}
    </div>
    {subTab==="input"    && <CommissionInput employees={employees} stores={stores} currentUser={currentUser} sched={sched} holidays={holidays} patterns={patterns}/>}
    {subTab==="results"  && <CommissionResults key={resultsKey} employees={employees} stores={stores}/>}
    {subTab==="settings" && <CommissionSettings stores={stores} onSettingsSaved={handleSettingsSaved}/>}
  </div>;
}

// ─── WRAPPER – řídí přihlášení BEZ hook problémů ─────────────
export default function App(){
  const [currentUser,setCurrentUser]=useState(()=>{
    try{const v=localStorage.getItem("sf_user");return v?JSON.parse(v):null;}catch{return null;}
  });
  const handleLogin=(user)=>{
    localStorage.setItem("sf_user",JSON.stringify(user));
    setCurrentUser(user);
  };
  const handleLogout=()=>{
    localStorage.removeItem("sf_user");
    setCurrentUser(null);
  };
  if(!currentUser) return <LoginScreen onLogin={handleLogin}/>;
  return <MainApp currentUser={currentUser} handleLogout={handleLogout}/>;
}
