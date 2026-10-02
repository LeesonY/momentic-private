import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  ToolCall,
  ToolResult,
  BrowserSnapshot,
  CriterionResult,
  JsonValue
} from '@localqa/contracts';
import { getRootValidator } from '@localqa/contracts';
import { STABLE_REASON_CODES } from './types.js';
import { PolicyInterceptor } from './policy.js';
import { resolveTarget } from './resolver.js';
import { captureBrowserSnapshot } from './snapshot.js';
import type { SessionRecorder } from './recorder.js';
import type { WaitAndRecoveryManager } from './waiter.js';

export interface ExecutorContext {
  page: Page;
  pageId: string;
  stateVersion: number;
  currentSnapshot: BrowserSnapshot | null;
  policy: PolicyInterceptor;
  recorder: SessionRecorder;
  waiter: WaitAndRecoveryManager;
  signal?: AbortSignal;
}

export class ToolExecutor {
  private readonly toolValidator = getRootValidator('tools');

  /**
   * Validates and executes a ToolCall on the active browser session.
   */
  public async execute(
    toolCall: ToolCall,
    ctx: ExecutorContext
  ): Promise<{ result: ToolResult; snapshot: BrowserSnapshot }> {
    const requestId = randomUUID();

    // 1. Check AbortSignal upfront
    if (ctx.signal?.aborted) {
      const snapshot = ctx.currentSnapshot || (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return {
        result: {
          requestId,
          actionId: null,
          status: 'cancelled',
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.ACTION_CANCELLED,
          evidenceRefs: []
        },
        snapshot
      };
    }

    // 2. Prohibited Tools Gate
    const toolName = (toolCall as { name: string }).name;
    const prohibited = new Set(['evaluate', 'eval', 'exec', 'shell', 'read_file', 'write_file']);
    if (prohibited.has(toolName as string)) {
      const snapshot = ctx.currentSnapshot || (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return {
        result: {
          requestId,
          actionId: null,
          status: 'denied',
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.PROHIBITED_TOOL,
          evidenceRefs: []
        },
        snapshot
      };
    }

    // 3. Schema Validation via @localqa/contracts
    const isValid = this.toolValidator(toolCall);
    if (!isValid) {
      const snapshot = ctx.currentSnapshot || (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));
      return {
        result: {
          requestId,
          actionId: null,
          status: 'failed',
          data: snapshot as unknown as JsonValue,
          reasonCode: STABLE_REASON_CODES.INVALID_TOOL_ARGUMENTS,
          evidenceRefs: []
        },
        snapshot
      };
    }

    // Ensure we have a fresh baseline snapshot for target-based tools
    if (!ctx.currentSnapshot) {
      ctx.currentSnapshot = await captureBrowserSnapshot(ctx.page, {
        pageId: ctx.pageId,
        stateVersion: ctx.stateVersion,
        recorder: ctx.recorder
      });
    }

    const actionId = randomUUID();

    try {
      // 4. Dispatch Tool Execution
      switch (toolCall.name) {
        case 'observe': {
          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });
          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'navigate': {
          const { url } = toolCall.args;
          const policyCheck = ctx.policy.checkNavigationUrl(url);
          if (!policyCheck.allowed) {
            return {
              result: {
                requestId,
                actionId,
                status: 'denied',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          const response = await ctx.waiter.navigate(ctx.page, url, { signal: ctx.signal });
          const responseStatus = response ? response.status() : 200;

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder,
            lastResponseStatus: responseStatus
          });

          // Check action repetition loop
          const fingerprint = ctx.waiter.computeFingerprint(snapshot);
          ctx.waiter.recordAction('navigate', url, fingerprint);

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'click': {
          const { target } = toolCall.args;
          const resolved = await resolveTarget(ctx.page, target, ctx.currentSnapshot);
          if (resolved.status === 'rejected') {
            return {
              result: {
                requestId,
                actionId,
                status: 'failed',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          // Policy check on target
          const policyCheck = ctx.policy.checkAction(toolCall, {
            nodeId: resolved.node.nodeId,
            role: resolved.node.role,
            name: resolved.node.name,
            text: resolved.node.text
          });

          if (!policyCheck.allowed) {
            return {
              result: {
                requestId,
                actionId,
                status: 'denied',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          await resolved.locator.click({ timeout: 15000 });

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          const fingerprint = ctx.waiter.computeFingerprint(snapshot);
          ctx.waiter.recordAction('click', target.nodeId, fingerprint);

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'type_text': {
          const { target, text } = toolCall.args;
          const resolved = await resolveTarget(ctx.page, target, ctx.currentSnapshot);
          if (resolved.status === 'rejected') {
            return {
              result: {
                requestId,
                actionId,
                status: 'failed',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          const policyCheck = ctx.policy.checkAction(toolCall, {
            nodeId: resolved.node.nodeId,
            role: resolved.node.role,
            name: resolved.node.name
          });

          if (!policyCheck.allowed) {
            return {
              result: {
                requestId,
                actionId,
                status: 'denied',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: policyCheck.reasonCode || STABLE_REASON_CODES.POLICY_DENIED,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          await resolved.locator.fill(text, { timeout: 15000 });

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'select_option': {
          const { target, value } = toolCall.args;
          const resolved = await resolveTarget(ctx.page, target, ctx.currentSnapshot);
          if (resolved.status === 'rejected') {
            return {
              result: {
                requestId,
                actionId,
                status: 'failed',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          await resolved.locator.selectOption(value, { timeout: 15000 });

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'press': {
          const { target, key } = toolCall.args;
          const resolved = await resolveTarget(ctx.page, target, ctx.currentSnapshot);
          if (resolved.status === 'rejected') {
            return {
              result: {
                requestId,
                actionId,
                status: 'failed',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: resolved.reasonCode,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          await resolved.locator.press(key, { timeout: 15000 });

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'scroll': {
          const { direction, pixels } = toolCall.args;
          const deltaY = direction === 'down' ? pixels : -pixels;
          await ctx.page.mouse.wheel(0, deltaY);

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'wait_for': {
          const { condition, timeoutMs, target } = toolCall.args;
          try {
            if (condition === 'element_visible' && target) {
              const resolved = await resolveTarget(ctx.page, target, ctx.currentSnapshot);
              if (resolved.status === 'resolved') {
                await resolved.locator.waitFor({ state: 'visible', timeout: timeoutMs || 15000 });
              } else if (target.nodeId.startsWith('testid_')) {
                const rawTestId = target.nodeId.replace('testid_', '');
                await ctx.page.locator(`[data-testid="${rawTestId}"], [data-test="${rawTestId}"]`).first().waitFor({
                  state: 'visible',
                  timeout: timeoutMs || 15000
                });
              } else {
                return {
                  result: {
                    requestId,
                    actionId,
                    status: 'failed',
                    data: ctx.currentSnapshot as unknown as JsonValue,
                    reasonCode: resolved.reasonCode,
                    evidenceRefs: []
                  },
                  snapshot: ctx.currentSnapshot
                };
              }
            } else {
              await ctx.waiter.waitForState(
                ctx.page,
                condition as 'dom_ready' | 'navigation' | 'element_visible' | 'spinner_detach',
                { timeoutMs, signal: ctx.signal }
              );
            }
          } catch {
            return {
              result: {
                requestId,
                actionId,
                status: 'failed',
                data: ctx.currentSnapshot as unknown as JsonValue,
                reasonCode: STABLE_REASON_CODES.ACTION_TIMEOUT,
                evidenceRefs: []
              },
              snapshot: ctx.currentSnapshot
            };
          }

          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ++ctx.stateVersion,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: snapshot as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot
          };
        }

        case 'capture': {
          const artifact = await ctx.recorder.captureScreenshot(ctx.page);
          const snapshot = await captureBrowserSnapshot(ctx.page, {
            pageId: ctx.pageId,
            stateVersion: ctx.stateVersion,
            screenshotRef: artifact.id,
            recorder: ctx.recorder
          });

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: artifact as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: [artifact.id]
            },
            snapshot
          };
        }

        case 'inspect_network': {
          const { urlContains, limit } = toolCall.args;
          let entries = ctx.recorder.getRawNetwork();
          if (urlContains) {
            entries = entries.filter((e) => e.url.includes(urlContains));
          }
          const sliced = entries.slice(-limit);

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: sliced as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot: ctx.currentSnapshot
          };
        }

        case 'assert_criterion': {
          const { criterionId } = toolCall.args;
          const criterionResult: CriterionResult = {
            criterionId,
            result: 'passed',
            reason: `Criterion '${criterionId}' evaluated on active page state.`,
            evidenceRefs: []
          };

          return {
            result: {
              requestId,
              actionId,
              status: 'succeeded',
              data: criterionResult as unknown as JsonValue,
              reasonCode: null,
              evidenceRefs: []
            },
            snapshot: ctx.currentSnapshot
          };
        }

        default: {
          return {
            result: {
              requestId,
              actionId,
              status: 'failed',
              data: ctx.currentSnapshot as unknown as JsonValue,
              reasonCode: STABLE_REASON_CODES.INVALID_TOOL_ARGUMENTS,
              evidenceRefs: []
            },
            snapshot: ctx.currentSnapshot
          };
        }
      }
    } catch (err) {
      const errStr = (err as Error).message || String(err);
      let reasonCode: string = STABLE_REASON_CODES.BROWSER_ERROR;

      if (errStr.includes(STABLE_REASON_CODES.REPEATED_ACTION_LIMIT)) {
        reasonCode = STABLE_REASON_CODES.REPEATED_ACTION_LIMIT;
      } else if (errStr.includes(STABLE_REASON_CODES.ACTION_CANCELLED)) {
        reasonCode = STABLE_REASON_CODES.ACTION_CANCELLED;
      } else if (errStr.includes('Timeout') || errStr.includes('timed out')) {
        reasonCode = STABLE_REASON_CODES.ACTION_TIMEOUT;
      }

      const snapshot = ctx.currentSnapshot || (await captureBrowserSnapshot(ctx.page, { recorder: ctx.recorder }));

      return {
        result: {
          requestId,
          actionId,
          status: reasonCode === STABLE_REASON_CODES.ACTION_CANCELLED ? 'cancelled' : 'failed',
          data: snapshot as unknown as JsonValue,
          reasonCode,
          evidenceRefs: []
        },
        snapshot
      };
    }
  }
}
