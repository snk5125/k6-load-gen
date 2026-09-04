/** Max of the numbers present; null when none is. Shared by the summary and timeline merges so "worst generator, ignoring missing" means one thing. */
export function maxNullable(xs: Array<number | null | undefined>): number | null {
  const present = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return present.length === 0 ? null : Math.max(...present);
}
