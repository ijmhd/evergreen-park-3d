import { CATALOG, UPGRADE_COST_MULTIPLIERS } from './catalog.js?v=5';

/**
 * 浏览器与 Node 共用的经营模型；所有时间/队长/收入均来自实际模拟。
 * time 为 09:00–21:00 的游戏分钟，1x 下 1200 真实秒 = 一营业日。
 * qNormal/qFast 为人数。visitors.phase: walking | queue | riding | leaving。
 * subscribe(fn) 的 fn(state, { type, message }) 可在变更后更新 UI。
 */
const KEY = 'evergreen-park-save-v1';
const DAY_START = 9 * 60;
const DAY_MINUTES = 12 * 60;
const GAME_MINUTES_PER_SECOND = DAY_MINUTES / 1200;
const ENTRANCE = { x: 0, z: 98 };
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const finite = (v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;
const names = ['小林','圆圆','阿乐','小满','安安','星星','小周','悠悠','乐乐','米粒','浩浩','晓雨','可可','冬冬','小白','豆豆'];

function freshState() {
  const plots=[];
  for(let row=0;row<6;row++) for(let col=0;col<10;col++) plots.push({x:(col-4.5)*24,z:(row-2.5)*26});
  plots.sort((a,b)=>(a.x*a.x+a.z*a.z)-(b.x*b.x+b.z*b.z)||a.z-b.z||a.x-b.x);
  return {
    version:1,economyVersion:2,money:10000,day:1,time:DAY_START,elapsed:0,ticketPrice:25,fastPrice:18,speed:1,paused:false,opened:false,
    facilities:CATALOG.map((c,i)=>({...c,...plots[i],restored:false,open:false,special:false,specialPrice:15,
      upgrades:Object.fromEntries(c.branches.map(b=>[b.id,0])),good:0,bad:0,reviews:[],dailyStats:[],qNormal:0,qFast:0,
      revenue:0,spentUpgrade:0,restorationPaid:0,runningUntil:0,riderIds:[],pendingReset:false,totalRiders:0})),
    visitors:[],totalVisitors:0,dayVisitors:0,dayIncome:0,dayExpense:0,totalIncome:0,totalExpense:0,reputation:74,
    events:[{day:1,text:'你已买下整座旧游乐园。用余下的 ¥10,000 翻修喜欢的设施，慢慢经营吧。',type:'info'}],
    history:[],nextVisitorId:1,arrivalProgress:0,reviewClock:0,
    totalInvestment:0,playSeconds:0,unlockedIds:CATALOG.map(f=>f.id),unlockedUpgradeLevel:5,
  };
}

export class ParkGame {
  constructor({load=true}={}) {
    this._listeners=new Set(); this._saveClock=0; this._notifyClock=0; this._statCache=new Map();
    this.state=freshState();
    if(load) this._load();
    this._refreshUnlocks(true);
    this._rebuildQueues();
  }
  subscribe(fn) { this._listeners.add(fn); return ()=>this._listeners.delete(fn); }
  _emit(type='tick',message='') { for(const fn of this._listeners) { try { fn(this.state,{type,message}); } catch(error) { console.error('Park subscriber:',error); } } }
  _event(text,type='info') { this.state.events.unshift({day:this.state.day,text,type}); this.state.events.length=Math.min(this.state.events.length,45); }
  _result(ok,message,type='change') { if(ok) {this._refreshUnlocks();this._statCache.clear();this.save();this._emit(type,message);} return {ok,message}; }
  getFacility(id) { return this.state.facilities.find(f=>f.id===id); }
  _active() { return this.state.facilities.filter(f=>f.restored&&f.open&&!f.pendingReset); }
  _credit(amount) { this.state.money+=amount;this.state.dayIncome+=amount;this.state.totalIncome+=amount; }
  _debit(amount) { this.state.money-=amount;this.state.dayExpense+=amount;this.state.totalExpense+=amount; }
  _invest(amount) {this._debit(amount);this.state.totalInvestment+=amount;}
  _refreshUnlocks() {
    const s=this.state;s.unlockedIds=s.facilities.map(f=>f.id);s.unlockedUpgradeLevel=5;
  }
  unlockStatus(id) {
    this._refreshUnlocks();const f=this.getFacility(id);
    if(!f) return {unlocked:false,description:'找不到这座设施。'};
    return {unlocked:true,description:'园区已归你所有，资金足够即可翻修。'};
  }
  upgradeUnlockStatus(id,branchId) {
    this._refreshUnlocks();const f=this.getFacility(id),b=f?.branches.find(b=>b.id===branchId);
    if(!f||!b) return {unlocked:false,description:'找不到这条升级路线。'};
    return {unlocked:true,description:''};
  }
  progression() {
    this._refreshUnlocks();const s=this.state,restoredCount=s.facilities.filter(f=>f.restored).length;
    const upgradeLevels=s.facilities.reduce((sum,f)=>sum+Object.values(f.upgrades).reduce((a,b)=>a+b,0),0);
    const totalUpgradeLevels=s.facilities.reduce((sum,f)=>sum+f.branches.reduce((a,b)=>a+b.max,0),0);
    const maxedCount=s.facilities.filter(f=>f.restored&&f.branches.every(b=>f.upgrades[b.id]>=b.max)).length;
    return {unlockedCount:s.unlockedIds.length,restoredCount,maxedCount,totalFacilities:s.facilities.length,
      upgradeLevels,totalUpgradeLevels,completionRate:(restoredCount*5+upgradeLevels)/(s.facilities.length*5+totalUpgradeLevels)*100,
      playSeconds:s.playSeconds,completed:maxedCount===s.facilities.length,nextUnlock:null};
  }

  facilityStats(id) {
    const f=typeof id==='object'?id:this.getFacility(id); if(!f) return null;
    const sums={capacity:0,appeal:0,speed:0,comfort:0,normalQueue:0,fastQueue:0,efficiency:0};
    for(const b of f.branches) sums[b.kind]=(sums[b.kind]||0)+(f.upgrades[b.id]||0);
    const totalLevel=Object.values(f.upgrades).reduce((s,v)=>s+v,0);
    // 排队通道绝不进入 capacity 的公式。
    const capacity=Math.max(1,Math.round(f.baseCapacity*(1+sums.capacity*.23)));
    const appeal=Math.round(f.baseAppeal*(1+sums.appeal*.18+sums.capacity*.025+sums.comfort*.035));
    const cycle=Math.max(2.5,f.cycle/(1+sums.speed*.115));
    const normalSpace=8+sums.normalQueue*10;
    const fastSpace=3+sums.fastQueue*6;
    const both=f.qNormal>0&&f.qFast>0;
    const normalSeats=both?Math.max(1,Math.ceil(capacity*.35)):capacity;
    const fastSeats=both?Math.max(1,capacity-normalSeats):capacity;
    const remain=Math.max(0,f.runningUntil-this.state.elapsed);
    const normalWait=f.qNormal?remain+Math.max(0,Math.ceil(f.qNormal/normalSeats)-1)*cycle:0;
    const fastWait=f.qFast?remain+Math.max(0,Math.ceil(f.qFast/fastSeats)-1)*cycle:0;
    const maintenanceBaseCost=f.maintenanceBaseCost??f.restoreCost;
    const costPerDay=Math.round((maintenanceBaseCost*.025+totalLevel*maintenanceBaseCost*.0018)*Math.max(.45,1-sums.efficiency*.09));
    const good=f.good,bad=f.bad;
    return {capacity,appeal,cycle,normalSpace,fastSpace,normalWait,fastWait,costPerDay,totalLevel,
      comfort:sums.comfort,efficiency:sums.efficiency,good,bad,positiveRate:good+bad?good/(good+bad)*100:0,
      negativeRate:good+bad?bad/(good+bad)*100:0,reviewCount:good+bad,
      queueNormal:f.qNormal,queueFast:f.qFast,riding:f.riderIds.length,
      normalCrowding:f.qNormal/normalSpace,fastCrowding:f.qFast/fastSpace,
      throughput:capacity/cycle*DAY_MINUTES,
      totalRiders:f.totalRiders,revenue:f.revenue,refund:Math.floor(f.spentUpgrade*.5),
      fairSpecialPrice:Math.round(9+appeal*.45),
    };
  }
  parkStats() {
    let good=0,bad=0,capacity=0,expense=0;
    for(const f of this.state.facilities) { good+=f.good;bad+=f.bad;if(f.restored&&f.open&&!f.pendingReset) {const t=this.facilityStats(f);capacity+=t.capacity;expense+=t.costPerDay;} }
    return {good,bad,positiveRate:good+bad?good/(good+bad)*100:0,negativeRate:good+bad?bad/(good+bad)*100:0,
      openedCount:this._active().length,restoredCount:this.state.facilities.filter(f=>f.restored).length,
      visitors:this.state.visitors.filter(v=>v.phase!=='leaving').length,income:this.state.dayIncome,
      expense:this.state.dayExpense,capacity,operatingCost:expense,reviewCount:good+bad};
  }
  reviewStats(id,period='all') {
    const facilities=id?[this.getFacility(id)].filter(Boolean):this.state.facilities;
    let good=0,bad=0;
    const firstDay=period==='today'?this.state.day:this.state.day-6;
    for(const f of facilities) {
      if(period==='all') {good+=f.good;bad+=f.bad;}
      else for(const d of f.dailyStats) if(d.day>=firstDay) {good+=d.good;bad+=d.bad;}
    }
    return {good,bad,positiveRate:good+bad?good/(good+bad)*100:0,negativeRate:good+bad?bad/(good+bad)*100:0};
  }
  demandForecast() {
    const active=this._active(); let appeal=0,normalAppeal=0,normalCount=0,specialCount=0;
    for(const f of active) {const a=this.facilityStats(f).appeal;if(f.special) {appeal+=a*Math.exp(-f.specialPrice/(12+a*.7))*.78;specialCount++;} else {appeal+=a;normalAppeal+=a;normalCount++;}}
    const fairPrice=Math.min(140,Math.round(16+Math.sqrt(normalAppeal)*3+normalCount*.55+specialCount*.15));
    const priceFactor=clamp(Math.exp((fairPrice-this.state.ticketPrice)/Math.max(18,fairPrice*.85)),.015,1.7);
    const reputationFactor=.4+this.state.reputation/100*.75;
    const market=Math.min(1200,35+12*Math.pow(appeal,.58)+active.length*2.5);
    const arrivalsPerDay=active.length?Math.round(Math.min(1800,market*priceFactor*reputationFactor)):0;
    // 便宜时几乎人人买，昂贵时接近无人购买；实际仍须在入园时逐人购买。
    const fastPurchaseRate=1/(1+Math.pow(this.state.fastPrice/21,2.3));
    return {arrivalsPerDay,visitorsPerMinute:arrivalsPerDay/DAY_MINUTES,fairPrice,priceFactor,appeal,fastPurchaseRate,
      recommendedTicket:Math.round(fairPrice*.85),marketLimit:1800};
  }

  restore(id) {
    const f=this.getFacility(id); if(!f) return this._result(false,'找不到这座设施。');
    if(f.restored) return this._result(false,'这座设施已经完成翻修。');
    if(this.state.money<f.restoreCost) return this._result(false,'资金不足，先用现有设施赚取收入吧。');
    this._invest(f.restoreCost);f.restorationPaid=f.restoreCost;f.restored=true;f.open=true;f.pendingReset=false;f.runningUntil=0;f.riderIds=[];
    this._event(`${f.name}翻修完成，重新亮起了灯！`,'build');
    return this._result(true,`${f.name}已翻修，可以开始接待游客。`,'restore');
  }
  upgradeCost(id,branchId) {
    const f=this.getFacility(id),b=f?.branches.find(b=>b.id===branchId); if(!f||!b) return 0;
    const level=f.upgrades[branchId]||0; return level>=b.max?0:Math.round(b.baseCost*UPGRADE_COST_MULTIPLIERS[level]/10)*10;
  }
  upgrade(id,branchId) {
    const f=this.getFacility(id),b=f?.branches.find(b=>b.id===branchId);
    if(!f||!b) return this._result(false,'找不到这条升级路线。');
    if(!f.restored) return this._result(false,'需要先翻修这座设施。');
    if(f.pendingReset) return this._result(false,'设施正在等待重置。');
    if(f.upgrades[branchId]>=b.max) return this._result(false,'这条路线已经升到最高等级。');
    const cost=this.upgradeCost(id,branchId);if(this.state.money<cost) return this._result(false,'升级资金不足。');
    this._invest(cost);f.spentUpgrade+=cost;f.upgrades[branchId]++;
    this._event(`${f.name} · ${b.label}升至 Lv.${f.upgrades[branchId]}`,'upgrade');
    return this._result(true,`${b.label}已升至 Lv.${f.upgrades[branchId]}。`,'upgrade');
  }
  reset(id) {
    const f=this.getFacility(id);if(!f) return this._result(false,'找不到这座设施。');
    if(!f.restored) return this._result(false,'设施已经处于废弃状态，没有可返还的升级。');
    if(f.pendingReset) return this._result(false,'正在等待本轮游客安全离场。');
    f.open=false;this._evacuateQueue(f,false);
    if(f.riderIds.length) {f.pendingReset=true;return this._result(true,'停止接待新游客；本轮游客离场后自动重置并退款。','reset-pending');}
    const refund=this._completeReset(f);return this._result(true,`${f.name}已重置，返还升级费用 ¥${refund.toLocaleString()}。`,'reset');
  }
  _completeReset(f) {
    const refund=Math.floor(f.spentUpgrade*.5);
    if(refund) this._credit(refund);
    f.spentUpgrade=0;f.upgrades=Object.fromEntries(f.branches.map(b=>[b.id,0]));
    f.restored=false;f.restorationPaid=0;f.open=false;f.pendingReset=false;f.qNormal=0;f.qFast=0;f.riderIds=[];f.runningUntil=0;
    this._event(`${f.name}回到废弃状态，返还 ¥${refund} 升级费。历史评价保留。`,'reset');
    return refund;
  }
  setPrices(ticket,fast) {
    if(!Number.isFinite(Number(ticket))||!Number.isFinite(Number(fast))) return this._result(false,'请输入有效的价格。');
    this.state.ticketPrice=clamp(Math.round(Number(ticket)),0,500);this.state.fastPrice=clamp(Math.round(Number(fast)),0,300);
    return this._result(true,'新票价已生效，已入园游客不补差价。','prices');
  }
  setSpecial(id,bool,price) {
    const f=this.getFacility(id);if(!f) return this._result(false,'找不到这座设施。');
    if(f.pendingReset) return this._result(false,'重置期间不能更改收费。');
    if(price!==undefined&&!Number.isFinite(Number(price))) return this._result(false,'请输入有效的项目价格。');
    f.special=!!bool;if(price!==undefined) f.specialPrice=clamp(Math.round(Number(price)),0,300);
    return this._result(true,f.special?`${f.name}成为特殊项目，新加入队列的游客按 ¥${f.specialPrice} 购票。`:`${f.name}已包含在门票内。`,'special');
  }
  toggleFacility(id) {
    const f=this.getFacility(id);if(!f?.restored) return this._result(false,'请先翻修设施。');
    if(f.pendingReset) return this._result(false,'设施正在等待重置。');
    f.open=!f.open;if(!f.open) this._evacuateQueue(f,false);
    return this._result(true,f.open?`${f.name}恢复营业。`:`${f.name}暂停营业，正在体验的游客会完成本轮。`,'facility');
  }
  togglePark() {
    if(!this.state.opened&&!this._active().length) return this._result(false,'先翻修并开放至少一座设施，再打开园区大门。');
    this.state.opened=!this.state.opened;
    this._event(this.state.opened?'大门打开了，欢迎来到常青游乐园！':'园区暂停入园，园内游客仍可完成游玩。');
    return this._result(true,this.state.opened?'园区已开门，游客正在陆续到来。':'园区已停止入园。','park');
  }
  setSpeed(speed) { this.state.speed=[.5,1,2].includes(Number(speed))?Number(speed):1;return this._result(true,`经营速度 ×${this.state.speed}`,'speed'); }
  togglePause() {this.state.paused=!this.state.paused;return this._result(true,this.state.paused?'时间已暂停。':'经营继续。','pause');}

  tick(realDtSeconds) {
    const dt=clamp(finite(realDtSeconds),0,15); if(!dt||this.state.paused) return;
    if(![.5,1,2].includes(this.state.speed)) this.state.speed=1;
    if(this.state.opened&&this._active().length) this.state.playSeconds+=dt;
    let remaining=dt*(this.state.speed||1);
    // 固定小步防止浏览器掉帧导致游客越过队列或重复结算。
    while(remaining>.00001) {const step=Math.min(.25,remaining);this._step(step);remaining-=step;}
    this._saveClock+=dt;this._notifyClock+=dt;
    if(this._saveClock>=8) {this.save();this._saveClock=0;}
    if(this._notifyClock>=.2) {this._emit();this._notifyClock=0;}
  }
  _step(seconds) {
    const minutes=seconds*GAME_MINUTES_PER_SECOND,s=this.state;
    s.elapsed+=minutes;s.time+=minutes;
    if(s.time>=DAY_START+DAY_MINUTES-1e-8) {s.time=Math.max(DAY_START,s.time-DAY_MINUTES);this._newDay();}
    const active=this._active();
    // 只要设施开放就有待机维护费；暂停单个项目可省下该项费用。
    for(const f of active) this._debit(this.facilityStats(f).costPerDay*minutes/DAY_MINUTES);
    if(s.opened&&active.length) {
      const forecast=this.demandForecast();s.arrivalProgress+=forecast.visitorsPerMinute*minutes;
      while(s.arrivalProgress>=1&&s.visitors.length<720) {s.arrivalProgress--;this._spawn(forecast);}
      s.arrivalProgress=Math.min(s.arrivalProgress,2);
    }
    for(const v of s.visitors) {
      if(v.phase==='walking'||v.phase==='leaving') this._move(v,seconds*2.8);
      else if(v.phase==='queue') {
        const f=this.getFacility(v.targetId);
        if(!f?.restored||!f.open||f.pendingReset) {this._chooseDestination(v);continue;}
        const stats=this.facilityStats(f),size=v.fast?f.qFast:f.qNormal,space=v.fast?stats.fastSpace:stats.normalSpace;
        if(size>space) v.crowdMinutes+=minutes;
        if(s.elapsed-v.queueSince>Math.max(90,stats.cycle*4)+v.patience) {
          this._review(f,v,false,v.fast?'特快通道也等了太久，没能坐上。':'排队太久，最后还是放弃了。',['waiting',...(v.fast?['fast']:[])]);
          this._chooseDestination(v);
        }
      }
    }
    s.visitors=s.visitors.filter(v=>!v.departed);
    this._rebuildQueues();
    for(const f of s.facilities) this._runFacility(f);
    s.reviewClock+=minutes;
    if(s.reviewClock>=12) {this._updateReputation();s.reviewClock=0;}
  }
  _newDay() {
    const s=this.state;
    s.history.push({day:s.day,income:s.dayIncome,expense:s.dayExpense,visitors:s.dayVisitors,reputation:s.reputation});
    if(s.history.length>30) s.history.shift();
    s.day++;s.dayIncome=0;s.dayExpense=0;s.dayVisitors=0;
    this._event(`第 ${s.day} 天开始了。继续修复园区，让新的故事发生。`,'day');
  }
  _spawn(forecast) {
    const s=this.state,fast=Math.random()<forecast.fastPurchaseRate;
    const v={id:s.nextVisitorId++,name:names[Math.floor(Math.random()*names.length)],
      x:ENTRANCE.x+(Math.random()-.5)*2,z:ENTRANCE.z,fast,phase:'walking',targetId:null,
      route:[],routeIndex:0,visited:[],visits:0,maxVisits:2+Math.floor(Math.random()*3),
      budget:30+Math.random()*100,patience:Math.random()*25,queueSince:0,crowdMinutes:0,
      ticketPaid:s.ticketPrice,fastPaid:fast?s.fastPrice:0,fairTicket:forecast.fairPrice,
      color:['#f5b74f','#e38279','#6d9cb7','#b0b47b','#b59ac5'][Math.floor(Math.random()*5)],
      born:s.elapsed,departed:false,feeQuote:0,rideUntil:0};
    s.visitors.push(v);s.totalVisitors++;s.dayVisitors++;this._credit(s.ticketPrice+(fast?s.fastPrice:0));
    this._refreshUnlocks();
    this._chooseDestination(v);
  }
  _chooseDestination(v) {
    const active=this._active().filter(f=>!v.visited.includes(f.id));
    if(!active.length||v.visits>=v.maxVisits||this.state.elapsed-v.born>210) {this._leave(v);return;}
    const weighted=active.map(f=>{const st=this.facilityStats(f);return {f,weight:st.appeal*Math.exp(-(f.special?f.specialPrice:0)/(14+st.appeal*.55))/(1+(v.fast?st.fastWait:st.normalWait)/22)};});
    const affordable=weighted.filter(({f})=>!f.special||f.specialPrice<=v.budget);
    if(!affordable.length) {
      const f=weighted[0]?.f;
      if(f&&v.visits===0) this._review(f,v,false,'买了门票后还要额外付费，能玩的项目太少。',['specialPrice','variety']);
      this._leave(v);return;
    }
    let pick=Math.random()*affordable.reduce((sum,a)=>sum+a.weight,0),target=affordable[0].f;
    for(const a of affordable) {pick-=a.weight;if(pick<=0) {target=a.f;break;}}
    v.targetId=target.id;v.phase='walking';v.queueSince=0;v.crowdMinutes=0;
    this._route(v,{x:target.x,z:target.z+10});
  }
  _route(v,dest) {
    // 每条地块入口横路接入 x=0 的中央纵路，游客不穿过建筑。
    const route=[];
    if(Math.abs(v.x)>1) {
      const roads=[-55,-29,-3,23,49,75];
      const roadZ=v.z>86?v.z:roads.reduce((a,b)=>Math.abs(a-v.z)<Math.abs(b-v.z)?a:b);
      if(Math.abs(v.z-roadZ)>.05) route.push({x:v.x,z:roadZ});
      route.push({x:0,z:roadZ});
    }
    route.push({x:0,z:dest.z},{x:dest.x,z:dest.z});
    v.route=route;v.routeIndex=0;
  }
  _leave(v) {v.phase='leaving';v.targetId=null;this._route(v,ENTRANCE);}
  _move(v,distance) {
    while(distance>0&&v.routeIndex<v.route.length) {
      const p=v.route[v.routeIndex],dx=p.x-v.x,dz=p.z-v.z,d=Math.hypot(dx,dz);
      if(d<=distance+.0001) {v.x=p.x;v.z=p.z;distance-=d;v.routeIndex++;} else {v.x+=dx/d*distance;v.z+=dz/d*distance;distance=0;}
    }
    if(v.routeIndex>=v.route.length) {
      if(v.phase==='leaving') {v.departed=true;return;}
      const f=this.getFacility(v.targetId);
      if(!f?.restored||!f.open||f.pendingReset) {this._chooseDestination(v);return;}
      v.phase='queue';v.queueSince=this.state.elapsed;v.crowdMinutes=0;
      // 入队时锁定费用；排队过程中改价不向游客追收。
      v.feeQuote=f.special?f.specialPrice:0;
    }
  }
  _rebuildQueues() {
    for(const f of this.state.facilities) {f.qNormal=0;f.qFast=0;f.riderIds=[];}
    for(const v of this.state.visitors) {
      const f=this.getFacility(v.targetId);if(!f) continue;
      if(v.phase==='queue') {if(v.fast) f.qFast++;else f.qNormal++;}
      else if(v.phase==='riding') f.riderIds.push(v.id);
    }
    const indices=new Map();
    for(const v of this.state.visitors) {
      if(v.phase!=='queue') continue;
      const f=this.getFacility(v.targetId);if(!f) continue;
      const key=f.id+(v.fast?':fast':':normal'),i=indices.get(key)||0;
      indices.set(key,i+1);
      const columns=v.fast?3:6,total=v.fast?f.qFast:f.qNormal,rows=Math.max(3,Math.ceil(total/columns));
      const col=i%columns,row=Math.floor(i/columns);
      v.x=f.x+(v.fast?5.6:-5.2)+(col-(columns-1)/2)*.9;
      v.z=f.z+4.7+row*Math.min(.75,4.6/rows);
    }
  }
  _runFacility(f) {
    if(f.riderIds.length&&this.state.elapsed>=f.runningUntil) {
      for(const id of [...f.riderIds]) {const v=this.state.visitors.find(v=>v.id===id);if(!v) continue;
        f.totalRiders++;v.visits++;v.visited.push(f.id);this._experienceReview(f,v);this._chooseDestination(v);
      }
      f.riderIds=[];f.runningUntil=0;
      if(f.pendingReset) {this._completeReset(f);this.save();this._emit('reset','游客已离场，设施重置完成。');return;}
    }
    if(!f.restored||!f.open||f.pendingReset||f.riderIds.length) return;
    const stats=this.facilityStats(f),waiting=this.state.visitors.filter(v=>v.targetId===f.id&&v.phase==='queue').sort((a,b)=>a.queueSince-b.queueSince||a.id-b.id);
    if(!waiting.length) return;
    const normal=waiting.filter(v=>!v.fast),fast=waiting.filter(v=>v.fast);
    const reserve=normal.length&&fast.length?Math.max(1,Math.ceil(stats.capacity*.35)):0;
    const selected=[...normal.splice(0,reserve),...fast.splice(0,stats.capacity-reserve)];
    selected.push(...normal.splice(0,stats.capacity-selected.length));
    selected.push(...fast.splice(0,stats.capacity-selected.length));
    for(const v of selected) {
      if(v.feeQuote>v.budget) {this._review(f,v,false,'额外项目收费超过预算，没能体验。',['specialPrice']);this._chooseDestination(v);continue;}
      if(v.feeQuote>0) {v.budget-=v.feeQuote;f.revenue+=v.feeQuote;this._credit(v.feeQuote);}
      v.phase='riding';v.waited=this.state.elapsed-v.queueSince;v.boardNormalWait=stats.normalWait;
      v.rideUntil=this.state.elapsed+stats.cycle;f.riderIds.push(v.id);
    }
    if(f.riderIds.length) f.runningUntil=this.state.elapsed+stats.cycle;
    f.qNormal=this.state.visitors.filter(v=>v.targetId===f.id&&v.phase==='queue'&&!v.fast).length;
    f.qFast=this.state.visitors.filter(v=>v.targetId===f.id&&v.phase==='queue'&&v.fast).length;
  }
  _evacuateQueue(f,complain=false) {
    for(const v of this.state.visitors) if(v.targetId===f.id&&(v.phase==='queue'||v.phase==='walking')) {
      if(complain&&v.phase==='queue') this._review(f,v,false,'设施临时停止营业，只好换个项目。',['closed']);
      this._chooseDestination(v);
    }
    f.qNormal=0;f.qFast=0;
  }
  _experienceReview(f,v) {
    const stats=this.facilityStats(f),tags=[];
    let positiveChance=.9+stats.comfort*.025+stats.totalLevel*.004;
    const priceRatio=v.ticketPaid/Math.max(1,v.fairTicket);
    if(priceRatio>1.25) {positiveChance-=Math.min(.65,(priceRatio-1.25)*.5);tags.push('price');}
    if(v.feeQuote>stats.fairSpecialPrice*1.3) {positiveChance-=Math.min(.5,(v.feeQuote/stats.fairSpecialPrice-1.3)*.3);tags.push('specialPrice');}
    const comfortableWait=Math.max(24,stats.cycle*1.4);
    if(v.waited>comfortableWait) {positiveChance-=Math.min(.6,(v.waited-comfortableWait)/(stats.cycle*3+35));tags.push('waiting');}
    if(v.crowdMinutes>7) {positiveChance-=Math.min(.4,v.crowdMinutes/80);tags.push('crowded');}
    if(v.fast&&v.fastPaid>0&&v.waited>stats.cycle*1.75&&v.waited>v.boardNormalWait*.9) {positiveChance-=.28;tags.push('fast');}
    if(stats.totalLevel===0&&this.state.day>3&&priceRatio>1.05) {positiveChance-=.12;tags.push('quality');}
    if(this._active().length<3) {positiveChance-=.05;tags.push('variety');}
    const positive=Math.random()<clamp(positiveChance,.06,.98);
    let text;
    if(positive) {
      const messages=[`${f.name}很好玩，下次还想来！`,'老园区重新有活力了，值得来看看。'];
      if(v.waited<stats.cycle*1.2) messages.push('排队流动很顺畅，很快就玩到了。');
      if(priceRatio<.9) messages.push('门票价格很实惠，今天玩得很值！');
      if(stats.comfort>0) messages.push('升级后的设施坐起来舒服多了。');
      if(v.fast&&v.fastPaid>0&&v.waited<stats.cycle*1.2) messages.push('特快通道很方便，省下不少时间。');
      if(stats.totalLevel>=8) messages.push('设施翻新得很用心，体验越来越好了。');
      text=messages[Math.floor(Math.random()*messages.length)];
      this._review(f,v,true,text,[v.waited<stats.cycle*1.2?'smooth':'fun',...(priceRatio<.9?['value']:[])]);
    } else {
      const reasons={price:'门票偏贵，园内体验还没有达到这个价格。',specialPrice:'买完门票还要另外付费，这个项目收费有点高。',waiting:'项目排队太久，希望增加每轮接待人数。',crowded:v.fast?'特快排队通道太拥挤了，希望扩充通道。':'普通排队通道太拥挤了，希望扩充通道。',fast:'买了特快通道，等待仍然太久。',quality:'设施的基础体验比较旧，期待继续升级。',variety:'开放的游玩项目太少了，还没玩尽兴。'};
      const reason=tags.length?tags[Math.floor(Math.random()*tags.length)]:'comfort';
      text=reasons[reason]||'体验还可以再舒服一点，希望改善座椅和设备。';
      this._review(f,v,false,text,tags.length?tags:['comfort']);
    }
  }
  _review(f,v,positive,text,tags=[]) {
    if(positive) f.good++;else f.bad++;
    let daily=f.dailyStats.find(d=>d.day===this.state.day);
    if(!daily) {daily={day:this.state.day,good:0,bad:0};f.dailyStats.push(daily);}
    if(positive) daily.good++;else daily.bad++;
    f.dailyStats=f.dailyStats.filter(d=>d.day>=this.state.day-13);
    f.reviews.unshift({positive,text,day:this.state.day,name:v.name,tags:[...new Set(tags)]});
    if(f.reviews.length>60) f.reviews.length=60;
  }
  _updateReputation() {
    let positive=0,total=0;
    for(const f of this.state.facilities) for(const d of f.dailyStats) {
      const age=this.state.day-d.day;if(age>6) continue;
      const weight=Math.exp(-age/3);total+=(d.good+d.bad)*weight;positive+=d.good*weight;
    }
    // 少量先验避免第一条差评毁掉园区；旧评价逐渐失去权重，改进能修复口碑。
    const target=(positive+7.4)/(total+10)*100;
    this.state.reputation=clamp(this.state.reputation*.95+target*.05,5,100);
  }
  save() {
    try {if(typeof localStorage==='undefined') return false;localStorage.setItem(KEY,JSON.stringify(this.state));return true;} catch {return false;}
  }
  _validSave(raw) {
    if(!raw||typeof raw!=='object'||raw.version!==1||!Array.isArray(raw.facilities)||raw.facilities.length!==CATALOG.length) return false;
    if(!Number.isFinite(raw.money)||!Number.isFinite(raw.totalVisitors)||raw.totalVisitors<0||!Number.isFinite(raw.day)||raw.day<1) return false;
    const ids=new Set();
    for(const f of raw.facilities) {
      const original=CATALOG.find(c=>c.id===f?.id);
      if(!original||ids.has(f.id)||typeof f.restored!=='boolean'||!f.upgrades||typeof f.upgrades!=='object') return false;
      ids.add(f.id);
      for(const b of original.branches) {
        const level=f.upgrades[b.id];if(!Number.isInteger(level)||level<0||level>b.max) return false;
      }
      for(const key of ['good','bad','spentUpgrade']) if(!Number.isFinite(f[key])||f[key]<0) return false;
    }
    return true;
  }
  importSave(jsonOrObject) {
    let raw;
    try {raw=typeof jsonOrObject==='string'?JSON.parse(jsonOrObject):jsonOrObject;} catch {return {ok:false,message:'存档不是有效的 JSON，当前进度未改变。'};}
    if(!this._validSave(raw)) return {ok:false,message:'存档内容不完整或数值无效，当前进度未改变。'};
    const previous=this.state,current=JSON.stringify(previous);let previousBackup=null,backupWritten=false;
    try {
      if(typeof localStorage==='undefined') return {ok:false,message:'浏览器存档不可用，无法先备份原进度；当前游戏未改变。'};
      previousBackup=localStorage.getItem(KEY+'-backup');
      localStorage.setItem(KEY+'-backup',current);backupWritten=true;
      if(!this._load(raw)) throw new Error('Invalid imported save');
      localStorage.setItem(KEY,JSON.stringify(this.state));
      this._memoryBackup=current;this._statCache.clear();
    } catch {
      this.state=previous;this._rebuildQueues();
      if(backupWritten) try {
        if(previousBackup!==null) localStorage.setItem(KEY+'-backup',previousBackup);
        else if(typeof localStorage.removeItem==='function') localStorage.removeItem(KEY+'-backup');
      } catch { /* 当前存档与内存仍保留，忽略无法回滚的备份写入。 */ }
      return {ok:false,message:'无法安全备份并导入这份存档，当前游戏未改变。'};
    }
    const message='存档已导入，原进度已自动备份，可以恢复。';this._emit('import',message);
    return {ok:true,message};
  }
  startNewGame() {
    const old=this.state,backup=JSON.stringify(old);
    try {
      if(typeof localStorage==='undefined') return {ok:false,message:'浏览器存档不可用，无法安全备份；当前游戏未改变。'};
      localStorage.setItem(KEY+'-backup',backup);
      this._memoryBackup=backup;this.state=freshState();
      localStorage.setItem(KEY,JSON.stringify(this.state));
    } catch {this.state=old;return {ok:false,message:'浏览器无法保存旧进度备份，当前游戏未改变。'};}
    this._saveClock=0;this._notifyClock=0;this._rebuildQueues();
    return this._result(true,'¥10,000 的慢速新经营已开始。原进度已备份，可以恢复。','new-game');
  }
  restoreBackup() {
    let backup;
    try {
      if(typeof localStorage==='undefined') return {ok:false,message:'浏览器存档不可用，无法安全恢复；当前游戏未改变。'};
      backup=localStorage.getItem(KEY+'-backup');
    } catch {return {ok:false,message:'浏览器无法读取备份，当前游戏未改变。'};}
    if(!backup) return {ok:false,message:'还没有可恢复的旧进度备份。'};
    let raw;try {raw=JSON.parse(backup);} catch {return {ok:false,message:'备份内容损坏，当前进度未改变。'};}
    if(!this._validSave(raw)) return {ok:false,message:'备份内容不完整，当前进度未改变。'};
    const old=this.state,current=JSON.stringify(old);
    if(!this._load(raw)) return {ok:false,message:'备份读取失败，当前进度未改变。'};
    try {
      if(typeof localStorage!=='undefined') {localStorage.setItem(KEY+'-backup',current);localStorage.setItem(KEY,JSON.stringify(this.state));}
      this._memoryBackup=current;
    } catch {
      this.state=old;this._rebuildQueues();
      try {if(typeof localStorage!=='undefined') localStorage.setItem(KEY+'-backup',backup);} catch { /* 保留当前会话。 */ }
      return {ok:false,message:'浏览器无法保存恢复结果，当前游戏未改变。'};
    }
    return this._result(true,'备份进度已恢复；刚才的进度已交换到备份，可再次切换。','restore-backup');
  }
  _load(override) {
    const previous=this.state;
    try {
      if(override===undefined&&typeof localStorage==='undefined') return false;
      const raw=override===undefined?JSON.parse(localStorage.getItem(KEY)||'null'):override;
      if(!this._validSave(raw)) return false;
      const s=freshState();this.state=s;
      for(const key of ['money','ticketPrice','fastPrice','dayIncome','dayExpense','totalIncome','totalExpense','totalVisitors','dayVisitors','elapsed','nextVisitorId','arrivalProgress','reviewClock']) if(Number.isFinite(raw[key])) s[key]=raw[key];
      s.ticketPrice=clamp(s.ticketPrice,0,500);s.fastPrice=clamp(s.fastPrice,0,300);
      s.day=Math.max(1,Math.floor(finite(raw.day,1)));s.time=clamp(finite(raw.time,DAY_START),DAY_START,DAY_START+DAY_MINUTES-.001);
      s.reputation=clamp(finite(raw.reputation,74),5,100);s.speed=[.5,1,2].includes(raw.speed)?raw.speed:1;
      s.paused=!!raw.paused;s.opened=!!raw.opened;
      for(const f of s.facilities) {
        const saved=raw.facilities.find(p=>p.id===f.id);if(!saved) continue;
        for(const key of ['restored','open','special','pendingReset']) f[key]=!!saved[key];
        if(!f.restored) {f.open=false;f.pendingReset=false;}
        f.restorationPaid=f.restored?Math.max(0,finite(saved.restorationPaid,finite(saved.restoreCost,f.maintenanceBaseCost))):0;
        for(const b of f.branches) f.upgrades[b.id]=f.restored?clamp(Math.floor(finite(saved.upgrades?.[b.id])),0,b.max):0;
        for(const key of ['good','bad','revenue','totalRiders','spentUpgrade','runningUntil']) f[key]=Math.max(0,finite(saved[key]));
        if(!f.restored) f.spentUpgrade=0;
        f.specialPrice=clamp(finite(saved.specialPrice,15),0,300);
        f.reviews=Array.isArray(saved.reviews)?saved.reviews.filter(r=>typeof r.text==='string'&&typeof r.positive==='boolean').slice(0,60).map(r=>({positive:r.positive,text:r.text.slice(0,300),day:clamp(Math.floor(finite(r.day,1)),1,s.day),name:typeof r.name==='string'?r.name.slice(0,25):'游客',tags:Array.isArray(r.tags)?r.tags.filter(t=>typeof t==='string').slice(0,8):[]})):[];
        f.dailyStats=Array.isArray(saved.dailyStats)?saved.dailyStats.filter(d=>Number.isFinite(d.day)&&d.day>=s.day-13&&d.day<=s.day).map(d=>({day:Math.floor(d.day),good:Math.max(0,Math.floor(finite(d.good))),bad:Math.max(0,Math.floor(finite(d.bad)))})):[];
      }
      const phases=['walking','queue','riding','leaving'];
      s.visitors=Array.isArray(raw.visitors)?raw.visitors.filter(v=>Number.isFinite(v.x)&&Number.isFinite(v.z)&&phases.includes(v.phase)&&(v.targetId===null||s.facilities.some(f=>f.id===v.targetId))).slice(0,720).map(v=>({...v,
        x:clamp(v.x,-200,200),z:clamp(v.z,-120,120),visited:Array.isArray(v.visited)?v.visited:[],
        route:Array.isArray(v.route)?v.route.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.z)):[],
        routeIndex:Math.max(0,Math.floor(finite(v.routeIndex))),budget:Math.max(0,finite(v.budget,50)),
        queueSince:finite(v.queueSince,s.elapsed),crowdMinutes:Math.max(0,finite(v.crowdMinutes)),
        patience:finite(v.patience,15),visits:Math.max(0,finite(v.visits)),maxVisits:clamp(finite(v.maxVisits,3),1,4),
        born:finite(v.born,s.elapsed),feeQuote:Math.max(0,finite(v.feeQuote)),fast:!!v.fast,departed:false,
      })):[];
      s.nextVisitorId=Math.max(s.nextVisitorId,...s.visitors.map(v=>finite(v.id)+1),1);
      s.events=Array.isArray(raw.events)?raw.events.filter(e=>typeof e.text==='string'&&!/(?:翻修|升级)许可/.test(e.text)).slice(0,45):s.events;
      s.history=Array.isArray(raw.history)?raw.history.slice(-30):[];
      const retainedInvestment=s.facilities.reduce((sum,f)=>sum+(f.restored?f.restorationPaid+f.spentUpgrade:0),0);
      s.totalInvestment=Number.isFinite(raw.totalInvestment)&&raw.totalInvestment>=0?raw.totalInvestment:retainedInvestment;
      s.playSeconds=Math.max(0,finite(raw.playSeconds,raw.economyVersion===2?0:Math.max(0,s.elapsed)/4));
      s.unlockedIds=s.facilities.map(f=>f.id);
      s.unlockedUpgradeLevel=5;
      this._refreshUnlocks(true);this._rebuildQueues();
      if(raw.economyVersion!==2) this._event('原存档资金、设施和评价全部保留。经营已切换为慢速节奏，原4倍速调整为常速。','migration');
      return true;
    } catch {this.state=previous;return false;}
  }
}
