import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.validation';

// Global config: ConfigModule validates every env var at startup (validateEnv), and
// AppConfigService is exported so any provider can inject typed, defaulted config.
@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
