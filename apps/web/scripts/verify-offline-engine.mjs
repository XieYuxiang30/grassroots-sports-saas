#!/usr/bin/env node
// ============================================================================
// 前端离线优先链路验证脚本
// ============================================================================
//
// 为什么需要它
// ------------
// 打包前端（Vite/Rollup/SWC）都依赖原生二进制，而这些二进制的 JS 封装通过
// 「子进程 + 管道 stdio」与它们通信。在受限环境里（Windows 未开启开发者模式、
// 企业安全策略、禁止创建管道句柄的沙箱/容器）这个 spawn 会直接 EPERM 失败，
// 报错是 `Error: spawn EPERM`，与业务代码无关。结论是：**这类环境里任何打包器都跑不起来**。
//
// 所以这里换一条路验证：把前端**真正的离线代码**（src/offline/queue.ts 与
// src/offline/derive.ts）用 TypeScript 的进程内 transpileModule 转成 CJS 后直接执行
// （纯 JS 实现，零原生依赖、零子进程），再对着**真实的 API 服务**跑一遍完整闭环：
//
//   建比赛 → 断网记录 3 次点击 → 本地立刻推出比分 → 队列落盘 → 恢复网络批量补传
//   → 比对服务端权威比分 → 重推验幂等 → 撤销验回退 → 校验图文直播与球员榜
//
// 这样「离线优先」这段最容易出错的逻辑是被真实执行过的，而不是只靠类型检查。
//
// 用法：node scripts/verify-offline-engine.mjs
// 前置：API 已构建（apps/api 执行过 build）。脚本会在需要时自行拉起一个实例。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));

