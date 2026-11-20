import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { DeepSeekProvider, OpenAICompatibleProvider } from '@/llm/providers/OpenAICompatibleProvider';
import type { LLMTaskName } from '@/llm/types';

async function main() {
  const original = globalThis.fetch;
  process.env.LLM_MAX_OUTPUT_TOKENS = '800';
  try {
    for (const [provider, model, task, disabled] of [
      ['deepseek', 'deepseek-flash', 'whatsapp_reply', true],
      ['deepseek', 'deepseek-v4-flash', 'whatsapp_reply', true],
      ['deepseek', 'deepseek-v4-pro', 'whatsapp_reply', false],
      ['deepseek', 'deepseek-flash', 'icp_generation', false],
      ['openai', 'deepseek-flash', 'whatsapp_reply', false],
    ] as const) {
      let body: Record<string, unknown> = {};
      globalThis.fetch = async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"Synthetic reply"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200 });
      };
      const config = { provider, modelName: model, apiKey: 'synthetic-only-key' };
      const adapter = provider === 'deepseek' ? new DeepSeekProvider(config) : new OpenAICompatibleProvider(config);
      const result = await adapter.runJsonTask<{ reply: string }>({ taskName: task as LLMTaskName, modelName: model, modelTier: 'fast', prompt: 'Return JSON', input: { synthetic: true } });
      assert.equal(body.max_tokens, 800, 'Fix must preserve the bounded output limit');
      assert.deepEqual(body.thinking, disabled ? { type: 'disabled' } : undefined);
      assert.equal(result.output.reply, 'Synthetic reply');
      assert.equal(result.usage?.totalTokens, 120);
      console.log(`PASS ${provider}/${model}/${task}: explicit fast mode=${disabled}; bounded output and parsed answer`);
    }
  } finally { globalThis.fetch = original; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
