// 데모 영상 제작기: 시뮬레이터 데모를 두 번 돌려(대사 수집 → 녹화) Kokoro 음성과 ffmpeg로 mp4·자막·스크린샷을 만든다
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { startApp } from '../src/app.js';

const HERE = import.meta.dirname;
const OUT = join(HERE, 'out');
const AUDIO = join(OUT, 'audio');
const MAX_SECONDS = 175; // the rules ask for "less than three (3) minutes"; keep a margin
const VOICES = { narrator: 'am_michael', user: 'af_sarah', assistant: 'af_heart' } as const;
const PAD_MS = 250;

type Step = { id: string; type: string; text?: string; speak?: string };
type DemoEvent = { t: number; wall: number; type: string; id?: string; text?: string };
type Line = { key: string; role: keyof typeof VOICES; text: string; spoken: string; wall: number };

const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8')) as { steps: Step[] };

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

async function playDemo(browser: Browser, url: string, opts: { speed: number; durations?: Record<string, number>; videoDir?: string }) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: { width: 1920, height: 1080 } } } : {}),
  });
  if (opts.durations) await context.addInitScript((d) => ((window as any).__homeAheadDurations = d), opts.durations);
  const page = await context.newPage();
  const videoStart = Date.now();
  await page.goto(`${url}/?demo=1&record&tts=0&speed=${opts.speed}&startDelay=1200`);
  await page.waitForFunction(() => (window as any).__homeAhead?.done === true, null, { timeout: 15 * 60_000, polling: 500 });
  await page.waitForTimeout(1500 / opts.speed);
  const events = (await page.evaluate(() => (window as any).__homeAhead.events)) as DemoEvent[];
  const video = page.video();
  await context.close();
  return { events, videoStart, videoPath: video ? await video.path() : undefined };
}

async function synthesize(lines: Line[]): Promise<Record<string, number>> {
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const durations: Record<string, number> = {};
  for (const line of lines) {
    const audio = await tts.generate(line.spoken, { voice: VOICES[line.role], speed: 1.1 });
    await audio.save(join(AUDIO, `${line.key}.wav`));
    durations[line.key] = Math.round((audio.audio.length / audio.sampling_rate) * 1000) + PAD_MS;
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return durations;
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
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(AUDIO, { recursive: true });
  const app = await startApp(
    { HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_AGENT: 'planner', HOME_AHEAD_VIDEO_SAFE: '1' },
    { port: 0 },
  );
  const browser = await chromium.launch();
  try {
    console.log('1/4 dry run to collect every spoken line');
    const dry = await playDemo(browser, app.server.url, { speed: 10 });
    const lines = linesFrom(dry.events);

    console.log(`2/4 synthesizing ${lines.length} lines with Kokoro-82M`);
    const durations = await synthesize(lines);

    console.log('3/4 recording the simulator at real speed');
    const rec = await playDemo(browser, app.server.url, { speed: 1, durations, videoDir: join(OUT, 'raw') });
    const raw = join(OUT, 'raw.webm');
    renameSync(rec.videoPath!, raw);
    // Each voice clip starts where the simulator marked its line; lines missing from the dry run stay silent.
    const cues = linesFrom(rec.events)
      .filter((l) => durations[l.key] !== undefined)
      .map((l) => ({ ...l, at: l.wall - rec.videoStart, ms: durations[l.key] }));
    writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ events: rec.events, cues }, null, 2));
    writeFileSync(
      join(OUT, 'home-ahead-demo.srt'),
      cues.map((c, i) => `${i + 1}\n${srtTime(c.at)} --> ${srtTime(c.at + c.ms - PAD_MS)}\n${c.text}\n`).join('\n'),
    );

    console.log('4/4 mixing voice-over and encoding');
    const args = ['-y', '-i', raw];
    for (const c of cues) args.push('-i', join(AUDIO, `${c.key}.wav`));
    const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, c.at)}:all=1[a${i}]`).join(';');
    const mix = `${delays};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
    const mp4 = join(OUT, 'home-ahead-demo.mp4');
    args.push('-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest', mp4);
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const seconds = ffprobeSeconds(mp4);

    // Devpost gallery images (3:2): the whole 16:9 frame, letterboxed in the page color.
    const shots: [string, string, number][] = [
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
    await app.close();
  }
}

await main();
