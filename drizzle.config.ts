import type { Config } from 'drizzle-kit'

import { DEFAULT_DATABASE_PATH } from './src/db/paths'

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: process.env['DATABASE_PATH'] ?? DEFAULT_DATABASE_PATH },
  strict: true,
  verbose: true,
} satisfies Config
