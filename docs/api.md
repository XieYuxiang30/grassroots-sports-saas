# REST 与 Socket.IO 协议参考

后端默认端口 `3000`，全局前缀 `/api`。非生产环境可访问 `/docs` 查看 Swagger 交互文档。

所有错误响应统一结构（前端据 `code` 做本地化文案，不要匹配 message）：

```json
{ "statusCode": 404, "code": "MATCH_NOT_FOUND", "message": "比赛不存在：xxx", "error": "MATCH_NOT_FOUND" }
```

## 错误码表

| code | HTTP | 含义 |
|------|------|------|
| `MATCH_NOT_FOUND` | 404 | 比赛不存在 |
| `MATCH_ARCHIVED` | 409 | 比赛已归档，不能再计分 |
| `SHARE_CODE_NOT_FOUND` | 404 | 分享码没有对应比赛 |
| `SHARE_CODE_CONFLICT` | 409 | 分享码生成冲突（重试即可） |
| `SEASON_NOT_FOUND` | 404 | 赛季不存在 |
| `PLAYER_NOT_FOUND` | 404 | 球员不存在或不属于本场 |
| `PLAYER_DUPLICATE_JERSEY` | 409 | 同队球衣号码重复 |
| `INVALID_PASSCODE` | 403 | 计分口令不正确 |
| `INVALID_EVENT` | 400 | 事件参数非法 |
| `TOO_MANY_EVENTS` | 400 | 单批事件超过 `MAX_SYNC_BATCH` |
| `NO_UNDOABLE_EVENT` | 400/404 | 没有可撤销的操作 / 目标已被撤销 |

---

## REST 接口

### 系统

#### `GET /api/health`

部署自检与多端排查「谁算错了」的入口。

```json
{
  "status": "ok",
  "service": "openhoopscore-api",
  "version": "1.0.0",
  "uptimeSeconds": 128,
  "storageDriver": "json",
  "serverTime": "2024-06-01T10:00:00.000Z",
  "projectionVersion": "1.0.0"
}
```

#### `GET /api/config/public`

前端启动配置，**绝不包含口令本身**。

```json
{ "projectionVersion": "1.0.0", "storageDriver": "json", "socketPath": "/socket.io",
  "maxSyncBatch": 500, "maxEventsPerMatch": 20000, "scorerPasscodeIsDefault": true }
```

`scorerPasscodeIsDefault: true` 表示还在用默认口令，生产部署应据此告警。

---

### 赛季

#### `POST /api/seasons`

```json
{ "name": "2024 社区篮球联赛", "organizer": "街道文体站", "startDate": "2024-06-01", "endDate": "2024-07-15" }
```

#### `GET /api/seasons`

```json
{ "items": [{ "id": "...", "name": "...", "organizer": "...", "matchCount": 6, "createdAt": "..." }] }
```

---

### 比赛

#### `POST /api/matches`

一次把比赛与两队名单录完（基层赛事最常见的节奏）。

```json
{
  "seasonId": null,
  "competition": "2024 社区篮球联赛",
  "title": "A 组第 3 轮",
  "venue": "街道体育馆",
  "scheduledAt": "2024-06-01T11:00:00.000Z",
  "periodFormat": "quarters",
  "periodSeconds": 600,
  "regulationPeriods": 4,
  "home": { "name": "东街猛虎", "shortName": "猛虎", "color": "#E4572E",
            "players": [{ "name": "张三", "jerseyNumber": "4", "isStarter": true }] },
  "away": { "name": "西巷飞鹰", "shortName": "飞鹰", "color": "#2563EB", "players": [] }
}
```

返回 `MatchDetail`：

```json
{
  "match": { "id": "...", "shareCode": "AB12CD", "status": "scheduled", "periodFormat": "quarters",
             "periodSeconds": 600, "regulationPeriods": 4, "homeTeamId": "...", "awayTeamId": "..." },
  "season": null,
  "teams": {
    "home": { "id": "...", "side": "home", "name": "东街猛虎", "shortName": "猛虎", "color": "#E4572E",
              "players": [{ "id": "...", "teamId": "...", "jerseyNumber": "4", "name": "张三", "isStarter": true }] },
    "away": { "...": "..." }
  }
}
```

#### `GET /api/matches?seasonId=&status=&limit=`

`status` ∈ `scheduled | live | finished | archived`。比分由事件流实时投影，**不存表**。

