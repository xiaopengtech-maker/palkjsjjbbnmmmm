'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');

const CONFIG_FILE = 'config.json';
const SEEN_FILE   = 'seen.json';
const STATS_FILE  = 'stats.json';

const DEFAULT_CONFIG = {
  adminPassword: '280911', botToken: '', chatId: '',
  checkIntervalMs: 15000, sendDelayMs: 1500, retryMax: 3, retryBaseDelayMs: 2000, apis: []
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '{}');
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
}
function saveSeen() { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); }
const DEFAULT_STATS = { totalTransactions:0, totalReceived:0, daily:{}, apiStats:{}, recentTransactions:[], lastCheckAt:null, lastSuccessAt:null, resetAt:null };
function loadStats() {
  if (!fs.existsSync(STATS_FILE)) return { ...DEFAULT_STATS };
  try { return { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch { return { ...DEFAULT_STATS }; }
}
function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify({
    totalTransactions:stats.totalTransactions, totalReceived:stats.totalReceived,
    daily:stats.daily, apiStats:stats.apiStats, recentTransactions:stats.recentTransactions,
    lastCheckAt:stats.lastCheckAt, lastSuccessAt:stats.lastSuccessAt, resetAt:stats.resetAt
  }));
}

let config = loadConfig();
let seen   = loadSeen();
let stats  = loadStats();
let sessions = {}, workers = {}, botRunning = false, telegramQueue = [], telegramProcessing = false;

