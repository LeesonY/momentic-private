import type { Page, Frame, Locator, ElementHandle } from 'playwright';
import type {
  NodeTarget,
  BrowserSnapshot,
  SnapshotNode,
} from '@localqa/contracts';
import { STABLE_REASON_CODES, type StableReasonCode } from './types.js';
import {
  isSameOriginOwnedFrame,
  snapshotFrameUnchanged,
  snapshotRegistryElement,
  snapshotTargetIdentity,
  snapshotTargetUnchanged,
} from './snapshot.js';

export interface ResolveTargetSuccess {
  status: 'resolved';
  locator: Locator;
  /** Pins the original DOM object, without Locator auto-rebinding. */
  elementHandle: ElementHandle<SVGElement | HTMLElement>;
  node: SnapshotNode;
  frame: Frame;
}

export interface ResolveTargetFailure {
  status: 'rejected';
  reasonCode: StableReasonCode;
  message: string;
  matchCount?: number;
}

export type ResolveTargetResult = ResolveTargetSuccess | ResolveTargetFailure;

export interface ResolveTargetOptions {
  allowHiddenForWait?: boolean;
}

/**
 * Resolves a NodeTarget on the active Playwright page.
 * Enforces stability hierarchy: test_id -> role+name -> label -> unique text.
 * Performs pre-action validation: Freshness, Uniqueness, Visibility, Operability, Semantics.
 *
 * The DOM witness is document-wide, but an unrelated page change (title,
 * loading overlay, another field's validation, our own previous action
 * elsewhere) does not invalidate the *approved element*. When the document
 * changed, the element is still acted on only if its own attributes, content
 * and position among siblings were provably untouched since the snapshot.
 * A replaced, removed, ambiguous or hidden element is still rejected.
 */
export async function resolveTarget(
  page: Page,
  target: NodeTarget,
  currentSnapshot: BrowserSnapshot,
  options: ResolveTargetOptions = {},
): Promise<ResolveTargetResult> {
  // 1. Page ID Check: target.pageId must match currentSnapshot.pageId
  if (
    target.pageId &&
    currentSnapshot.pageId &&
    target.pageId !== currentSnapshot.pageId
  ) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target pageId '${target.pageId}' does not match active snapshot pageId '${currentSnapshot.pageId}'.`,
    };
  }

  // 2. Freshness Check: Snapshot ID must match current active snapshot.
  // The browser layer does not retain older snapshots, so it cannot prove
  // that a node id from an older observation still names the same element.
  if (target.snapshotId !== currentSnapshot.snapshotId) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.VERSION_CONFLICT,
      message: `Snapshot '${target.snapshotId}' is stale. Active snapshot is '${currentSnapshot.snapshotId}' (stateVersion: ${currentSnapshot.stateVersion}).`,
    };
  }

  // 2. Find Node in Current Snapshot Registry
  const node = currentSnapshot.nodes.find(
    (n) =>
      n.nodeId === target.nodeId && n.frameId === (target.frameId ?? 'main'),
  );

  if (!node) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target node '${target.nodeId}' not found in current snapshot '${currentSnapshot.snapshotId}'.`,
    };
  }

  // 3. Locate Target Frame
  const located = locateOwnedFrame(page, node);
  if (located.status === 'rejected') return located;
  const frame = located.frame;

  // 4-7. Bind the element the snapshot pinned for this node, and only fall back
  // to locator uniqueness when the registry cannot prove it. A list page with
  // eleven identical 「详情」 buttons has no unique role+name locator, yet the
  // snapshot already recorded one DOM object per row: the model chose a node id,
  // not "the only element that looks like this".
  const pinned = await bindPinnedTarget(
    page,
    node,
    frame,
    currentSnapshot.snapshotId,
    options,
  );
  let bound: Awaited<ReturnType<typeof bindUniqueTarget>>;
  if (pinned.status === 'bound') {
    bound = pinned;
  } else {
    bound = await bindUniqueTarget(node, frame, options);
    // The snapshot's own element is gone, yet the page still has look-alikes:
    // the honest answer is "this observation is stale", not "ambiguous".
    if (
      pinned.status === 'gone' &&
      bound.status === 'rejected' &&
      bound.reasonCode === STABLE_REASON_CODES.TARGET_AMBIGUOUS
    )
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.VERSION_CONFLICT,
        message:
          'The element this snapshot pinned is no longer in the document and the page now has several matching elements; capture a fresh snapshot before acting.',
      };
  }
  if (bound.status === 'rejected') return bound;

  // 8. Freshness of the bound element. The document may have changed for
  // reasons unrelated to this target; the action is still refused unless the
  // bound element is the exact object the snapshot recorded for this node
  // and its own content was left untouched. A locator that rebound to a
  // same-named element revealed through an ancestor's visibility change is
  // therefore rejected instead of acted on.
  if (
    !(await snapshotFrameUnchanged(
      page,
      currentSnapshot.snapshotId,
      node.frameId,
      frame,
    ))
  ) {
    const sameElement = await snapshotTargetIdentity(
      page,
      currentSnapshot.snapshotId,
      node.frameId,
      frame,
      node.nodeId,
      bound.elementHandle,
    );
    const untouched =
      sameElement &&
      (await snapshotTargetUnchanged(
        page,
        currentSnapshot.snapshotId,
        node.frameId,
        frame,
        bound.elementHandle,
      ));
    if (!untouched) {
      await bound.elementHandle.dispose().catch(() => undefined);
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.VERSION_CONFLICT,
        message:
          'The observed document or DOM changed; capture a fresh snapshot before acting.',
      };
    }
  }

  return {
    status: 'resolved',
    locator: bound.locator,
    elementHandle: bound.elementHandle,
    node,
    frame,
  };
}

