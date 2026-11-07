import { ParkGame } from './engine.js?v=5';
import { ParkScene } from './scene.js?v=6';
import { createSlowUI } from './slow-ui.js?v=5';
import { patchMarkup, ReviewSnapshot } from './stable-dom.js?v=3';
import { ScrollCoordinator } from './scroll-coordinator.js?v=6';

const $ = (q) => document.querySelector(q);
const money = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN');
const number = (n) => Math.round(Number(n) || 0).toLocaleString('zh-CN');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = (n) => (Number(n) || 0).toFixed(1) + '%';
const tagNames={waiting:'等待时间过长',crowded:'排队通道拥挤',fast:'特快通道优势不足',price:'门票偏贵',specialPrice:'项目额外收费偏贵',quality:'设施等级偏低',variety:'开放项目太少',comfort:'舒适度不足',closed:'设施暂停营业',smooth:'排队顺畅',fun:'项目有趣',value:'价格实惠'};
const icons = {carousel:'♞',ferris:'◎',coaster:'〰',train:'▰',teacups:'☕',boat:'⛵',mine:'◆',tower:'↟',pirate:'⚓',pendulum:'◒',swings:'✺',zipline:'↗',water:'≈',slide:'〰',river:'≈',pool:'≋',surf:'≋',cs:'⚑',laser:'⌖',shooter:'⌖',kart:'⚑',haunted:'♜',maze:'▦',ropes:'⌘',climbing:'△',playground:'♧',vr:'◉',cinema:'▷',theater:'✦',fountain:'♒',bumper:'▰',trampoline:'↥',golf:'⚑',bowling:'●',rink:'❄',ski:'❄',windtunnel:'↟',pedal:'♧',waterball:'◉',digger:'⚒',blocks:'▦',science:'⚛',football:'⚽',skate:'〰',rc:'⚑',dance:'♫',cable:'▣',spin:'⊕',simulator:'✈',dinosaur:'♜',ar:'⌖',career:'⌂',music:'♫',harbor:'⚓'};
let game, scene, slowUI, selected = null, detailTab = 'upgrade', sideTab = 'facilities', category = '全部', onlyOpen = false, reviewPeriod = 'all', toastTimer, dirty = true, lastRender = 0, lastSave = 0;
const scrollUpdates = new ScrollCoordinator({quietMs:500});
let hoverLabel='',saveStatus='自动保存在当前浏览器',hideToastPending=false,autoCommits=0,explicitCommits=0;
const setText=(node,value)=>{const text=String(value);if(node.textContent!==text)node.textContent=text;};
const setValue=(node,value)=>{const text=String(value);if(node.value!==text)node.value=text;};
const setAttribute=(node,name,value)=>{const text=String(value);if(node.getAttribute(name)!==text)node.setAttribute(name,text);};
const setStyle=(node,name,value)=>{if(node.style[name]!==value)node.style[name]=value;};
const toggleClass=(node,name,on)=>{if(node.classList.contains(name)!==on)node.classList.toggle(name,on);};
function flushDecorations(){setText($('#aim-label'),hoverLabel);if(hideToastPending){$('#toast').classList.remove('show');hideToastPending=false;}}
function trackScrollActivity(){
 const inUI=target=>target?.closest?.('.ui, #modal');
 const activity=event=>{if(inUI(event.target)){scrollUpdates.activity();scrollUpdates.markPending();}};
 document.addEventListener('wheel',activity,{capture:true,passive:true});
 document.addEventListener('scroll',activity,{capture:true,passive:true});
 document.addEventListener('pointerdown',event=>{if(inUI(event.target))scrollUpdates.beginInteraction(event.pointerId);},{capture:true,passive:true});
 const release=event=>scrollUpdates.finishPointer(event.pointerId);
 window.addEventListener('pointerup',release,{capture:true,passive:true});
 window.addEventListener('pointercancel',release,{capture:true,passive:true});
 window.addEventListener('blur',()=>scrollUpdates.reset());
 document.addEventListener('visibilitychange',()=>{scrollUpdates.reset();scrollUpdates.markPending();});
}

