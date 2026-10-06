#!/usr/bin/env node
// ============================================================================
// 开发数据种子（Prisma 驱动）
// ============================================================================
// 用途：本地起好 PostgreSQL 后，一条命令得到「一场可直接计分的比赛」，
// 省去每次手动建赛事、录名单的重复劳动。
//
// 用法：
//   docker compose --profile full up -d
//   pnpm --filter @openhoopscore/api db:deploy   # 建表
//   pnpm --filter @openhoopscore/api db:seed     # 灌数据
//
// 幂等：以分享码 SEED01 作为标记，重复执行不会造出第二场种子比赛。

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_SHARE_CODE = 'SEED01';

const HOME_PLAYERS = [
  { name: '张三', jerseyNumber: '4', isStarter: true },
  { name: '李四', jerseyNumber: '5', isStarter: true },
  { name: '王五', jerseyNumber: '6', isStarter: true },
  { name: '赵六', jerseyNumber: '7', isStarter: false },
];

const AWAY_PLAYERS = [
  { name: '钱七', jerseyNumber: '8', isStarter: true },
  { name: '孙八', jerseyNumber: '9', isStarter: true },
  { name: '周九', jerseyNumber: '10', isStarter: true },
];

async function main() {
  const existing = await prisma.match.findUnique({ where: { shareCode: SEED_SHARE_CODE } });
  if (existing) {
    console.log(`种子比赛已存在（分享码 ${SEED_SHARE_CODE}），跳过。`);
    console.log(`  比赛 id：${existing.id}`);
    return;
  }

  const season = await prisma.season.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: '社区篮球联赛（种子数据）',
      organizer: '街道文体站',
    },
  });

  // 先建比赛（外键列填占位），再建队伍并回填：与 PrismaStore.createMatch 同构
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      competition: '社区篮球联赛（种子数据）',
      title: 'A 组第 1 轮',
      venue: '街道体育馆',
      status: 'scheduled',
      periodFormat: 'quarters',
      periodSeconds: 600,
      regulationPeriods: 4,
      shareCode: SEED_SHARE_CODE,
      homeTeamId: '00000000-0000-4000-8000-0000000000a1',
      awayTeamId: '00000000-0000-4000-8000-0000000000a2',
    },
  });

  const home = await prisma.team.create({
    data: {
      matchId: match.id,
      side: 'home',
      name: '东街猛虎',
      shortName: '猛虎',
      color: '#E4572E',
      players: { create: HOME_PLAYERS },
    },
  });
  const away = await prisma.team.create({
    data: {
      matchId: match.id,
      side: 'away',
      name: '西巷飞鹰',
      shortName: '飞鹰',
      color: '#2563EB',
      players: { create: AWAY_PLAYERS },
    },
  });

  await prisma.match.update({
    where: { id: match.id },
    data: { homeTeamId: home.id, awayTeamId: away.id },
  });

  console.log('已创建种子比赛：');
  console.log(`  比赛 id   ：${match.id}`);
  console.log(`  分享码     ：${SEED_SHARE_CODE}`);
  console.log(`  计分台     ：/score/${match.id}`);
  console.log(`  观众端     ：/live/${match.id}`);
  console.log(`  大屏       ：/display/${match.id}`);
}

main()
  .catch((error) => {
    console.error('种子数据写入失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
