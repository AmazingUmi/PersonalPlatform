/** Same order as snapshot import, so sync apply and import cannot deadlock. */
export function dataLockNames(tables: readonly string[]): string[] {
  return [...new Set(tables)].sort();
}
