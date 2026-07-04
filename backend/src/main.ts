import 'dotenv/config';
import { INestApplicationContext, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { assertProdConfig } from './common/assert-prod-config';

// Applies the configured CORS origin to the Socket.IO server so WebSocket CORS comes from
// AppConfigService (single source of truth), not a process.env read inside the gateway decorator.
class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigin: string,
  ) {
    super(app);
  }
  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.corsOrigin } });
  }
}

async function bootstrap() {
  assertProdConfig();
  // rawBody: true exposes req.rawBody so the controller can verify the LINE signature.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService);
  // In production, set CORS_ORIGIN to the board domain, e.g. https://board.example.com.
  app.enableCors({ origin: config.corsOrigin });
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config.corsOrigin));
  // Strip unknown fields and validate body types on every endpoint that has a DTO.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(config.port);
  console.log(`backend listening on :${config.port}`);
}
bootstrap();
