import type { Page, Frame, JSHandle, ElementHandle } from 'playwright';
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
  /**
   * Set only when the page was still changing after the action that produced
   * this observation (the settle cap was reached). Absent means stable.
   */
  settled?: boolean | undefined;
}

type DomWitness = {
  frame: Frame;
  handle: JSHandle<{
    changed: () => boolean;
    targetUnchanged: (element: unknown) => boolean;
    /** The button a plain Enter in this control would activate, if unique. */
    enterButton: (element: unknown) => Element | null;
    stop: () => void;
  }>;
  /**
   * Page-side nodeId -> element map from the snapshot extraction. Held only
   * through this handle, so page JS has no global name to reach it by. Used
   * to prove that an action is bound to the very element the snapshot
   * recorded, not to a lookalike a locator rebound to.
   */
  registry?: JSHandle<{ byNodeId: Map<string, Element> }>;
};
// Process-local only: never persisted, serialized into model messages or
// exposed to page JS. Old handles invalidate on frame document navigation.
const pageWitnesses = new WeakMap<Page, Map<string, Map<string, DomWitness>>>();
const MAX_SNAPSHOT_WITNESSES_PER_PAGE = 12;

async function disposeWitnesses(witnesses: Map<string, DomWitness>) {
  await Promise.allSettled(
    [...witnesses.values()].map(async ({ handle, registry }) => {
      await handle.evaluate((w) => w.stop()).catch(() => undefined);
      await handle.dispose().catch(() => undefined);
      await registry?.dispose().catch(() => undefined);
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

/**
 * True when the approved element and its own content were left untouched by
 * every DOM change observed since the snapshot, even though the document as a
 * whole changed. Unrelated page churn (title, loading overlays, another
 * field's validation, our own previous action elsewhere) does not invalidate
 * the model's observation of this element, while a remount, replacement or
 * content change still does. A missing/evicted witness fails closed.
 */
export async function snapshotTargetUnchanged(
  page: Page,
  snapshotId: string,
  frameId: string,
  frame: Frame,
  element: ElementHandle<SVGElement | HTMLElement>,
): Promise<boolean> {
  const record = pageWitnesses.get(page)?.get(snapshotId)?.get(frameId);
  if (!record || record.frame !== frame) return false;
  try {
    return await record.handle.evaluate(
      (w, target) => w.targetUnchanged(target),
      element,
    );
  } catch {
    // Detached frame, destroyed execution context or disposed observer.
    return false;
  }
}

/**
 * True when the bound element is the exact DOM object the snapshot recorded
 * for this node. A locator can silently rebind to another element with the
 * same role and name when the page reveals it through an ancestor's
 * class/style/hidden (carousels, tabs, lazy panels). Only this object
 * identity proves the action stays on the element the model selected. A
 * missing/evicted registry fails closed.
 */
export async function snapshotTargetIdentity(
  page: Page,
  snapshotId: string,
  frameId: string,
  frame: Frame,
  nodeId: string,
  element: ElementHandle<SVGElement | HTMLElement>,
): Promise<boolean> {
  const record = pageWitnesses.get(page)?.get(snapshotId)?.get(frameId);
  if (!record || record.frame !== frame || !record.registry) return false;
  try {
    const expected = await record.registry.evaluateHandle(
      (registry, id) => registry.byNodeId.get(id) ?? null,
      nodeId,
    );
    try {
      return await element.evaluate(
        (el, other) => (other as unknown) === el,
        expected,
      );
    } finally {
      await expected.dispose().catch(() => undefined);
    }
  } catch {
    // Detached frame, destroyed execution context or disposed registry.
    return false;
  }
}

/**
 * The live DOM element a plain Enter in `control` would activate, computed by
 * the snapshot's own rule. Returns null when there is no single equivalent
 * button. The element is returned as a handle so the caller can compare its
 * object identity with the button the snapshot recorded.
 */
export async function snapshotEnterButton(
  page: Page,
  snapshotId: string,
  frameId: string,
  frame: Frame,
  control: ElementHandle<SVGElement | HTMLElement>,
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  const record = pageWitnesses.get(page)?.get(snapshotId)?.get(frameId);
  if (!record || record.frame !== frame) return null;
  try {
    const handle = await record.handle.evaluateHandle(
      (w, element) => w.enterButton(element) ?? null,
      control,
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose().catch(() => undefined);
      return null;
    }
    return element as ElementHandle<SVGElement | HTMLElement>;
  } catch {
    // Detached frame, destroyed execution context or disposed observer.
    return null;
  }
}

/**
 * The snapshot-time element recorded for a node, held in the process-local
 * registry. Used to prove that a live button is still the approved one.
 */
export async function snapshotNodeElement(
  page: Page,
  snapshotId: string,
  frameId: string,
  frame: Frame,
  nodeId: string,
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  const record = pageWitnesses.get(page)?.get(snapshotId)?.get(frameId);
  if (!record || record.frame !== frame || !record.registry) return null;
  try {
    const handle = await record.registry.evaluateHandle(
      (registry, id) => registry.byNodeId.get(id) ?? null,
      nodeId,
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose().catch(() => undefined);
      return null;
    }
    return element as ElementHandle<SVGElement | HTMLElement>;
  } catch {
    return null;
  }
}

/**
 * nodeId -> the button node a plain Enter in that control would activate, for
 * every text-like control in the frame. Computed page-side from the snapshot's
 * own rule; a button that is not a snapshot node is never referenced.
 */
async function enterButtonNodeIds(
  witness: DomWitness,
  registry: JSHandle<{ byNodeId: Map<string, Element> }>,
): Promise<Record<string, string>> {
  return witness.handle.evaluate(
    (w, reg: unknown) => {
      const registry = reg as { byNodeId: Map<string, Element> };
      const nodeIdByElement = new Map<Element, string>();
      for (const [nodeId, element] of registry.byNodeId)
        nodeIdByElement.set(element, nodeId);
      const out: Record<string, string> = {};
      for (const [nodeId, element] of registry.byNodeId) {
        const tag = element.tagName.toLowerCase();
        const textLike =
          tag === 'textarea' ||
          (tag === 'input' &&
            [
              'text',
              'email',
              'tel',
              'url',
              'search',
              'number',
              'password',
              '',
            ].includes((element as HTMLInputElement).type.toLowerCase()));
        if (!textLike) continue;
        const button = w.enterButton(element);
        if (!button) continue;
        const buttonNodeId = nodeIdByElement.get(button);
        if (buttonNodeId) out[nodeId] = buttonNodeId;
      }
      return out;
    },
    registry as unknown,
  );
}

async function newDomWitness(frame: Frame): Promise<DomWitness> {
  const handle = await frame.evaluateHandle(() => {
    const MAX_RECORDS = 2000;
    const records: MutationRecord[] = [];
    let saturated = false;
    const retain = (mutations: MutationRecord[]) => {
      for (const record of mutations) records.push(record);
      if (records.length > MAX_RECORDS) {
        // Older evidence was dropped, so "this element was untouched" can no
        // longer be proven. Fail closed for the target-scoped check.
        saturated = true;
        records.splice(0, records.length - MAX_RECORDS);
      }
    };
    const observer = new MutationObserver(retain);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const drain = () => {
      // The callback and takeRecords() are the two delivery paths; retain
      // both so a delivered record is never dropped.
      retain(observer.takeRecords());
    };
    const contains = (element: Node, target: Node): boolean =>
      target === element || element.contains(target);

    // ---- the button a plain Enter in a control would activate -----------
    // Rules (keep in sync with docs and the grant's evaluateTargetGrant):
    //  1. a button-like control activates itself;
    //  2. a form's native default submit button wins;
    //  3. otherwise the first ancestor holding visible buttons decides:
    //     exactly one visible+enabled button is the equivalent button, more
    //     than one is ambiguous (none), and a dialog is the outermost scope.
    // Deliberately excluded from rule 3: plain links (a "forgot password" link
    // beside a field is not its submit control) and any button that is hidden
    // or disabled.
    const BUTTONISH =
      'button, [role="button"], input[type="submit"], input[type="button"], input[type="image"], input[type="reset"]';
    const ENTER_BUTTON_MAX_DEPTH = 6;
    const isDialogLike = (el: Element): boolean =>
      el.tagName.toLowerCase() === 'dialog' ||
      el.getAttribute('role') === 'dialog' ||
      el.getAttribute('aria-modal') === 'true';
    const isShown = (el: Element): boolean => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if ((el as HTMLButtonElement).disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      )
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isButtonLike = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return true;
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type.toLowerCase();
        return (
          type === 'submit' ||
          type === 'button' ||
          type === 'image' ||
          type === 'reset'
        );
      }
      if (tag === 'a') return (el as HTMLAnchorElement).hasAttribute('href');
      return el.getAttribute('role') === 'button';
    };
    const nativeSubmitButton = (form: HTMLFormElement): Element | null => {
      for (const el of Array.from(form.elements)) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') {
          const type = (el as HTMLButtonElement).type.toLowerCase();
          if (type === 'submit' || !el.hasAttribute('type')) return el;
        } else if (tag === 'input') {
          const type = (el as HTMLInputElement).type.toLowerCase();
          if (type === 'submit' || type === 'image') return el;
        }
      }
      return null;
    };
    const enterButton = (control: Element): Element | null => {
      if (isButtonLike(control)) return control;
      const form = (control as HTMLInputElement).form ?? null;
      if (form) {
        const native = nativeSubmitButton(form);
        if (native) return native;
      }
      let ancestor: Element | null = (form ?? control).parentElement;
      for (let depth = 0; ancestor && depth < ENTER_BUTTON_MAX_DEPTH; depth++) {
        if (
          ancestor === document.body ||
          ancestor === document.documentElement
        )
          return null;
        const buttons = Array.from(ancestor.querySelectorAll(BUTTONISH)).filter(
          isShown,
        );
        if (buttons.length > 0)
          return buttons.length === 1 ? buttons[0]! : null;
        if (isDialogLike(ancestor)) return null;
        ancestor = ancestor.parentElement;
      }
      return null;
    };

    return {
      changed: () => {
        drain();
        return records.length > 0;
      },
      targetUnchanged: (element: unknown) => {
        drain();
        if (saturated) return false;
        if (!element || !(element as Node).isConnected) return false;
        const target = element as Node;
        const parent = target.parentNode;
        for (const record of records) {
          if (record.type === 'childList') {
            // Children of the target, the target's own position among
            // siblings, or any descendant structure changed.
            if (
              record.target === target ||
              (parent !== null && record.target === parent) ||
              target.contains(record.target)
            )
              return false;
            // The target itself was inserted or removed as part of a larger
            // subtree replacement (SPA route change, remount). A locator can
            // rebind to the new element; it is not the approved one.
            for (const node of record.addedNodes)
              if (node === target || node.contains(target)) return false;
            for (const node of record.removedNodes)
              if (node === target || node.contains(target)) return false;
          } else if (contains(target, record.target)) {
            // The target's own attributes or text content changed.
            return false;
          }
        }
        return true;
      },
      enterButton: (element: unknown) =>
        element ? enterButton(element as Element) : null,
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
      domWitnesses.set(frameId, {
        ...witness,
        registry: frameExtract.registry,
      });
      if (frameExtract.truncated) isTruncated = true;
      // Record which button a plain Enter in each text control would activate.
      // The witness runs the same rule live, so the grant and the executor
      // compare one definition of "equivalent button".
      const enterButtons = await enterButtonNodeIds(
        witness,
        frameExtract.registry,
      ).catch(() => null);
      const frameNodes = enterButtons
        ? frameExtract.nodes.map((node) => {
            const enterButtonNodeId = enterButtons[node.nodeId];
            return enterButtonNodeId ? { ...node, enterButtonNodeId } : node;
          })
        : frameExtract.nodes;
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
          bounds: { left: 0, top: 0, width: 0, height: 0 },
        });
      }
    }

    if (allNodes.length >= 1000) {
      isTruncated = true;
      break;
    }
  }

  // A field may only point at a button that survived into this snapshot.
  const presentNodeIds = new Set(
    allNodes.map((node) => `${node.frameId}\u0000${node.nodeId}`),
  );
  for (const node of allNodes) {
    if (
      node.enterButtonNodeId &&
      !presentNodeIds.has(`${node.frameId}\u0000${node.enterButtonNodeId}`)
    )
      delete node.enterButtonNodeId;
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
    // Only a clipped node observation counts as truncated. Capped
    // network/console *summaries* must not mark a complete DOM as incomplete:
    // consumers use this flag to decide whether the observed page can prove
    // an element's absence and whether the sign-in page really came back.
    truncated: isTruncated,
    ...(options.settled === false ? { settled: false } : {}),
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
 *
 * Beside the legacy interactive/content selector, the snapshot now also records
 * what a user can actually read: visible text that is not itself a control
 * (form validation messages, toasts, hints, body copy) and the current content
 * of value-bearing controls. Text nodes are appended *after* every control and
 * have their own budget, so they can never crowd a control out of the snapshot.
 */
async function extractNodesFromFrame(
  frame: Frame,
  frameId: string,
): Promise<{
  nodes: SnapshotNode[];
  truncated: boolean;
  registry: JSHandle<{ byNodeId: Map<string, Element> }>;
}> {
  const handle = await frame.evaluateHandle((fId) => {
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
    // Controls whose own text already covers everything inside them. A text run
    // nested in one of these would only duplicate the control's text.
    const CONTROL_TEXT_OWNER =
      'button,a[href],select,textarea,input,option,optgroup,summary,canvas';
    // Live regions that already become a control node carrying their text.
    const LIVE_REGION =
      '[role="alert"],[role="status"],[role="log"],[role="tooltip"]';
    // How far above a text run its form item may sit.
    const GROUP_DEPTH = 6;
    // Page-level containers are never "the form item" a text belongs to: their
    // text is body copy, not a field's hint, even when the page happens to hold
    // a single field.
    const STRUCTURAL_TAGS = new Set([
      'form',
      'main',
      'section',
      'article',
      'aside',
      'header',
      'footer',
      'nav',
      'table',
      'dialog',
      'fieldset',
      'ul',
      'ol',
      'body',
      'html',
    ]);
    const STRUCTURAL_ROLES = new Set([
      'form',
      'dialog',
      'main',
      'region',
      'group',
      'list',
      'navigation',
      'table',
    ]);
    const isStructural = (el: Element): boolean => {
      if (STRUCTURAL_TAGS.has(el.tagName.toLowerCase())) return true;
      const role = el.getAttribute('role');
      return typeof role === 'string' && STRUCTURAL_ROLES.has(role);
    };
    const MAX_CONTROLS = 1000;
    // Visible text is admitted in two classes so ordinary body copy can never
    // spend the budget a validation message needs.
    const MAX_TEXT_NODES = 400;
    const MAX_TEXT_CANDIDATES = 2000;
    const MAX_SCAN = 5000;
    const VALUE_LIMIT = 200;
    const TEXT_LIMIT = 2000;
    // Types whose value is not user-visible content: never read them.
    const UNREAD_VALUE_TYPES = new Set([
      'checkbox',
      'radio',
      'file',
      'submit',
      'button',
      'reset',
      'image',
    ]);

    // The legacy snapshot only traversed light DOM. Open Shadow Roots are
    // accessible browser DOM but excluded by document.querySelectorAll,
    // causing the AI to invent targets even though Playwright can locate them.
    // Traverse open roots only, with a hard shared work cap. Closed roots
    // remain opaque; there is no shadow-root piercing or instrumentation.
    const elements: Element[] = [];
    // Visible text candidates. A hidden element must never take a candidate
    // slot: a collapsed menu or an unexpanded select can hold hundreds of
    // invisible strings ahead of the one visible notice appended to the body.
    const textCandidates: Array<{ el: Element; rect: DOMRect }> = [];
    let textCandidateOverflow = false;
    const directText = (el: Element): string => {
      let out = '';
      for (const child of el.childNodes)
        if (child.nodeType === 3) out += child.nodeValue ?? '';
      return out.replace(/\s+/g, ' ').trim();
    };
    const checkVisibility = (
      el: Element & {
        checkVisibility?: (options?: {
          checkOpacity?: boolean;
          checkVisibilityCSS?: boolean;
        }) => boolean;
      },
    ): boolean => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if (typeof el.checkVisibility === 'function') {
        try {
          return el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          });
        } catch {
          /* fall through to the explicit checks */
        }
      }
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility === 'visible';
    };
    let scanned = 0;
    // Keyboard focus. `document.activeElement` names the shadow host, so an
    // input inside an open shadow root needs one more hop; a same-origin child
    // frame resolves this in its own document, so each frame reports its own
    // focus and only the frame that really has it marks a node.
    const deepActiveElement = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement)
        active = active.shadowRoot.activeElement;
      return active;
    };
    const focusedElement = deepActiveElement();
    const pageLevelFocus =
      !focusedElement ||
      focusedElement === document.body ||
      focusedElement === document.documentElement ||
      ['body', 'html'].includes(focusedElement.tagName.toLowerCase());
    const scan = (root: Document | ShadowRoot): void => {
      if (scanned >= MAX_SCAN || elements.length >= MAX_CONTROLS) return;
      for (const el of root.querySelectorAll('*')) {
        if (scanned++ >= MAX_SCAN || elements.length >= MAX_CONTROLS) return;
        if (el.matches(selector)) elements.push(el);
        else if (
          !el.matches('script,style,noscript,template') &&
          directText(el).length > 0 &&
          checkVisibility(el)
        ) {
          const rect = el.getBoundingClientRect();
          // Zero-size text is not readable, so it is not a candidate either.
          if (rect.width > 0 && rect.height > 0) {
            if (textCandidates.length < MAX_TEXT_CANDIDATES)
              textCandidates.push({ el, rect });
            else textCandidateOverflow = true;
          }
        }
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(document);
    // A focused element the selector does not cover (a contenteditable block, an
    // iframe that owns the focus) is still where Tab went: report it, marked
    // focused, instead of dropping the only focus evidence the page has. Focus
    // on body/html means "nothing in the page is focused" and marks no node.
    if (
      !pageLevelFocus &&
      focusedElement &&
      !elements.includes(focusedElement) &&
      elements.length < MAX_CONTROLS
    )
      elements.push(focusedElement);
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
      value?: string;
      relatedNodeId?: string;
      placeholder?: string;
      invalid?: boolean;
      focused?: boolean;
    }> = [];
    const byNodeId = new Map<string, Element>();
    const nodeIdByElement = new Map<Element, string>();
    // id referenced by a control through ARIA -> that control.
    const referenceOwner = new Map<string, Element>();

    let counter = 0;

    for (const el of elements) {
      if (counter >= MAX_CONTROLS) break;

      const tag = el.tagName.toLowerCase();
      const inputType =
        el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
      const isPassword = inputType === 'password';
      const isHiddenInput = inputType === 'hidden';
      const isSensitiveAttr =
        el.getAttribute('data-sensitive') === 'true' ||
        el.getAttribute('autocomplete') === 'current-password' ||
        el.getAttribute('autocomplete') === 'new-password';
      const isSensitive = isPassword || isHiddenInput || isSensitiveAttr;

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
      if (!isSensitive) {
        text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      } else {
        text = '[redacted]';
      }

      // Current content of a value-bearing control, separate from the
      // placeholder/label in `name`. A sensitive control only reveals whether
      // it holds anything, never the value itself.
      let value: string | undefined;
      if (isPassword || isHiddenInput) {
        value = (el as HTMLInputElement).value ? '[redacted]' : '';
      } else if (el instanceof HTMLSelectElement) {
        const option = el.selectedOptions[0];
        value = (option ? option.textContent || option.value : '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, VALUE_LIMIT);
      } else if (
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !UNREAD_VALUE_TYPES.has(inputType))
      ) {
        const raw = el.value ?? '';
        value = isSensitiveAttr
          ? raw
            ? '[redacted]'
            : ''
          : raw.replace(/\s+/g, ' ').trim().slice(0, VALUE_LIMIT);
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

      // Stable nodeId. The registry keeps the exact element for later
      // identity checks; it is reachable only through a process-local handle.
      const nodeId = (
        testId ? `testid_${testId}` : `${fId}_node_${counter}`
      ).slice(0, 120);
      byNodeId.set(nodeId, el);
      nodeIdByElement.set(el, nodeId);
      for (const attribute of [
        'aria-describedby',
        'aria-errormessage',
        'aria-labelledby',
      ]) {
        for (const id of (el.getAttribute(attribute) || '').split(' ')) {
          if (id && !referenceOwner.has(id)) referenceOwner.set(id, el);
        }
      }

      results.push({
        nodeId,
        frameId: fId,
        role: role.slice(0, 120),
        ...(inputType
          ? { inputType }
          : el instanceof HTMLButtonElement
            ? { inputType: el.type }
            : {}),
        name: name.slice(0, 1000),
        text: text.slice(0, TEXT_LIMIT),
        ...(value !== undefined ? { value } : {}),
        // The control's own hint stays a separate field: a rendered validation
        // message often repeats the placeholder text word for word.
        ...(placeholder
          ? { placeholder: placeholder.slice(0, VALUE_LIMIT) }
          : {}),
        // Only the standard attribute counts; a class name is not an API.
        ...(el.getAttribute('aria-invalid') === 'true'
          ? { invalid: true }
          : {}),
        ...(el === focusedElement ? { focused: true } : {}),
        visible: isVisible,
        enabled: isEnabled,
        bounds: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        },
        isSensitive,
      });

      counter++;
    }

    // ---- visible text that is not itself a control ---------------------
    // Which ancestor each form field owns ("one form item = one field"). A text
    // run sitting in such a group belongs to that field. Counted once per
    // field instead of running a subtree query per text candidate.
    const groupCounts = new Map<Element, { count: number; field: Element }>();
    for (const el of elements) {
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLSelectElement) &&
        !(el instanceof HTMLTextAreaElement)
      )
        continue;
      if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'hidden')
        continue;
      let ancestor = el.parentElement;
      for (let depth = 0; ancestor && depth < GROUP_DEPTH; depth += 1) {
        if (isStructural(ancestor)) break;
        const entry = groupCounts.get(ancestor);
        if (entry) entry.count += 1;
        else groupCounts.set(ancestor, { count: 1, field: el });
        ancestor = ancestor.parentElement;
      }
    }
    // The control a text run describes: an explicit ARIA reference wins, else
    // the nearest ancestor that holds exactly one form field (one form item).
    const relatedControl = (el: Element): Element | null => {
      const explicit = referenceOwner.get(el.id);
      if (explicit) return explicit;
      let ancestor = el.parentElement;
      for (let depth = 0; ancestor && depth < GROUP_DEPTH; depth += 1) {
        if (isStructural(ancestor)) return null;
        const entry = groupCounts.get(ancestor);
        if (entry) return entry.count === 1 ? entry.field : null;
        ancestor = ancestor.parentElement;
      }
      return null;
    };
    type TextItem = {
      el: Element;
      text: string;
      rect: DOMRect;
      order: number;
      related: Element | null;
      label: boolean;
    };
    // Admitted in this order, so a notice at the end of a long page is not lost
    // to the labels and body copy that came before it.
    const critical: TextItem[] = []; // live region / ARIA-referenced message
    const messages: TextItem[] = []; // field hint that is not just a label
    const labels: TextItem[] = []; // a field's label (its text is the name too)
    const ordinary: TextItem[] = []; // body copy
    let order = 0;
    for (const candidate of textCandidates) {
      const el = candidate.el;
      // A focused element pushed in above is reported as a control, once.
      if (nodeIdByElement.has(el)) continue;
      if (el.closest(CONTROL_TEXT_OWNER)) continue;
      if (el.closest('svg')) continue;
      if (el.closest(LIVE_REGION)) continue;
      const text = directText(el);
      if (!text) continue;
      const related = relatedControl(el);
      const tag = el.tagName.toLowerCase();
      const label = tag === 'label' || el.getAttribute('role') === 'label';
      const item = {
        el,
        text,
        rect: candidate.rect,
        order: order++,
        related,
        label,
      };
      if (el.closest('[aria-live]') || referenceOwner.has(el.id))
        critical.push(item);
      else if (related && !label) messages.push(item);
      else if (related) labels.push(item);
      else ordinary.push(item);
    }
    const budget = (taken: number) => Math.max(0, MAX_TEXT_NODES - taken);
    const keptText = [
      ...critical.slice(0, MAX_TEXT_NODES),
      ...messages.slice(0, budget(critical.length)),
      ...labels.slice(0, budget(critical.length + messages.length)),
      ...ordinary.slice(
        0,
        budget(critical.length + messages.length + labels.length),
      ),
    ].sort((left, right) => left.order - right.order);
    let textCounter = 0;
    for (const item of keptText) {
      const relatedId = item.related
        ? nodeIdByElement.get(item.related)
        : undefined;
      const tag = item.el.tagName.toLowerCase();
      const role =
        tag === 'p'
          ? 'paragraph'
          : tag === 'li'
            ? 'listitem'
            : tag === 'td' || tag === 'th'
              ? 'cell'
              : tag === 'label'
                ? 'label'
                : 'statictext';
      const nodeId = `${fId}_text_${textCounter++}`.slice(0, 120);
      byNodeId.set(nodeId, item.el);
      results.push({
        nodeId,
        frameId: fId,
        role,
        name: item.text.slice(0, 1000),
        text: item.text.slice(0, TEXT_LIMIT),
        visible: true,
        enabled: true,
        bounds: {
          left: Math.round(item.rect.left),
          top: Math.round(item.rect.top),
          width: Math.max(0, Math.round(item.rect.width)),
          height: Math.max(0, Math.round(item.rect.height)),
        },
        isSensitive: false,
        ...(relatedId ? { relatedNodeId: relatedId } : {}),
      });
    }

    // Any visible text that did not make it in is a clipped observation, no
    // matter which cap dropped it.
    const textClipped =
      textCandidateOverflow ||
      keptText.length <
        critical.length + messages.length + labels.length + ordinary.length;
    return {
      results,
      truncated:
        scanned >= MAX_SCAN || elements.length >= MAX_CONTROLS || textClipped,
      byNodeId,
    };
  }, frameId);

  let rawNodes: {
    results: Array<{
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
      value?: string;
      relatedNodeId?: string;
      placeholder?: string;
      invalid?: boolean;
      focused?: boolean;
    }>;
    truncated: boolean;
  };
  try {
    rawNodes = await handle.evaluate((value) => ({
      results: value.results,
      truncated: value.truncated,
    }));
  } catch (error) {
    await handle.dispose().catch(() => undefined);
    throw error;
  }

  // Apply Node.js-side regex sanitization
  return {
    nodes: rawNodes.results.map((rn) => ({
      nodeId: rn.nodeId,
      frameId: rn.frameId,
      role: rn.role,
      ...(rn.inputType ? { inputType: rn.inputType } : {}),
      ...(rn.isSensitive ? { sensitive: true } : {}),
      name: sanitizeText(rn.name),
      text: sanitizeText(rn.text),
      ...(rn.value !== undefined
        ? { value: sanitizeText(rn.value).slice(0, 200) }
        : {}),
      ...(rn.relatedNodeId ? { relatedNodeId: rn.relatedNodeId } : {}),
      ...(rn.placeholder
        ? { placeholder: sanitizeText(rn.placeholder).slice(0, 200) }
        : {}),
      ...(rn.invalid ? { invalid: true } : {}),
      ...(rn.focused ? { focused: true } : {}),
      visible: rn.visible,
      enabled: rn.enabled,
      bounds: rn.bounds,
    })),
    truncated: rawNodes.truncated,
    registry: handle,
  };
}