function createSession() { const s=crypto.randomBytes(24).toString('hex'); sessions[s]={created:Date.now()}; return s; }
function isValidSession(s) { return !!(s && sessions[s]); }
function parseCookies(h) {
  const c={};
  if(!h)return c;
  h.split(';').forEach(p=>{const[k,...v]=p.trim().split('=');if(k)c[k.trim()]=v.join('=').trim();});
  return c;
}
function fv(n){return Number(n||0).toLocaleString('vi-VN')+' đ';}
function todayKey(){return new Date().toISOString().slice(0,10);}
function sh(s){return String(s||'').replace(/[^\x20-\x7E]/g,'').replace(/[\r\n]/g,'');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function httpsGet(u,t=10000){
  return new Promise((resolve,reject)=>{
    let p; try{p=new URL(u);}catch(e){return reject(e);}
    const proto=p.protocol==='https:'?https:http;
    const req=proto.request({hostname:p.hostname,port:p.port||(p.protocol==='https:'?443:80),path:p.pathname+p.search,method:'GET',headers:{'User-Agent':'BankMonitor/1.0'},timeout:t},res=>{
      let d=''; res.on('data',c=>{d+=c;}); res.on('end',()=>{try{resolve(JSON.parse(d));}catch{reject(new Error('Bad JSON'));}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject); req.end();
  });
}
function httpsPost(u,body,t=10000){
  return new Promise((resolve,reject)=>{
    let p; try{p=new URL(u);}catch(e){return reject(e);}
    const pd=JSON.stringify(body);
    const req=https.request({hostname:p.hostname,port:p.port||443,path:p.pathname+p.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(pd),'User-Agent':'BankMonitor/1.0'},timeout:t},res=>{
      let d=''; res.on('data',c=>{d+=c;}); res.on('end',()=>{try{resolve(JSON.parse(d));}catch{reject(new Error('Bad JSON'));}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject); req.write(pd); req.end();
  });
}
function sendHtml(res,body,code=200){const buf=Buffer.from(body,'utf8');res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Content-Length':buf.length});res.end(buf);}
function sendJson(res,obj,code=200){res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));}
function redir(res,loc,cookie){const h={'Location':sh(loc)};if(cookie)h['Set-Cookie']=cookie;res.writeHead(302,h);res.end();}
function parseBody(req){
  return new Promise(resolve=>{
    let body='';
    req.on('data',c=>{body+=c;if(body.length>100000)req.destroy();});
    req.on('end',()=>{
      const p={};
      body.split('&').forEach(pair=>{
        const i=pair.indexOf('=');if(i<0)return;
        try{p[decodeURIComponent(pair.slice(0,i).replace(/\+/g,' '))]=decodeURIComponent(pair.slice(i+1).replace(/\+/g,' '));}catch{}
      });
      resolve(p);
    });
    req.on('error',()=>resolve({}));
  });
}

async function sendTG(text,retry=0){
  if(!config.botToken||!config.chatId)return;
  try{await httpsPost('https://api.telegram.org/bot'+config.botToken+'/sendMessage',{chat_id:config.chatId,text,parse_mode:'HTML'});}
  catch(err){
    if(retry<(config.retryMax||3)){await sleep((config.retryBaseDelayMs||2000)*Math.pow(2,retry));return sendTG(text,retry+1);}
    console.error('[TG]',err.message);
  }
}
function enqueueTG(text){telegramQueue.push(text);processTGQueue();}
async function processTGQueue(){
  if(telegramProcessing||telegramQueue.length===0)return;
  telegramProcessing=true;
  while(telegramQueue.length>0){await sendTG(telegramQueue.shift());await sleep(config.sendDelayMs||1500);}
  telegramProcessing=false;
}
function buildTxMsg(tx,api){
  const amt=tx.amount||tx.Amount||tx.creditAmount||0;
  const desc=tx.description||tx.Description||tx.content||tx.Content||'';
  const date=tx.transactionDate||tx.TransactionDate||tx.date||tx.Date||new Date().toLocaleString('vi-VN');
  const ref=tx.refNo||tx.RefNo||tx.id||tx.Id||'N/A';
  const acct=tx.accountNo||tx.AccountNo||tx.account||api.name||'';
  return `💸 <b>Giao dịch mới</b>\n🏦 <b>Tài Khoản:</b> ${acct}\n💰 <b>Số Tiền:</b> ${fv(amt)}\n📝 <b>Nội Dung:</b> ${desc}\n🕐 <b>Ngày Giờ:</b> ${date}\n🔖 <b>Mã GD:</b> ${ref}`;
}

async function checkApi(api,preSeed=false){
  stats.lastCheckAt=new Date().toLocaleString('vi-VN');
  try{
    const data=await httpsGet(api.url);
    const txList=data.TranList||data.tranList||data.transactions||data.data||[];
    if(!Array.isArray(txList))return;
    stats.lastSuccessAt=new Date().toLocaleString('vi-VN');
    const sk=api.id;
    if(!seen[sk])seen[sk]={};
    if(preSeed){
      let seeded=false;
      for(const tx of txList){const r=tx.refNo||tx.RefNo||tx.id||tx.Id;if(r&&!seen[sk][r]){seen[sk][r]=true;seeded=true;}}
      if(seeded)saveSeen();
      console.log(`[Worker:${api.name}] Pre-seeded ${txList.length} txns — no resend`);
      return;
    }
    for(const tx of txList){
      const ref=tx.refNo||tx.RefNo||tx.id||tx.Id;
      if(!ref||seen[sk][ref])continue;
      seen[sk][ref]=true;
      const amt=Number(tx.amount||tx.Amount||tx.creditAmount||0);
      if(amt>0){
        stats.totalReceived+=amt;
        const day=todayKey();
        if(!stats.daily[day])stats.daily[day]={count:0,amount:0};
        stats.daily[day].count++; stats.daily[day].amount+=amt;
        if(!stats.apiStats[sk])stats.apiStats[sk]={name:api.name,totalReceived:0,totalTransactions:0};
        stats.apiStats[sk].totalReceived+=amt;
      }
      stats.totalTransactions++;
      if(!stats.apiStats[sk])stats.apiStats[sk]={name:api.name,totalReceived:0,totalTransactions:0};
      stats.apiStats[sk].name=api.name; stats.apiStats[sk].totalTransactions++;
      stats.recentTransactions.unshift({
        refNo:ref,amount:tx.amount||tx.Amount||tx.creditAmount||0,
        description:tx.description||tx.Description||tx.content||tx.Content||'',
        date:tx.transactionDate||tx.TransactionDate||tx.date||tx.Date||new Date().toISOString(),
        apiName:api.name,apiId:sk,time:Date.now()
      });
      if(stats.recentTransactions.length>50)stats.recentTransactions.pop();
      enqueueTG(buildTxMsg(tx,api));
    }
    saveSeen(); saveStats();
  }catch(err){console.error(`[Worker:${api.name}]`,err.message);}
}

function startWorker(api){
  if(workers[api.id]){clearInterval(workers[api.id]);delete workers[api.id];}
  if(!api.enabled)return;
  console.log('[Worker] Starting:',api.name);
  checkApi(api,true).then(()=>{
    workers[api.id]=setInterval(()=>checkApi(api,false),config.checkIntervalMs||15000);
  });
}
function stopWorker(id){if(workers[id]){clearInterval(workers[id]);delete workers[id];}}
function startAllWorkers(){(config.apis||[]).forEach(api=>{if(api.enabled)startWorker(api);});botRunning=true;}
function stopAllWorkers(){Object.keys(workers).forEach(stopWorker);botRunning=false;}
function restartAllWorkers(){stopAllWorkers();startAllWorkers();}
function resetAllStats(){
  stats={totalTransactions:0,totalReceived:0,daily:{},apiStats:{},recentTransactions:[],lastCheckAt:null,lastSuccessAt:null,resetAt:new Date().toLocaleString('vi-VN')};
  seen={};saveSeen();saveStats();console.log('[Stats] Reset done');
}

// ── CSS (iOS dark native)
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#000;--sf:#1c1c1e;--card:#2c2c2e;--c2:#3a3a3c;--sep:#38383a80;--border:#38383a;
--acc:#0a84ff;--grn:#30d158;--red:#ff453a;--ylw:#ffd60a;--org:#ff9f0a;--pur:#bf5af2;
--tx:#fff;--tx2:#ebebf5cc;--tx3:#ebebf599;--mt:#636366;
--f:'Inter',system-ui,-apple-system,sans-serif;--m:'SF Mono','Menlo',monospace;
--r:12px;--rl:16px;--rxl:20px}
html{background:#000}
body{background:var(--bg);color:var(--tx);font-family:var(--f);min-height:100vh;font-size:15px;line-height:1.5;overflow-x:hidden}
::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-thumb{background:#444;border-radius:4px}
.topbar{position:sticky;top:0;z-index:200;background:rgba(0,0,0,.82);backdrop-filter:saturate(180%) blur(24px);-webkit-backdrop-filter:saturate(180%) blur(24px);border-bottom:1px solid var(--border)}
.ti{max-width:680px;margin:0 auto;padding:0 18px;height:52px;display:flex;align-items:center}
.brand{font-size:17px;font-weight:700;letter-spacing:-.03em;flex:1}.brand span{color:var(--acc)}
.tout{font-size:13px;font-weight:600;color:var(--mt);text-decoration:none}
.tabs-wrap{max-width:680px;margin:0 auto;padding:10px 16px 0}
.nav-tabs{display:flex;gap:2px;background:var(--sf);border-radius:10px;padding:2px}
.nav-tab{flex:1;text-align:center;padding:7px 2px;font-size:12px;font-weight:600;border-radius:8px;color:var(--tx3);transition:all .16s;cursor:pointer;border:none;background:none;letter-spacing:.01em}
.nav-tab.on{background:var(--c2);color:var(--tx);box-shadow:0 2px 6px rgba(0,0,0,.45)}
.main{max-width:680px;margin:0 auto;padding:16px 16px 100px}
@supports(padding:env(safe-area-inset-bottom)){.main{padding-bottom:calc(80px + env(safe-area-inset-bottom))}}
.group{background:var(--sf);border-radius:var(--rl);overflow:hidden;margin-bottom:16px}
.gi{padding:13px 16px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:12px}
.gi:last-child{border-bottom:none}
.gi-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.gi-body{flex:1;min-width:0}.gi-lbl{font-size:12px;color:var(--tx3);margin-bottom:2px}
.gi-val{font-size:14px;font-weight:600;font-family:var(--m)}.gi-arr{color:var(--mt);font-size:18px;flex-shrink:0}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.sb{background:var(--sf);border-radius:var(--rl);padding:16px 14px;position:relative;overflow:hidden}
.sb::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:3px 3px 0 0}
.cb::after{background:var(--acc)}.cg::after{background:var(--grn)}.cp::after{background:var(--pur)}.co::after{background:var(--org)}
.sl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--mt);margin-bottom:5px}
.sv{font-size:22px;font-weight:800;font-family:var(--m);line-height:1.15;word-break:break-all}
.sv.sm{font-size:15px}.ss{font-size:11px;color:var(--mt);margin-top:3px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
.pg{background:#30d15820;color:var(--grn)}.pr{background:#ff453a20;color:var(--red)}
.pb{background:#0a84ff20;color:var(--acc)}.pm{background:#3a3a3c;color:var(--tx3)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
.dg{background:var(--grn);box-shadow:0 0 0 2px #30d15838}.dr{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}.pulse{animation:pulse 1.7s infinite}
button{font-family:var(--f);cursor:pointer;border:none;transition:opacity .15s,transform .12s;-webkit-user-select:none;user-select:none}
button:active{transform:scale(.96);opacity:.8}
.btn{border-radius:var(--r);padding:14px 20px;font-size:15px;font-weight:600;width:100%;display:block;text-align:center}
.bb{background:var(--acc);color:#fff}.bg2{background:var(--grn);color:#000}.br2{background:var(--red);color:#fff}
.bs{background:var(--sf);color:var(--tx)}.bc{background:var(--card);color:var(--tx)}
.btn-s{border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;width:auto}
input,select{font-family:var(--f);font-size:15px;background:#1c1c1e;border:1.5px solid var(--border);color:var(--tx);border-radius:var(--r);padding:12px 14px;width:100%;outline:none;transition:border .2s;-webkit-appearance:none;appearance:none}
input:focus{border-color:var(--acc)}input::placeholder{color:var(--mt)}
.fl{font-size:13px;font-weight:600;color:var(--tx3);display:block;margin-bottom:6px}.fg{margin-bottom:14px}
.sh{font-size:13px;font-weight:600;color:var(--mt);text-transform:uppercase;letter-spacing:.06em;margin:20px 4px 8px;display:flex;align-items:center;justify-content:space-between}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:460px}
th{padding:10px 12px;color:var(--mt);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid var(--sep);text-align:left;white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--sep);color:var(--tx2);vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#ffffff04}
.ta{color:var(--grn);font-weight:700;font-family:var(--m);white-space:nowrap}
.tr2{font-family:var(--m);font-size:12px;color:var(--mt)}.td2{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al{padding:12px 16px;border-radius:var(--r);margin-bottom:14px;font-size:14px;font-weight:500}
.ao{background:#30d15820;color:var(--grn);border:1px solid #30d15840}.ae{background:#ff453a20;color:var(--red);border:1px solid #ff453a40}
#toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;width:88%;max-width:320px}
.ti2{background:rgba(44,44,46,.96);backdrop-filter:blur(20px);color:var(--tx);border:1px solid var(--border);border-radius:14px;padding:11px 20px;font-size:14px;font-weight:500;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.6);animation:tin .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes tin{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
.mo{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);z-index:500;display:none;align-items:flex-end;justify-content:center}
.mo.show{display:flex}
.ms{background:var(--sf);border-radius:var(--rxl) var(--rxl) 0 0;width:100%;max-width:520px;padding:24px 20px 36px;animation:sUp .28s cubic-bezier(.34,1.2,.64,1)}
@keyframes sUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.mt2{font-size:17px;font-weight:700;text-align:center;margin-bottom:6px}
.msub{font-size:14px;color:var(--tx3);text-align:center;margin-bottom:22px;line-height:1.5}
.mbs{display:flex;flex-direction:column;gap:10px}
.ac{background:var(--sf);border-radius:var(--rl);padding:14px 16px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px}
.ab{flex:1;min-width:0}.an{font-size:15px;font-weight:600;margin-bottom:3px}
.au{font-size:11px;color:var(--mt);font-family:var(--m);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ast{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.aa{display:flex;gap:6px;flex-shrink:0;flex-direction:column;align-items:flex-end}
.pb2{height:3px;background:var(--c2);border-radius:3px;overflow:hidden;margin-top:8px}
.pf{height:100%;border-radius:3px;transition:width .5s}
.empty{text-align:center;padding:44px 20px;color:var(--mt);font-size:14px}
.ei{font-size:36px;margin-bottom:10px}
.lb{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(ellipse at 50% 18%,#0a84ff15,transparent 65%)}
.lc{width:100%;max-width:340px}
.li{font-size:52px;text-align:center;margin-bottom:8px}
.ltit{font-size:26px;font-weight:800;text-align:center;letter-spacing:-.03em;margin-bottom:4px}
.lsub{font-size:14px;color:var(--tx3);text-align:center;margin-bottom:32px}
@media(max-width:400px){.sv{font-size:18px}.sg{gap:8px}}
`;

function loginPage(err=''){
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#000"><title>BankMonitor</title><style>${CSS}</style></head><body>
<div class="lb"><div class="lc">
<div class="li">💳</div>
<div class="ltit">BankMonitor</div>
<div class="lsub">Nhập mật khẩu để tiếp tục</div>
${err?`<div class="al ae" style="margin-bottom:20px">${err}</div>`:''}
<form method="POST" action="/login">
<div class="fg"><label class="fl">Mật khẩu</label><input type="password" name="password" placeholder="••••••••" autofocus style="margin-bottom:14px"></div>
<button type="submit" class="btn bb">Đăng nhập →</button>
</form>
</div></div></body></html>`;
}

function resetModalHtml(){
  return `<div class="mo" id="rm" onclick="hideRM(event)"><div class="ms">
<div class="mt2">🗑️ Reset lịch sử</div>
<div class="msub">Xoá toàn bộ thống kê, seen.json và lịch sử giao dịch.<br>Không thể hoàn tác.</div>
<div class="mbs">
<button class="btn br2" onclick="doAct('reset-stats')">Xác nhận Reset</button>
<button class="btn bs" onclick="hideRM()">Huỷ</button>
</div></div></div>`;
}

function dashboardPage(section='dashboard',msg='',msgType=''){
  const apis=config.apis||[];
  const rc=Object.keys(workers).length;
  const today=stats.daily[todayKey()]||{count:0,amount:0};
  const apiArr=Object.entries(stats.apiStats||{}).sort((a,b)=>b[1].totalReceived-a[1].totalReceived);

  const dashTab=`
<div class="sg">
<div class="sb cb"><div class="sl">Trạng thái</div>
<div style="margin:5px 0"><span class="pill ${botRunning?'pg':'pr'}"><span class="dot ${botRunning?'dg pulse':'dr'}"></span>${botRunning?'Đang chạy':'Đã dừng'}</span></div>
<div class="ss">${rc} worker hoạt động</div></div>
<div class="sb cg"><div class="sl">Tổng giao dịch</div><div class="sv">${stats.totalTransactions.toLocaleString()}</div><div class="ss">Hôm nay: ${today.count}</div></div>
<div class="sb cp" style="grid-column:span 2"><div class="sl">Tổng tiền nhận được</div><div class="sv sm">${fv(stats.totalReceived)}</div>
<div class="ss">Hôm nay: ${fv(today.amount)}${stats.resetAt?' · Reset: '+stats.resetAt:''}</div></div>
</div>

<div class="sh">Thống kê theo API</div>
${apiArr.length===0?'<div class="group"><div class="empty"><div class="ei">📊</div>Chưa có dữ liệu</div></div>':`
<div class="group" style="padding:0"><div class="tw"><table>
<thead><tr><th>API</th><th>Số GD</th><th>Tổng tiền</th><th>Tỷ lệ</th></tr></thead><tbody>
${apiArr.map(([id,s])=>{const pct=stats.totalReceived>0?Math.round((s.totalReceived/stats.totalReceived)*100):0;return`<tr>
<td style="font-weight:600">${esc(s.name)}</td><td class="tr2">${s.totalTransactions}</td>
<td class="ta">${fv(s.totalReceived)}</td>
<td><div style="display:flex;align-items:center;gap:6px"><div style="width:52px;height:4px;background:var(--c2);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--acc)"></div></div><span style="font-size:11px;color:var(--mt)">${pct}%</span></div></td>
</tr>`;}).join('')}
</tbody></table></div></div>`}

<div class="sh">Giao dịch gần đây (20 mới nhất)</div>
${stats.recentTransactions.length===0?'<div class="group"><div class="empty"><div class="ei">📭</div>Chưa có giao dịch nào</div></div>':`
<div class="group" style="padding:0"><div class="tw"><table>
<thead><tr><th>Thời gian</th><th>API</th><th>Số tiền</th><th>Nội dung</th><th>Mã GD</th></tr></thead><tbody>
${stats.recentTransactions.slice(0,20).map(tx=>`<tr>
<td style="white-space:nowrap;font-size:11px;color:var(--mt)">${new Date(tx.time).toLocaleString('vi-VN')}</td>
<td><span class="pill pb" style="font-size:10px">${esc(tx.apiName)}</span></td>
<td class="ta">${fv(tx.amount)}</td><td class="td2">${esc(tx.description)}</td><td class="tr2">${esc(tx.refNo)}</td>
</tr>`).join('')}
</tbody></table></div></div>`}

<div class="sh">Hệ thống</div>
<div class="group">
<div class="gi"><div class="gi-body"><div class="gi-lbl">Kiểm tra lần cuối</div><div class="gi-val">${stats.lastCheckAt||'—'}</div></div></div>
<div class="gi"><div class="gi-body"><div class="gi-lbl">Thành công lần cuối</div><div class="gi-val">${stats.lastSuccessAt||'—'}</div></div></div>
<div class="gi"><div class="gi-body"><div class="gi-lbl">Chu kỳ kiểm tra</div><div class="gi-val">${config.checkIntervalMs}ms</div></div></div>
<div class="gi"><div class="gi-body"><div class="gi-lbl">Hàng đợi Telegram</div><div class="gi-val">${telegramQueue.length} tin</div></div></div>
</div>

<div class="sh">Điều khiển</div>
<div class="group">
<div class="gi" style="cursor:pointer" onclick="doAct('start')"><div class="gi-icon" style="background:#30d15820">▶️</div><div class="gi-body"><div style="font-weight:600">Bật tất cả worker</div><div style="font-size:12px;color:var(--mt)">Bắt đầu giám sát tất cả API</div></div><div class="gi-arr">›</div></div>
<div class="gi" style="cursor:pointer" onclick="doAct('stop')"><div class="gi-icon" style="background:#ff453a20">⏹️</div><div class="gi-body"><div style="font-weight:600">Dừng tất cả worker</div><div style="font-size:12px;color:var(--mt)">Tạm dừng giám sát</div></div><div class="gi-arr">›</div></div>
<div class="gi" style="cursor:pointer" onclick="doAct('restart')"><div class="gi-icon" style="background:#0a84ff20">🔄</div><div class="gi-body"><div style="font-weight:600">Khởi động lại</div><div style="font-size:12px;color:var(--mt)">Restart tất cả worker</div></div><div class="gi-arr">›</div></div>
<div class="gi" style="cursor:pointer" onclick="doAct('test-telegram')"><div class="gi-icon" style="background:#bf5af220">📤</div><div class="gi-body"><div style="font-weight:600">Test Telegram</div><div style="font-size:12px;color:var(--mt)">Gửi tin nhắn thử nghiệm</div></div><div class="gi-arr">›</div></div>
<div class="gi" style="cursor:pointer" onclick="showRM()"><div class="gi-icon" style="background:#ff9f0a20">🗑️</div><div class="gi-body"><div style="font-weight:600;color:var(--org)">Reset lịch sử</div><div style="font-size:12px;color:var(--mt)">Xoá toàn bộ thống kê & seen.json</div></div><div class="gi-arr" style="color:var(--org)">›</div></div>
</div>
${resetModalHtml()}`;

  const apisTab=`
<div class="sh">Thêm API mới</div>
<div class="group" style="padding:16px">
<form method="POST" action="/api/add">
<div class="fg"><label class="fl">Tên API</label><input name="name" placeholder="VD: MB Bank Cá nhân" required></div>
<div class="fg"><label class="fl">URL API</label><input name="apiUrl" placeholder="https://..." required></div>
<button type="submit" class="btn bb">+ Thêm API</button>
</form></div>

<div class="sh">Danh sách API (${apis.length})</div>
${apis.length===0?'<div class="group"><div class="empty"><div class="ei">🔌</div>Chưa có API nào</div></div>':
apis.map(api=>{
  const astat=(stats.apiStats||{})[api.id]||{totalReceived:0,totalTransactions:0};
  const pct=Math.min(100,Math.round((astat.totalReceived/(stats.totalReceived||1))*100));
  return `<div class="ac">
<div style="padding-top:4px"><span class="dot ${api.enabled?'dg':'dr'}" style="width:10px;height:10px"></span></div>
<div class="ab"><div class="an">${esc(api.name)}</div><div class="au">${esc(api.url)}</div>
<div class="ast">
<span class="pill pg" style="font-size:11px">💰 ${fv(astat.totalReceived)}</span>
<span class="pill pb" style="font-size:11px">🔢 ${astat.totalTransactions} GD</span>
<span class="pill ${api.enabled?'pg':'pm'}" style="font-size:11px">${api.enabled?'● ON':'○ OFF'}</span>
</div>
<div class="pb2"><div class="pf" style="width:${pct}%;background:${api.enabled?'var(--grn)':'var(--mt)'}"></div></div>
</div>
<div class="aa">
<form method="POST" action="/api/toggle" style="margin:0"><input type="hidden" name="id" value="${api.id}"><button type="submit" class="btn-s ${api.enabled?'bc':'bg2'}" style="min-width:58px">${api.enabled?'Tắt':'Bật'}</button></form>
<form method="POST" action="/api/delete" style="margin:0" onsubmit="return confirm('Xoá API ${esc(api.name)}?')"><input type="hidden" name="id" value="${api.id}"><button type="submit" class="btn-s br2" style="min-width:58px">Xoá</button></form>
</div></div>`;}).join('')}

<div class="sh">Thống kê chi tiết</div>
${apiArr.length===0?'<div class="group"><div class="empty"><div class="ei">📊</div>Chưa có dữ liệu</div></div>':`
<div class="group" style="padding:0"><div class="tw"><table>
<thead><tr><th>Tên API</th><th>Số GD</th><th>Tổng tiền</th><th>Tỷ lệ</th></tr></thead><tbody>
${apiArr.map(([id,s])=>{const pct=stats.totalReceived>0?Math.round((s.totalReceived/stats.totalReceived)*100):0;return`<tr>
<td style="font-weight:600">${esc(s.name)}</td><td class="tr2">${s.totalTransactions}</td><td class="ta">${fv(s.totalReceived)}</td>
<td><div style="display:flex;align-items:center;gap:6px"><div style="width:50px;height:3px;background:var(--c2);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--acc)"></div></div><span style="font-size:11px;color:var(--mt)">${pct}%</span></div></td>
</tr>`;}).join('')}
</tbody></table></div></div>`}`;

  const settingsTab=`
<div class="sh">Telegram Bot</div>
<div class="group" style="padding:16px">
<form method="POST" action="/settings/save">
<div class="fg"><label class="fl">Bot Token</label><input name="botToken" value="${esc(config.botToken||'')}" placeholder="123456789:ABC..."></div>
<div class="fg"><label class="fl">Chat ID</label><input name="chatId" value="${esc(config.chatId||'')}" placeholder="-100..."></div>
<div style="height:1px;background:var(--sep);margin:14px 0"></div>
<div class="fg"><label class="fl">Chu kỳ kiểm tra (ms)</label><input name="checkIntervalMs" type="number" value="${config.checkIntervalMs}" min="5000"></div>
<div class="fg"><label class="fl">Độ trễ gửi tin (ms)</label><input name="sendDelayMs" type="number" value="${config.sendDelayMs}" min="500"></div>
<div class="fg"><label class="fl">Số lần retry tối đa</label><input name="retryMax" type="number" value="${config.retryMax}" min="0" max="10"></div>
<div class="fg"><label class="fl">Retry base delay (ms)</label><input name="retryBaseDelayMs" type="number" value="${config.retryBaseDelayMs}" min="500"></div>
<div style="height:1px;background:var(--sep);margin:14px 0"></div>
<div class="fg"><label class="fl">Mật khẩu mới (rỗng = giữ nguyên)</label><input name="adminPassword" type="password" placeholder="••••••••"></div>
<button type="submit" class="btn bb">Lưu cài đặt</button>
</form></div>
<div class="sh">Vùng nguy hiểm</div>
<div class="group">
<div class="gi" style="cursor:pointer" onclick="showRM()">
<div class="gi-icon" style="background:#ff9f0a20">🗑️</div>
<div class="gi-body"><div style="font-weight:600;color:var(--org)">Reset toàn bộ lịch sử</div><div style="font-size:12px;color:var(--mt)">Xoá stats, seen.json, giao dịch gần đây</div></div>
<div class="gi-arr" style="color:var(--org)">›</div>
</div></div>
${resetModalHtml()}`;

  const tabs=[
    {id:'dashboard',label:'📊 Tổng quan',href:'/'},
    {id:'apis',label:'🔗 APIs',href:'/apis'},
    {id:'settings',label:'⚙️ Cài đặt',href:'/settings'}
  ];

  return `<!DOCTYPE html><html lang="vi"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#000000"><title>BankMonitor</title><style>${CSS}</style></head><body>
<div class="topbar"><div class="ti"><span class="brand">Bank<span>Monitor</span></span><a href="/logout" class="tout">Đăng xuất</a></div></div>
<div class="tabs-wrap"><div class="nav-tabs">
${tabs.map(t=>`<button class="nav-tab${section===t.id?' on':''}" onclick="location.href='${t.href}'">${t.label}</button>`).join('')}
</div></div>
<div class="main">
${msg?`<div class="al ${msgType==='error'?'ae':'ao'}" style="margin-top:12px">${esc(msg)}</div>`:''}
${section==='dashboard'?dashTab:''}${section==='apis'?apisTab:''}${section==='settings'?settingsTab:''}
</div>
<div id="toast"></div>
<script>
function doAct(a){
  if(a==='reset-stats')hideRM();
  fetch('/action/'+a,{method:'POST'}).then(r=>r.json())
    .then(d=>{showToast(d.message||'OK');setTimeout(()=>location.reload(),900);})
    .catch(()=>showToast('Lỗi kết nối','e'));
}
function showToast(m,t){
  var el=document.createElement('div');el.className='ti2';
  el.style.borderColor=t==='e'?'var(--red)':'var(--grn)';
  el.textContent=m;document.getElementById('toast').appendChild(el);
  setTimeout(()=>el.remove(),3000);
}
function showRM(){var m=document.getElementById('rm');if(m){m.classList.add('show');document.body.style.overflow='hidden';}}
function hideRM(e){if(e&&e.target&&e.target.id!=='rm')return;var m=document.getElementById('rm');if(m){m.classList.remove('show');document.body.style.overflow='';}}
</script></body></html>`;
}

const server=http.createServer(async(req,res)=>{
  const p=url.parse(req.url,true);
  const pathname=p.pathname;
  const method=req.method;
  const cookies=parseCookies(req.headers.cookie);
  const authed=isValidSession(cookies.sid);
  try{
    if(pathname==='/login'){
      if(method==='GET')return sendHtml(res,loginPage());
      if(method==='POST'){
        const b=await parseBody(req);
        if(b.password===config.adminPassword){const sid=createSession();return redir(res,'/',`sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);}
        return sendHtml(res,loginPage('Mật khẩu không đúng'),401);
      }
    }
    if(pathname==='/logout'){if(cookies.sid)delete sessions[cookies.sid];return redir(res,'/login','sid=; Path=/; Max-Age=0');}
    if(!authed)return redir(res,'/login');
    if(pathname==='/')return sendHtml(res,dashboardPage('dashboard'));
    if(pathname==='/apis')return sendHtml(res,dashboardPage('apis'));
    if(pathname==='/settings')return sendHtml(res,dashboardPage('settings'));
    if(pathname==='/api/add'&&method==='POST'){
      const b=await parseBody(req);
      if(!b.name||!b.apiUrl)return redir(res,'/apis');
      const newApi={id:crypto.randomBytes(8).toString('hex'),name:b.name.trim(),url:b.apiUrl.trim(),enabled:true};
      config.apis=config.apis||[];config.apis.push(newApi);saveConfig(config);startWorker(newApi);
      return redir(res,'/apis');
    }
    if(pathname==='/api/toggle'&&method==='POST'){
      const b=await parseBody(req);
      const api=(config.apis||[]).find(a=>a.id===b.id);
      if(api){api.enabled=!api.enabled;saveConfig(config);if(api.enabled)startWorker(api);else stopWorker(api.id);}
      return redir(res,'/apis');
    }
    if(pathname==='/api/delete'&&method==='POST'){
      const b=await parseBody(req);stopWorker(b.id);
      if(stats.apiStats&&stats.apiStats[b.id])delete stats.apiStats[b.id];
      config.apis=(config.apis||[]).filter(a=>a.id!==b.id);saveConfig(config);saveStats();
      return redir(res,'/apis');
    }
    if(pathname==='/settings/save'&&method==='POST'){
      const b=await parseBody(req);
      if(b.adminPassword&&b.adminPassword.trim())config.adminPassword=b.adminPassword.trim();
      config.botToken=(b.botToken||'').trim();config.chatId=(b.chatId||'').trim();
      config.checkIntervalMs=Math.max(5000,parseInt(b.checkIntervalMs)||15000);
      config.sendDelayMs=Math.max(500,parseInt(b.sendDelayMs)||1500);
      config.retryMax=Math.min(10,Math.max(0,parseInt(b.retryMax)||3));
      config.retryBaseDelayMs=Math.max(500,parseInt(b.retryBaseDelayMs)||2000);
      saveConfig(config);restartAllWorkers();return redir(res,'/settings');
    }
    if(pathname.startsWith('/action/')&&method==='POST'){
      const action=pathname.slice('/action/'.length);
      if(action==='start'){startAllWorkers();return sendJson(res,{message:'Đã bật tất cả worker'});}
      if(action==='stop'){stopAllWorkers();return sendJson(res,{message:'Đã dừng tất cả worker'});}
      if(action==='restart'){restartAllWorkers();return sendJson(res,{message:'Đã restart worker'});}
      if(action==='reset-stats'){resetAllStats();return sendJson(res,{message:'Đã reset toàn bộ lịch sử ✓'});}
      if(action==='test-telegram'){
        enqueueTG(`🧪 <b>Test từ BankMonitor</b>\n⏰ ${new Date().toLocaleString('vi-VN')}\n✅ Kết nối Telegram hoạt động tốt!`);
        return sendJson(res,{message:'Đã gửi tin test vào queue'});
      }
      return sendJson(res,{error:'Unknown action'},400);
    }
    sendHtml(res,'<html><body style="background:#000;color:#636366;font-family:system-ui;padding:40px;text-align:center"><div style="font-size:48px;margin-bottom:12px">🌐</div><div style="font-size:20px;color:#fff;margin-bottom:12px">404</div><a href="/" style="color:#0a84ff">← Về trang chủ</a></body></html>',404);
  }catch(err){
    console.error('[Server]',err);
    sendHtml(res,`<html><body style="background:#000;color:#ff453a;font-family:monospace;padding:32px"><h2>500</h2><pre>${esc(err.message)}</pre></body></html>`,500);
  }
});

server.listen(3000,()=>{
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      💳  BankMonitor Admin Panel         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  URL    : http://localhost:3000           ║');
  console.log(`║  APIs   : ${String((config.apis||[]).length).padEnd(31)}║`);
  console.log('║  Mode   : No-resend on restart ✓         ║');
  console.log('║  Stats  : Persistent (stats.json) ✓      ║');
  console.log('╚══════════════════════════════════════════╝\n');
  startAllWorkers();
});
server.on('error',err=>{console.error('[Fatal]',err.message);process.exit(1);});
process.on('uncaughtException',err=>console.error('[Uncaught]',err.message));
process.on('unhandledRejection',r=>console.error('[Rejection]',r));