function locateOwnedFrame(
  page: Page,
  node: SnapshotNode,
): { status: 'located'; frame: Frame } | ResolveTargetFailure {
  if (node.frameId === 'main')
    return { status: 'located', frame: page.mainFrame() };
  const foundFrame = page
    .frames()
    .find(
      (f, idx) =>
        `frame-${idx}-${f.name() || 'subframe'}`.slice(0, 120) === node.frameId,
    );
  if (!foundFrame) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target frame '${node.frameId}' not accessible or detached.`,
    };
  }
  if (!isSameOriginOwnedFrame(foundFrame, page.mainFrame()))
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
      message: 'Target frame origin differs from the approved main page.',
    };
  return { status: 'located', frame: foundFrame };
}

/**
 * Builds the stable candidate locators for the approved node, requires a
 * unique match, and checks visibility/operability. Returns the pinned element
 * handle so no later locator resolution can auto-rebind to another element.
 */
/** The stable candidate locators for a snapshot node, in priority order. */
function candidateLocatorsFor(
  node: SnapshotNode,
  frame: Frame,
): Array<{ strategy: string; locator: Locator }> {
  const candidateLocators: Array<{ strategy: string; locator: Locator }> = [];

  // Priority 1: test_id contract
  if (node.nodeId.startsWith('testid_')) {
    const rawTestId = node.nodeId.replace('testid_', '');
    candidateLocators.push({
      strategy: 'test_id',
      locator: frame.locator(
        `[data-testid="${rawTestId}"], [data-test="${rawTestId}"]`,
      ),
    });
  }

  // Priority 2: role + accessible name
  if (
    node.role &&
    node.name &&
    node.role !== 'generic' &&
    node.role !== 'div'
  ) {
    try {
      candidateLocators.push({
        strategy: 'role_and_name',
        locator: frame.getByRole(
          node.role as Parameters<typeof frame.getByRole>[0],
          {
            name: node.name,
            exact: true,
          },
        ),
      });
    } catch {
      // Role name might not be valid ARIA role
    }
  }

  // Priority 3: label
  if (
    node.name &&
    (node.role === 'textbox' ||
      ['text', 'email', 'tel', 'url', 'search', 'number', 'password'].includes(
        node.role,
      ) ||
      node.role === 'checkbox' ||
      node.role === 'combobox')
  ) {
    try {
      candidateLocators.push({
        strategy: 'label',
        locator: frame.getByLabel(node.name, { exact: true }),
      });
    } catch {
      // Ignore
    }
  }

  // Native input types are snapshot roles too. They may have a label,
  // placeholder, or name without any data-testid/ARIA role configured.
  if (
    node.name &&
    [
      'textbox',
      'text',
      'email',
      'tel',
      'url',
      'search',
      'number',
      'password',
    ].includes(node.role)
  ) {
    candidateLocators.push({
      strategy: 'placeholder',
      locator: frame.getByPlaceholder(node.name, { exact: true }),
    });
    candidateLocators.push({
      strategy: 'input_name',
      locator: frame.locator(`input[name=${JSON.stringify(node.name)}]`),
    });
    if (node.role === 'password')
      candidateLocators.push({
        strategy: 'unique_password',
        locator: frame.locator('input[type="password"]:visible'),
      });
  }
  if (
    node.inputType &&
    ['text', 'email', 'tel', 'password'].includes(node.inputType)
  ) {
    const selector =
      node.inputType === 'text'
        ? 'input:not([type]):visible, input[type="text"]:visible'
        : `input[type=${JSON.stringify(node.inputType)}]:visible`;
    candidateLocators.push({
      strategy: 'unique_input_type',
      locator: frame.locator(selector),
    });
  }

  // Priority 4: unique text structure
  if (node.text && node.text.length > 0 && node.text.length < 100) {
    candidateLocators.push({
      strategy: 'exact_text',
      locator: frame.getByText(node.text, { exact: true }),
    });
  }

  // Fallback: If no candidate was formed, fallback to testid or bounds
  if (candidateLocators.length === 0 && node.name) {
    candidateLocators.push({
      strategy: 'name_fallback',
      locator: frame.locator(`text="${node.name}"`),
    });
  }
  return candidateLocators;
}

type BoundTarget = {
  status: 'bound';
  locator: Locator;
  elementHandle: ElementHandle<SVGElement | HTMLElement>;
};

type PinnedBinding =
  | BoundTarget
  /** The snapshot pinned an element and it is no longer in the document. */
  | { status: 'gone' }
  /** No usable registry entry, or it is hidden: let the locator path decide. */
  | { status: 'unusable' };

/**
 * A locator that names exactly the pinned element: the first candidate strategy
 * that matches it, narrowed to its position among the matches (a list page has
 * one per row). Null when no strategy describes it any more, which means the
 * element no longer looks like what the snapshot recorded.
 */
async function pinnedLocatorFor(
  node: SnapshotNode,
  frame: Frame,
  element: ElementHandle<SVGElement | HTMLElement>,
): Promise<Locator | null> {
  for (const { locator } of candidateLocatorsFor(node, frame)) {
    const index = await locator
      .evaluateAll(
        (elements, target) =>
          elements.findIndex((candidate) => candidate === target),
        element as ElementHandle<SVGElement>,
      )
      .catch(() => -1);
    if (index < 0) continue;
    const count = await locator.count().catch(() => 0);
    return count === 1 ? locator : locator.nth(index);
  }
  return null;
}

/**
 * Bind the DOM object the snapshot recorded for this node, when it is still the
 * element the model chose: still in the document, still visible, still enabled,
 * and still matching the recorded role/name (the candidate strategy must find
 * it). Locator uniqueness is not required — that is the whole point on a table
 * where every row has a 「详情」 button.
 *
 * Being the recorded object is what keeps the ancestor-visibility defense
 * intact: a look-alike revealed by a style swap is a different object, so the
 * freshness check below still rejects it.
 */
async function bindPinnedTarget(
  page: Page,
  node: SnapshotNode,
  frame: Frame,
  snapshotId: string,
  options: ResolveTargetOptions,
): Promise<PinnedBinding | ResolveTargetFailure> {
  const elementHandle = await snapshotRegistryElement(
    page,
    snapshotId,
    node.frameId,
    frame,
    node.nodeId,
  );
  if (!elementHandle) return { status: 'unusable' };
  let keep = false;
  try {
    const connected = await elementHandle
      .evaluate((element) => element.isConnected)
      .catch(() => false);
    // Gone: the caller decides between "not found" (nothing similar left) and
    // "stale observation" (look-alikes remain).
    if (!connected) return { status: 'gone' };
    const visible = await elementHandle.isVisible().catch(() => false);
    // A hidden pinned element defers to the locator path: it knows how to tell
    // TARGET_HIDDEN from "another element was revealed" (VERSION_CONFLICT).
    if (!visible && !options.allowHiddenForWait) return { status: 'unusable' };
    const enabled = await elementHandle.isEnabled().catch(() => true);
    if (!enabled)
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_DISABLED,
        message: `Target element '${node.name || node.nodeId}' is disabled or has aria-disabled='true'. Refusing interaction.`,
      };
    const locator = await pinnedLocatorFor(node, frame, elementHandle);
    if (!locator) return { status: 'unusable' };
    keep = true;
    return { status: 'bound', locator, elementHandle };
  } finally {
    if (!keep) await elementHandle.dispose().catch(() => undefined);
  }
}

async function bindUniqueTarget(
  node: SnapshotNode,
  frame: Frame,
  options: ResolveTargetOptions,
): Promise<BoundTarget | ResolveTargetFailure> {
  const candidateLocators = candidateLocatorsFor(node, frame);
  if (candidateLocators.length === 0)
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Cannot form any stable locator for node '${node.nodeId}'.`,
    };

  // 5. Evaluate Locators for Uniqueness and Validity
  let bestLocator: Locator | null = null;
  let ambiguousCount = 0;

  for (const { locator } of candidateLocators) {
    try {
      const count = await locator.count();
      if (count === 1) {
        bestLocator = locator;
        break; // Unique match found!
      } else if (count > 1) {
        ambiguousCount = count;
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Handle Ambiguity: If matches > 1 and no unique locator succeeded
  if (!bestLocator) {
    if (ambiguousCount > 1) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_AMBIGUOUS,
        matchCount: ambiguousCount,
        message: `Ambiguous target '${node.name || node.text}': found ${ambiguousCount} matching elements on page. Refusing action without unique discriminator.`,
      };
    }
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Element corresponding to '${node.name || node.nodeId}' is no longer attached or found.`,
    };
  }

  // 6. Pre-action Validation: Visibility Check
  try {
    const isVisible = await bestLocator.isVisible();
    if (!isVisible && !options.allowHiddenForWait) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_HIDDEN,
        message: `Target element '${node.name || node.nodeId}' is hidden (display: none or visibility: hidden). Refusing interaction.`,
      };
    }
  } catch (err) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target element visibility check failed: ${(err as Error).message}`,
    };
  }

  // 7. Pre-action Validation: Operability / Enabled Check
  try {
    const isEnabled = await bestLocator.isEnabled().catch(() => true);
    if (!isEnabled) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_DISABLED,
        message: `Target element '${node.name || node.nodeId}' is disabled or has aria-disabled='true'. Refusing interaction.`,
      };
    }
  } catch {
    // Some elements don't support isEnabled, proceed
  }

  const elementHandle = await bestLocator.elementHandle().catch(() => null);
  if (!elementHandle)
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: 'Approved element detached while binding its identity.',
    };
  return { status: 'bound', locator: bestLocator, elementHandle };
}
