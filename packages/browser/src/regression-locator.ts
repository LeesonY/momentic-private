import type { Page } from 'playwright';
import { parseContract } from '@localqa/contracts';
import type { Locator, NodeTarget, BrowserSnapshot } from '@localqa/contracts';
import { resolveTarget } from './resolver.js';

export class RegressionLocatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RegressionLocatorError';
  }
}

/** No browser launch. Resolves only a unique visible main-frame DOM element
 * represented by the owned current snapshot; executor rechecks freshness. */
export async function resolveRegressionLocator(
  page: Page,
  input: Locator,
  snapshot: BrowserSnapshot,
  signal?: AbortSignal,
): Promise<NodeTarget> {
  const locator = parseContract('Locator', input);
  if (signal?.aborted) throw new RegressionLocatorError('CANCELLED');
  const selected =
    locator.by === 'role'
      ? page.getByRole(locator.value as Parameters<Page['getByRole']>[0], {
          ...(locator.name ? { name: locator.name } : {}),
          exact: true,
        })
      : locator.by === 'label'
        ? page.getByLabel(locator.value, { exact: true })
        : locator.by === 'test_id'
          ? page.getByTestId(locator.value)
          : locator.by === 'text'
            ? page.getByText(locator.value, { exact: true })
            : page.locator(locator.value);
  // A zero match is an explicit "not present" signal; anything else stays
  // ambiguous so multi-match and hidden cases are never flattened into absence.
  const count = await selected.count();
  if (count === 0) throw new RegressionLocatorError('LOCATOR_NOT_FOUND');
  if (count !== 1 || !(await selected.isVisible()))
    throw new RegressionLocatorError('LOCATOR_NOT_UNIQUE');
  const handle = await selected.elementHandle();
  if (!handle) throw new RegressionLocatorError('LOCATOR_NOT_FOUND');
  try {
    const targets: NodeTarget[] = [];
    for (const node of snapshot.nodes.filter(
      (node) => node.visible && node.frameId === 'main',
    )) {
      if (signal?.aborted) throw new RegressionLocatorError('CANCELLED');
      const target = {
        snapshotId: snapshot.snapshotId,
        pageId: snapshot.pageId,
        nodeId: node.nodeId,
        frameId: node.frameId,
      };
      const resolved = await resolveTarget(page, target, snapshot);
      if (
        resolved.status === 'resolved' &&
        (await resolved.locator.evaluate(
          (element, expected) => element === expected,
          handle,
        ))
      )
        targets.push(target);
    }
    if (targets.length !== 1)
      throw new RegressionLocatorError('LOCATOR_NOT_OWNED_OR_AMBIGUOUS');
    return parseContract('NodeTarget', targets[0]);
  } finally {
    await handle.dispose();
  }
}

/** Fast revalidation of an untrusted role/name hint against the LIVE DOM.
 * The caller may supply only a NodeTarget derived from the current, budgeted
 * snapshot. The cached entry never contains a target, a verdict or an element.
 * A failed check must return null and trigger normal frozen-locator replay.
 */
export async function resolveCachedRegressionLocator(
  page: Page,
  input: Locator,
  candidate: NodeTarget,
  snapshot: BrowserSnapshot,
  signal?: AbortSignal,
): Promise<NodeTarget | null> {
  if (signal?.aborted) throw new RegressionLocatorError('CANCELLED');
  const locator = parseContract('Locator', input);
  if (locator.by !== 'role' || !locator.name) return null;
  if (
    candidate.snapshotId !== snapshot.snapshotId ||
    candidate.pageId !== snapshot.pageId ||
    candidate.frameId !== 'main'
  )
    return null;
  const nodes = snapshot.nodes.filter(
    (node) =>
      node.frameId === 'main' &&
      node.visible &&
      node.enabled &&
      node.role === locator.value &&
      node.name === locator.name,
  );
  if (nodes.length !== 1 || nodes[0]!.nodeId !== candidate.nodeId) return null;
  const selected = page.getByRole(
    locator.value as Parameters<Page['getByRole']>[0],
    { name: locator.name, exact: true },
  );
  try {
    if (
      (await selected.count()) !== 1 ||
      !(await selected.isVisible()) ||
      !(await selected.isEnabled())
    )
      return null;
    const handle = await selected.elementHandle();
    if (!handle) return null;
    try {
      if (signal?.aborted) throw new RegressionLocatorError('CANCELLED');
      const resolved = await resolveTarget(page, candidate, snapshot);
      if (
        resolved.status !== 'resolved' ||
        !(await resolved.locator.evaluate(
          (element, expected) => element === expected,
          handle,
        ))
      )
        return null;
      return parseContract('NodeTarget', candidate);
    } finally {
      await handle.dispose();
    }
  } catch (error) {
    if (signal?.aborted) throw new RegressionLocatorError('CANCELLED');
    return null;
  }
}
