import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/).default('3002'),
  DEMO_MODE: z.enum(['V1_VULNERABLE', 'V2_PROTECTED']),
  DEMO_RECEIPT_SECRET: z.string().min(32),
}).strict();

const selectedNames = ['HOST', 'PORT', 'DEMO_MODE', 'DEMO_RECEIPT_SECRET'] as const;

export type DemoTargetRuntimeConfig = Readonly<{
  host: string;
  port: number;
  mode: 'V1_VULNERABLE' | 'V2_PROTECTED';
  receiptSecret: string;
}>;

export class DemoTargetConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'DemoTargetConfigurationError';
    this.fields = fields;
  }
}

export function parseDemoTargetRuntimeConfig(environment: NodeJS.ProcessEnv): DemoTargetRuntimeConfig {
  const selected = Object.fromEntries(selectedNames.map((name) => [name, environment[name]]));
  const parsed = environmentSchema.safeParse(selected);
  if (!parsed.success) {
    throw new DemoTargetConfigurationError(
      'x402 demo target configuration is incomplete or invalid',
      parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }
  return {
    host: parsed.data.HOST,
    port: Number(parsed.data.PORT),
    mode: parsed.data.DEMO_MODE,
    receiptSecret: parsed.data.DEMO_RECEIPT_SECRET,
  };
}
