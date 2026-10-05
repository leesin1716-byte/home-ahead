// 앱 구성 요소(시계·리콜 색인·저장소·규칙·카탈로그·서비스)를 설정값으로 한 번에 만든다
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecallIndex } from './cpsc/index.js';
import { Clock } from './domain/clock.js';
import { loadRules, type RuleFile } from './domain/rules.js';
import { HomeService, type Catalog } from './domain/service.js';
import type { Household } from './domain/types.js';
import { emptyHousehold, HouseholdStore } from './store/store.js';

export const ROOT = join(import.meta.dirname, '..');
export const DATA_DIR = join(ROOT, 'data');

export interface AppConfig {
  host: string;
  port: number;
  /** null keeps state in memory only. */
  stateFile: string | null;
  /** Never call the live CPSC API; use the bundled snapshot only. */
  offline: boolean;
  /** Hide third-party brand names on screen (for recording the demo video). */
  videoSafe: boolean;
  /** Start from the demo household and demo clock. */
  demo: boolean;
  /** Minutes between scheduled recall refreshes; 0 disables the timer. */
  refreshMinutes: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const flag = (v: string | undefined) => v === '1' || v === 'true';
  const demo = flag(env.HOME_AHEAD_DEMO);
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
    stateFile: demo ? null : (env.HOME_AHEAD_STATE ?? join(DATA_DIR, 'state', 'household.json')),
    offline: flag(env.HOME_AHEAD_OFFLINE),
    videoSafe: flag(env.HOME_AHEAD_VIDEO_SAFE),
    demo,
    refreshMinutes: Number(env.HOME_AHEAD_REFRESH_MINUTES ?? 360),
  };
}

export interface DemoSeed {
  clockStart: string;
  household: Household;
}

export function loadDemoSeed(): DemoSeed {
  return JSON.parse(readFileSync(join(DATA_DIR, 'demo', 'household.json'), 'utf8')) as DemoSeed;
}

export interface AppContext {
  config: AppConfig;
  clock: Clock;
  index: RecallIndex;
  rules: RuleFile;
  catalog: Catalog;
  store: HouseholdStore;
  service: HomeService;
  /** Listeners notified when alerts change (the MCP layer subscribes). */
  alertListeners: Set<() => void>;
  resetDemo(): void;
}

export function createContext(config: AppConfig): AppContext {
  const clock = new Clock();
  const index = RecallIndex.fromSnapshotFile(join(DATA_DIR, 'cpsc', 'snapshot.json'));
  const rules = loadRules(join(DATA_DIR, 'rules', 'hazards.json'));
  const catalog = JSON.parse(readFileSync(join(DATA_DIR, 'catalog.json'), 'utf8')) as Catalog;
  const seed = config.demo ? loadDemoSeed() : undefined;
  if (seed) clock.set(seed.clockStart);
  const store = new HouseholdStore(config.stateFile, () => (seed ? structuredClone(seed.household) : emptyHousehold(clock.now())));
  const alertListeners = new Set<() => void>();
  const service = new HomeService({
    store,
    index,
    rules,
    catalog,
    clock,
    videoSafe: config.videoSafe,
    onAlertsChanged: () => alertListeners.forEach((fn) => fn()),
  });
  return {
    config,
    clock,
    index,
    rules,
    catalog,
    store,
    service,
    alertListeners,
    resetDemo() {
      const s = loadDemoSeed();
      clock.set(s.clockStart);
      store.replace(s.household);
      alertListeners.forEach((fn) => fn());
    },
  };
}
