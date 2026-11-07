// Patch existing DOM nodes instead of replacing scrolling elements on every tick.
const previousMarkup = new WeakMap();
function key(node) {
  if (node.nodeType !== 1) return null;
  for (const attr of ['data-key','id','data-select','data-upgrade','data-action','data-detail-tab','data-refresh-reviews']) {
    if (node.hasAttribute(attr)) return node.tagName+':'+attr+':'+node.getAttribute(attr);
  }
  return null;
}
function compatible(a,b) { return a && a.nodeType===b.nodeType && (a.nodeType!==1 || a.tagName===b.tagName) && key(a)===key(b); }
function patchNode(target,draft) {
  if (target.nodeType !== 1) { if(target.nodeValue!==draft.nodeValue) target.nodeValue=draft.nodeValue; return; }
  for(const attr of [...target.attributes]) if(!draft.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  for(const attr of [...draft.attributes]) if(target.getAttribute(attr.name)!==attr.value) target.setAttribute(attr.name,attr.value);
  reconcile(target,draft);
  if(target!==target.ownerDocument.activeElement) {
    if(target.tagName==='INPUT') {target.checked=draft.checked;if(target.value!==draft.value)target.value=draft.value;}
    if(target.tagName==='SELECT' && target.value!==draft.value) target.value=draft.value;
  }
}
function reconcile(target,draft) {
  let cursor=target.firstChild;
  for(const child of [...draft.childNodes]) {
    let current=cursor;
    if(!compatible(current,child)) {
      const childKey=key(child);
      current=childKey?[...target.childNodes].find(n=>key(n)===childKey&&compatible(n,child)):null;
      if(current) target.insertBefore(current,cursor);
      else { current=child.cloneNode(true);target.insertBefore(current,cursor); }
    }
    patchNode(current,child);
    cursor=current.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;target.removeChild(cursor);cursor=next;}
}
export function patchMarkup(root,html) {
  if(previousMarkup.get(root)===html) return false;
  const template=root.ownerDocument.createElement('template');template.innerHTML=html;
  reconcile(root,template.content);previousMarkup.set(root,html);return true;
}

// Reading a review never inserts newer messages above the reader's position.
export class ReviewSnapshot {
  read({scope,key,count,revision=count},build) {
    if(this.scope!==scope||this.key!==key||this.html===undefined) {
      this.scope=scope;this.key=key;this.count=count;this.revision=revision;this.html=build();
    }
    return {html:this.html,pending:this.revision!==revision,newCount:Math.max(0,count-this.count)};
  }
  refresh(){this.html=undefined;}
}
