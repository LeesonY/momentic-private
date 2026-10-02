import type { Page, Frame } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { BrowserSnapshot, SnapshotNode } from '@localqa/contracts';
import { validateContract } from '@localqa/contracts';
import { sanitizeUrl, sanitizeText } from './redaction.js';
import type { SessionRecorder } from './recorder.js';

export interface SnapshotOptions {
  pageId?: string;
  stateVersion?: number;
  screenshotRef?: string | null;
  recorder?: SessionRecorder;
  lastResponseStatus?: number | null;
}

/**
 * Generates a clean, schema-conforming BrowserSnapshot with sensitive data scrubbed.
 */
export async function captureBrowserSnapshot(
  page: Page,
  options: SnapshotOptions = {}
): Promise<BrowserSnapshot> {
  const snapshotId = randomUUID();
  const pageId = options.pageId || randomUUID();
  const stateVersion = options.stateVersion ?? 1;
  const rawUrl = page.url();
  const displayUrl = sanitizeUrl(rawUrl).slice(0, 8192);
  const title = (await page.title().catch(() => '')).slice(0, 500);
  const viewportSize = page.viewportSize() || { width: 1280, height: 720 };

  const frameIds: string[] = ['main'];
  const allNodes: SnapshotNode[] = [];
  let isTruncated = false;

  const frames = page.frames();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const isMain = frame === page.mainFrame();
    const frameId = isMain ? 'main' : `frame-${i}-${frame.name() || 'subframe'}`.slice(0, 120);

    if (!isMain && !frameIds.includes(frameId)) {
      frameIds.push(frameId);
    }

    try {
      // Evaluate within frame context
      const frameNodes = await extractNodesFromFrame(frame, frameId);
      for (const node of frameNodes) {
        if (allNodes.length >= 1000) {
          isTruncated = true;
          break;
        }
        allNodes.push(node);
      }
    } catch {
      // Inaccessible frame (cross-origin or detached)
      if (!isMain && !frameIds.includes(frameId)) {
        frameIds.push(frameId);
      }
      if (allNodes.length < 1000) {
        allNodes.push({
          nodeId: `inaccessible-${frameId}`.slice(0, 120),
          frameId,
          role: 'iframe',
          name: 'Inaccessible frame',
          text: 'Cross-origin frame content cannot be accessed directly',
          visible: true,
          enabled: false,
          bounds: { left: 0, top: 0, width: 0, height: 0 }
        });
      }
    }

    if (allNodes.length >= 1000) {
      isTruncated = true;
      break;
    }
  }

  // Retrieve summaries from recorder
  const summaries = options.recorder
    ? options.recorder.getSnapshotSummaries()
    : {
        networkSummary: [],
        consoleSummary: [],
        truncated: false,
        redacted: true
      };

  const snapshot: BrowserSnapshot = {
    snapshotId,
    pageId,
    frameIds: frameIds.slice(0, 100),
    displayUrl,
    title,
    responseStatus: options.lastResponseStatus ?? 200,
    capturedAt: new Date().toISOString(),
    stateVersion,
    viewport: {
      width: Math.max(100, Math.min(10000, viewportSize.width)),
      height: Math.max(100, Math.min(10000, viewportSize.height))
    },
    nodes: allNodes.slice(0, 1000),
    screenshotRef: options.screenshotRef || null,
    networkSummary: summaries.networkSummary.slice(0, 100),
    consoleSummary: summaries.consoleSummary.slice(0, 50),
    truncated: isTruncated || summaries.truncated,
    redacted: true
  };

  // Validate output against contracts schema
  const validation = validateContract('BrowserSnapshot', snapshot);
  if (!validation.success) {
    const errorDetails = validation.errors.map((e) => `${e.instancePath} ${e.message}`).join(', ');
    throw new Error(`Generated BrowserSnapshot violated contract schema: ${errorDetails}`);
  }

  return snapshot;
}

/**
 * Extracts interactive and content nodes from a Playwright Frame.
 * Strictly redacts passwords, hidden inputs, storage, and sensitive queries.
 */
async function extractNodesFromFrame(frame: Frame, frameId: string): Promise<SnapshotNode[]> {
  const rawNodes = await frame.evaluate((fId) => {
    const selector = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'main',
      'nav',
      'details',
      'summary',
      'table',
      'canvas',
      '[role]',
      '[data-testid]',
      '[data-test]',
      '[tabindex]'
    ].join(',');

    const elements = Array.from(document.querySelectorAll(selector));
    const results: Array<{
      nodeId: string;
      frameId: string;
      role: string;
      name: string;
      text: string;
      visible: boolean;
      enabled: boolean;
      bounds: { left: number; top: number; width: number; height: number };
      isSensitive: boolean;
    }> = [];

    let counter = 0;

    for (const el of elements) {
      if (counter >= 1000) break;

      const tag = el.tagName.toLowerCase();
      const inputType = el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
      const isPassword = inputType === 'password';
      const isHiddenInput = inputType === 'hidden';
      const isSensitiveAttr =
        el.getAttribute('data-sensitive') === 'true' ||
        el.getAttribute('autocomplete') === 'current-password' ||
        el.getAttribute('autocomplete') === 'new-password';

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible =
        !isHiddenInput &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0;

      const isEnabled = !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';

      const role =
        el.getAttribute('role') ||
        (tag === 'a' ? 'link' : tag === 'input' ? inputType || 'textbox' : tag);

      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const placeholder = (el as HTMLInputElement).placeholder || '';
      const titleAttr = el.getAttribute('title') || '';

      // Text and Name calculation
      let text = '';
      if (!isPassword && !isHiddenInput && !isSensitiveAttr) {
        text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      } else {
        text = '[redacted]';
      }

      let name = testId || ariaLabel || titleAttr || placeholder;
      if (!name && text) {
        name = text.slice(0, 100);
      }
      if (!name) {
        name = `${role}_${counter}`;
      }

      // Stable nodeId
      const nodeId = testId ? `testid_${testId}` : `${fId}_node_${counter}`;

      results.push({
        nodeId: nodeId.slice(0, 120),
        frameId: fId,
        role: role.slice(0, 120),
        name: name.slice(0, 1000),
        text: text.slice(0, 2000),
        visible: isVisible,
        enabled: isEnabled,
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height))
        },
        isSensitive: isPassword || isHiddenInput || isSensitiveAttr
      });

      counter++;
    }

    return results;
  }, frameId);

  // Apply Node.js-side regex sanitization
  return rawNodes.map((rn) => ({
    nodeId: rn.nodeId,
    frameId: rn.frameId,
    role: rn.role,
    name: sanitizeText(rn.name),
    text: sanitizeText(rn.text),
    visible: rn.visible,
    enabled: rn.enabled,
    bounds: rn.bounds
  }));
}