const detailReviewSnapshot=new ReviewSnapshot(),parkReviewSnapshot=new ReviewSnapshot();
function reviewRefreshButton(target,view){return `<button class="review-refresh" data-refresh-reviews="${target}" ${view.pending?'':'disabled'}>${view.pending?(view.newCount?`有 ${number(view.newCount)} 条新评价 · 点击更新`:'评价有更新 · 点击查看'):'已显示当前评价 · 新留言会先提示'}</button>`;}

function toast(text) { setText($('#toast'),text);hideToastPending=false;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{hideToastPending=true;scrollUpdates.markPending();},3200); }
function act(result, success) { if (result?.ok === false) toast(result.message || '操作未完成'); else toast(success || result?.message || '已完成'); dirty = true; render(); }
function modal(html) { scene?.unlock(); $('#modal-content').innerHTML = html; $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function reviewsFor(f) { const list = f.reviews || []; if (reviewPeriod === 'all') return list; const from = reviewPeriod === 'today' ? game.state.day : game.state.day - 6; return list.filter(r => r.day >= from); }
function counts(f) { if(game.reviewStats)return game.reviewStats(f.id,reviewPeriod); if (reviewPeriod === 'all') return {good:f.good || 0, bad:f.bad || 0}; const from=reviewPeriod==='today'?game.state.day:game.state.day-6;if(f.dailyStats){return f.dailyStats.filter(d=>d.day>=from).reduce((a,d)=>({good:a.good+d.good,bad:a.bad+d.bad}),{good:0,bad:0});}const list=reviewsFor(f); return {good:list.filter(r=>r.positive).length,bad:list.filter(r=>!r.positive).length}; }
function reviewBar(good, bad) { const total = good + bad, rate = total ? good / total * 100 : 0; return `<div class="review-summary"><div class="review-top"><span>游客好评率</span><strong>${total ? percent(rate) : '—'}</strong></div><div class="review-bar" role="img" aria-label="好评${good}条，差评${bad}条"><span class="good" style="width:${rate}%"></span><span class="bad" style="width:${total ? 100-rate : 0}%"></span></div><div class="review-legend"><span class="good">● 好评 ${number(good)} · ${total ? percent(rate) : '—'}</span><span class="bad">● 差评 ${number(bad)} · ${total ? percent(100-rate) : '—'}</span></div></div>`; }
function periodSelect(){return `<select class="review-select" aria-label="评价时间范围" data-review-period><option value="all" ${reviewPeriod==='all'?'selected':''}>全部历史评价</option><option value="today" ${reviewPeriod==='today'?'selected':''}>今日评价</option><option value="week" ${reviewPeriod==='week'?'selected':''}>最近7个游戏日</option></select>`;}
function renderTop() {
 const s = game.state, totals = game.parkStats();
 setText($('#money'),money(s.money));patchMarkup($('#visitor-count'),`${number(s.visitors?.length)} <small>人</small>`);
 const total = (totals.good || 0) + (totals.bad || 0);setText($('#rating'),total ? percent(totals.good / total * 100) : '暂无评价');
 setText($('#day'),`第 ${s.day} 天`);
 const minute = Math.floor(Number(s.time) || 540);
 setText($('#clock'),`${String(Math.floor(minute / 60) % 24).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`);
 setText($('#pause'),s.paused ? '▶' : 'Ⅱ');setAttribute($('#pause'),'title',s.paused ? '继续' : '暂停');
 document.querySelectorAll('[data-speed]').forEach(b => toggleClass(b,'active',Number(b.dataset.speed)===s.speed));
 setText($('#park-status'),s.opened ? '正在营业' : '暂未营业');toggleClass($('#park-status'),'open',s.opened);
 patchMarkup($('#toggle-park'),s.opened ? '暂停接待新游客 <span>Ⅱ</span>' : '开园迎客 <span>↗</span>');
 if (!['ticket','ticket-number','fast','fast-number'].includes(document.activeElement.id)) { for(const id of ['ticket','ticket-number'])setValue($('#'+id),s.ticketPrice);for(const id of ['fast','fast-number'])setValue($('#'+id),s.fastPrice); }
 const open = s.facilities.filter(f=>f.restored&&f.open).length;
 setText($('#forecast'),open ? `${open} 项已开放 · 预计日客流 ${number(game.demandForecast().arrivalsPerDay)} 人 · 门票参考 ${money(game.demandForecast().recommendedTicket)} · 特快购买意向 ${percent(game.demandForecast().fastPurchaseRate*100)}` : '翻修至少一处设施，再打开园门接待游客。');
 setStyle($('.scene-caption'),'display',s.totalVisitors > 0 ? 'none' : '');
 const cam=scene?.inspectState();if(cam){const [x,y,z]=cam.position;const d=Math.hypot(x,z);const side=Math.abs(x)>Math.abs(z)?(x<0?'西':'东'):(z<0?'北':'南');const dirs=['北','东北','东','东南','南','西南','西','西北'];const heading=dirs[((Math.round(-cam.yaw/(Math.PI/4))%8)+8)%8];const location=$('#camera-location');setText(location,(d<2?'园区中心':`中心以${side} ${Math.round(d)}米`)+` · 朝${heading}`);for(const [name,value]of Object.entries({x,y,z,yaw:cam.yaw,pitch:cam.pitch}))setAttribute(location,'data-'+name,value);}
 const progress=game.progression?.();if(progress){setText($('#progress-number'),percent(progress.completionRate));setStyle($('#progress-fill'),'width',progress.completionRate+'%');setText($('#progress-caption'),`已翻修 ${progress.restoredCount}/60 · 满级 ${progress.maxedCount}/60`);}
 setText($('#save-status'),saveStatus);
}
function renderList() {
 const query = $('#search').value.trim().toLowerCase();
 const facilities = game.state.facilities.filter(f=>(category==='全部'||f.category===category)&&(!onlyOpen||f.restored)&&(!query||f.name.toLowerCase().includes(query)));
 setText($('#list-count'),`${facilities.length} 处固定设施`);
 patchMarkup($('#facility-list'), facilities.length ? facilities.map(f=>{
 const total=(f.good||0)+(f.bad||0), rate=total?percent(f.good/total*100):'暂无评价';
 return `<button class="facility-row ${f.restored?'':'closed'} ${selected===f.id?'selected':''}" data-select="${esc(f.id)}"><span class="facility-thumb" style="color:${esc(f.color || '#617956')}">${icons[f.model]||'♧'}</span><span><span class="facility-name">${esc(f.name)}</span><span class="facility-sub">${f.restored?(f.open?'营业中':'已暂停'):'等待翻修'} · ${f.branches?.length || 0}条升级路线</span></span><span class="row-tail">${f.restored?rate:money(f.restoreCost)}<small>${f.restored?`排队 ${number((f.qNormal||0)+(f.qFast||0))} 人`:'翻修费用'}</small></span></button>`;
 }).join('') : '<div class="empty-search">没有找到符合条件的设施。<br>试试其他名称或分类。</div>');
}
function renderParkReviews() {
 let good=0,bad=0; const ranked = game.state.facilities.map(f=>{const c=counts(f);good+=c.good;bad+=c.bad;return {f,...c};}).filter(v=>v.good+v.bad>0).sort((a,b)=>b.bad-a.bad);
 const view=parkReviewSnapshot.read({scope:game.state,key:'park:'+reviewPeriod,count:good+bad,revision:(reviewPeriod==='all'?'':game.state.day+':')+good+':'+bad},()=>`<div class="park-summary" data-key="park:${reviewPeriod}">${reviewBar(good,bad)}<p class="micro">先累加各项目好评、差评数量，再计算全园比例。同一游客体验多个项目时，各项目分别记评。</p><div class="complaint-title">项目评价 · 按差评数量排列</div>${ranked.length?ranked.map(v=>`<button class="rank-row" data-select="${esc(v.f.id)}"><span>${esc(v.f.name)}<br><small>好评 ${v.good} · 差评 ${v.bad}</small></span><span>${percent(v.good/(v.good+v.bad)*100)} ↗</span></button>`).join(''):'<p class="review-empty">这里还很安静。<br>游客完成体验后，会留下真实的项目评价。</p>'}</div>`);
 patchMarkup($('#park-reviews'),`<div class="park-review-tools" data-key="park-tools">${periodSelect()}${reviewRefreshButton('park',view)}</div>${view.html}`);
}
function selectFacility(id, focus=false) { const f=game.getFacility(id); if(!f)return; detailReviewSnapshot.refresh();selected=id;detailTab='upgrade';scene?.unlock();if(focus)scene?.focus(id);dirty=true;render();if($('.detail-content'))$('.detail-content').scrollTop=0; }
function renderDetail() {
 const panel=$('#detail'), f=selected?game.getFacility(selected):null; if(!f){if(!panel.hidden)panel.hidden=true;return;} if(panel.hidden)panel.hidden=false;
 if(panel.contains(document.activeElement)&&document.activeElement.matches('input,select'))return;
 const st=game.facilityStats(f.id) || {}; const branches=f.branches||[];
 let content='',detailReviewUpdate='';
 if(!f.restored) {
 content=`<div class="restore-card"><div class="restore-icon" style="color:${esc(f.color)}">${icons[f.model]||'♧'}</div><h3>等待重新亮起的那一天</h3><p>你已买下这座园区，设备和场地都属于你。<br>资金足够，就能直接翻修这处设施。</p><div class="restore-cost"><small>基础翻修费用</small>${money(f.restoreCost)}</div><button class="primary full" data-action="restore" ${game.state.money<f.restoreCost?'disabled':''}>翻修并开放 <span>↗</span></button><div class="branch-preview"><strong>翻修后可自由升级 ${branches.length} 条路线</strong><br>${branches.map(b=>esc(b.label)).join(' · ')}</div></div>`;
 } else if(detailTab==='upgrade') {
 const cycle=Number(st.cycle)||60;
 content=`<div class="stat-grid"><div class="small-stat"><span>每轮接待人数</span><strong>${number(st.capacity)} <small>人</small></strong></div><div class="small-stat"><span>普通 / 特快排队</span><strong>${number(f.qNormal)} <small>/</small> ${number(f.qFast)}</strong></div><div class="small-stat"><span>普通排队区容量</span><strong>${number(st.normalSpace)} <small>人</small></strong></div><div class="small-stat"><span>特快排队区容量</span><strong>${number(st.fastSpace)} <small>人</small></strong></div></div><p class="micro">预计等待：普通 ${number(st.normalWait)} / 特快 ${number(st.fastWait)} 游戏分钟。<br>首次翻修只启用部分座位，容量路线可继续恢复接待量。<br>通道改善拥挤，座位数量与周转速度决定队伍消化速度。</p>${branches.map(b=>{const lv=Number(f.upgrades[b.id])||0,max=b.max||5,cost=game.upgradeCost(f.id,b.id);return `<div class="branch-card"><div class="branch-top"><span class="branch-title">${esc(b.label)}</span><span class="branch-level">Lv.${lv} / ${max}</span></div><p class="branch-description">${esc(b.description)}</p><div class="branch-bottom"><div class="level-blocks">${Array.from({length:max},(_,i)=>`<i class="${i<lv?'filled':''}"></i>`).join('')}</div><button class="upgrade-button" data-upgrade="${esc(b.id)}" ${lv>=max||game.state.money<cost?'disabled':''}>${lv>=max?'已满级':`升级 ${money(cost)}`}</button></div></div>`;}).join('')}<div class="reset-area"><p>重置后回到0级废弃状态，返还本轮升级支出的50%，需要重新付费翻修。历史评价保留。</p><button class="danger-button" data-action="reset" ${f.pendingReset?'disabled':''}>${f.pendingReset?'等待本轮游客离场…':`重置 · 返还 ${money((f.spentUpgrade||0)*.5)}`}</button></div>`;
 } else if(detailTab==='pricing') {
 content=`<div class="switch-row"><span>开放该项目</span><input type="checkbox" id="facility-open" ${f.open?'checked':''}></div><div class="switch-row"><span>设为特殊项目 · 单独收费</span><input type="checkbox" id="special" ${f.special?'checked':''}></div><p class="pricing-note">普通项目包含在门票内。特殊项目需要额外付费，特快通行证不免除这笔费用。额外收费过多会降低门票的性价比。</p><label class="pricing-label" for="special-price">每次体验价格（金币）</label><input id="special-price" class="pricing-field" type="number" min="0" max="300" value="${Number(f.specialPrice ?? 15)}"><button class="primary full" style="margin-top:15px" data-action="special">保存项目收费设置 <span>✓</span></button><div class="stat-grid" style="margin-top:25px"><div class="small-stat"><span>项目累计额外收入</span><strong>${money(f.revenue)}</strong></div><div class="small-stat"><span>累计升级投入</span><strong>${money(f.spentUpgrade)}</strong></div></div>`;
 } else {
 const c=counts(f), list=[...reviewsFor(f)]; const reasons={};for(const r of list.filter(r=>!r.positive))for(const tag of (r.tags||[]))reasons[tag]=(reasons[tag]||0)+1;
 content=`${periodSelect()}${reviewBar(c.good,c.bad)}${Object.keys(reasons).length?`<div class="complaint-title">最常见的投诉原因</div>${Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([tag,n])=>`<div class="complaint-row"><span>${esc(tagNames[tag]||tag)}</span><span>${n} 次提及</span></div>`).join('')}<p class="micro">同一条差评可以提及多个问题，差评数量只计一次。</p>`:''}<div class="complaint-title">游客留言</div>${list.length?list.slice(0,60).map(r=>`<article class="review-card ${r.positive?'positive':''}"><header><span>${esc(r.name||'游客')} · ${r.positive?'好评':'差评'}</span><span>第 ${r.day} 天</span></header><p>${esc(r.text)}</p>${(r.tags||[]).map(t=>`<span class="tag">${esc(tagNames[t]||t)}</span>`).join('')}</article>`).join(''):'<p class="review-empty">暂时没有评价，等待游客完成体验。</p>'}`;
 }
 if(f.restored&&detailTab==='reviews'){const c=counts(f);const view=detailReviewSnapshot.read({scope:game.state,key:f.id+':'+reviewPeriod,count:c.good+c.bad,revision:(reviewPeriod==='all'?'':game.state.day+':')+c.good+':'+c.bad},()=>content);content=view.html;detailReviewUpdate=reviewRefreshButton('detail',view);}
 patchMarkup(panel,`<div class="detail-head"><button class="detail-close" title="关闭设施面板">×</button><div class="detail-category">${esc(f.category)} / 固定设施</div><h2>${esc(f.name)}</h2><div class="detail-meta"><span class="badge ${f.restored&&f.open?'open':''}">${f.restored?(f.open?'正在营业':'暂停营业'):'0级 · 尚未翻修'}</span><span>${f.restored?(f.special?'特殊项目 · 另收费':'包含在门票内'):'原址翻修'}</span></div></div>${f.restored?`<div class="detail-tabs"><button data-detail-tab="upgrade" class="${detailTab==='upgrade'?'active':''}">升级路线</button><button data-detail-tab="pricing" class="${detailTab==='pricing'?'active':''}">营业与收费</button><button data-detail-tab="reviews" class="${detailTab==='reviews'?'active':''}">游客评价</button></div>`:''}${detailReviewUpdate}<div class="detail-content" data-key="${esc(f.id)}:${f.restored}:${detailTab}${detailTab==='reviews'?':'+reviewPeriod:''}">${content}</div>`);
}
function render(automatic=false){if(!game)return;renderTop();renderList();if(sideTab==='reviews')renderParkReviews();renderDetail();dirty=false;if(automatic)autoCommits++;else explicitCommits++;}

