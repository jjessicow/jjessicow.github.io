// Scripted screen recorder for the Tangents prototypes.
// Drives headless Chrome over the DevTools protocol with virtual time, so every frame is exactly 1/30 s apart,
// then encodes the frames to a video inside the browser (MediaRecorder). No extra downloads needed.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const [, , sceneName, outDir, debugDir] = process.argv;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 500);
const W = 1440, H = 900, FPS = 30;
const BASE = 'http://localhost:4175/tangents/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = join(os.tmpdir(), 'tangents-rec-' + PORT);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });

async function connect(match) {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find(match);
      if (t) return cdp(t.webSocketDebuggerUrl);
    } catch {}
    await sleep(200);
  }
  throw new Error('no devtools target');
}
function cdp(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); let id = 0; const pend = new Map(), waiters = new Map();
    ws.onopen = () => res({
      send(method, params = {}) { return new Promise((ok, no) => { const my = ++id; const t = setTimeout(() => no(new Error('timeout: ' + method + ' ' + JSON.stringify(params).slice(0, 120))), 120000); pend.set(my, { ok: v => { clearTimeout(t); ok(v); }, no: e => { clearTimeout(t); no(e); }, method }); ws.send(JSON.stringify({ id: my, method, params })); }); },
      once(ev) { return new Promise((ok, no) => { const t = setTimeout(() => no(new Error('timeout waiting for ' + ev)), 15000); waiters.set(ev, v => { clearTimeout(t); ok(v); }); }); },
      close() { ws.close(); },
    });
    ws.onerror = rej;
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.no(new Error(p.method + ': ' + d.error.message)) : p.ok(d.result); }
      else if (waiters.has(d.method)) { const w = waiters.get(d.method); waiters.delete(d.method); w(d.params); }
    };
  });
}

