import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { assertProdConfig } from './common/assert-prod-config';

async function bootstrap() {
  assertProdConfig();
  // rawBody: true exposes req.rawBody so the controller can verify the LINE signature.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService);
  // In production, set CORS_ORIGIN to the board domain, e.g. https://board.example.com.
  app.enableCors({ origin: config.corsOrigin });
  // Strip unknown fields and validate body types on every endpoint that has a DTO.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(config.port);
  console.log(`backend listening on :${config.port}`);
}
bootstrap();