function help(){slowUI.help();}

async function init(){
 game=new ParkGame();
 trackScrollActivity();
 scene=new ParkScene({canvas:$('#world'),game,onSelect:id=>selectFacility(id,false),onHover:id=>{hoverLabel=id?(game.getFacility(id)?.name||''):'';if(!scrollUpdates.shouldDefer())setText($('#aim-label'),hoverLabel);else scrollUpdates.markPending();},onLockChange:locked=>toggleClass(document.body,'locked',locked)});
 slowUI=createSlowUI({game,scene,toast,act,modal,closeModal,clearSelection:()=>{selected=null;}});
 window.parkGame=game;window.parkScene=scene;window.parkUIRenderAudit=()=>({autoCommits,explicitCommits,deferred:scrollUpdates.shouldDefer(),pending:scrollUpdates.pending,quietMs:500});window.addEventListener('park-control-fallback',e=>toast(e.detail?.message||'当前浏览器限制了锁定鼠标，可按住右键转向，或用桌面Chrome打开。'));
 const categories=['全部',...new Set(game.state.facilities.map(f=>f.category))];$('#category-filters').innerHTML=categories.map(c=>`<button data-category="${esc(c)}" class="${c==='全部'?'active':''}">${esc(c)}</button>`).join('');
 game.subscribe(()=>{dirty=true;});
 $('#category-filters').onclick=e=>{const b=e.target.closest('[data-category]');if(!b)return;category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(v=>v.classList.toggle('active',v===b));renderList();};
 $('#search').oninput=renderList;$('#only-open').onclick=()=>{onlyOpen=!onlyOpen;$('#only-open').classList.toggle('active',onlyOpen);renderList();};
 $('#facility-list').onclick=e=>{const b=e.target.closest('[data-select]');if(b)selectFacility(b.dataset.select);};
 $('#park-reviews').onclick=e=>{if(e.target.closest('[data-refresh-reviews]')){parkReviewSnapshot.refresh();renderParkReviews();$('#park-reviews .park-summary').scrollTop=0;return;}const b=e.target.closest('[data-select]');if(b){selectFacility(b.dataset.select);detailTab='reviews';render();}};
 document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{sideTab=b.dataset.side;if(sideTab==='reviews')parkReviewSnapshot.refresh();document.querySelectorAll('[data-side]').forEach(v=>v.classList.toggle('active',v===b));$('#facility-browser').hidden=sideTab!=='facilities';$('#park-reviews').hidden=sideTab!=='reviews';render();});
 const updatePrice=(source,type)=>{const value=Math.max(0,Math.min(type==='ticket'?300:250,Number(source.value)||0));$(`#${type}`).value=$(`#${type}-number`).value=value;game.setPrices(type==='ticket'?value:game.state.ticketPrice,type==='fast'?value:game.state.fastPrice);dirty=true;};
 for(const type of ['ticket','fast'])for(const suffix of ['', '-number'])$(`#${type}${suffix}`).oninput=e=>updatePrice(e.target,type);
 $('#toggle-park').onclick=()=>act(game.togglePark());$('#pause').onclick=()=>{game.state.paused=!game.state.paused;dirty=true;render();};document.querySelectorAll('[data-speed]').forEach(b=>b.onclick=()=>{game.state.speed=Number(b.dataset.speed);game.state.paused=false;dirty=true;render();});
 $('#report').onclick=()=>{const s=game.state;modal(`<div class="detail-category">园长经营手账</div><h2 class="modal-title">第 ${s.day} 天 · 营业报告</h2><div class="stat-grid"><div class="small-stat"><span>今日营业收入</span><strong>${money(s.dayIncome)}</strong></div><div class="small-stat"><span>今日支出 · 含翻修升级</span><strong>${money(s.dayExpense)}</strong></div><div class="small-stat"><span>今日入园游客</span><strong>${number(s.dayVisitors)} 人</strong></div><div class="small-stat"><span>预计日客流</span><strong>${number(game.demandForecast().arrivalsPerDay)} 人</strong></div></div><p class="modal-copy">目前资金 ${money(s.money)} · 全园已翻修 ${game.parkStats().restoredCount} 处。翻修与升级记入当天支出，日常运营费随时间结算。</p><div class="complaint-title">过去的营业日</div>${s.history.length?s.history.slice(-7).reverse().map(d=>`<div class="help-row"><span>第 ${d.day} 天 · ${number(d.visitors)} 人</span><span>收 ${money(d.income)} / 支 ${money(d.expense)}</span></div>`).join(''):'<p class="micro">第一天的故事正在发生，结束后会留下完整报告。</p>'}`);};$('#save').onclick=()=>{const saved=game.save();toast(saved?'园区进度已保存':'浏览器暂时无法保存，请从帮助中导出存档');saveStatus=saved?'刚刚已保存':'浏览器存储不可用';setText($('#save-status'),saveStatus);};$('#help').onclick=help;$('.modal-close').onclick=closeModal;
 $('#modal').onclick=e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};
 $('#home').onclick=()=>{selected=null;scene.home();render();};$('.brand').onclick=e=>{e.preventDefault();$('#home').click();};
 $('#detail').onclick=e=>{
 if(e.target.closest('[data-refresh-reviews]')){detailReviewSnapshot.refresh();renderDetail();$('.detail-content').scrollTop=0;return;}
 if(e.target.closest('.detail-close')){selected=null;render();return;}
 const tab=e.target.closest('[data-detail-tab]');if(tab){detailTab=tab.dataset.detailTab;if(detailTab==='reviews')detailReviewSnapshot.refresh();renderDetail();return;}
 const b=e.target.closest('[data-upgrade]');if(b){act(game.upgrade(selected,b.dataset.upgrade));return;}
 const a=e.target.closest('[data-action]');if(!a)return;const f=game.getFacility(selected);
 if(a.dataset.action==='restore')act(game.restore(selected));
 if(a.dataset.action==='special')act(game.setSpecial(selected,$('#special').checked,Math.max(0,Math.min(300,Number($('#special-price').value)||0))),'项目收费已更新');
 if(a.dataset.action==='reset'){const id=selected;modal(`<h2 class="modal-title">重置${esc(f.name)}？</h2><p class="modal-copy">所有升级清零，建筑恢复0级废弃状态。返还本轮升级花费的一半：<strong>${money((f.spentUpgrade||0)/2)}</strong>。翻修费和运营费不返还，历史评价保留。再次营业需要重新翻修。</p><div class="modal-actions"><button class="secondary" id="cancel-reset">保留设施</button><button class="primary" id="confirm-reset">确认重置</button></div>`);$('#cancel-reset').onclick=closeModal;$('#confirm-reset').onclick=()=>{closeModal();act(game.reset(id));};}
 };
 $('#detail').onchange=e=>{if(e.target.id==='facility-open')act(game.toggleFacility(selected));if(e.target.matches('[data-review-period]')){reviewPeriod=e.target.value;e.target.blur();render();}};
 $('#park-reviews').onchange=e=>{if(e.target.matches('[data-review-period]')){reviewPeriod=e.target.value;e.target.blur();render();}};
 window.addEventListener('beforeunload',()=>game.save());document.addEventListener('visibilitychange',()=>{if(document.hidden)game.save();});
 render();$('#loading').remove();
 let previous=performance.now();function frame(now){
  const dt=Math.min((now-previous)/1000,.1);previous=now;
  if(!document.hidden){
   scene.setUIInteractionActive(scrollUpdates.shouldDefer(now));game.tick(dt);scene.update(dt);
   if(now-lastRender>650){scrollUpdates.markPending();lastRender=now;}
   if(now-lastSave>15000){const saved=game.save();lastSave=now;saveStatus=saved?'进度已自动保存':'浏览器存储不可用，可导出存档';scrollUpdates.markPending();}
   if(scrollUpdates.consumePending(now)){render(true);flushDecorations();lastRender=now;}
  }
  requestAnimationFrame(frame);
 }requestAnimationFrame(frame);
 let first=true;try{first=!localStorage.getItem('park-revival-welcomed');localStorage.setItem('park-revival-welcomed','1');}catch{}if(first)help();
}
init().catch(error=>{console.error(error);const loading=$('#loading')||document.body.appendChild(Object.assign(document.createElement('div'),{id:'loading'}));loading.innerHTML=`<strong>园区暂时未能启动</strong><span>${esc(error.message)}</span><span>请使用支持WebGL的桌面浏览器，并开启硬件加速。</span><button class="primary" onclick="location.reload()">重新进入</button>`;});
