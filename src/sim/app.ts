// 시뮬레이터 브라우저 코드: MCP 클라이언트(구독 알림), MCP Apps 호스트(AppBridge), 음성 입출력, 인스펙터, 데모 재생
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { withCsp } from './csp.js';

interface UiRef {
  tool: string;
  resourceUri: string;
  args: Record<string, unknown>;
  result: Record<string, any>;
  isError: boolean;
}
interface CallRec {
  tool: string;
  args: unknown;
  result: { isError: boolean; spoken: string; structuredContent: unknown };
  ms: number;
}
interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  modelMs: number;
}
interface Reply {
  spoken: string;
  calls: CallRec[];
  ui: UiRef | null;
  mode: string;
  model?: string;
  usage?: Usage;
  protocolVersion?: string;
  error?: string;
}
interface Step {
  id: string;
  type: 'narrate' | 'chapter' | 'say' | 'advance' | 'inspector' | 'wait';
  text?: string;
  speak?: string;
  days?: number;
  open?: boolean;
  ms?: number;
  expectAlert?: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const RECORDING = params.has('record');
const SPEED = Number(params.get('speed') ?? 1);
// Milliseconds per word when a line has no measured voice-over (the live-model video measures afterwards).
const PACE = Number(params.get('pace') ?? 390);
const screen = $('screen');
const t0 = performance.now();

/** Timeline the video recorder reads to place voice-over clips. */
const events: { t: number; wall: number; type: string; id?: string; text?: string }[] = [];
// The video recorder injects measured voice-over lengths before the page loads.
(window as any).__homeAhead = { events, ready: false, done: false, durations: ((window as any).__homeAheadDurations ?? {}) as Record<string, number> };
const mark = (type: string, id?: string, text?: string) => events.push({ t: Math.round(performance.now() - t0), wall: Date.now(), type, id, text });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / SPEED));

// ---------------------------------------------------------------- layout
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.getElementById('stage')!.style.setProperty('--scale', String(s));
}
addEventListener('resize', fit);
fit();
if (RECORDING) document.body.classList.add('recording');

// ---------------------------------------------------------------- MCP client (for resources, alerts and MCP Apps)
const client = new Client({ name: 'home-ahead-simulator', version: '0.1.0' });
const callLog: CallRec[] = [];

function logCall(c: CallRec, source: string) {
  callLog.push(c);
  const li = document.createElement('li');
  li.innerHTML = `<div><span class="name ${c.result.isError ? 'err' : ''}"></span><span class="ms">${c.ms} ms</span></div><div class="src">${source}</div><pre class="a"></pre><pre class="r"></pre>`;
  li.querySelector('.name')!.textContent = `tools/call ${c.tool}`;
  li.querySelector('.a')!.textContent = `arguments ${JSON.stringify(c.args)}`;
  const sc = { ...(c.result.structuredContent as Record<string, unknown>) };
  li.querySelector('.r')!.textContent = `structuredContent ${JSON.stringify(sc, null, 1).slice(0, 900)}`;
  $('calls').appendChild(li);
}

/** One line per model turn: which model answered, how many requests, tokens and time. */
function logModelTurn(model: string, u: Usage) {
  const li = document.createElement('li');
  li.className = 'turn';
  const n = (x: number) => x.toLocaleString('en-US');
  li.innerHTML = `<div><span class="name"></span><span class="ms"></span></div><div class="src"></div>`;
  li.querySelector('.name')!.textContent = `model ${model.replace(/^Claude /, '')}`;
  li.querySelector('.ms')!.textContent = `${(u.modelMs / 1000).toFixed(1)} s`;
  li.querySelector('.src')!.textContent = `${u.modelCalls} request${u.modelCalls === 1 ? '' : 's'} · ${n(u.inputTokens + u.cacheReadInputTokens + u.cacheWriteInputTokens)} tokens in (${n(u.cacheReadInputTokens)} cached) · ${n(u.outputTokens)} out`;
  $('calls').appendChild(li);
}

// Tool calls made by an MCP App (e.g. the cart's "Place order" button) also show in the inspector.
const rawCallTool = client.callTool.bind(client);
(client as any).callTool = async (p: { name: string; arguments?: Record<string, unknown> }, o?: unknown) => {
  const start = performance.now();
  const res = await rawCallTool(p as never, o as never);
  const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
  logCall({ tool: p.name, args: p.arguments ?? {}, result: { isError: !!res.isError, spoken: String(sc.spoken ?? ''), structuredContent: sc }, ms: Math.round(performance.now() - start) }, 'called from the MCP App view');
  if (!res.isError && sc.spoken && p.name === 'confirm_supply_order') void speakReply(String(sc.spoken));
  void refreshAmbient();
  return res;
};

