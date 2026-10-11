import type { Page, Frame, JSHandle } from 'playwright';
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

type DomWitness = {
  frame: Frame;
  handle: JSHandle<{ changed: () => boolean; stop: () => void }>;
};
// Process-local only: never persisted, serialized into model messages or
// exposed to page JS. Old handles invalidate on frame document navigation.
const pageWitnesses = new WeakMap<Page, Map<string, Map<string, DomWitness>>>();
const MAX_SNAPSHOT_WITNESSES_PER_PAGE = 12;

async function disposeWitnesses(witnesses: Map<string, DomWitness>) {
  await Promise.allSettled(
    [...witnesses.values()].map(async ({ handle }) => {
      await handle.evaluate((w) => w.stop()).catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }),
  );
}

export async function snapshotFrameUnchanged(
  page: Page,
  snapshotId: string,
  frameId: string,
  frame: Frame,
): Promise<boolean> {
  const record = pageWitnesses.get(page)?.get(snapshotId)?.get(frameId);
  if (!record || record.frame !== frame) return false;
  try {
    return !(await record.handle.evaluate((w) => w.changed()));
  } catch {
    // Detached frame, destroyed execution context or disposed observer.
    return false;
  }
}

async function newDomWitness(frame: Frame): Promise<DomWitness> {
  const handle = await frame.evaluateHandle(() => {
    let changed = false;
    const observer = new MutationObserver(() => {
      changed = true;
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return {
      changed: () => changed || observer.takeRecords().length > 0,
      stop: () => observer.disconnect(),
    };
  });
  return { frame, handle };
}

/** Browser automation can observe cross-origin frame DOM unlike page JS.
 * Constrain observations/actions to the approved main origin. The only
 * opaque child URLs allowed are inherited about:blank and about:srcdoc.
 */
export function isSameOriginOwnedFrame(frame: Frame, main: Frame): boolean {
  const origin = new URL(main.url()).origin;
  if (origin === 'null' && main.url() !== 'about:blank') return frame === main;
  let current: Frame | null = frame;
  while (current && current !== main) {
    const url = current.url();
    if (url !== 'about:blank' && url !== 'about:srcdoc') {
      try {
        if (origin === 'null') return false;
        if (new URL(url).origin !== origin) return false;
      } catch {
        return false;
      }
    }
    current = current.parentFrame();
  }
  return current === main;
}

/**
 * Generates a clean, schema-conforming BrowserSnapshot with sensitive data scrubbed.
 */
export async function captureBrowserSnapshot(
  page: Page,
  options: SnapshotOptions = {},
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
  const domWitnesses = new Map<string, DomWitness>();
  let isTruncated = false;

  const frames = page.frames();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const isMain = frame === page.mainFrame();
    const frameId = isMain
      ? 'main'
      : `frame-${i}-${frame.name() || 'subframe'}`.slice(0, 120);

    if (!isMain && !frameIds.includes(frameId)) {
      frameIds.push(frameId);
    }

    try {
      // Do not disclose cross-origin frame text to the model even if
      // Playwright is technically capable of evaluating its DOM.
      if (!isSameOriginOwnedFrame(frame, page.mainFrame()))
        throw new Error('FRAME_ORIGIN_NOT_ALLOWED');
      const witness = await newDomWitness(frame);
      // Evaluate within frame context
      let frameExtract: Awaited<ReturnType<typeof extractNodesFromFrame>>;
      try {
        frameExtract = await extractNodesFromFrame(frame, frameId);
      } catch (error) {
        await disposeWitnesses(new Map([[frameId, witness]]));
        throw error;
      }
      domWitnesses.set(frameId, witness);
      if (frameExtract.truncated) isTruncated = true;
      for (const node of frameExtract.nodes) {
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
          bounds: { left: 0, top: 0, width: 0, height: 0 },
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
        redacted: true,
      };

  const snapshot: BrowserSnapshot = {
    snapshotId,
    pageId,
    frameIds: frameIds.slice(0, 100),
    displayUrl,
    title,
    responseStatus: options.lastResponseStatus ?? null,
    capturedAt: new Date().toISOString(),
    stateVersion,
    viewport: {
      width: Math.max(100, Math.min(10000, viewportSize.width)),
      height: Math.max(100, Math.min(10000, viewportSize.height)),
    },
    nodes: allNodes.slice(0, 1000),
    screenshotRef: options.screenshotRef || null,
    networkSummary: summaries.networkSummary.slice(0, 100),
    consoleSummary: summaries.consoleSummary.slice(0, 50),
    truncated: isTruncated || summaries.truncated,
    redacted: true,
  };

  // Validate output against contracts schema
  const validation = validateContract('BrowserSnapshot', snapshot);
  if (!validation.success) {
    await disposeWitnesses(domWitnesses);
    const errorDetails = validation.errors
      .map((e) => `${e.instancePath} ${e.message}`)
      .join(', ');
    throw new Error(
      `Generated BrowserSnapshot violated contract schema: ${errorDetails}`,
    );
  }

  let registered = pageWitnesses.get(page);
  if (!registered) {
    registered = new Map();
    pageWitnesses.set(page, registered);
  }
  registered.set(snapshotId, domWitnesses);
  // Bound retained observers/JS handles; evicted snapshots fail closed.
  while (registered.size > MAX_SNAPSHOT_WITNESSES_PER_PAGE) {
    const oldestId = registered.keys().next().value;
    if (!oldestId) break;
    const oldest = registered.get(oldestId);
    registered.delete(oldestId);
    if (oldest) await disposeWitnesses(oldest);
  }

  return snapshot;
}

/**
 * Extracts interactive and content nodes from a Playwright Frame.
 * Strictly redacts passwords, hidden inputs, storage, and sensitive queries.
 */
async function extractNodesFromFrame(
  frame: Frame,
  frameId: string,
): Promise<{ nodes: SnapshotNode[]; truncated: boolean }> {
  const rawNodes = await frame.evaluate((fId) => {
    const selector = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'main',
      'nav',
      'details',
      'summary',
      'table',
      'canvas',
      '[role]',
      '[data-testid]',
      '[data-test]',
      '[tabindex]',
    ].join(',');

    // The legacy snapshot only traversed light DOM. Open Shadow Roots are
    // accessible browser DOM but excluded by document.querySelectorAll,
    // causing the AI to invent targets even though Playwright can locate them.
    // Traverse open roots only, with a hard shared work cap. Closed roots
    // remain opaque; there is no shadow-root piercing or instrumentation.
    const elements: Element[] = [];
    let scanned = 0;
    const scan = (root: Document | ShadowRoot): void => {
      if (scanned >= 5000 || elements.length >= 1000) return;
      for (const el of root.querySelectorAll('*')) {
        if (scanned++ >= 5000 || elements.length >= 1000) return;
        if (el.matches(selector)) elements.push(el);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(document);
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
      inputType?: string;
    }> = [];

    let counter = 0;

    for (const el of elements) {
      if (counter >= 1000) break;

      const tag = el.tagName.toLowerCase();
      const inputType =
        el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
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

      const isEnabled =
        !(el as HTMLButtonElement).disabled &&
        el.getAttribute('aria-disabled') !== 'true';

      const role =
        el.getAttribute('role') ||
        (tag === 'a' ? 'link' : tag === 'input' ? inputType || 'textbox' : tag);

      const testId =
        el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const fieldLabels =
        el instanceof HTMLInputElement
          ? Array.from(el.labels ?? [])
              .map((label) => label.textContent ?? '')
              .join(' ')
              .trim()
          : '';
      const fieldName = el instanceof HTMLInputElement ? el.name : '';
      const placeholder = (el as HTMLInputElement).placeholder || '';
      const titleAttr = el.getAttribute('title') || '';

      // Text and Name calculation
      let text: string;
      if (!isPassword && !isHiddenInput && !isSensitiveAttr) {
        text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      } else {
        text = '[redacted]';
      }

      let name =
        testId ||
        ariaLabel ||
        fieldLabels ||
        titleAttr ||
        placeholder ||
        fieldName;
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
        ...(inputType
          ? { inputType }
          : el instanceof HTMLButtonElement
            ? { inputType: el.type }
            : {}),
        name: name.slice(0, 1000),
        text: text.slice(0, 2000),
        visible: isVisible,
        enabled: isEnabled,
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        },
        isSensitive: isPassword || isHiddenInput || isSensitiveAttr,
      });

      counter++;
    }

    return {
      results,
      truncated: scanned >= 5000 || elements.length >= 1000,
    };
  }, frameId);

  // Apply Node.js-side regex sanitization
  return {
    nodes: rawNodes.results.map((rn) => ({
      nodeId: rn.nodeId,
      frameId: rn.frameId,
      role: rn.role,
      ...(rn.inputType ? { inputType: rn.inputType } : {}),
      name: sanitizeText(rn.name),
      text: sanitizeText(rn.text),
      visible: rn.visible,
      enabled: rn.enabled,
      bounds: rn.bounds,
    })),
    truncated: rawNodes.truncated,
  };
}
