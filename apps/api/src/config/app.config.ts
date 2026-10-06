/**
 * 运行时配置。
 *
 * 所有配置集中在这里解析一次，业务代码只依赖 `AppConfig` 这个强类型对象，
 * 避免到处散落 `process.env.XXX` —— 现场部署时改环境变量即可切换行为。
 */
export type StorageDriver = 'json' | 'prisma' | 'memory';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  corsOrigins: string[] | '*';
  /** 计分员写操作口令；观众端只读，无需口令。 */
  scorerPasscode: string;
  storageDriver: StorageDriver;
  dataDir: string;
  databaseUrl: string | null;
  socket: {
    pingInterval: number;
    pingTimeout: number;
  };
  maxEventsPerMatch: number;
  maxSyncBatch: number;
  /** 生产模式下是否托管前端静态产物（apps/web/dist）。 */
  serveWebAssets: boolean;
  webDistDir: string;
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readCorsOrigins(value: string | undefined): string[] | '*' {
  if (!value || value.trim() === '*') return '*';
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readStorageDriver(value: string | undefined): StorageDriver {
  const normalized = (value ?? 'json').trim().toLowerCase();
  if (normalized === 'prisma' || normalized === 'postgres' || normalized === 'postgresql') return 'prisma';
  if (normalized === 'memory') return 'memory';
  return 'json';
}

export function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const storageDriver = readStorageDriver(process.env.STORAGE_DRIVER);

  if (storageDriver === 'prisma' && !process.env.DATABASE_URL) {
    throw new Error(
      'STORAGE_DRIVER=prisma 时必须提供 DATABASE_URL（可执行 `docker compose up -d` 拉起本地 PostgreSQL）。' +
        '若只想快速验证，请设置 STORAGE_DRIVER=json。',
    );
  }

  return {
    nodeEnv,
    port: readInt(process.env.PORT, 3000),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigins: readCorsOrigins(process.env.CORS_ORIGINS),
    scorerPasscode: process.env.SCORER_PASSCODE ?? 'hoop2024',
    storageDriver,
    dataDir: process.env.DATA_DIR ?? './data',
    databaseUrl: process.env.DATABASE_URL ?? null,
    socket: {
      pingInterval: readInt(process.env.SOCKET_PING_INTERVAL, 20_000),
      pingTimeout: readInt(process.env.SOCKET_PING_TIMEOUT, 25_000),
    },
    maxEventsPerMatch: readInt(process.env.MAX_EVENTS_PER_MATCH, 20_000),
    maxSyncBatch: readInt(process.env.MAX_SYNC_BATCH, 500),
    serveWebAssets: readBool(process.env.SERVE_WEB_ASSETS, nodeEnv === 'production'),
    webDistDir: process.env.WEB_DIST_DIR ?? '../web/dist',
  };
}

export const CONFIG_TOKEN = 'APP_CONFIG';

/** 投影内核版本号：多端比对「谁算错了」时非常有用。 */
export const PROJECTION_VERSION = '1.0.0';

export const SERVICE_VERSION = '1.0.0';
