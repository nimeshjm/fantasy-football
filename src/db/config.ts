/** Simple key/value config store. Seeded by the migration with
 * enabled='1' and dry_run='1'. */
export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value)
    .run();
}

export async function isEnabled(db: D1Database): Promise<boolean> {
  return (await getConfig(db, 'enabled')) === '1';
}

export async function isDryRun(db: D1Database): Promise<boolean> {
  return (await getConfig(db, 'dry_run')) === '1';
}