const frames = [];
let page, cur = { x: W * .62, y: H * .66 };
const ev = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  in: ' + expr.slice(0, 160));
  return r.result.value;
};
async function frame(n = 1, capture = true) {
  for (let i = 0; i < n; i++) {
    await ev(`__clock.advance(${1000 / FPS})`);
    if (!capture) continue;
    const opts = { format: 'jpeg', quality: 93 };
    if (cam) {
      if (camT) { camT.i++; const t = easeC(camT.i / camT.n); cam = { x: camT.a.x + (camT.b.x - camT.a.x) * t, y: camT.a.y + (camT.b.y - camT.a.y) * t, w: camT.a.w + (camT.b.w - camT.a.w) * t }; if (camT.i >= camT.n) camT = null; }
      opts.clip = { x: cam.x, y: cam.y, width: cam.w, height: cam.w * H / W, scale: OUT_W / cam.w };
    }
    const shot = await page.send('Page.captureScreenshot', opts);
    frames.push(shot.data);
    if (frames.length % 60 === 0) console.log('  ', frames.length, 'frames');
  }
}
// The camera: a 16:10 window onto the page, given by its centre and width. It can glide between framings while frames roll.
const OUT_W = 1200;
let cam = null, camT = null;
const easeC = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const rectFor = (cx, cy, w) => { const h = w * H / W; return { x: Math.min(Math.max(0, cx - w / 2), W - w), y: Math.min(Math.max(0, cy - h / 2), H - h), w }; };
const camSet = (cx, cy, w) => { cam = rectFor(cx, cy, w); camT = null; };
const camTo = (cx, cy, w, n = 30) => { camT = { a: { ...cam }, b: rectFor(cx, cy, w), i: 0, n }; };
// A hand-cranked clock, installed before the page's own scripts: timers, requestAnimationFrame, performance.now and
// CSS transitions only move when advance() is called, so each captured frame is exactly one step apart.
const CLOCK = `(() => {
  let now = 0, seq = 1; const t0 = Date.now(), timers = new Map(); let rafs = [];
  const seen = new WeakSet();
  window.setTimeout = (fn, d, ...a) => { const id = seq++; timers.set(id, { t: now + Math.max(0, +d || 0), fn, a }); return id; };
  window.setInterval = (fn, d, ...a) => { const id = seq++; timers.set(id, { t: now + Math.max(1, +d || 0), fn, a, every: Math.max(1, +d || 0) }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers.delete(id); };
  window.requestAnimationFrame = fn => { const id = seq++; rafs.push({ id, fn }); return id; };
  window.cancelAnimationFrame = id => { rafs = rafs.filter(r => r.id !== id); };
  performance.now = () => now; Date.now = () => t0 + now;
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' }, configurable: true }); } catch (e) {}
  const call = (fn, a) => { try { typeof fn === 'function' ? fn(...a) : (0, eval)(fn); } catch (e) { console.error(e); } };
  window.__clock = { advance(dt) {
    const target = now + dt;
    for (let guard = 0; guard < 5000; guard++) {
      let next = null, nid = 0; timers.forEach((v, id) => { if (v.t <= target && (!next || v.t < next.t)) { next = v; nid = id; } });
      if (!next) break;
      now = Math.max(now, next.t);
      if (next.every) next.t += next.every; else timers.delete(nid);
      call(next.fn, next.a);
    }
    now = target;
    const q = rafs; rafs = []; q.forEach(r => call(r.fn, [now]));
    void document.documentElement.offsetWidth;
    document.getAnimations().forEach(a => {
      if (!seen.has(a)) { seen.add(a); try { a.pause(); } catch (e) {} return; }
      if (a.playState === 'finished' || a.playState === 'idle') return;
      try {
        const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity, t = (a.currentTime || 0) + dt;
        if (t >= end) a.finish(); else a.currentTime = t;
      } catch (e) {}
    });
  } };
})()`;
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const setCursor = (x, y, s = 1) => ev(`__rec.cursor(${x.toFixed(1)},${y.toFixed(1)},${s})`);
async function move(x, y, n = 22) {
  const sx = cur.x, sy = cur.y;
  // a slight arc reads as a hand, not a machine
  const bow = Math.min(40, Math.hypot(x - sx, y - sy) * .12), nx = -(y - sy), ny = x - sx, nl = Math.hypot(nx, ny) || 1;
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n), b = Math.sin(Math.PI * t) * bow;
    cur = { x: sx + (x - sx) * t + nx / nl * b, y: sy + (y - sy) * t + ny / nl * b };
    await setCursor(cur.x, cur.y); await ev(`__rec.hover(${cur.x},${cur.y})`); await frame();
  }
}
async function click(hold = 3) {
  await setCursor(cur.x, cur.y, .82); await ev(`__rec.down(${cur.x},${cur.y})`); await frame(hold);
  await setCursor(cur.x, cur.y, 1); await ev(`__rec.up(${cur.x},${cur.y})`); await frame(2);
}
const at = async (expr) => ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
async function moveToEl(expr, n = 22, dx = 0, dy = 0) { const p = await at(expr); if (!p) throw new Error('not found: ' + expr); await move(p.x + dx, p.y + dy, n); return p; }
async function wheel(total, n, ctrl, axis = 'y') {     // spread a wheel gesture over n frames with an eased profile
  let prev = 0;
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n), d = (t - prev) * total; prev = t;
    await ev(`__rec.wheel(${cur.x},${cur.y},${axis === 'x' ? d : 0},${axis === 'y' ? d : 0},${!!ctrl})`); await frame();
  }
}
const zoom = (factor, n) => wheel(-100 * Math.log(factor), n, true);
const card = t => `[...document.querySelectorAll('.card.node')].find(c => c.textContent.includes(${JSON.stringify(t)}))`;

