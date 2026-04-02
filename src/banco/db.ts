import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

// drizzle-orm/better-sqlite3 aceita string como caminho e instancia o cliente
// internamente — não é preciso createRequire aqui.
const db = drizzle('./data/db.sqlite', { schema });

// Configurações de performance via $client (instância better-sqlite3 subjacente)
db.$client.pragma('journal_mode = WAL');
db.$client.pragma('synchronous = NORMAL');

export { db };
export type Database = typeof db;
