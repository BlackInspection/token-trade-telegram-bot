// Optional [Explain more] button: a short plain-language explanation of one decision event, written by Claude.
// Hidden and fully offline without ANTHROPIC_API_KEY: no client is created and no network call is made.
// The payload is the event JSON only (no keys, no wallet data). It never changes a verdict or places a trade.
// The SDK (@anthropic-ai/sdk) is an optional dependency, loaded with dynamic import() only when the key is set.
import { getLogger } from './log.js';

const log = getLogger('llm');

export const llmEnabled = (cfg) => !!cfg?.llm?.apiKey;

const SYSTEM = [
  'You explain one decision of a crypto trading bot to an ordinary user in plain English.',
  'Use only the numbers present in the event JSON; do not invent prices, odds or advice.',
  'Write 3 to 5 short sentences: what the bot decided, why, and what the main risk is in money terms.',
  'Never tell the user to buy or sell.',
].join(' ');

/** Strip anything that is not needed to explain the decision (defence in depth: events hold no secrets). */
export function eventPayload(event) {
  const { v, ts, bot, kind, mode, subject, money, verdict, score, confidence, reasons } = event ?? {};
  return { v, ts, bot, kind, mode, subject, money, verdict, score, confidence, reasons };
}

/**
 * @param {any} event suite.event.v1 object
 * @param {{apiKey: string, model: string, clientFactory?: (apiKey: string) => Promise<any>}} opts
 * @returns {Promise<string|null>} null when disabled (no key) - nothing is called in that case.
 */
export async function explainMore(event, { apiKey, model, clientFactory }) {
  if (!apiKey) return null;
  const make = clientFactory ?? (async (key) => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: key });
  });
  let client;
  try {
    client = await make(apiKey);
  } catch (err) {
    log.warn(`Anthropic SDK unavailable: ${err.message}`);
    return 'Explain more is unavailable: install the optional dependency @anthropic-ai/sdk.';
  }
  const response = await client.beta.messages.create({
    model,
    max_tokens: 1024,
    // Server-side fallback on a safety decline (Claude API); routed by refusal category.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Event JSON:\n${JSON.stringify(eventPayload(event))}` }],
  });
  if (response.stop_reason === 'refusal') return 'No extra explanation is available for this decision.';
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || 'No extra explanation is available for this decision.';
}
