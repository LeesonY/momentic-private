import {
  FIXTURE,
  type ProviderAdapter,
  type ProviderResponse,
} from './adapter.js';

const REPAIR_MARK = '格式修复';

function textBlob(
  messages: readonly { content: readonly { type: string; text?: string }[] }[],
): string {
  return messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

function json(
  value: unknown,
  usage: ProviderResponse['usage'],
): ProviderResponse {
  return {
    raw: JSON.stringify(value),
    httpStatus: 200,
    reportedModelId: null,
    usage,
    errorCode: null,
  };
}

const click = {
  toolCalls: [
    {
      name: 'click',
      args: {
        target: {
          snapshotId: FIXTURE.snapshotId,
          pageId: FIXTURE.pageId,
          nodeId: 'main/save',
        },
      },
    },
  ],
  done: false,
};

export function createStubAdapter(): ProviderAdapter & { calls: number } {
  let calls = 0;
  const adapter: ProviderAdapter & { calls: number } = {
    kind: 'stub',
    version: 'stub.1',
    get calls() {
      return calls;
    },
    build(input) {
      return {
        endpoint: input.endpoint,
        body: {
          model: input.model,
          purpose: input.purpose,
          messages: input.messages,
          outputSchema: input.outputSchema,
          tools: input.tools,
          maxOutputTokens: input.maxOutputTokens,
        },
      };
    },
    send(input, signal) {
      calls += 1;
      const model = input.model;
      const body = input.body as {
        purpose?: string;
        messages?: { content: { type: string; text?: string }[] }[];
        outputSchema?: { properties?: Record<string, unknown> };
      };
      const purpose = body.purpose ?? 'decide';
      const blob = textBlob(body.messages ?? []);
      if (model === 'stub-timeout') {
        return new Promise((_resolve, reject) => {
          const fail = () =>
            reject(
              Object.assign(new Error('MODEL_TIMEOUT'), { code: 'TIMEOUT' }),
            );
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      }
      if (model === 'stub-429') {
        return Promise.resolve({
          raw: '',
          httpStatus: 429,
          reportedModelId: null,
          usage: null,
          errorCode: 'RATE_LIMITED' as const,
        });
      }
      if (model === 'stub-image-unsupported') {
        return Promise.resolve({
          raw: JSON.stringify({ error: 'image_unsupported' }),
          httpStatus: 200,
          reportedModelId: model,
          usage: null,
          errorCode: 'IMAGE_UNSUPPORTED' as const,
        });
      }
      if (model === 'stub-malformed') {
        const repairs = blob.split(REPAIR_MARK).length - 1;
        if (repairs === 0) {
          return Promise.resolve({
            raw: 'not-json {{{',
            httpStatus: 200,
            reportedModelId: model,
            usage: null,
            errorCode: null,
          });
        }
        if (repairs === 1) {
          return Promise.resolve(
            json(
              { toolCalls: [], done: true },
              { inputTokens: 8, outputTokens: 4 },
            ),
          );
        }
        return Promise.resolve({
          raw: 'still-bad',
          httpStatus: 200,
          reportedModelId: model,
          usage: null,
          errorCode: null,
        });
      }
      if (model === 'stub-repeat') return Promise.resolve(json(click, null));
      if (model === 'stub-unauthorized') {
        return Promise.resolve(
          json(
            {
              toolCalls: [
                { name: 'finish_case', args: { summary: '越权', gaps: [] } },
              ],
              done: false,
            },
            null,
          ),
        );
      }
      if (model === 'stub-fake-evidence') {
        return Promise.resolve(
          json(
            {
              criterionId: FIXTURE.criterionId,
              result: 'passed',
              reason: '模型声称通过',
              evidenceRefs: [FIXTURE.fakeEvidenceId],
            },
            null,
          ),
        );
      }
      if (purpose === 'plan' && body.outputSchema?.properties?.['action']) {
        const context = (body.messages ?? [])
          .flatMap((m) => m.content)
          .map((p) => {
            try {
              return JSON.parse(p.text ?? '');
            } catch {
              return null;
            }
          })
          .find((p) => p?.session);
        const data = {
          action: 'finish',
          rationale: '离线脚本仅验证通用入口',
          exploreTargets: [] as string[],
          cases: [] as unknown[],
          coverageGaps: [],
        };
        if (context && !context.observations.length) {
          data.action = 'dispatch';
          data.exploreTargets = [context.targetUrl];
        } else if (context && !context.cases.length && context.remainingCases) {
          data.action = 'dispatch';
          data.cases = [
            {
              entryUrl: context.targetUrl,
              title: '离线入口检查',
              summary: '脚本通用冒烟',
              preconditions: [],
              outline: ['检查可见内容'],
              criteria: [
                {
                  id: 'smoke.visible',
                  kind: 'element_visible',
                  description: '页面内容可见',
                  sourceKind: 'generic_smoke',
                  sourceRef: 'FR-016',
                  sourceQuote: '',
                  locator: { by: 'css', value: 'body', name: null },
                  expectedValue: null,
                },
              ],
            },
          ];
        }
        return Promise.resolve(
          json(data, { inputTokens: 11, outputTokens: 7 }),
        );
      }
      if (
        purpose === 'summarize' &&
        body.outputSchema?.properties?.['overview']
      ) {
        return Promise.resolve(
          json(
            {
              overview: '完成离线脚本入口检查，不代表真实服务商测试。',
              caseComments: [],
              coverageGaps: [],
            },
            { inputTokens: 11, outputTokens: 7 },
          ),
        );
      }
      if (purpose === 'probe') {
        return Promise.resolve(
          json(
            { structuredOutput: true, nativeTools: true, imageInput: true },
            { inputTokens: 11, outputTokens: 7 },
          ),
        );
      }
      if (purpose === 'assert') {
        return Promise.resolve(
          json(
            {
              criterionId: FIXTURE.criterionId,
              result: 'passed',
              reason: '观察里看得到目标',
              evidenceRefs: [FIXTURE.evidenceId],
            },
            { inputTokens: 11, outputTokens: 7 },
          ),
        );
      }
      if (blob.includes('"executed":true') || blob.includes('DISPATCHED')) {
        return Promise.resolve(
          json(
            { toolCalls: [], done: true },
            { inputTokens: 11, outputTokens: 7 },
          ),
        );
      }
      return Promise.resolve(
        json(
          {
            toolCalls: [{ name: 'observe', args: { pageId: FIXTURE.pageId } }],
            done: false,
          },
          { inputTokens: 11, outputTokens: 7 },
        ),
      );
    },
  };
  return adapter;
}
