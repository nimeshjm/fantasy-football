import { STRATEGY_EP_NEXT, STRATEGY_MODEL_V2, type ProjectionStrategy } from '../model/projection';

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

/** Config key holding the active projection strategy. Kept in D1 rather than
 * a wrangler var so the model can be rolled back to `ep-next` without a
 * deploy -- the fallback has to be reachable faster than a deploy cycle if a
 * live gameweek's projections look wrong. */
export const PROJECTION_STRATEGY_KEY = 'projection_strategy';

/**
 * The active projection strategy. Unrecognised or unset values fall back to
 * `'ep-next'`: an unreadable config value must never silently select the
 * newer, less-proven model. `projectPlayer`'s own default is `'ep-next'`
 * too, so the two agree.
 */
export async function getProjectionStrategy(db: D1Database): Promise<ProjectionStrategy> {
  const raw = await getConfig(db, PROJECTION_STRATEGY_KEY);
  return raw === STRATEGY_MODEL_V2 ? STRATEGY_MODEL_V2 : STRATEGY_EP_NEXT;
}

export async function setProjectionStrategy(
  db: D1Database,
  strategy: ProjectionStrategy,
): Promise<void> {
  await setConfig(db, PROJECTION_STRATEGY_KEY, strategy);
}
