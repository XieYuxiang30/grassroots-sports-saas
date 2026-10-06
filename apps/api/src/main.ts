import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { loadConfig, SERVICE_VERSION } from './config/app.config';

/**
 * 启动入口。
 *
 * 关键点（都是为现场环境准备的）：
 *   1. `bodyParser` 上限调大：离线补传一次可能带上百条事件；
 *   2. ValidationPipe 开启 `transform`：查询串里的数字才能正确转换；
 *   3. CORS 由 `CORS_ORIGINS` 控制：开发时给 Vite 端口，生产时同源即可；
 *   4. 全局前缀 `api`：前端静态资源与接口在同一域名下互不干扰；
 *   5. Swagger 挂在 `/docs`：交付给前端联调时省掉一半沟通成本。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const config = loadConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(), {
    logger: config.nodeEnv === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
    bodyParser: true,
  });

  app.setGlobalPrefix('api', { exclude: ['docs', 'docs-json', 'healthz'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableCors({
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-scorer-passcode'],
  });
  app.enableShutdownHooks();

  // JSON 与表单的请求体上限：离线补传批次可能很大
  app.useBodyParser('json', { limit: '4mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  if (config.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('基层赛事 SaaS 平台 API')
      .setDescription(
        '事件溯源计分 + 离线优先同步 + Socket.IO 实时比分。\n\n' +
          '扫码进房：GET /api/matches/by-code/{分享码}\n' +
          '实时协议：Socket.IO（默认命名空间），事件名见 packages/contracts/src/realtime.ts',
      )
      .setVersion(SERVICE_VERSION)
      .addTag('赛事管理')
      .addTag('计分与观赛')
      .addTag('实时通道')
      .addApiKey({ type: 'apiKey', name: 'x-scorer-passcode', in: 'header' }, 'scorer-passcode')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
    });
  }

  await app.listen(config.port, config.host);

  const assets = AppModule.webAssetsDir();
  logger.log(`服务已启动：http://127.0.0.1:${config.port}/api/health`);
  if (config.nodeEnv !== 'production') {
    logger.log(`接口文档：http://127.0.0.1:${config.port}/docs`);
  }
  if (assets) {
    logger.log(`已托管前端页面：http://127.0.0.1:${config.port}/ （目录 ${assets}）`);
  } else {
    logger.log('未检测到前端构建产物：只提供 API。执行 `pnpm --filter @openhoopscore/web build` 后再启动即可同域访问。');
  }
  logger.log(`存储驱动：${config.storageDriver}；CORS：${config.corsOrigins === '*' ? '允许全部（开发模式）' : config.corsOrigins.join(', ')}`);
}

void bootstrap().catch((error) => {
  // 启动失败必须打印完整堆栈：现场部署时这是唯一线索
  // eslint-disable-next-line no-console
  console.error('[Bootstrap] 启动失败：', error);
  process.exit(1);
});