```json
{ "items": [{ "id": "...", "competition": "...", "title": "...", "venue": "...", "status": "live",
              "scheduledAt": null, "shareCode": "AB12CD", "period": 2,
              "homeName": "猛虎", "awayName": "飞鹰", "homeScore": 31, "awayScore": 28,
              "scoreText": "31 : 28", "updatedAt": "..." }], "total": 1 }
```

#### `GET /api/matches/by-code/:code`

扫码进房入口。分享码大小写不敏感。返回 `MatchDetail`。

#### `GET /api/matches/:id`

比赛详情（含两队名单）。返回 `MatchDetail`。

#### `PATCH /api/matches/:id`

可改 `competition` / `title` / `venue` / `scheduledAt` / `status` / `periodSeconds` / `regulationPeriods`。

#### `POST /api/matches/:id/archive`

归档：只改状态，**事件流完整保留**，随时可回放复盘。归档后计分返回 409。

#### `POST /api/matches/:id/players`

```json
{ "side": "home", "name": "周九", "jerseyNumber": "9", "isStarter": false }
```

#### `DELETE /api/matches/:id/players/:playerId`

赛前准备阶段使用。已记录的该球员事件不会被删除（事件溯源：历史不可变）。

#### `GET /api/admin/stats`

存储规模统计（运维排查用）。

---

### 计分与观赛

#### `GET /api/matches/:id/live?feedLimit=200`

**观众端与计分端首屏都打这个接口**，一次拿全：权威状态、图文直播、比分时间线、撤销栈。

```json
{
  "state": {
    "matchId": "...", "status": "live", "period": 2, "gameClockSeconds": 330,
    "home": { "teamId": "...", "side": "home", "name": "东街猛虎", "shortName": "猛虎", "color": "#E4572E",
              "score": 31, "teamFouls": 3, "teamFoulsByPeriod": { "1": 2, "2": 1 }, "timeoutsUsed": 1,
              "players": [{ "playerId": "...", "teamId": "...", "name": "张三", "jerseyNumber": "4",
                            "points": 12, "fouls": 1, "madeByShotType": { "layup": 2, "mid": 1, "three": 2, "dunk": 0, "free_throw": 1, "other": 0 },
                            "threePointersMade": 2, "turnovers": 1, "steals": 0, "blocks": 0,
                            "reboundsOffensive": 0, "reboundsDefensive": 2, "onCourt": true }] },
    "away": { "...": "..." },
    "scoreboard": { "matchId": "...", "status": "live", "period": 2, "gameClockSeconds": 330,
                    "home": { "teamId": "...", "name": "东街猛虎", "shortName": "猛虎", "color": "#E4572E", "score": 31 },
                    "away": { "...": "..." }, "leader": "home", "margin": 3, "blowout": false, "updatedAt": "..." },
    "lastSeq": 42, "appliedEventCount": 42, "voidedEventIds": [], "updatedAt": "..."
  },
  "feed": [{ "id": "...", "seq": 42, "clock": "05:30", "period": 2, "teamSide": "home",
             "playerName": "张三", "jerseyNumber": "4", "type": "score", "points": 3,
             "text": "第2节 05:30 张三（4 号） 命中三分，+3", "tone": "home",
             "homeScore": 31, "awayScore": 28, "createdAt": "..." }],
  "timeline": [{ "seq": 42, "period": 2, "homeScore": 31, "awayScore": 28, "label": "..." }],
  "undoable": [{ "eventId": "...", "seq": 42, "type": "score", "description": "撤销 张三（主队） 的 3 分（第2节）", "createdAt": "..." }]
}
```

`feed` 最新在最前，每条带**该事件生效后的比分快照**，所以观众中途进场也有完整上下文。

#### `GET /api/matches/:id/scoreboard`

只要比分牌（大屏轮询兜底）。

#### `GET /api/matches/:id/state`

完整 `MatchState`。

#### `GET /api/matches/:id/leaderboard?sortedBy=points|fouls|threePointersMade`

```json
{ "matchId": "...",
  "entries": [{ "playerId": "...", "teamId": "...", "teamSide": "home", "teamName": "东街猛虎",
                "name": "张三", "jerseyNumber": "4", "points": 12, "fouls": 1, "threePointersMade": 2, "rank": 1 }],
  "sortedBy": "points" }
```

同分并列名次（体育惯例：1, 1, 3）。

#### `GET /api/matches/:id/events?sinceSeq=0&limit=1000`

增量拉取（断线重连 / 直播回放）。

```json
{ "matchId": "...", "events": [ /* GameEvent[]，按 seq 升序 */ ], "nextSeq": 42, "hasMore": false }
```

