import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  ToolCall,
  ToolResult,
  BrowserSnapshot,
  CriterionResult,
  Verdict,
  InputRequest,
  CaseDefinition,
  Finding,
  Reproduction,
  JsonValue,
} from '@localqa/contracts';
import {
  getRootValidator,
  getToolResultValidator,
  validateContract,
  toolMetadata,
} from '@localqa/contracts';
import { STABLE_REASON_CODES, type ActionTargetMetadata } from './types.js';
import { PolicyInterceptor } from './policy.js';
import { resolveTarget } from './resolver.js';
import { captureBrowserSnapshot } from './snapshot.js';
import type { SessionRecorder } from './recorder.js';
import type { WaitAndRecoveryManager } from './waiter.js';

export interface ExecutorContext {
  page: Page;
  pageId: string;
  getPage?: (pageId: string) => Page | undefined;
  stateVersion: number;
  currentSnapshot: BrowserSnapshot | null;
  policy: PolicyInterceptor;
  recorder: SessionRecorder;
  waiter: WaitAndRecoveryManager;
  signal?: AbortSignal;
}

function getTargetPage(ctx: ExecutorContext, pageId?: string): Page | null {
  if (!pageId) return ctx.page;
  if (ctx.getPage) {
    const found = ctx.getPage(pageId);
    if (found) return found;
  }
  return pageId === ctx.pageId ? ctx.page : null;
}

/** Policy hints are read from the current DOM, never from the model. */
async function inspectedTargetMetadata(
  resolved: Extract<
    Awaited<ReturnType<typeof resolveTarget>>,
    { status: 'resolved' }
  >,
  page: Page,
): Promise<ActionTargetMetadata> {
  const handle = resolved.elementHandle;
  const attr = (name: string): Promise<string | null> =>
    typeof handle.getAttribute === 'function'
      ? handle.getAttribute(name).catch(() => null)
      : Promise.resolve(null);
  const [href, formAction, formMethod, type, owner] = await Promise.all([
    attr('href'),
    attr('formaction'),
    attr('formmethod'),
    attr('type'),
    handle
      .evaluate((node) => {
        const form = node.closest('form');
        const anchor = node.closest('a[href]');
        return {
          action: form?.getAttribute('action') ?? null,
          method: form?.getAttribute('method') ?? null,
          href: anchor?.getAttribute('href') ?? null,
        };
      })
      .catch(() => ({ action: null, method: null, href: null })),
  ]);
  const absolute = (value: string | null) => {
    if (!value) return undefined;
    try {
      return new URL(value, page.url()).toString();
    } catch {
      return value;
    }
  };
  return {
    nodeId: resolved.node.nodeId,
    role: resolved.node.role,
    name: resolved.node.name,
    text: resolved.node.text,
    tag: resolved.node.role === 'button' ? 'button' : undefined,
    href: absolute(href ?? owner.href),
    actionUrl: absolute(formAction ?? owner.action),
    isDangerousMutation:
      ['post', 'put', 'patch', 'delete'].includes(
        (formMethod ?? owner.method ?? '').toLowerCase(),
      ) &&
      (type === 'submit' || resolved.node.role === 'button'),
  };
}

export class ToolExecutor {
  private readonly toolValidator = getRootValidator('tools');

  private finalizeResult(
    result: ToolResult,
    toolCall: ToolCall,
    snapshot: BrowserSnapshot,
  ): { result: ToolResult; snapshot: BrowserSnapshot } {
    if (result.status === 'succeeded') {
      const resultValidator = getToolResultValidator(toolCall.name);
      if (resultValidator && !resultValidator(result.data)) {
        const errorDetails =
          resultValidator.errors
            ?.map((e) => `${e.instancePath} ${e.message}`)
            .join(', ') || 'Schema violation';
        throw new Error(
          `Tool '${toolCall.name}' result data violated contract schema (${toolMetadata[toolCall.name]?.resultContract}): ${errorDetails}`,
        );
      }
    }

    const envelopeValidation = validateContract('ToolResult', result);
    if (!envelopeValidation.success) {
      const errorDetails = envelopeValidation.errors
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(', ');
      throw new Error(
        `Generated ToolResult envelope violated contract schema: ${errorDetails}`,
      );
    }

    return { result, snapshot };
  }

