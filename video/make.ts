// 데모 영상 제작기: 시뮬레이터 데모를 두 번 돌려(대사 수집 → CDP 화면 캡처) Kokoro 음성·알림 차임과 ffmpeg로 mp4·자막·스크린샷을 만든다(--live 는 실모델 컷)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { KokoroTTS } from 'kokoro-js';
import { startApp } from '../src/app.js';

const HERE = import.meta.dirname;
// --live: the shorter cut where a live model (Claude through the Strands agent) writes every reply.
const LIVE = process.argv.includes('--live');
const OUT = join(HERE, LIVE ? 'out_live' : 'out');
const NAME = LIVE ? 'home-ahead-demo-live' : 'home-ahead-demo';
const AUDIO = join(OUT, 'audio');
// Live replies are only known while recording, so the simulator holds each one this long per word.
const LIVE_PACE_MS = 430;
const MAX_SECONDS = 175; // the rules ask for "less than three (3) minutes"; keep a margin
const VOICES = { narrator: 'am_michael', user: 'af_sarah', assistant: 'af_heart' } as const;
const PAD_MS = 250;

type Step = { id: string; type: string; text?: string; speak?: string };
type DemoEvent = { t: number; wall: number; type: string; id?: string; text?: string };
type Line = { key: string; role: keyof typeof VOICES; text: string; spoken: string; wall: number };

const script = JSON.parse(readFileSync(join(HERE, LIVE ? 'script-live.json' : 'script.json'), 'utf8')) as { steps: Step[] };

/** Every line that gets a voice, keyed the way the simulator looks up durations. */
function linesFrom(events: DemoEvent[]): Line[] {
  const speakOverride = new Map(script.steps.filter((s) => s.speak).map((s) => [s.id, s.speak!]));
  const lines: Line[] = [];
  for (const e of events) {
    if (!e.id || !e.text) continue;
    const base = { text: e.text, spoken: e.text, wall: e.wall };
    if (e.type === 'narrate') lines.push({ ...base, key: `${e.id}.narrator`, role: 'narrator' });
    if (e.type === 'user') lines.push({ ...base, key: `${e.id}.user`, role: 'user', spoken: speakOverride.get(e.id) ?? e.text });
    if (e.type === 'assistant' || e.type === 'alert') lines.push({ ...base, key: `${e.id}.assistant`, role: 'assistant' });
  }
  return lines;
}

type Frame = { file: string; at: number };

/**
 * Plays the scripted demo. With `framesDir`, captures the screen through the Chrome DevTools
 * screencast as high-quality JPEG frames with their own timestamps. Playwright's built-in recorder
 * encodes at a fixed ~1 Mbps, which blurs small text at 1080p.
 */
async function playDemo(browser: Browser, url: string, opts: { speed: number; durations?: Record<string, number>; framesDir?: string }) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  if (opts.durations) await context.addInitScript((d) => ((window as any).__homeAheadDurations = d), opts.durations);
  const page = await context.newPage();
  const frames: Frame[] = [];
  const cdp = opts.framesDir ? await context.newCDPSession(page) : undefined;
  if (cdp && opts.framesDir) {
    const dir = opts.framesDir;
    mkdirSync(dir, { recursive: true });
    cdp.on('Page.screencastFrame', (f) => {
      // Ack first: Chrome captures the next frame only after the ack, so a slow write here would
      // delay the capture of every screen change and put the picture behind the voice.
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      frames.push({ file, at: f.metadata.timestamp ? f.metadata.timestamp * 1000 : Date.now() });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 });
  }
  const videoStart = Date.now();
  await page.goto(`${url}/?demo=1&record&tts=0&speed=${opts.speed}&startDelay=1200${LIVE ? `&script=live&pace=${LIVE_PACE_MS}` : ''}`);
  await page.waitForFunction(() => (window as any).__homeAhead?.done === true, null, { timeout: 15 * 60_000, polling: 500 });
  await page.waitForTimeout(1500 / opts.speed);
  const videoEnd = Date.now();
  if (cdp) await cdp.send('Page.stopScreencast');
  const events = (await page.evaluate(() => (window as any).__homeAhead.events)) as DemoEvent[];
  await context.close();
  return { events, videoStart, videoEnd, frames };
}

