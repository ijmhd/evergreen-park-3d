const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Math.round(Number(value)||0).toLocaleString('zh-CN');
const pct = value => (Number(value)||0).toFixed(1)+'%';

export function createSlowUI({game,scene,toast,act,modal,closeModal,clearSelection}) {
 function exportSave(){
   game.save();
   const url=URL.createObjectURL(new Blob([JSON.stringify(game.state,null,2)],{type:'application/json'}));
   const a=document.createElement('a');a.href=url;a.download=`重返游乐园-第${game.state.day}天.json`;a.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);toast('存档已导出');
 }
 function loaded(result){if(result.ok){clearSelection();scene.home();closeModal();}act(result);}
 function saveManager(){
   modal(`<div class="detail-category">下次见，园长</div><h2 class="modal-title">把这段故事存好。</h2><p class="modal-copy">进度自动保存在当前浏览器。也可以导出文件，下次导入继续玩。关闭网页后经营暂停，回来再慢慢建设。</p><div class="save-actions"><button class="primary" id="save-now">保存当前进度</button><button class="secondary" id="export-save">导出存档文件</button><button class="secondary" id="import-save">导入存档文件</button><button class="secondary" id="restore-backup">恢复上一个备份</button></div><input type="file" id="save-file" accept=".json,application/json" hidden><div class="reset-area"><p>想从慢节奏新局开始？初始资金为10,000金币。当前园区会先自动备份，可用“恢复上一个备份”找回。</p><button class="danger-button" id="new-game">新开慢节奏存档</button></div>`);
   $('#save-now').onclick=()=>{const ok=game.save();act({ok,message:ok?'当前进度已保存':'浏览器暂时无法保存，请导出存档文件'});};
   $('#export-save').onclick=exportSave;
   $('#import-save').onclick=()=>$('#save-file').click();
   $('#save-file').onchange=async event=>{
     const file=event.target.files[0];if(!file)return;
     if(file.size>8_000_000){toast('请选择小于8MB的游戏JSON存档');return;}
     let text;try{text=await file.text();}catch{toast('读取存档失败');return;}
     modal(`<h2 class="modal-title">载入这份园区存档？</h2><p class="modal-copy">文件：${esc(file.name)}。当前进度会自动备份，之后可恢复。</p><div class="modal-actions"><button class="secondary" id="cancel-import">取消</button><button class="primary" id="confirm-import">载入存档</button></div>`);
     $('#cancel-import').onclick=saveManager;$('#confirm-import').onclick=()=>loaded(game.importSave(text));
   };
   $('#restore-backup').onclick=()=>loaded(game.restoreBackup());
   $('#new-game').onclick=()=>{
     modal(`<h2 class="modal-title">从第一盏灯重新开始？</h2><p class="modal-copy">你已买下整座园区，新局有10,000金币，所有设施都可付费翻修和升级，一个营业日约20分钟。现有资金、设施和评价会自动备份。</p><div class="modal-actions"><button class="secondary" id="cancel-new">继续当前园区</button><button class="primary" id="confirm-new">备份并开始新局</button></div>`);
     $('#cancel-new').onclick=saveManager;$('#confirm-new').onclick=()=>loaded(game.startNewGame());
   };
 }
 function showProgress(){
   const p=game.progression();
   modal(`<div class="detail-category">慢慢来，每一盏灯都算数</div><h2 class="modal-title">乐园复兴计划 · ${pct(p.completionRate)}</h2><div class="stat-grid"><div class="small-stat"><span>已购入设施</span><strong>${p.unlockedCount} / 60</strong></div><div class="small-stat"><span>已完成翻修</span><strong>${p.restoredCount} / 60</strong></div><div class="small-stat"><span>全路线满级设施</span><strong>${p.maxedCount} / 60</strong></div><div class="small-stat"><span>已完成升级等级</span><strong>${number(p.upgradeLevels)} / ${number(p.totalUpgradeLevels)}</strong></div></div><p class="modal-copy">你已买下整座废弃游乐场，全部60处设施都能直接付费翻修。翻修和所有升级都只看金币是否足够，你可以自由决定先增加高度、座位、长宽或排队通道，再慢慢把每条路线升到满级。</p><div class="pricing-note">全部设施与升级路线都已属于你，准备好金币就能继续建设。</div>${p.completed?'<h3>乐园已全面复兴！谢谢你让快乐重新发生。</h3>':''}<div class="modal-actions"><button class="secondary" id="progress-save">存档管理</button><button class="primary" id="progress-close">继续慢慢经营</button></div>`);
   $('#progress-save').onclick=saveManager;$('#progress-close').onclick=closeModal;
 }
 function help(){
   modal(`<div class="detail-category">欢迎回来，园长</div><h2 class="modal-title">在园区中央，慢慢逛。</h2><p class="modal-copy">你已经买下这座废弃游乐场，全部60处设施和所有升级路线只要金币足够就能建设。先选一两处开始经营，标准速度一个营业日约20分钟，可以暂停，或选择0.5×、2×。</p><div class="help-row"><span>前后左右走动</span><span>W / S / A / D</span></div><div class="help-row"><span>向上、下、左、右看</span><span>↑ / ↓ / ← / →</span></div><div class="help-row"><span>鼠标转向</span><span>按住左键或右键拖拽</span></div><div class="help-row"><span>查看设施 / 回到中心</span><span>单击建筑或列表 / ⌂</span></div><div class="help-row"><span>升降 / 缩放</span><span>Q、E / 滚轮</span></div><div class="help-row"><span>锁定 / 释放鼠标</span><span>单击场景空白处 / Esc</span></div><p class="modal-copy">旧存档的资金和设施会保留，后续按慢节奏经营。想从10,000金币重新开始，可在存档管理中新开一局，旧进度会自动备份。</p><div class="modal-actions"><button class="secondary" id="help-saves">存档管理</button><button class="primary" id="start-playing">开始经营 ↗</button></div>`);
   $('#start-playing').onclick=closeModal;$('#help-saves').onclick=saveManager;
 }
 $('#progress').onclick=showProgress;
 return {help,saveManager,showProgress};
}