const INJECT = `(() => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;transform-origin:4px 3px;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.28))';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 3 L4 20.5 L8.8 16.4 L12 23.6 L15.2 22.2 L12.1 15.2 L18.6 15 Z" fill="#161714" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  const stage = document.getElementById('stage'); if (stage) stage.setPointerCapture = () => {};
  const hit = (x, y) => { c.style.display = 'none'; const el = document.elementFromPoint(x, y); c.style.display = ''; return el || document.body; };
  const P = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
  const M = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 });
  let downEl = null, last = null, flip = 0;
  const px = document.createElement('div'); px.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;z-index:2147483646;pointer-events:none;background:#f6f4ef';
  document.documentElement.appendChild(px);
  window.__rec = {
    cursor(x, y, s) { c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px) scale(' + s + ')'; },
    hover(x, y) { const el = hit(x, y); if (el !== last) { if (last) last.dispatchEvent(M('mouseout', x, y)); el.dispatchEvent(M('mouseover', x, y)); last = el; } el.dispatchEvent(P('pointermove', x, y)); el.dispatchEvent(M('mousemove', x, y)); },
    down(x, y) { downEl = hit(x, y); downEl.dispatchEvent(P('pointerdown', x, y)); downEl.dispatchEvent(M('mousedown', x, y)); },
    up(x, y) { const el = hit(x, y); el.dispatchEvent(P('pointerup', x, y)); el.dispatchEvent(M('mouseup', x, y)); if (el === downEl || el.contains(downEl) || downEl.contains(el)) { const t = downEl.closest('button,a,[role=button]') || el; if (t.focus && t.matches('[contenteditable],input,textarea')) t.focus(); t.dispatchEvent(M('click', x, y)); } },
    wheel(x, y, dx, dy, ctrl) { hit(x, y).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy, ctrlKey: ctrl })); },
  };
})()`;