/** An ffconcat list that holds each frame until the next one; the first frame covers from `start` (ms, wall clock). */
function frameList(frames: Frame[], start: number, end: number): string {
  const name = (f: Frame) => `file '${f.file.replace(/\\/g, '/')}'`;
  const out = ['ffconcat version 1.0'];
  let last = frames[0];
  frames.forEach((f, i) => {
    const from = i === 0 ? start : f.at;
    const to = i + 1 < frames.length ? frames[i + 1].at : end;
    // A frame replaced within the same millisecond (or one that landed inside a cut) is never seen;
    // listing it anyway still costs one demuxer frame and pushes everything after it late.
    if (to - from < 1 && i + 1 < frames.length) return;
    out.push(name(f), `duration ${(Math.max(to - from, 1) / 1000).toFixed(4)}`);
    last = f;
  });
  out.push(name(last));
  return `${out.join('\n')}\n`;
}

type Cut = { from: number; to: number };

/**
 * Live cut: the simulator held each model reply on screen for a word-count estimate, longer than its
 * voice-over turned out to be. Cut that silent, unchanging tail (keeping half a second) from the video.
 * Only the time after a reply has been read is cut; the wait for the model before it stays.
 */
function silentTails(cues: { key: string; role: string; at: number; ms: number }[], marks: number[]): Cut[] {
  const cuts: Cut[] = [];
  for (const c of cues.filter((x) => x.role === 'assistant' && !x.key.startsWith('alert-'))) {
    const from = c.at + c.ms + 500;
    const to = marks.find((m) => m > c.at + 50) ?? from;
    if (to - from > 100) cuts.push({ from, to });
  }
  return cuts;
}

/** Video time after removing the cuts; a moment inside a cut lands on its start. */
function shiftForCuts(t: number, cuts: Cut[]): number {
  let out = t;
  for (const c of cuts) {
    if (t >= c.to) out -= c.to - c.from;
    else if (t > c.from) out -= t - c.from;
  }
  return out;
}

