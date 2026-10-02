import type { Page, Frame, Locator } from 'playwright';
import type { NodeTarget, BrowserSnapshot, SnapshotNode } from '@localqa/contracts';
import { STABLE_REASON_CODES, type StableReasonCode } from './types.js';

export interface ResolveTargetSuccess {
  status: 'resolved';
  locator: Locator;
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

/**
 * Resolves a NodeTarget on the active Playwright page.
 * Enforces stability hierarchy: test_id -> role+name -> label -> unique text.
 * Performs pre-action validation: Freshness, Uniqueness, Visibility, Operability, Semantics.
 */
export async function resolveTarget(
  page: Page,
  target: NodeTarget,
  currentSnapshot: BrowserSnapshot
): Promise<ResolveTargetResult> {
  // 1. Page ID Check: target.pageId must match currentSnapshot.pageId
  if (target.pageId && currentSnapshot.pageId && target.pageId !== currentSnapshot.pageId) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target pageId '${target.pageId}' does not match active snapshot pageId '${currentSnapshot.pageId}'.`
    };
  }

  // 2. Freshness Check: Snapshot ID must match current active snapshot
  if (target.snapshotId !== currentSnapshot.snapshotId) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.VERSION_CONFLICT,
      message: `Snapshot '${target.snapshotId}' is stale. Active snapshot is '${currentSnapshot.snapshotId}' (stateVersion: ${currentSnapshot.stateVersion}).`
    };
  }

  // 2. Find Node in Current Snapshot Registry
  const node = currentSnapshot.nodes.find(
    (n) => n.nodeId === target.nodeId && (!target.frameId || n.frameId === target.frameId)
  );

  if (!node) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target node '${target.nodeId}' not found in current snapshot '${currentSnapshot.snapshotId}'.`
    };
  }

  // 3. Locate Target Frame
  let frame: Frame = page.mainFrame();
  if (target.frameId && target.frameId !== 'main') {
    const foundFrame = page.frames().find(
      (f, idx) => f.name() === target.frameId || `frame-${idx}-${f.name() || 'subframe'}` === target.frameId
    );
    if (!foundFrame) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
        message: `Target frame '${target.frameId}' not accessible or detached.`
      };
    }
    frame = foundFrame;
  }

  // 4. Construct Candidate Locators in Priority Order
  const candidateLocators: Array<{ strategy: string; locator: Locator }> = [];

  // Priority 1: test_id contract
  if (node.nodeId.startsWith('testid_')) {
    const rawTestId = node.nodeId.replace('testid_', '');
    candidateLocators.push({
      strategy: 'test_id',
      locator: frame.locator(`[data-testid="${rawTestId}"], [data-test="${rawTestId}"]`)
    });
  }

  // Priority 2: role + accessible name
  if (node.role && node.name && node.role !== 'generic' && node.role !== 'div') {
    try {
      candidateLocators.push({
        strategy: 'role_and_name',
        locator: frame.getByRole(node.role as Parameters<typeof frame.getByRole>[0], {
          name: node.name,
          exact: true
        })
      });
    } catch {
      // Role name might not be valid ARIA role
    }
  }

  // Priority 3: label
  if (node.name && (node.role === 'textbox' || node.role === 'checkbox' || node.role === 'combobox')) {
    try {
      candidateLocators.push({
        strategy: 'label',
        locator: frame.getByLabel(node.name, { exact: true })
      });
    } catch {
      // Ignore
    }
  }

  // Priority 4: unique text structure
  if (node.text && node.text.length > 0 && node.text.length < 100) {
    candidateLocators.push({
      strategy: 'exact_text',
      locator: frame.getByText(node.text, { exact: true })
    });
  }

  // Fallback: If no candidate was formed, fallback to testid or bounds
  if (candidateLocators.length === 0) {
    if (node.name) {
      candidateLocators.push({
        strategy: 'name_fallback',
        locator: frame.locator(`text="${node.name}"`)
      });
    } else {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
        message: `Cannot form any stable locator for node '${node.nodeId}'.`
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
        message: `Ambiguous target '${node.name || node.text}': found ${ambiguousCount} matching elements on page. Refusing action without unique discriminator.`
      };
    }
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Element corresponding to '${node.name || node.nodeId}' is no longer attached or found.`
    };
  }

  // 6. Pre-action Validation: Visibility Check
  try {
    const isVisible = await bestLocator.isVisible();
    if (!isVisible) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_HIDDEN,
        message: `Target element '${node.name || node.nodeId}' is hidden (display: none or visibility: hidden). Refusing interaction.`
      };
    }
  } catch (err) {
    return {
      status: 'rejected',
      reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
      message: `Target element visibility check failed: ${(err as Error).message}`
    };
  }

  // 7. Pre-action Validation: Operability / Enabled Check
  try {
    const isEnabled = await bestLocator.isEnabled().catch(() => true);
    if (!isEnabled) {
      return {
        status: 'rejected',
        reasonCode: STABLE_REASON_CODES.TARGET_DISABLED,
        message: `Target element '${node.name || node.nodeId}' is disabled or has aria-disabled='true'. Refusing interaction.`
      };
    }
  } catch {
    // Some elements don't support isEnabled, proceed
  }

  return {
    status: 'resolved',
    locator: bestLocator,
    node,
    frame
  };
}