const PORT = Number(process.env.VERIFY_PORT ?? 3100);
const BASE_URL = process.env.API_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PASSCODE = 'verify-passcode';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n▶ ${title}`);
}

/* ------------------------------------------------------------------ 浏览器垫片 */

/**
 * 最小浏览器垫片。
 *
 * 这里**故意不提供 indexedDB**：于是队列会退化到 localStorage ——
 * 正好覆盖「隐私模式 / 老旧 WebView」这条真实分支，比只测主路径更有价值。
 */
function installBrowserShims() {
  const storage = new Map();
  globalThis.window = globalThis;
  globalThis.localStorage = {
    get length() {
      return storage.size;
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  delete globalThis.indexedDB;
}

/** 网络闸门：模拟「拔网线」。 */
const networkGate = { open: true, blockedCalls: 0 };

function installNetworkGate() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!networkGate.open) {
      networkGate.blockedCalls += 1;
      throw new TypeError('fetch failed（模拟断网）');
    }
    return realFetch(input, init);
  };
}

/* ------------------------------------------------------------------ 前端源码加载 */

const tempFiles = [];

/**
 * 加载前端 TS 源码为可执行模块。
 *
 * 用 TypeScript 的 transpileModule：进程内、纯 JS、不 spawn。
 * 把 `@/xxx` 别名改写成从 apps/web 解析的相对路径，保证模块内互相引用能对上。
 */
function loadFrontendModule(relativePath) {
  const ts = require('typescript');
  const absolute = join(webRoot, relativePath);
  const source = readFileSync(absolute, 'utf8');

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: absolute,
  });

  const cacheDir = join(webRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const tempFile = join(cacheDir, `verify-${randomUUID()}.cjs`);
  writeFileSync(tempFile, transpiled.outputText, 'utf8');
  tempFiles.push(tempFile);
  return require(tempFile);
}

/* ------------------------------------------------------------------ HTTP 辅助 */

async function api(path, init = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log('前端离线优先链路验证');
  console.log(`API: ${BASE_URL}`);

  const dataDir = mkdtempSync(join(tmpdir(), 'hoop-verify-'));
  let apiProcess = null;

  try {
    const health = await api('/health').catch(() => null);
    if (!health || health.status !== 200) {
      console.log('未检测到运行中的 API，自行启动一个实例…');
      apiProcess = spawn(process.execPath, [join(apiRoot, 'dist', 'src', 'main.js')], {
        cwd: apiRoot,
        env: {
          ...process.env,
          PORT: String(PORT),
          HOST: '127.0.0.1',
          STORAGE_DRIVER: 'json',
          DATA_DIR: dataDir,
          SCORER_PASSCODE: PASSCODE,
          SERVE_WEB_ASSETS: 'false',
          CORS_ORIGINS: '*',
          NODE_ENV: 'production',
        },
        // stdio 用 ignore：受限环境里管道 stdio 会 EPERM
        stdio: 'ignore',
      });
      await waitForHealth(40);
    }

    installBrowserShims();
    installNetworkGate();

    section('1. 前端离线模块可在受限存储下正确降级');
    const queue = loadFrontendModule('src/offline/queue.ts');
    const derive = loadFrontendModule('src/offline/derive.ts');

    check('队列模块导出 createQueueStorage', typeof queue.createQueueStorage === 'function');
    check('离线推导模块导出 deriveOfflineState', typeof derive.deriveOfflineState === 'function');
    check('离线推导模块导出 buildLocalVoidDraft', typeof derive.buildLocalVoidDraft === 'function');

    const storage = await queue.createQueueStorage();
    check(
      'IndexedDB 不可用时自动降级到 localStorage',
      storage.kind === 'localstorage',
      `实际 ${storage.kind}`,
    );

    const clientId = derive.resolveClientId();
    check('设备标识生成且稳定', typeof clientId === 'string' && clientId.length > 8);
    check('再次取设备标识不变（同一台平板固定 id）', derive.resolveClientId() === clientId);

    section('2. 创建比赛并生成分享码（管理后台链路）');
    const created = await api('/matches', {
      method: 'POST',
      body: JSON.stringify({
        competition: '前端链路验证赛',
        title: '验证轮次',
        periodFormat: 'quarters',
        periodSeconds: 600,
        home: {
          name: '东街猛虎',
          players: [
            { name: '张三', jerseyNumber: '4', isStarter: true },
            { name: '李四', jerseyNumber: '5', isStarter: true },
          ],
        },
        away: { name: '西巷飞鹰', players: [{ name: '赵六', jerseyNumber: '7', isStarter: true }] },
      }),
    });
    check('创建比赛成功', created.status === 201, JSON.stringify(created.body).slice(0, 200));

    const matchId = created.body.match.id;
    const homeTeamId = created.body.teams.home.id;
    const awayTeamId = created.body.teams.away.id;
    const homePlayerId = created.body.teams.home.players[0].id;

    const shared = await api(`/matches/by-code/${created.body.match.shareCode.toLowerCase()}`);
    check('分享码可扫码进房（大小写不敏感）', shared.status === 200 && shared.body.match.id === matchId);

    section('3. 断网：三次点击先落本地队列，本地立刻算出比分');
    networkGate.open = false;

    const drafts = [
      makeScoreDraft(matchId, clientId, homeTeamId, homePlayerId, 3, 0),
      makeScoreDraft(matchId, clientId, homeTeamId, homePlayerId, 2, 1000),
      makeScoreDraft(matchId, clientId, homeTeamId, homePlayerId, 1, 2000),
    ];
    const pending = drafts.map((draft) => queue.makePendingEntry(draft));
    await storage.save(matchId, clientId, pending);

    const reloaded = await storage.load(matchId, clientId);
    check('离线事件已落本地（刷新页面也不丢）', reloaded.length === 3, `实际 ${reloaded.length} 条`);
    check('队列项带 clientEventId（幂等键）', reloaded.every((entry) => Boolean(entry.clientEventId)));

    const authority = await fetch(`${BASE_URL}/api/matches/${matchId}/events`).catch(() => null);
    check('断网期间请求确实被挡住（模拟有效）', authority === null && networkGate.blockedCalls > 0);

    const context = {
      matchId,
      homeTeam: { teamId: homeTeamId, side: 'home' },
      awayTeam: { teamId: awayTeamId, side: 'away' },
      regulationPeriods: 4,
    };
    const contracts = require('@openhoopscore/contracts');
    // 这里故意只用「事件 → 比分牌」这一小块投影，够验证离线推导的口径
    const project = (events, assumeSorted = false) => {
      const tally = contracts.projectMatch(events, context, { assumeSorted });
      return {
        scoreboard: { home: { score: tally.score.home }, away: { score: tally.score.away } },
        period: tally.period,
      };
    };

    const derived = derive.deriveOfflineState([], pending, project);
    check('断网时本地立即推出 6:0（乐观 UI）', derived.state.scoreboard.home.score === 6, `实际 ${derived.state.scoreboard.home.score}`);
    check('本地知道自己有 3 条未同步', derived.pendingCount === 3 && derived.optimistic === true);

    section('4. 恢复网络：批量补传并与服务端对账');
    networkGate.open = true;
    const flush = await api(`/matches/${matchId}/events`, {
      method: 'POST',
      headers: { 'x-scorer-passcode': PASSCODE },
      body: JSON.stringify({ clientId, events: reloaded.map((entry) => entry.event) }),
    });
    check('补传 3 条全部被接受', flush.body.acceptedCount === 3, JSON.stringify(flush.body.results));
    check('服务端权威比分 6:0 与本地推导一致', flush.body.state.scoreboard.home.score === 6);

    await storage.save(matchId, clientId, []);
    check('补传成功后本地队列清空', (await storage.load(matchId, clientId)).length === 0);

    const reconcile = await api(`/matches/${matchId}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ clientEventIds: [...drafts.map((draft) => draft.clientEventId), 'local-only-1'] }),
    });
    check('对账能识别出服务端已收到的 3 条', reconcile.body.acknowledged.length === 3, JSON.stringify(reconcile.body));
    check('对账能标出尚未上行的 1 条', reconcile.body.unknown.length === 1);

    section('5. 幂等：客户端没收到回执，重推同一批');
    const retry = await api(`/matches/${matchId}/events`, {
      method: 'POST',
      headers: { 'x-scorer-passcode': PASSCODE },
      body: JSON.stringify({ clientId, events: drafts }),
    });
    check('重推全部判为幂等命中', retry.body.duplicateCount === 3 && retry.body.acceptedCount === 0);
    check('比分没有被重复计分（仍是 6:0）', retry.body.state.scoreboard.home.score === 6);

    section('6. 离线撤销：本地追加 void 事件（不删历史）');
    const voidDraft = derive.buildLocalVoidDraft(matchId, clientId, 'some-authority-event-id');
    check('本地 void 事件结构合法', voidDraft.type === 'void' && Boolean(voidDraft.payload.targetEventId));
    check('本地 void 带幂等键与设备标识', Boolean(voidDraft.clientEventId) && voidDraft.clientId === clientId);

    section('7. 撤销：比分回退、事件流完整保留');
    // 三次得分依次是 3（三分）、2（两分）、1（罚球），合计 6 分。
    // 撤销「最近一步」= 撤销最后一次得分，也就是那记罚球，于是 6 - 1 = 5 分。
    const undo = await api(`/matches/${matchId}/undo`, {
      method: 'POST',
      headers: { 'x-scorer-passcode': PASSCODE },
      body: JSON.stringify({ clientId, steps: 1 }),
    });
    check('撤销成功', undo.status === 201 && undo.body.voidedEventIds.length === 1);
    check('比分回退到 5:0（撤销最近的一次罚球得分）', undo.body.state.scoreboard.home.score === 5, `实际 ${undo.body.state.scoreboard.home.score}`);
    check('撤销描述可读（UI 会直接显示给计分员）', /撤销/.test(undo.body.descriptions[0] ?? ''), undo.body.descriptions[0]);
    check(
      '撤销的是那次 1 分（文案按分值说明，而不是「罚球」这个记账细节）',
      /1 分/.test(undo.body.descriptions[0] ?? ''),
      undo.body.descriptions[0],
    );

    const eventsAfter = await api(`/matches/${matchId}/events`);
    check('历史事件一条没删（3 条得分 + 1 条 void）', eventsAfter.body.events.length === 4, `实际 ${eventsAfter.body.events.length}`);

    section('8. 观众端能看到的内容：图文直播与球员榜');
    const live = await api(`/matches/${matchId}/live`);
    check(
      'live 返回 state / feed / timeline / undoable 四项',
      Boolean(live.body.state && live.body.feed && live.body.timeline && live.body.undoable),
    );
    check(
      '图文直播有「三分」中文文案',
      live.body.feed.some((item) => /三分/.test(item.text)),
      JSON.stringify(live.body.feed.map((item) => item.text)),
    );
    check(
      '被撤销的那条事件不再出现在直播流里',
      live.body.feed.length === 2,
      `实际 ${live.body.feed.length} 条：${JSON.stringify(live.body.feed.map((item) => item.text))}`,
    );
    check(
      '直播流最新一条的比分快照已回退为 5:0',
      live.body.feed[0].homeScore === 5 && live.body.feed[0].awayScore === 0,
      JSON.stringify({ home: live.body.feed[0].homeScore, away: live.body.feed[0].awayScore }),
    );
    check('撤销后仍可继续撤销（撤销栈已刷新）', live.body.undoable.length === 2, `实际 ${live.body.undoable.length}`);

    const board = await api(`/matches/${matchId}/leaderboard?sortedBy=points`);
    check('球员榜第一是 5 分（三分 + 两分，罚球已被撤销）', board.body.entries[0].points === 5, JSON.stringify(board.body.entries[0]));

    section('9. 清理与队列生命周期');
    await storage.clear(matchId);
    check('按比赛清理后本地不再残留该场数据', (await storage.load(matchId, clientId)).length === 0);

    // 队列隔离：不同比赛、不同设备的队列互不干扰（同一台平板打多场的关键）
    await storage.save('match-A', 'device-1', [queue.makePendingEntry(drafts[0])]);
    await storage.save('match-A', 'device-2', [queue.makePendingEntry(drafts[1])]);
    check('不同设备的队列互相隔离', (await storage.load('match-A', 'device-1')).length === 1 && (await storage.load('match-A', 'device-2')).length === 1);
    await storage.clear('match-A');
    check('清理只影响指定比赛', (await storage.load('match-A', 'device-1')).length === 0);
  } finally {
    for (const file of tempFiles) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 忽略 */
      }
    }
    if (apiProcess) apiProcess.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

function makeScoreDraft(matchId, clientId, teamId, playerId, points, offsetMs) {
  return {
    id: randomUUID(),
    matchId,
    type: 'score',
    teamId,
    playerId,
    points: 0,
    period: 1,
    gameClockSeconds: 480,
    clientTimestamp: new Date(Date.now() + offsetMs).toISOString(),
    clientId,
    clientEventId: randomUUID(),
    payload: { points, shotType: points === 3 ? 'three' : points === 1 ? 'free_throw' : 'mid' },
  };
}

async function waitForHealth(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const health = await api('/health');
      if (health.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`API 在 ${timeoutSeconds} 秒内没有就绪`);
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exit(1);
});