#### `POST /api/matches/:id/events`

**在线实时与离线补传共用**。需要 `x-scorer-passcode` 头或 body 里的 `passcode`。

```json
{
  "clientId": "device-a1b2c3d4",
  "sinceSeq": 10,
  "events": [
    {
      "id": "本地临时 id（服务端会重写）",
      "matchId": "...",
      "type": "score",
      "teamId": "主队或客队 id",
      "playerId": "球员 id 或 null",
      "points": 0,
      "period": 2,
      "gameClockSeconds": 330,
      "clientTimestamp": "2024-06-01T11:23:45.123Z",
      "clientId": "device-a1b2c3d4",
      "clientEventId": "幂等键，本地唯一",
      "payload": { "points": 3, "shotType": "three" }
    }
  ]
}
```

字段要点：

- `clientEventId` 是**幂等键**，必填且必须由客户端生成；
- `points` 由服务端根据 `payload.points` 推导，客户端传了也会被覆盖；
- `clientTimestamp` 是**本地时间**，断网补传时就是「过去」的时间，服务端按它插回时间线。

响应：

```json
{
  "matchId": "...",
  "results": [
    { "clientEventId": "...", "status": "accepted", "eventId": "...", "seq": 43 },
    { "clientEventId": "...", "status": "duplicate", "eventId": "...", "seq": 41 },
    { "clientEventId": "...", "status": "rejected", "reason": "球员 xxx 不属于本场比赛" }
  ],
  "acceptedCount": 1, "duplicateCount": 1, "rejectedCount": 1,
  "state": { /* 提交后的权威 MatchState */ },
  "feed": [ /* 本次新增的图文直播条目，按时间正序 */ ],
  "reordered": false
}
```

`status` 的语义：`accepted` 新接受 / `duplicate` 幂等命中（**客户端应出队**）/
`rejected` 参数非法（**应保留并提示人工处理**，不要无限重试）。

`reordered: true` 表示本次补传插入到了历史中间，客户端应重新拉取 `/live`。

#### `POST /api/matches/:id/undo`

```json
{ "clientId": "device-a1b2c3d4", "targetEventId": "可选，指定撤哪条", "steps": 1 }
```

`steps` 用于连撤（计分员连点错误的典型场景）。不传 `targetEventId` 时默认撤最近的。

```json
{ "matchId": "...", "voidedEventIds": ["..."], "descriptions": ["撤销 张三（主队） 的 3 分（第2节）"],
  "state": { /* 撤销后的 MatchState */ }, "undoable": [ /* 新的撤销栈 */ ] }
```

#### `POST /api/matches/:id/clock`

```json
{ "clientId": "device-a1b2c3d4", "period": 3, "gameClockSeconds": 600, "running": false }
```

只有**节次变化**会写入事件（`period_end` / `game_start`）；秒表走动只广播 `state:patch`。
原因见 [architecture.md](architecture.md) 第 8 节。

#### `POST /api/matches/:id/finish`

```json
{ "clientId": "device-a1b2c3d4", "reason": "normal" }
```

`reason` ∈ `normal | forfeit | aborted`。写入 `game_end` 事件并把状态改为 `finished`。

#### `POST /api/matches/:id/preview`

无副作用试算，用于校验客户端本地投影与服务端一致。

```json
// 请求
{ "events": [ /* 待确认的本地事件 */ ] }
// 响应
{ "homeScore": 31, "awayScore": 28, "period": 2, "projectionVersion": "1.0.0" }
```

#### `POST /api/matches/:id/reconcile`

本地队列对账：断网客户端恢复后先问「哪些其实服务端已经收到了」，避免重复提交。

```json
// 请求
{ "clientEventIds": ["...", "..."] }
// 响应
{ "matchId": "...", "acknowledged": ["..."], "unknown": ["..."] }
```

#### `GET /api/matches/:id/realtime/scorers`

当前在线计分设备（现场提示「另一台平板也在计分」）。

---

## Socket.IO 协议

连接地址：与 REST 同源（生产同源部署），路径 `/socket.io`。
协议类型定义见 `packages/contracts/src/realtime.ts`。

```ts
import { io } from 'socket.io-client';

const socket = io('https://your-host', {
  transports: ['websocket', 'polling'],   // 自动降级：场馆网络常只放行 80/443
  reconnection: true,
  reconnectionDelayMax: 5000,
});
```

### 客户端 → 服务端

#### `match:join` → ack `JoinMatchAck`

