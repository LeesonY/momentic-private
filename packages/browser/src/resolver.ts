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

  // 4-7. Bind the unique owned element and validate visibility/operability.
  const bound = await bindUniqueTarget(node, frame, options);
  if (bound.status === 'rejected') return bound;

  // 8. Freshness of the bound element. The document may have changed for
  // reasons unrelated to this target; the action is still refused when the
  // approved element itself (or its position) was touched.
  if (
    !(await snapshotFrameUnchanged(
      page,
      currentSnapshot.snapshotId,
      node.frameId,
      frame,
    )) &&
    !(await snapshotTargetUnchanged(
      page,
      currentSnapshot.snapshotId,
      node.frameId,
      frame,
      bound.elementHandle,
    ))
  ) {
    await bound.elementHandle.dispose().catch(() => undefined);
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.VERSION_CONFLICT,
      message:
        'The observed document or DOM changed; capture a fresh snapshot before acting.',
    };
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
async function bindUniqueTarget(
  node: SnapshotNode,
  frame: Frame,
  options: ResolveTargetOptions,
): Promise<
  | {
      status: 'bound';
      locator: Locator;
      elementHandle: ElementHandle<SVGElement | HTMLElement>;
    }
  | ResolveTargetFailure
> {
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
  if (candidateLocators.length === 0) {
    if (node.name) {
      candidateLocators.push({
        strategy: 'name_fallback',
        locator: frame.locator(`text="${node.name}"`),
      });
    } else {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
        message: `Cannot form any stable locator for node '${node.nodeId}'.`,
      };
    }
  }

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