const scenes = {
  // The cover: arrive on the whole trail, zoom in, wander along it, open a card, pull back out.
  async cover() {
    await frame(10);
    await moveToEl(card('Gold seams on deep blue'), 24, 30, 10);
    await zoom(.62 / .243, 42);
    await frame(4);
    await wheel(980, 54, false, 'x');
    await frame(4);
    await moveToEl(card('Text spilling off the page'), 22);
    await click();
    await frame(54);
    await moveToEl(`document.querySelector('.c-close')`, 16);
    await click();
    await frame(8);
    await moveToEl(`document.getElementById('zoom-fit')`, 26);
    await click();
    await frame(32);
    await move(W * .62, H * .66, 22);
    await frame(4);
  },
  // Open a card and read where it came from and where it led.
  async details() {
    await ev(`__rec.wheel(300,400,0,${-100 * Math.log(1 / .243)},true)`); await frame(1);
    const p = await at(card('Gold seams, up close'));
    await ev(`__rec.wheel(0,0,${p.x - 620},${p.y - 380},false)`); await frame(12);
    cur = { x: 1050, y: 640 }; await setCursor(cur.x, cur.y);
    await moveToEl(card('Gold seams, up close'), 26, 20, -10);
    await click();
    await frame(70);
    await moveToEl(`document.querySelector('.c-close')`, 18);
    await click();
    await frame(12);
    await moveToEl(card('Gold seams on deep blue'), 24, 10, -10);
    await click();
    await frame(70);
    await moveToEl(`document.querySelector('.c-close')`, 18);
    await click();
    await frame(20);
  },
  // Make it yours: drop a note, then branch off from a card.
  async edit() {
    await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.5 / .243)},true)`); await frame(1);
    const p = await at(card('Kintsugi bowl'));
    await ev(`__rec.wheel(0,0,${p.x - 330},${p.y - 450},false)`); await frame(12);
    cur = { x: 980, y: 600 }; await setCursor(cur.x, cur.y);
    await moveToEl(`document.querySelector('#tools button[data-tool=note]')`, 26);
    await click(); await frame(10);
    const g = await at(card('Gold seams, up close'));
    await move(g.x + 40, g.y - 205, 26);
    await click(); await frame(12);
    const text = 'gold = the repair is the feature';
    for (let i = 1; i <= text.length; i++) {
      await ev(`(() => { const t = document.activeElement && document.activeElement.isContentEditable ? document.activeElement : [...document.querySelectorAll('.note .text')].pop(); t.textContent = ${JSON.stringify(text)}.slice(0, ${i}); t.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
      await frame(i % 3 === 0 ? 2 : 1);
    }
    await frame(16);
    await moveToEl(`document.querySelector('#tools button[data-tool=branch]')`, 28);
    await click(); await frame(10);
    await moveToEl(card('Gold seams on deep blue'), 26, 10, -10);
    await click();
    await frame(70);
  },
  // Share: a view-only link, or the session as context.
  async share() {
    await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.5 / .243)},true)`); await frame(1);
    const p = await at(card('Constellations over a face'));
    await ev(`__rec.wheel(0,0,${p.x - 1000},${p.y - 470},false)`); await frame(12);
    cur = { x: 760, y: 560 }; await setCursor(cur.x, cur.y);
    await frame(8);
    await moveToEl(`document.getElementById('share-btn')`, 30);
    await click(); await frame(22);
    await moveToEl(`document.getElementById('copy-link')`, 20, -40, 0);
    await frame(8);
    await click(); await frame(70);
    await move(760, 560, 26);
    await frame(10);
  },
  // The companion: opt in, browse, and watch the session fill up.
  async companion() {
    await frame(16);
    await moveToEl(`document.getElementById('startBtn')`, 28);
    await click(); await frame(40);
    const pins = `[...document.querySelectorAll('#board figure.card img')]`;
    await moveToEl(`${pins}[2]`, 26); await click(); await frame(50);
    if (await at(`document.querySelector('#pinOpen .pback')`)) { await moveToEl(`document.querySelector('#pinOpen .pback')`, 22); await click(); await frame(26); } else console.log('  no pin view; board children:', await ev(`[...document.querySelectorAll('#board > *')].slice(0,3).map(e => e.outerHTML.slice(0,160)).join(' || ')`));
    await moveToEl(`${pins}[7]`, 26); await click(); await frame(50);
    await moveToEl(`document.getElementById('openBtn')`, 24); await click(); await frame(80);
  },
};

// Short cover: the whole map, a slow zoom into the trail, then back out to where it started so the loop is seamless.
scenes.cover = async () => {
  const home = { ...cur };
  await frame(18);
  await moveToEl(card('There’s a name for it in Japanese') + ' || ' + card('A kintsugi poem'), 26, 40, 20);
  await frame(4);
  await zoom(.6 / .243, 54);
  await frame(34);
  await zoom(.243 / .6, 48);
  await frame(6);
  await move(home.x, home.y, 24);
  await frame(6);
};

// ---- feature clips: the camera sits close on the feature being shown ----

// Open a card: the panel that unfolds from it.
scenes.details = async () => {
  await ev(`__rec.wheel(300,400,0,${-100 * Math.log(1 / .243)},true)`); await frame(1, false);
  const p = await at(card('Gold seams, up close'));
  await ev(`__rec.wheel(0,0,${p.x - 620},${p.y - 400},false)`); await frame(12, false);
  camSet(720, 450, 900);
  cur = { x: 1010, y: 610 }; await setCursor(cur.x, cur.y);
  await frame(10);
  await moveToEl(card('Gold seams, up close'), 24, 20, -10);
  await click();
  await frame(78);
  await moveToEl(`document.querySelector('.c-close')`, 18);
  await click();
  await frame(26);
};

// Make it yours, part one: pick the note tool, drop a note, write in it.
scenes.note = async () => {
  await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.75 / .243)},true)`); await frame(1, false);
  const p = await at(card('Kintsugi bowl'));
  await ev(`__rec.wheel(0,0,${p.x - 420},${p.y - 560},false)`); await frame(12, false);
  const tool = await at(`document.querySelector('#tools button[data-tool=note]')`);
  camSet(tool.x, 660, 860);
  cur = { x: tool.x + 250, y: 600 }; await setCursor(cur.x, cur.y);
  await frame(10);
  await move(tool.x, tool.y, 22);
  await click(); await frame(8);
  const g = await at(card('Gold seams, up close'));
  camTo(g.x + 60, g.y - 130, 860, 34);
  await move(g.x + 30, g.y - 290, 30);
  await click(); await frame(12);
  const text = 'the repair is the feature';
  for (let i = 1; i <= text.length; i++) {
    await ev(`(() => { const t = document.activeElement && document.activeElement.isContentEditable ? document.activeElement : [...document.querySelectorAll('.note .text')].pop(); t.textContent = ${JSON.stringify(text)}.slice(0, ${i}); t.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
    await frame(i % 3 === 0 ? 3 : 2);
  }
  await frame(40);
};

// Make it yours, part two: branch off from a card.
scenes.branch = async () => {
  await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.75 / .243)},true)`); await frame(1, false);
  const p = await at(card('Gold seams on deep blue'));
  await ev(`__rec.wheel(0,0,${p.x - 700},${p.y - 520},false)`); await frame(12, false);
  const tool = await at(`document.querySelector('#tools button[data-tool=branch]')`);
  camSet(tool.x, 640, 860);
  cur = { x: tool.x - 230, y: 610 }; await setCursor(cur.x, cur.y);
  await frame(10);
  await move(tool.x, tool.y, 22);
  await click(); await frame(8);
  camTo(720, 470, 900, 30);
  await moveToEl(card('Gold seams on deep blue'), 26, 10, -10);
  await click();
  camTo(720, 400, 820, 30);
  await frame(44);
  const name = 'gold as line';
  for (let i = 1; i <= name.length; i++) {
    const ok = await ev(`(() => { const t = document.activeElement; if (!t || !t.isContentEditable) return false; t.textContent = ${JSON.stringify(name)}.slice(0, ${i}); t.dispatchEvent(new InputEvent('input', { bubbles: true })); return true; })()`);
    if (!ok) break;
    await frame(i % 3 === 0 ? 3 : 2);
  }
  await frame(44);
};