```ts
socket.emit('match:join', {
  matchId: '...',
  role: 'audience',        // 'audience' | 'scorer' | 'display'
  passcode: undefined,     // role='scorer' 时必填
  clientId: 'device-xxx',  // 计分端填，用于在线设备列表
  lastSeq: 0,              // 已有数据的最大 seq，服务端据此只推缺失部分
}, (ack) => { /* ... */ });
```

```ts
// ack 成功
{ ok: true, role: 'audience', matchId: '...', serverTime: '...',
  state: MatchState,            // 权威状态（省掉一次 REST 往返）
  events: GameEvent[],          // lastSeq 之后缺失的事件
  feed: LiveFeedItem[],         // 图文直播（最新在前）
  onlineScorers: [{ clientId, since }] }   // 仅 role='scorer' 时返回

// ack 失败
{ ok: false, error: 'match_not_found' | 'invalid_passcode' | 'match_archived', ... }
```

#### `scoring:submit` → ack `SubmitEventsAck`

载荷同 REST 的 `POST /events`（`matchId` / `clientId` / `passcode` / `events` / `batchId`）。
ack 里带 `acceptedCount` / `duplicateCount` / `rejectedCount` / `serverSeq` / `rejected[]`。

#### `scoring:undo` → ack `UndoAck`

```ts
socket.emit('scoring:undo', { matchId, clientId, passcode, targetEventId?, steps? },
  (ack) => { /* { ok, voidedEventIds, descriptions, error? } */ });
```

#### `state:request` → ack

```ts
socket.emit('state:request', { matchId, sinceSeq: 42, withFeed: true }, (result) => {
  // { ok, state?, events?, feed? }
});
```

注意 `sinceSeq: 0` 是合法值，表示「我什么都没有，请把全部事件给我」——
这是观众首次进房最常见的取值。

#### `clock:set` / `match:finish`

同对应 REST 接口，均需 `passcode`。

#### `match:leave`

```ts
socket.emit('match:leave', { matchId });
```

### 服务端 → 客户端

#### `events:committed`

```json
{ "matchId": "...", "events": [ /* 新接受的 GameEvent，按权威顺序 */ ],
  "scoreboard": { /* Scoreboard */ }, "finalSeq": 43, "reordered": false, "at": "..." }
```

#### `state:patch`

```json
{ "matchId": "...", "state": { /* 完整 MatchState */ },
  "reason": "period_change" | "clock" | "match_status" | "resync" | "undo" | "manual", "at": "..." }
```

`state` 是**完整**的 `MatchState`（含两队 `players` 与 `teamFoulsByPeriod`），
客户端可以直接用它渲染，不需要自己合并。

#### `feed:appended`

```json
{ "matchId": "...", "items": [ /* 新增 LiveFeedItem，按时间正序 */ ], "at": "..." }
```

按 `id` 去重后合并即可。最新在最前由客户端负责。

#### `undo:applied`

```json
{ "matchId": "...", "voidedEventIds": ["..."], "descriptions": ["..."],
  "scoreboard": { /* Scoreboard */ }, "undoable": [ /* 新撤销栈 */ ],
  "clientId": "device-xxx", "at": "..." }
```

历史直播条目会被改写，客户端收到后建议重拉一次 `/live` 或 `state:request`。

#### `scorers:presence`

```json
{ "matchId": "...", "online": [{ "clientId": "device-xxx", "since": "..." }], "at": "..." }
```

#### `match:finished`

```json
{ "matchId": "...", "reason": "normal", "finalScoreboard": { /* Scoreboard */ }, "at": "..." }
```

#### `player:highlight`

```json
{ "matchId": "...", "playerId": "...", "teamId": "...", "teamSide": "home",
  "milestone": "twenty_points" | "double_double" | "fouled_out" | "three_point_streak",
  "text": "张三 砍下 20 分！", "at": "..." }
```

#### `error`

```json
{ "code": "invalid_passcode", "message": "计分口令不正确", "matchId": "..." }
```

---

## 客户端接入自查清单

1. **一定要带 `clientEventId`**，并在本地持久化 —— 没有它就无法幂等。
2. **收到 `duplicate` 要把本地队列出队**，否则会无限重试。
3. **收到 `rejected` 不要重试**，把 `reason` 显示给计分员。
4. **`reordered: true` 要重拉 `/live`**，否则直播流顺序会与服务端不一致。
5. **断线重连时带上 `lastSeq`**，服务端会直接回推缺失事件，省一次往返。
6. **`points` 不要自己算**，交给服务端从 `payload.points` 推导。
