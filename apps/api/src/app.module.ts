import { DynamicModule, Module, Type } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AppConfigModule } from './config/config.module';
import { loadConfig } from './config/app.config';
import { StoreModule } from './store/store.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ScoringModule } from './scoring/scoring.module';
import { MatchesModule } from './matches/matches.module';
import { HealthController } from './health/health.controller';

/**
 * 应用根模块。
 *
 * 装配顺序对应单向依赖：
 *   AppConfigModule（全局配置）→ StoreModule（全局存储）→ RealtimeModule（全局实时）
 *   → ScoringModule（计分）→ MatchesModule（赛事管理）
 *
 * ## 生产部署的一个便利设计
 * 后端可以直接托管前端产物（`apps/web/dist`）。好处：
 *   - 对外只有一个地址、一个端口，现场用手机连场馆局域网即可打开，不用记两个域名；
 *   - 自带同源，前端不触发跨域（分离部署到 Vercel 时用 CORS_ORIGINS 放开即可）。
 * 目录不存在时（例如只跑 API 做压测）自动跳过静态托管，不会报错。
 */
@Module({})
export class AppModule {
  static register(): DynamicModule {
    const config = loadConfig();
    const assetsDir = config.serveWebAssets ? findWebAssets(config.webDistDir) : undefined;

    const imports: Array<Type<unknown> | DynamicModule> = [
      AppConfigModule,
      StoreModule,
      RealtimeModule,
      ScoringModule,
      MatchesModule,
    ];

    if (assetsDir) {
      imports.push(
        ServeStaticModule.forRoot({
          rootPath: assetsDir,
          exclude: ['/api/{*path}', '/socket.io/{*path}', '/docs', '/docs/{*path}', '/docs-json'],
        }),
      );
    }

    return {
      module: AppModule,
      imports,
      controllers: [HealthController],
    };
  }

  /** 供 main.ts 判断是否要打印「已托管前端」提示。 */
  static webAssetsDir(): string | undefined {
    const config = loadConfig();
    return config.serveWebAssets ? findWebAssets(config.webDistDir) : undefined;
  }
}

function findWebAssets(configured: string): string | undefined {
  const candidates = [
    isAbsolute(configured) ? configured : resolve(process.cwd(), configured),
    resolve(process.cwd(), '../web/dist'),
    resolve(__dirname, '../../web/dist'),
    resolve(__dirname, '../../../web/dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}
