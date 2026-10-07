import {z} from 'zod';

const boolFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform(v => v === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    APP_VERSION: z.string().default('dev'),

    DB_HOST: z.string().default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().default(''),
    DB_NAME: z.string().min(1),

    IMAGE_DIR: z.string().min(1),
    IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

    AI_PROVIDER: z.enum(['mock', 'anthropic', 'openai', 'google']).default('mock'),
    AI_MODEL: z.string().default(''),
    AI_API_KEY: z.string().default(''),
    AI_MOCK_SCENARIO: z
      .enum(['ok', 'schema_invalid', 'timeout', 'rate_limited', 'auth'])
      .default('ok'),

    REF_MISMATCH_BLOCKS_OK: boolFromEnv,
    DEV_MODE_ENABLED: boolFromEnv,

    SLACK_WEBHOOK_URL: z.union([z.literal(''), z.url()]).default(''),
  })
  .superRefine((env, ctx) => {
    // 本番で mock や開発モードのまま起動しない（気づかないまま偽の判定を出さないため）
    if (env.NODE_ENV === 'production' && env.AI_PROVIDER === 'mock') {
      ctx.addIssue({code: 'custom', path: ['AI_PROVIDER'], message: 'production では mock を使えません'});
    }
    if (env.AI_PROVIDER !== 'mock') {
      if (!env.AI_MODEL) ctx.addIssue({code: 'custom', path: ['AI_MODEL'], message: '必須です'});
      if (!env.AI_API_KEY) ctx.addIssue({code: 'custom', path: ['AI_API_KEY'], message: '必須です'});
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`環境変数が不正です: ${issues.join(' / ')}`);
    this.name = 'ConfigError';
  }
}

/** 環境変数を検証する。不正なら起動させない（値そのものはメッセージに含めない） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  }
  return parsed.data;
}

/** 起動ログ・ヘルスチェックに出してよい設定値（秘匿情報を除く） */
export function describeConfig(config: Config) {
  return {
    nodeEnv: config.NODE_ENV,
    appVersion: config.APP_VERSION,
    aiProvider: config.AI_PROVIDER,
    aiModel: config.AI_MODEL || null,
    aiMockScenario: config.AI_PROVIDER === 'mock' ? config.AI_MOCK_SCENARIO : null,
    refMismatchBlocksOk: config.REF_MISMATCH_BLOCKS_OK,
    devModeEnabled: config.DEV_MODE_ENABLED,
    notifyEnabled: config.SLACK_WEBHOOK_URL !== '',
  };
}
