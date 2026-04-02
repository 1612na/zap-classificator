import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/banco/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/db.sqlite',
  },
  verbose: true,
  strict: true,
});