const seenAlerts = new Set<string>();
let alertsSpoken = 0;

async function connectMcp() {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
  client.setNotificationHandler('notifications/resources/updated', async (n: { params: { uri: string } }) => {
    if (n.params.uri === 'home://alerts') await showNewAlerts();
  });
  await client.subscribeResource({ uri: 'home://alerts' });
  $('proto').textContent = `protocol ${client.getNegotiatedProtocolVersion() ?? '?'} · session ${(client as any).transport?.sessionId?.slice(0, 8) ?? ''}`;
  // Alerts that already exist are history, not news.
  const alerts = await readJson('home://alerts');
  for (const a of alerts.recent ?? []) seenAlerts.add(a.id);
}

async function readJson(uri: string): Promise<any> {
  const res = await client.readResource({ uri });
  return JSON.parse((res.contents[0] as { text: string }).text);
}

// ---------------------------------------------------------------- ambient home screen
async function refreshAmbient() {
  const h = await readJson('home://household');
  const now = new Date(h.now);
  // The household's time zone, so the screen and "Saturday morning" agree.
  const timeZone = h.timeZone ?? 'UTC';
  $('time').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).replace(/\s?[AP]M/, '');
  $('date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone });
  $('clock-badge').textContent = h.simulatedClock ? `Demo clock · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone })}` : `Live clock · ${timeZone}`;
  const child = h.children[0];
  const next = h.openTasks.find((t: any) => t.when);
  const recalls = h.openRecalls.filter((r: any) => r.remedyStatus === 'open');
  const card = (k: string, v: string, s: string, warn = false) => `<div class="amb ${warn ? 'warn' : ''}"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;
  $('ambient').innerHTML =
    card('Stage', child ? `${child.nickname} · ${child.stageLabel}` : 'No child added', child ? 'Home Ahead plans for this stage' : 'Say her nickname and birth month') +
    card('Next up', next ? next.title : `${h.openTasks.length} open task${h.openTasks.length === 1 ? '' : 's'}`, next ? next.when : 'Nothing scheduled') +
    card('Recalls', recalls.length ? `${recalls.length} need${recalls.length === 1 ? 's' : ''} action` : 'All clear', recalls.length ? recalls.map((r: any) => r.item).join(', ') : `${h.items.length} items watched`, recalls.length > 0);
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------------------------------------------------------------- voice
let ttsOn = !RECORDING && params.get('tts') !== '0';
($('tts') as HTMLInputElement).checked = ttsOn;
$('tts').addEventListener('change', (e) => (ttsOn = (e.target as HTMLInputElement).checked));

function estimateMs(text: string) {
  return Math.max(1400, text.split(/\s+/).length * PACE);
}

/** Speak with the browser voice, or wait as long as the recorded voice-over will take. */
async function speakOrWait(text: string, id: string) {
  const known = (window as any).__homeAhead.durations[id] as number | undefined;
  if (ttsOn && 'speechSynthesis' in window && !RECORDING) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      setTimeout(resolve, estimateMs(text) * 2.5);
    });
  } else {
    await sleep(known ?? estimateMs(text));
  }
}

async function speakReply(text: string, id = `reply-${events.length}`) {
  mark('assistant', id, text);
  await speakOrWait(text, `${id}.assistant`);
}

// ---------------------------------------------------------------- MCP Apps host
let bridge: AppBridge | null = null;

async function teardownApp() {
  if (bridge) {
    await bridge.teardownResource({}).catch(() => {});
    await bridge.close().catch(() => {});
    bridge = null;
  }
  $('app-slot').innerHTML = '';
  $('app-slot').hidden = true;
}

async function showApp(ui: UiRef) {
  await teardownApp();
  const fullscreen = ui.tool === 'get_safety_plan' || ui.tool === 'set_child_stage';
  screen.dataset.ui = fullscreen ? 'fullscreen' : 'inline';
  const res = await client.readResource({ uri: ui.resourceUri });
  const content = res.contents[0] as { text: string; _meta?: { ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } } } };
  const html = withCsp(content.text, content._meta?.ui?.csp);
  const slot = $('app-slot');
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = ui.tool;
  iframe.style.height = fullscreen ? '100%' : '360px';
  slot.appendChild(iframe);
  slot.hidden = false;
  const maxW = fullscreen ? 1280 : 660;
  const maxH = fullscreen ? 800 : 728;
  bridge = new AppBridge(
    client as never,
    { name: 'Home Ahead simulator', version: '0.1.0' },
    { openLinks: {}, serverTools: {}, logging: {} },
    {
      hostContext: {
        theme: 'dark',
        displayMode: fullscreen ? 'fullscreen' : 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: { maxWidth: maxW, maxHeight: maxH },
        platform: 'web',
        deviceCapabilities: { touch: true, hover: false },
        safeAreaInsets: { top: 0, right: 0, bottom: fullscreen ? 120 : 0, left: 0 },
        locale: 'en-US',
        userAgent: 'home-ahead-simulator',
        // The fields Alexa+ documents for its own hosts, so views can be written against them.
        deviceClass: 'hub-landscape',
        maxWidth: maxW,
        maxHeight: maxH,
      },
    },
  );
  bridge.onsizechange = ({ height }) => {
    if (!fullscreen && height) iframe.style.height = `${Math.min(height, maxH)}px`;
  };
  const ready = new Promise<void>((resolve) => (bridge!.oninitialized = () => resolve()));
  // Connect before loading the view: it sends ui/initialize as soon as its script runs.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  // Route the view's tool calls through our wrapper so they show in the inspector too.
  bridge.oncalltool = async (p) => (client as any).callTool(p);
  iframe.srcdoc = html;
  await Promise.race([ready, sleep(3000)]);
  await bridge.sendToolInput({ arguments: ui.args });
  await bridge.sendToolResult({ content: [{ type: 'text', text: String(ui.result.spoken ?? '') }], structuredContent: ui.result, isError: ui.isError });
}

// ---------------------------------------------------------------- alerts
async function showNewAlerts() {
  const a = await readJson('home://alerts');
  const fresh = (a.unread ?? []).filter((x: any) => !seenAlerts.has(x.id)).reverse();
  for (const alert of fresh) {
    seenAlerts.add(alert.id);
    // Let a "three weeks later" title card finish before the alert appears.
    while (!$('chapter').hidden) await sleep(100);
    await teardownApp();
    screen.dataset.state = 'home';
    screen.dataset.ui = 'none';
    $('user-bubble').hidden = true;
    $('reply').hidden = true;
    const card = $('alert-card');
    const source = alert.recallNumber ? `<div class="src">U.S. CPSC recall ${esc(alert.recallNumber)}</div>` : '';
    card.innerHTML = `<div class="k">${alert.kind === 'recall' ? 'New recall' : 'Heads up'}</div><div class="t">${esc(alert.title)}</div><div class="s">${esc(alert.spoken)}</div>${source}`;
    card.hidden = false;
    // The recording cannot capture WebAudio, so the video builder adds the same chime at this mark.
    mark('chime');
    chime();
    await sleep(700);
    const alertId = `alert-${alertsSpoken}`;
    mark('alert', alertId, alert.spoken);
    await speakOrWait(alert.spoken, `${alertId}.assistant`);
    alertsSpoken++;
  }
  await refreshAmbient();
}

function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.55);
    });
  } catch {
    /* audio is optional */
  }
}

// ---------------------------------------------------------------- one conversational turn
let busy = false;

async function ask(text: string, id = `turn-${events.length}`) {
  if (busy || !text.trim()) return;
  busy = true;
  try {
    $('alert-card').hidden = true;
    screen.dataset.state = 'talk';
    screen.dataset.ui = screen.dataset.ui === 'fullscreen' ? 'fullscreen' : 'none';
    $('reply').hidden = true;
    $('user-text').textContent = text;
    $('user-bubble').hidden = false;
    screen.dataset.listening = 'true';
    mark('user', id, text);
    await speakOrWaitUser(text, id);
    screen.dataset.listening = 'false';
    screen.dataset.thinking = 'true';
    const res = await fetch('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, conversationId: 'sim' }) });
    const reply = (await res.json()) as Reply;
    screen.dataset.thinking = 'false';
    if (reply.error) throw new Error(reply.error);
    const agentName = reply.mode === 'strands' ? 'Strands agent' : 'Planner';
    $('mode-badge').textContent = `${agentName}${reply.model ? ` · ${reply.model}` : ''} · MCP ${reply.protocolVersion ?? ''}`;
    $('mode-badge').classList.add('live');
    for (const c of reply.calls) logCall(c, `called by the ${reply.mode === 'strands' ? 'Strands agent' : 'planner'}`);
    if (reply.model && reply.usage) logModelTurn(reply.model, reply.usage);
    if (reply.ui) await showApp(reply.ui);
    else {
      await teardownApp();
      screen.dataset.ui = 'none';
    }
    $('reply').textContent = reply.spoken;
    $('reply').hidden = false;
    void refreshAmbient();
    await speakReply(reply.spoken, id);
  } catch (err) {
    screen.dataset.thinking = 'false';
    $('reply').textContent = 'Sorry, something went wrong. Please try again.';
    $('reply').hidden = false;
    console.error(err);
  } finally {
    busy = false;
  }
}

/** In demo/recording mode the user's line takes as long as its recorded voice. */
async function speakOrWaitUser(text: string, id: string) {
  if (!DEMO) return sleep(500);
  const known = (window as any).__homeAhead.durations[`${id}.user`] as number | undefined;
  await sleep(known ?? Math.max(1200, text.split(/\s+/).length * 330));
}

// ---------------------------------------------------------------- input: text and Web Speech
$('inputbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text') as HTMLInputElement;
  const text = input.value;
  input.value = '';
  void ask(text);
});

const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
$('mic').addEventListener('click', () => {
  if (!Recognition) {
    $('reply').textContent = 'Voice input needs Chrome or Edge. You can type instead.';
    $('reply').hidden = false;
    return;
  }
  const rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = false;
  $('mic').classList.add('on');
  screen.dataset.listening = 'true';
  rec.onresult = (e: any) => void ask(e.results[0][0].transcript);
  rec.onend = () => {
    $('mic').classList.remove('on');
    screen.dataset.listening = 'false';
  };
  rec.start();
});

// ---------------------------------------------------------------- inspector (D key)
function toggleInspector(open?: boolean) {
  const el = $('inspector');
  const show = open ?? el.hidden === true;
  el.hidden = !show;
  document.getElementById('stage')!.classList.toggle('with-inspector', show);
}
$('inspector-toggle').addEventListener('click', () => toggleInspector());
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'd' && document.activeElement?.tagName !== 'INPUT') toggleInspector();
});

// ---------------------------------------------------------------- demo player
async function narrate(text: string, id: string) {
  const n = $('narration');
  n.textContent = text;
  n.hidden = false;
  mark('narrate', id, text);
  await speakOrWait(text, `${id}.narrator`);
  n.hidden = true;
}

async function chapter(text: string, id: string) {
  $('chapter-text').textContent = text;
  $('chapter').hidden = false;
  mark('chapter', id, text);
  await sleep(1600);
  $('chapter').hidden = true;
}

async function playDemo() {
  const script = (await (await fetch(`/demo-script.json?script=${params.get('script') ?? ''}`)).json()) as { steps: Step[] };
  await fetch('/api/demo/reset', { method: 'POST' });
  await fetch('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true, conversationId: 'sim' }) });
  seenAlerts.clear();
  for (const a of (await readJson('home://alerts')).recent ?? []) seenAlerts.add(a.id);
  await refreshAmbient();
  await sleep(800);
  for (const step of script.steps) {
    switch (step.type) {
      case 'narrate':
        await narrate(step.text!, step.id);
        break;
      case 'chapter':
        await chapter(step.text!, step.id);
        break;
      case 'say':
        await ask(step.text!, step.id);
        await sleep(600);
        break;
      case 'advance': {
        await teardownApp();
        screen.dataset.state = 'home';
        screen.dataset.ui = 'none';
        $('user-bubble').hidden = true;
        $('reply').hidden = true;
        $('chapter-text').textContent = step.text ?? '';
        $('chapter').hidden = false;
        mark('chapter', step.id, step.text);
        const alertShown = step.expectAlert ? waitForAlert() : Promise.resolve();
        await fetch('/api/demo/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: step.days }) });
        await refreshAmbient();
        await sleep(1600);
        $('chapter').hidden = true;
        await alertShown;
        await sleep(400);
        break;
      }
      case 'inspector':
        toggleInspector(step.open);
        await sleep(1200);
        break;
      case 'wait':
        await sleep(step.ms ?? 1000);
        break;
    }
  }
  mark('end');
  (window as any).__homeAhead.done = true;
}

function waitForAlert(): Promise<void> {
  return new Promise((resolve) => {
    const before = alertsSpoken;
    const timer = setInterval(() => {
      if (alertsSpoken > before) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 15000 / SPEED);
  });
}

// ---------------------------------------------------------------- boot
(async () => {
  await connectMcp();
  await refreshAmbient();
  (window as any).__homeAhead.ready = true;
  (window as any).__homeAhead.ask = ask;
  (window as any).__homeAhead.calls = callLog;
  if (DEMO) {
    const wait = Number(params.get('startDelay') ?? 0);
    if (wait) await sleep(wait);
    await playDemo();
  }
})();