// Share: the menu under the Share button.
scenes.share = async () => {
  camSet(1140, 150, 600);
  cur = { x: 960, y: 300 }; await setCursor(cur.x, cur.y);
  await frame(12);
  await moveToEl(`document.getElementById('share-btn')`, 26);
  await click(); await frame(24);
  await moveToEl(`document.getElementById('copy-link')`, 20, -40, 0);
  await frame(8);
  await click(); await frame(66);
  await move(960, 300, 24);
  await frame(8);
};

// End session: the recap that plays back the session as a short story.
scenes.recap = async () => {
  await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.5 / .243)},true)`); await frame(1, false);
  const p = await at(`document.querySelector('.sf-end')`);
  await ev(`__rec.wheel(0,0,${p.x - 860},${p.y - 450},false)`); await frame(12, false);
  camSet(720, 450, 1000);
  cur = { x: 560, y: 600 }; await setCursor(cur.x, cur.y);
  await frame(12);
  await moveToEl(`document.querySelector('.sf-end')`, 26);
  await click();
  await frame(34);
  const c = await at(`document.getElementById('sofar')`);
  console.log('   summary card', JSON.stringify(c));
  camTo(c.x - 16, c.y, 440, 30);
  await frame(60);
  await moveToEl(`document.querySelector('#sofar [data-step="1"]')`, 22);
  await click(); await frame(70);
  await click(); await frame(80);
};

// The companion: opt in, open a pin, and look at the session so far.
scenes.companion = async () => {
  camSet(720, 300, 960);
  cur = { x: 1020, y: 430 }; await setCursor(cur.x, cur.y);
  await frame(16);
  await moveToEl(`document.getElementById('startBtn')`, 26);
  await click(); await frame(44);
  await moveToEl(`document.querySelector('#board img[alt="Translated vase"]')`, 26, 0, -40); await click(); await frame(54);
  await moveToEl(`document.getElementById('openBtn')`, 24); await click(); await frame(90);
};

// The timeline on its infinite canvas: the whole trail, a zoom into its start, a pan left to right, then back to fit.
scenes.timeline = async () => {
  camSet(720, 450, 1440);
  const first = await at(`document.querySelector('.card.node')`);
  console.log('   first card', JSON.stringify(first));
  cur = { x: 520, y: 620 }; await setCursor(cur.x, cur.y);
  await frame(16);
  await move(Math.max(120, first.x + 40), first.y + 10, 24);
  await frame(4);
  await zoom(.62 / .243, 46);
  await frame(8);
  await move(720, first.y + 40, 20);
  await wheel(2500, 120, false, 'x');
  await frame(14);
  await moveToEl(`document.getElementById('zoom-fit')`, 24);
  await click();
  await frame(36);
};

// The toolbar: step through the tools one by one.
scenes.toolbar = async () => {
  await ev(`__rec.wheel(300,400,0,${-100 * Math.log(.5 / .243)},true)`); await frame(1, false);
  await frame(12, false);
  const names = await ev(`[...document.querySelectorAll('#tools button[data-tool]')].map(b => b.dataset.tool)`);
  console.log('   tools', names.join(','));
  const bar = await at(`document.getElementById('tools')`);
  console.log('   bar', JSON.stringify(bar));
  camSet(bar.x, bar.y - 90, Math.max(620, bar.w + 260));
  cur = { x: bar.x + bar.w / 2 + 60, y: bar.y - 150 }; await setCursor(cur.x, cur.y);
  await frame(12);
  for (const n of names.filter(n => n !== 'select')) {
    await moveToEl(`document.querySelector('#tools button[data-tool=${n}]')`, 16);
    await click(); await frame(26);
  }
  await moveToEl(`document.querySelector('#tools button[data-tool=select]')`, 20);
  await click(); await frame(10);
  await move(bar.x + bar.w / 2 + 60, bar.y - 150, 20);
  await frame(6);
};

const PAGES = { companion: 'browser.html' };

try {
  page = await connect(t => t.type === 'page');
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url: BASE + (PAGES[sceneName] || 'app.html') });
  await loaded; await sleep(1800);                       // fonts and images arrive in real time
  await frame(sceneName === 'companion' ? 12 : 120, false); await sleep(400);   // let the opening animation play out, uncaptured
  await ev(INJECT); await setCursor(cur.x, cur.y);
  await scenes[sceneName]();
  console.log(sceneName, 'frames:', frames.length, '(' + (frames.length / FPS).toFixed(1) + 's)');

  if (debugDir) {
    mkdirSync(debugDir, { recursive: true });
    for (let i = 0; i < frames.length; i += Math.max(1, Math.floor(frames.length / 8))) writeFileSync(join(debugDir, `${sceneName}-${String(i).padStart(3, '0')}.jpg`), Buffer.from(frames[i], 'base64'));
  }

  // encode in a second tab running in real time
  const { targetId } = await page.send('Target.createTarget', { url: 'about:blank' });
  const enc = await connect(t => t.id === targetId);
  const run = async (expr) => { const r = await enc.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('encode: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
  await run('window.F = []; 0');
  for (let i = 0; i < frames.length; i += 6) await run(`F.push(${frames.slice(i, i + 6).map(f => JSON.stringify(f)).join(',')}); 0`);
  const out = await run(`(async () => {
    const bmps = []; for (const f of F) bmps.push(await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + f)).blob()));
    const CW = ${cam ? OUT_W : W}, CH = ${cam ? OUT_W * H / W : H};
    const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH; const cx = cv.getContext('2d'); cx.drawImage(bmps[0], 0, 0, CW, CH);
    const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const stream = cv.captureStream(0), track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: ${cam ? 2000000 : 3200000} }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data);
    const stopped = new Promise(r => rec.onstop = r);
    rec.start();
    const t0 = performance.now();
    for (let i = 0; i < bmps.length; i++) {
      const due = t0 + i * 1000 / ${FPS}; const wait = due - performance.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      cx.drawImage(bmps[i], 0, 0, CW, CH); track.requestFrame();
    }
    await new Promise(r => setTimeout(r, 1000 / ${FPS})); rec.stop(); await stopped;
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return { mime, b64: btoa(s) };
  })()`);
  const ext = out.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${sceneName}.${ext}`);
  writeFileSync(file, Buffer.from(out.b64, 'base64'));
  writeFileSync(join(outDir, `${sceneName}.jpg`), Buffer.from(frames[0], 'base64'));     // poster frame
  console.log('wrote', file, out.mime, (Buffer.from(out.b64, 'base64').length / 1e6).toFixed(2) + ' MB');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