/** Two soft tones (660 Hz, then 880 Hz): the chime the simulator plays with WebAudio, which a screen capture cannot hear. */
function makeChime(file: string) {
  const expr = '0.22*sin(2*PI*660*t)*exp(-7*t)+0.22*sin(2*PI*880*(t-0.18))*exp(-7*(t-0.18))*gte(t\\,0.18)';
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=24000:d=0.9`, file], { stdio: 'ignore' });
}

async function loadTts(): Promise<KokoroTTS> {
  const { KokoroTTS } = await import('kokoro-js');
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
}

/** Writes the line's wav and returns its length plus padding (ms). */
async function synthOne(tts: KokoroTTS, line: Line, speed = 1.1): Promise<number> {
  const audio = await tts.generate(line.spoken, { voice: VOICES[line.role], speed });
  await audio.save(join(AUDIO, `${line.key}.wav`));
  return Math.round((audio.audio.length / audio.sampling_rate) * 1000) + PAD_MS;
}

async function synthesize(tts: KokoroTTS, lines: Line[]): Promise<Record<string, number>> {
  const durations: Record<string, number> = {};
  for (const line of lines) {
    durations[line.key] = await synthOne(tts, line);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return durations;
}

/**
 * Live cut: voices the replies the model gave while recording. Each must end before the next thing on
 * screen; a reply that runs long is read a little faster (at most 1.35x) to fit its slot.
 */
async function voiceLiveReplies(tts: KokoroTTS, events: DemoEvent[], durations: Record<string, number>): Promise<string[]> {
  const notes: string[] = [];
  for (const line of linesFrom(events).filter((l) => durations[l.key] === undefined)) {
    const next = events.find((e) => e.wall > line.wall && e.type !== 'assistant');
    const slot = (next ? next.wall - line.wall : 10_000) - 150;
    let ms = await synthOne(tts, line);
    if (ms - PAD_MS > slot) {
      const speed = Math.min(1.35, (1.1 * (ms - PAD_MS)) / slot);
      ms = await synthOne(tts, line, speed);
      notes.push(`${line.key}: read at ${speed.toFixed(2)}x to fit ${slot} ms${ms - PAD_MS > slot ? ' (still runs over)' : ''}`);
    }
    durations[line.key] = ms;
  }
  return notes;
}

const srtTime = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

function ffprobeSeconds(file: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

async function main() {
  if (LIVE) {
    const envFile = join(HERE, '..', '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('--live needs ANTHROPIC_API_KEY (put it in .env).');
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(AUDIO, { recursive: true });
  const base = { HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_VIDEO_SAFE: '1' };
  const app = await startApp({ ...base, HOME_AHEAD_AGENT: 'planner' }, { port: 0 });
  // The live cut records against a second app whose agent is the model; the planner app only collects lines.
  const recApp = LIVE
    ? await startApp({ ...base, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, HOME_AHEAD_USAGE_LOG: join(OUT, 'claude-usage.jsonl') }, { port: 0 })
    : app;
  if (LIVE && recApp.agent.mode !== 'strands') throw new Error('The live app did not start the Strands agent.');
  const browser = await chromium.launch();
  try {
    console.log('1/4 dry run to collect every spoken line');
    const dry = await playDemo(browser, app.server.url, { speed: 10 });
    // In the live cut the model's replies are unknown until recording; voice only the fixed lines now.
    const lines = linesFrom(dry.events).filter((l) => !LIVE || l.role !== 'assistant' || l.key.startsWith('alert-'));

    console.log(`2/4 synthesizing ${lines.length} lines with Kokoro-82M`);
    const tts = await loadTts();
    const durations = await synthesize(tts, lines);

    console.log(`3/4 recording the simulator at real speed${LIVE ? ` (live model: ${recApp.agent.modelLabel})` : ''}`);
    const framesDir = join(OUT, 'frames');
    const rec = await playDemo(browser, recApp.server.url, { speed: 1, durations, framesDir });
    const fitNotes = LIVE ? await voiceLiveReplies(tts, rec.events, durations) : [];
    for (const n of fitNotes) console.log(`  ${n}`);
    // Each voice clip starts where the simulator marked its line; lines missing from the dry run stay silent.
    const rawCues = linesFrom(rec.events)
      .filter((l) => durations[l.key] !== undefined)
      .map((l) => ({ ...l, at: l.wall - rec.videoStart, ms: durations[l.key] }));
    const cuts = LIVE ? silentTails(rawCues, rec.events.map((e) => e.wall - rec.videoStart)) : [];
    const at = (t: number) => shiftForCuts(t, cuts);
    const list = join(OUT, 'frames.txt');
    const frames = rec.frames.map((f) => ({ ...f, at: rec.videoStart + at(f.at - rec.videoStart) }));
    writeFileSync(list, frameList(frames, rec.videoStart, rec.videoStart + at(rec.videoEnd - rec.videoStart)));
    const cues = rawCues.map((c) => ({ ...c, at: at(c.at) }));
    const chimes = rec.events.filter((e) => e.type === 'chime').map((e) => at(e.wall - rec.videoStart));
    const chime = join(AUDIO, 'chime.wav');
    makeChime(chime);
    writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ events: rec.events, cues, chimes, frames: rec.frames.length, fitNotes, cuts }, null, 2));
    writeFileSync(
      join(OUT, `${NAME}.srt`),
      cues.map((c, i) => `${i + 1}\n${srtTime(c.at)} --> ${srtTime(c.at + c.ms - PAD_MS)}\n${c.text}\n`).join('\n'),
    );

    console.log('4/4 mixing voice-over and encoding');
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
    const clips = [...cues.map((c) => ({ file: join(AUDIO, `${c.key}.wav`), at: c.at })), ...chimes.map((at) => ({ file: chime, at }))];
    for (const c of clips) args.push('-i', c.file);
    const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, c.at)}:all=1[a${i}]`).join(';');
    const mix =
      `[0:v]fps=30,format=yuv420p[vout];${delays};` +
      `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
    const mp4 = join(OUT, `${NAME}.mp4`);
    args.push('-filter_complex', mix, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mp4);
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    rmSync(framesDir, { recursive: true, force: true });
    const seconds = ffprobeSeconds(mp4);

    // Devpost gallery images (3:2): the whole 16:9 frame, letterboxed in the page color.
    const shots: [string, string, number][] = LIVE
      ? [
          ['live-1-recall-card', 'a2.assistant', 1500],
          ['live-2-cart', 'b2.assistant', 1500],
          ['live-3-recall-guidance', 'c2.assistant', 1500],
        ]
      : [
          ['1-recall-card', 'a2.assistant', 1500],
          ['2-safety-plan', 'b1.assistant', 1500],
          ['3-cart', 'b2.assistant', 1500],
          ['4-recall-alert', 'alert-1.assistant', 1500],
          ['5-inspector', 'outro.narrator', -400],
        ];
    for (const [name, key, offset] of shots) {
      const cue = cues.find((c) => c.key === key);
      if (!cue) continue;
      const at = Math.max(0, (cue.at + offset) / 1000);
      execFileSync('ffmpeg', ['-y', '-ss', String(at), '-i', mp4, '-frames:v', '1', '-vf', 'scale=1500:-2,pad=1500:1000:0:(oh-ih)/2:color=0x15120f', join(OUT, `${name}.png`)], { stdio: 'ignore' });
    }
    console.log(`Video: ${mp4} (${seconds.toFixed(1)} s)`);
    if (seconds >= MAX_SECONDS) {
      console.error(`Too long: ${seconds.toFixed(1)} s. The limit we keep is ${MAX_SECONDS} s.`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    if (recApp !== app) await recApp.close();
    await app.close();
  }
}

await main();
