// Order offers, not jobs: the database lease claim remains authoritative.
export function projectOffers(projects, capacity, round) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || !projects.length)
    return [];
  const first = round % projects.length;
  return Array.from(
    { length: capacity },
    (_, i) => projects[(first + i) % projects.length],
  );
}
