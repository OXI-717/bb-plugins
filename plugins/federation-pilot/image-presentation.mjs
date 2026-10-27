// DOM image/link requests bypass fetch. Rewrite only exact, same-origin BB
// project attachment URLs. Never inspect or rewrite text/history/React caches.
export function mountImageUrls(win, rewrite) {
  if (!win.Element || !win.MutationObserver || !win.document) return {refresh(){}, dispose(){}};
  const proto = win.Element.prototype;
  const originalSet = proto.setAttribute;
  const records = new Map();
  let disposed = false;
  const attributeFor = node => node.tagName === 'IMG' ? 'src' : node.tagName === 'A' ? 'href' : null;
  function translated(node, name, value) {
    if (disposed || attributeFor(node) !== name) return value;
    const old = records.get(node);
    if (old?.rewritten === value) return value;
    const next = rewrite(value);
    if (!next || next === value) {records.delete(node); return value;}
    records.set(node, {name, original:value, rewritten:next});
    return next;
  }
  function patchedSet(name, value) {
    const key = String(name).toLowerCase(), text = String(value);
    return originalSet.call(this, name, translated(this, key, text));
  }
  proto.setAttribute = patchedSet;
  const properties = [];
  for (const [klass, name] of [[win.HTMLImageElement, 'src'], [win.HTMLAnchorElement, 'href']]) {
    if (!klass) continue;
    const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, name);
    if (!descriptor?.set || !descriptor.configurable) continue;
    const set = function(value) {descriptor.set.call(this, translated(this, name, String(value)));};
    Object.defineProperty(klass.prototype, name, {...descriptor, set});
    properties.push({proto:klass.prototype, name, descriptor, set});
  }
  function visit(node) {
    if (node.nodeType !== 1) return;
    const name = attributeFor(node);
    if (name) {
      const value = node.getAttribute(name);
      if (value !== null) {
        const next = translated(node, name, value);
        if (next !== value) originalSet.call(node, name, next);
      }
    }
    for (const child of node.querySelectorAll('img[src], a[href]')) visit(child);
  }
  function refresh() {
    if (disposed) return;
    for (const [node, old] of records) {
      if (!node.isConnected) {records.delete(node);continue;}
      if (node.getAttribute(old.name) !== old.rewritten) {records.delete(node);continue;}
      const next = rewrite(old.original) || old.original;
      if (next !== old.rewritten) {
        originalSet.call(node, old.name, next);
        if (next === old.original) records.delete(node); else old.rewritten = next;
      }
    }
    visit(win.document.documentElement);
  }
  const observer = new win.MutationObserver(changes => {
    for (const change of changes) {
      if (change.type === 'attributes') visit(change.target);
      else for (const node of change.addedNodes) visit(node);
    }
    for (const node of records.keys()) if (!node.isConnected) records.delete(node);
  });
  observer.observe(win.document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['src','href']});
  refresh();
  return {refresh, dispose() {
    if (disposed) return; disposed = true; observer.disconnect();
    if (proto.setAttribute === patchedSet) proto.setAttribute = originalSet;
    for (const p of properties) if (Object.getOwnPropertyDescriptor(p.proto,p.name)?.set === p.set) Object.defineProperty(p.proto,p.name,p.descriptor);
    for (const [node, old] of records) if (node.getAttribute(old.name) === old.rewritten) originalSet.call(node,old.name,old.original);
    records.clear();
  }};
}
