import type {
  ActionDenialCode,
  BrowserSnapshot,
  NodeTarget,
  SnapshotNode,
  ToolCall,
} from '@localqa/contracts';
import { hashPayload, StorageError } from '@localqa/storage';
import { isButtonLikeNode, withinWriteScope } from '@localqa/browser';
import {
  isHiddenInput,
  isReleasedSensitiveTool,
  isSensitiveInput,
} from './signed-out-input.js';

/** Buttons that submit or mutate business data in a non-submitting run. */
const DESTRUCTIVE_TARGET_TEXT =
  /删除|新增|新建|创建|保存|提交|发送|购买|支付|启用|停用|禁用|授权|重置|发布|\b(delete|remove|create|save|submit|send|purchase|enable|disable|reset|publish)\b/i;

/** True when activating this node submits or mutates business data. */
export function mutationIntent(
  node: Pick<SnapshotNode, 'name' | 'text' | 'inputType'>,
): boolean {
  return (
    node.inputType === 'submit' ||
    DESTRUCTIVE_TARGET_TEXT.test(`${node.name} ${node.text}`)
  );
}

export interface TargetGrantInput {
  target: NodeTarget;
  /** The recorded snapshot the model cited, when this task owns it. */
  owned: BrowserSnapshot | null | undefined;
  /** Result hash of this task's latest succeeded non-capture action. */
  latestResultHash: string | null | undefined;
  call: ToolCall;
  /** This task's immutable case is `requiresLogin === false`. */
  signedOutCase: boolean;
  actionPolicy: string;
  writeScope: readonly string[];
}

export interface TargetGrantDecision {
  /** The first refusal, in precedence order; null when the target is allowed. */
  denial: ActionDenialCode | null;
  /** The cited snapshot node, when it exists (used for a safe denial trace). */
  node: SnapshotNode | null;
  /** The signed-out lane may type into this sensitive input (check secrets). */
  releasedSensitive: boolean;
  /**
   * The equivalent button a plain Enter was judged against, when the press
   * rule used one. Carried into the denial trace so a refusal names it.
   */
  enterButton: SnapshotNode | null;
}

/**
 * Classifies a target action against the action ledger's rules. Kept pure so
 * every refusal reason is testable without PostgreSQL; the caller supplies the
 * recorded snapshot and the latest result hash it read in the same transaction.
 */
export function evaluateTargetGrant(
  input: TargetGrantInput,
): TargetGrantDecision {
  const { target, owned, latestResultHash, call } = input;
  const node =
    owned?.nodes.find(
      (candidate) =>
        candidate.nodeId === target.nodeId &&
        candidate.frameId === (target.frameId ?? 'main'),
    ) ?? null;
  if (!owned || owned.pageId !== target.pageId || !node)
    return {
      denial: 'TARGET_NOT_FOUND',
      node,
      releasedSensitive: false,
      enterButton: null,
    };
  if (!node.visible)
    return {
      denial: 'TARGET_HIDDEN',
      node,
      releasedSensitive: false,
      enterButton: null,
    };
  if (!node.enabled)
    return {
      denial: 'TARGET_DISABLED',
      node,
      releasedSensitive: false,
      enterButton: null,
    };
  // The model must act on the observation its latest action produced. The
  // browser layer re-proves DOM identity inside that snapshot, but the
  // sensitive/hidden classification below is only trustworthy for the state
  // the model actually saw last.
  if (
    latestResultHash !==
    hashPayload({ status: 'succeeded', snapshot: owned, evidence: [] })
  )
    return {
      denial: 'VERSION_CONFLICT',
      node,
      releasedSensitive: false,
      enterButton: null,
    };

  const hiddenInput = isHiddenInput(node);
  const sensitiveInput = isSensitiveInput(node);
  // Mo's subagents may TYPE into a password box. Only a session-managed
  // smoke run's immutable signed-out case (requiresLogin=false) may do so,
  // and only with a value that is not a saved credential.
  const releasedSensitive =
    sensitiveInput &&
    !hiddenInput &&
    input.signedOutCase &&
    isReleasedSensitiveTool(call.name);
  // A plain Enter is judged exactly like clicking the button it would
  // activate: the target itself when it is button-like, else the snapshot's
  // recorded equivalent button. Modifier combinations stay refused; Space is
  // left to the browser layer, which refuses it.
  let enterButton: SnapshotNode | null = null;
  let outOfScopeMutation = false;
  const outsideWriteScope = !withinWriteScope(
    owned.displayUrl,
    input.actionPolicy === 'approved_workflows' ? input.writeScope : [],
  );
  if (outsideWriteScope && call.name === 'click')
    outOfScopeMutation = mutationIntent(node);
  if (outsideWriteScope && call.name === 'press') {
    const key = String(call.args.key ?? '').toLowerCase();
    if (key === 'enter' || key === 'numpadenter') {
      if (isButtonLikeNode(node)) {
        outOfScopeMutation = mutationIntent(node);
      } else {
        enterButton =
          owned.nodes.find(
            (candidate) =>
              candidate.nodeId === node.enterButtonNodeId &&
              candidate.frameId === node.frameId,
          ) ?? null;
        if (enterButton && enterButton.visible && enterButton.enabled)
          outOfScopeMutation = mutationIntent(enterButton);
        else
          // No unambiguous, usable equivalent button: refuse, as before. A
          // found-but-unusable button is still named in the denial trace.
          outOfScopeMutation = true;
      }
    } else if (/(?:^|\+)(?:enter|numpadenter)$/.test(key)) {
      outOfScopeMutation = true;
    }
  }
  if (hiddenInput)
    return {
      denial: 'HIDDEN_INPUT_FORBIDDEN',
      node,
      releasedSensitive,
      enterButton,
    };
  if (sensitiveInput && !releasedSensitive)
    return {
      denial: 'SENSITIVE_INPUT_FORBIDDEN',
      node,
      releasedSensitive,
      enterButton,
    };
  if (outOfScopeMutation)
    return {
      denial: 'OUT_OF_SCOPE_MUTATION',
      node,
      releasedSensitive,
      enterButton,
    };
  return { denial: null, node, releasedSensitive, enterButton };
}

/**
 * A grant-stage refusal that also carries a bounded, value-free description of
 * the target node. The Worker copies that description into its denial trace;
 * it is never part of the error message, a ToolResult or an event.
 */
export function actionDenied(
  code: ActionDenialCode,
  node?: Pick<SnapshotNode, 'role' | 'name'> | null,
  enterButton?: Pick<SnapshotNode, 'role' | 'name'> | null,
): StorageError {
  // A StorageError, not a DomainError: Coordinator.tx rewrites DomainError
  // codes outside its short allowlist to VALIDATION_ERROR, and Database then
  // maps non-StorageError failures to SERVICE_UNAVAILABLE. A refusal must
  // reach the dispatcher with its own code.
  const error = new StorageError(code);
  if (node)
    (
      error as StorageError & {
        denial?: {
          role: string | null;
          name: string | null;
          enterButton?: { role: string | null; name: string | null };
        };
      }
    ).denial = {
      role: node.role ? node.role.slice(0, 120) : null,
      name: node.name ? node.name.slice(0, 200) : null,
      ...(enterButton
        ? {
            enterButton: {
              role: enterButton.role
                ? enterButton.role.slice(0, 120)
                : null,
              name: enterButton.name
                ? enterButton.name.slice(0, 200)
                : null,
            },
          }
        : {}),
    };
  return error;
}