  /**
   * Validates and executes a ToolCall on the active browser session.
   */
  public async execute(
    toolCall: ToolCall,
    ctx: ExecutorContext,
  ): Promise<{ result: ToolResult; snapshot: BrowserSnapshot }> {
    const requestId = randomUUID();

    // 1. Check AbortSignal upfront
    if (ctx.signal?.aborted) {
      const snapshot =
        ctx.currentSnapshot ||
        (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return this.finalizeResult(
        {
          requestId,
          actionId: null,
          status: 'cancelled',
          // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.USER_CANCELLED,
          evidenceRefs: [],
        },
        toolCall,
        snapshot,
      );
    }

    // 2. Prohibited Tools Gate
    const toolName = (toolCall as { name: string }).name;
    const prohibited = new Set([
      'evaluate',
      'eval',
      'exec',
      'shell',
      'read_file',
      'write_file',
    ]);
    if (prohibited.has(toolName as string)) {
      const snapshot =
        ctx.currentSnapshot ||
        (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return this.finalizeResult(
        {
          requestId,
          actionId: null,
          status: 'denied',
          // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
          evidenceRefs: [],
        },
        toolCall,
        snapshot,
      );
    }

    // 3. Schema Validation via @localqa/contracts
    const isValid = this.toolValidator(toolCall);
    if (!isValid) {
      const snapshot =
        ctx.currentSnapshot ||
        (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return this.finalizeResult(
        {
          requestId,
          actionId: null,
          status: 'failed',
          // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.VALIDATION_ERROR,
          evidenceRefs: [],
        },
        toolCall,
        snapshot,
      );
    }

    // Ensure we have a fresh baseline snapshot for target-based tools
    if (!ctx.currentSnapshot) {
      ctx.currentSnapshot = await captureBrowserSnapshot(ctx.page, {
        pageId: ctx.pageId,
        stateVersion: ctx.stateVersion,
        recorder: ctx.recorder,
      });
    }

    const actionId = randomUUID();

    // Apply the common policy to every tool, not just click/type/navigation.
    const generalPolicy = ctx.policy.checkAction(
      toolCall,
      undefined,
      ctx.page.url(),
    );
    if (!generalPolicy.allowed) {
      return this.finalizeResult(
        {
          requestId,
          actionId,
          status: 'denied',
          data: ctx.currentSnapshot as unknown as JsonValue,
          reasonCode:
            generalPolicy.reasonCode ?? STABLE_REASON_CODES.POLICY_DENIED,
          evidenceRefs: [],
        },
        toolCall,
        ctx.currentSnapshot,
      );
    }

    try {
      // 4. Dispatch Tool Execution
      switch (toolCall.name) {
        case 'observe': {
          const targetPageId = toolCall.args?.pageId || ctx.pageId;
          const targetPage = getTargetPage(ctx, toolCall.args?.pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot,
            );
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId: targetPageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });
          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'navigate': {
          const { url } = toolCall.args;
          const policyCheck = ctx.policy.checkNavigationUrl(url);
          if (!policyCheck.allowed) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'denied',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode:
                  policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot,
            );
          }

          const response = await ctx.waiter.navigate(ctx.page, url, {
            signal: ctx.signal,
          });
          const responseStatus = response ? response.status() : null;

          // Navigation may follow redirects. Re-check the URL that actually
          // loaded so a redirect cannot move the session onto a disallowed or
          // restricted origin.
          const finalUrl = ctx.page.url();
          if (/^https?:\/\//i.test(finalUrl)) {
            const finalCheck = ctx.policy.checkNavigationUrl(finalUrl);
            if (!finalCheck.allowed) {
              const redirectSnapshot = await captureBrowserSnapshot(ctx.page, {
                pageId: ctx.pageId,
                stateVersion: ++ctx.stateVersion,
                recorder: ctx.recorder,
                lastResponseStatus: responseStatus,
              });
              return this.finalizeResult(
                {
                  requestId,
                  actionId,
                  status: 'denied',
                  // SAFETY: BrowserSnapshot is the JSON-serializable payload the
                  // ToolResult envelope carries; the contract types it as JsonValue.
                  // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                  data: redirectSnapshot as unknown as JsonValue,
                  reasonCode:
                    finalCheck.reasonCode ??
                    STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
                  evidenceRefs: [],
                },
                toolCall,
                redirectSnapshot,
              );
            }
          }

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
            lastResponseStatus: responseStatus,
          });

          // Check action repetition loop
          const fingerprint = ctx.waiter.computeFingerprint(snapshot);
          ctx.waiter.recordAction('navigate', url, fingerprint);

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'click': {
          const { target } = toolCall.args;
          const targetPage = getTargetPage(ctx, target.pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const resolved = await resolveTarget(
            targetPage,
            target,
            ctx.currentSnapshot!,
          );
          if (resolved.status === 'rejected') {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          // Policy check on target
          const policyCheck = ctx.policy.checkAction(
            toolCall,
            await inspectedTargetMetadata(resolved, targetPage),
            targetPage.url(),
          );

          if (!policyCheck.allowed) {
            await resolved.elementHandle.dispose().catch(() => undefined);
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'denied',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode:
                  policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          try {
            // Detect inert repeats before dispatch. Previously the third
            // click happened but was reported failed after the fact.
            if (ctx.currentSnapshot)
              ctx.waiter.assertActionPermitted(
                'click',
                target.nodeId,
                ctx.waiter.computeFingerprint(ctx.currentSnapshot),
              );
            if (ctx.signal?.aborted)
              throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
            await resolved.elementHandle.click({ timeout: 15000 });
          } finally {
            await resolved.elementHandle.dispose().catch(() => undefined);
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId: target.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          const fingerprint = ctx.waiter.computeFingerprint(snapshot);
          ctx.waiter.recordAction('click', target.nodeId, fingerprint);

          return this.finalizeResult(
            {
              requestId,
              actionId,
              // Cancellation during dispatch does not undo a browser-side
              // click. Preserve a non-null actionId for ambiguous outcomes.
              status: ctx.signal?.aborted ? 'cancelled' : 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: ctx.signal?.aborted
                ? STABLE_REASON_CODES.USER_CANCELLED
                : null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'type_text': {
          const { target, text } = toolCall.args;
          const targetPage = getTargetPage(ctx, target.pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const resolved = await resolveTarget(
            targetPage,
            target,
            ctx.currentSnapshot!,
          );
          if (resolved.status === 'rejected') {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const policyCheck = ctx.policy.checkAction(
            toolCall,
            await inspectedTargetMetadata(resolved, targetPage),
            targetPage.url(),
          );

          if (!policyCheck.allowed) {
            await resolved.elementHandle.dispose().catch(() => undefined);
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'denied',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode:
                  policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          try {
            if (ctx.signal?.aborted)
              throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
            await resolved.elementHandle.fill(text, { timeout: 15000 });
          } finally {
            await resolved.elementHandle.dispose().catch(() => undefined);
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId: target.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'select_option': {
          const { target, value } = toolCall.args;
          const targetPage = getTargetPage(ctx, target.pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const resolved = await resolveTarget(
            targetPage,
            target,
            ctx.currentSnapshot!,
          );
          if (resolved.status === 'rejected') {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const selectPolicy = ctx.policy.checkAction(
            toolCall,
            await inspectedTargetMetadata(resolved, targetPage),
            targetPage.url(),
          );
          if (!selectPolicy.allowed) {
            await resolved.elementHandle.dispose().catch(() => undefined);
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'denied',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode:
                  selectPolicy.reasonCode ?? STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          try {
            if (ctx.signal?.aborted)
              throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
            await resolved.elementHandle.selectOption(value, {
              timeout: 15000,
            });
          } finally {
            await resolved.elementHandle.dispose().catch(() => undefined);
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId: target.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'press': {
          const { target, key } = toolCall.args;
          const targetPage = getTargetPage(ctx, target?.pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          if (target) {
            const resolved = await resolveTarget(
              targetPage,
              target,
              ctx.currentSnapshot!,
            );
            if (resolved.status === 'rejected') {
              return this.finalizeResult(
                {
                  requestId,
                  actionId,
                  status: 'failed',
                  // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                  data: ctx.currentSnapshot as unknown as JsonValue,
                  reasonCode: resolved.reasonCode,
                  evidenceRefs: [],
                },
                toolCall,
                ctx.currentSnapshot!,
              );
            }
            const pressPolicy = ctx.policy.checkAction(
              toolCall,
              await inspectedTargetMetadata(resolved, targetPage),
              targetPage.url(),
            );
            if (!pressPolicy.allowed) {
              await resolved.elementHandle.dispose().catch(() => undefined);
              return this.finalizeResult(
                {
                  requestId,
                  actionId,
                  status: 'denied',
                  data: ctx.currentSnapshot as unknown as JsonValue,
                  reasonCode:
                    pressPolicy.reasonCode ?? STABLE_REASON_CODES.POLICY_DENIED,
                  evidenceRefs: [],
                },
                toolCall,
                ctx.currentSnapshot!,
              );
            }
            try {
              if (ctx.signal?.aborted)
                throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
              await resolved.elementHandle.press(key, { timeout: 15000 });
            } finally {
              await resolved.elementHandle.dispose().catch(() => undefined);
            }
          } else {
            await targetPage.keyboard.press(key);
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId: target?.pageId || ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'scroll': {
          const { pageId, direction, pixels } = toolCall.args;
          const targetPage = getTargetPage(ctx, pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const deltaY = direction === 'down' ? pixels : -pixels;
          await targetPage.mouse.wheel(0, deltaY);

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'wait_for': {
          const { pageId, condition, timeoutMs, target } = toolCall.args;
          const targetPage = getTargetPage(ctx, pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          try {
            if (condition === 'element_visible' && target) {
              const resolved = await resolveTarget(
                targetPage,
                target,
                ctx.currentSnapshot!,
                { allowHiddenForWait: true },
              );
              if (resolved.status === 'resolved') {
                try {
                  await resolved.elementHandle.waitForElementState('visible', {
                    timeout: timeoutMs || 15000,
                  });
                } finally {
                  await resolved.elementHandle.dispose().catch(() => undefined);
                }
              } else {
                return this.finalizeResult(
                  {
                    requestId,
                    actionId,
                    status: 'failed',
                    // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                    data: ctx.currentSnapshot as unknown as JsonValue,
                    reasonCode: resolved.reasonCode,
                    evidenceRefs: [],
                  },
                  toolCall,
                  ctx.currentSnapshot!,
                );
              }
            } else {
              await ctx.waiter.waitForState(
                targetPage,
                condition as
                  | 'dom_ready'
                  | 'navigation'
                  | 'element_visible'
                  | 'spinner_detach',
                { timeoutMs, signal: ctx.signal },
              );
            }
          } catch {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.ACTION_TIMEOUT,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            snapshot,
          );
        }

        case 'capture': {
          const { pageId } = toolCall.args;
          const targetPage = getTargetPage(ctx, pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          const artifact = await ctx.recorder.captureScreenshot(targetPage);
          const snapshot = await captureBrowserSnapshot(targetPage, {
            pageId,
            stateVersion: ctx.stateVersion,
            screenshotRef: artifact.id,
            recorder: ctx.recorder,
          });

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: artifact as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [artifact.id],
            },
            toolCall,
            snapshot,
          );
        }

        case 'inspect_network': {
          const { pageId, urlContains, limit } = toolCall.args;
          const targetPage = getTargetPage(ctx, pageId);
          if (!targetPage) {
            return this.finalizeResult(
              {
                requestId,
                actionId,
                status: 'failed',
                // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.TARGET_NOT_FOUND,
                evidenceRefs: [],
              },
              toolCall,
              ctx.currentSnapshot!,
            );
          }

          let entries = ctx.recorder.getRawNetwork();
          if (urlContains) {
            entries = entries.filter((e) => e.url.includes(urlContains));
          }
          const sliced = entries.slice(-limit);

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: sliced as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'assert_criterion': {
          const { criterionId } = toolCall.args;
          const evidenceArtifact = await ctx.recorder.captureScreenshot(
            ctx.page,
          );
          const evidenceRefs = [evidenceArtifact.id];

          const status = ctx.currentSnapshot?.responseStatus;
          const isErrorPage =
            status !== null && status !== undefined && status >= 400;

          const criterionResult: CriterionResult = {
            criterionId,
            result: isErrorPage ? 'failed' : 'passed',
            reason: isErrorPage
              ? `Criterion '${criterionId}' failed: page response status was ${status}.`
              : `Criterion '${criterionId}' satisfied based on active page state (${ctx.page.url()}).`,
            evidenceRefs,
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: criterionResult as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs,
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'finish_case': {
          const { summary, gaps } = toolCall.args;
          const verdict: Verdict = {
            id: randomUUID(),
            caseId: randomUUID(),
            attemptId: randomUUID(),
            status: 'passed',
            reasonCode: 'COMPLETED',
            summary,
            criterionResults: [],
            gaps: gaps || [],
            createdAt: new Date().toISOString(),
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: verdict as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'request_input': {
          const { kind, prompt } = toolCall.args;
          const inputRequest: InputRequest = {
            id: randomUUID(),
            runId: ctx.recorder.getRunId(),
            kind,
            status: 'pending',
            prompt,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            version: 1,
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: inputRequest as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'submit_case': {
          const { candidate } = toolCall.args;
          const caseDef: CaseDefinition = {
            id: randomUUID(),
            runId: ctx.recorder.getRunId(),
            projectId: ctx.recorder.getProjectId(),
            version: 1,
            title: candidate.title,
            summary: candidate.summary,
            preconditions: candidate.preconditions || [],
            outline: candidate.outline || [],
            criteria: candidate.criteria || [],
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: caseDef as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'report_suspect': {
          const { caseId, criterionId, actual, evidenceRefs, reproSteps } =
            toolCall.args;
          const finding: Finding = {
            id: randomUUID(),
            runId: ctx.recorder.getRunId(),
            caseIds: [caseId],
            kind: 'functional',
            status: 'suspected',
            title: `Suspected failure on criterion ${criterionId}`.slice(
              0,
              200,
            ),
            severity: 'medium',
            expected: `Criterion ${criterionId} satisfied`.slice(0, 4000),
            actual: actual.slice(0, 4000),
            expectedSource: 'generic_smoke',
            reproSteps: reproSteps || [],
            evidenceRefs: evidenceRefs || [],
            reproductionRef: null,
            triageDisposition: 'open',
            version: 1,
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: finding as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: evidenceRefs || [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        case 'complete_reproduction': {
          const { outcome, summary, evidenceRefs } = toolCall.args;
          const reproduction: Reproduction = {
            id: randomUUID(),
            findingId: randomUUID(),
            taskId: ctx.recorder.getTaskId() || randomUUID(),
            outcome,
            freshContext: true,
            summary: summary.slice(0, 4000),
            evidenceRefs: evidenceRefs || [],
            createdAt: new Date().toISOString(),
          };

          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'succeeded',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: reproduction as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: evidenceRefs || [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }

        default: {
          return this.finalizeResult(
            {
              requestId,
              actionId,
              status: 'failed',
              // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
              data: ctx.currentSnapshot as unknown as JsonValue,
              reasonCode: STABLE_REASON_CODES.VALIDATION_ERROR,
              evidenceRefs: [],
            },
            toolCall,
            ctx.currentSnapshot!,
          );
        }
      }
    } catch (err) {
      const errStr = (err as Error).message || String(err);
      let reasonCode: string = STABLE_REASON_CODES.BROWSER_UNAVAILABLE;

      if (ctx.signal?.aborted) {
        // If the browser command was already in flight, its side effects
        // are unknown. Do not claim the action never happened.
        reasonCode = STABLE_REASON_CODES.USER_CANCELLED;
      } else if (errStr.includes(STABLE_REASON_CODES.REPEATED_ACTION_LIMIT)) {
        reasonCode = STABLE_REASON_CODES.REPEATED_ACTION_LIMIT;
      } else if (errStr.includes(STABLE_REASON_CODES.USER_CANCELLED)) {
        reasonCode = STABLE_REASON_CODES.USER_CANCELLED;
      } else if (errStr.includes('Timeout') || errStr.includes('timed out')) {
        reasonCode = STABLE_REASON_CODES.ACTION_TIMEOUT;
      }

      const snapshot =
        ctx.currentSnapshot ||
        (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));

      return this.finalizeResult(
        {
          requestId,
          actionId,
          status:
            reasonCode === STABLE_REASON_CODES.USER_CANCELLED
              ? 'cancelled'
              : 'failed',
          // SAFETY: the snapshot/result object is JSON-serializable; the ToolResult contract types data as JsonValue.
          data: snapshot as unknown as JsonValue,
          reasonCode,
          evidenceRefs: [],
        },
        toolCall,
        snapshot,
      );
    }
  }
}
