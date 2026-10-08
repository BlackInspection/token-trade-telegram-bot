import '../src/warnings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { MockDataSource, MOCK_TOKENS } from '../src/data/mock.js';
import { strategyFactory } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';
import { createBot } from '../src/bot.js';
import { sendRich } from '../src/notifier.js';

const ADMIN = 42;
const botInfo = {
  id: 1, is_bot: true, first_name: 'T', username: 't_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
};

function setup(overrides = {}) {
  const cfg = defaultConfig({ SAMPLE_TOKENS: `solana:${MOCK_TOKENS[0].address}`, ...overrides });
  const storage = new Storage(':memory:');
  let clock = 1_800_000_000_000;
  const engine = new Engine({
    cfg, storage, dataSource: new MockDataSource({ now: 1_800_000_000_000 }),
    notifier: { adminIds: [ADMIN], send: async () => {} },
    executors: { paper: new PaperExecutor(cfg.trading) },
    strategyFactory: strategyFactory(cfg.strategy, cfg.analysis),
    now: () => clock,
  });
  const bot = createBot({ token: '1:test', adminIds: [ADMIN], engine, botInfo });
  const sent = [];
  // Intercept all Bot API calls: nothing leaves the process.
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, text: payload.text, chat: payload.chat_id, payload });
    const result = method === 'sendMessage' || method === 'editMessageText'
      ? { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text }
      : true;
    return { ok: true, result };
  });
  let n = 0;
  const texts = () => sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText').map((s) => s.text).join('\n');
  const say = async (text, from = ADMIN) => {
    sent.length = 0;
    n += 1;
    const cmd = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [];
    await bot.handleUpdate({
      update_id: n,
      message: { message_id: n, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'U' }, text, entities: cmd },
    });
    return texts();
  };
  const tap = async (data, from = ADMIN) => {
    sent.length = 0;
    n += 1;
    await bot.handleUpdate({
      update_id: n,
      callback_query: {
        id: `q${n}`, from: { id: from, is_bot: false, first_name: 'U' }, chat_instance: 'c', data,
        message: { message_id: 1, date: 0, chat: { id: from, type: 'private' }, text: 'card' },
      },
    });
    return texts();
  };
  /** All buttons of the messages sent by the last action. */
  const buttons = () => sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  return { engine, storage, say, tap, sent, buttons, advance: (ms) => (clock += ms) };
}

const [GOOD, BASE, POT] = MOCK_TOKENS;

test('bot: admin gate, analysis by paste, watch/positions/pnl/settings/mode', async () => {
  const { storage, say, tap, buttons } = setup();
  assert.equal(await say('/help', 7), 'Access denied.');
  assert.match(await say('/help'), /\/watch <address>/);
  assert.match(await say(POT.address), /VERDICT: AVOID/);
  assert.match(await say(`/analyze ${GOOD.address}`), /VERDICT: BUY/);
  assert.match(await say(`/watch ${GOOD.address}`), /Watching MOCKGOOD/);
  assert.match(await say('/watchlist'), /MOCKGOOD/);
  assert.match(await say(`/buy ${POT.address} 10`), /Refused: refused \(hard avoid\)/);
  assert.match(await say(`/buy ${GOOD.address} 20`), /Put in \$20, sell right away, get back about \$20/);
  const confirm = buttons().find((b) => /^Confirm \$20/.test(b.text));
  await tap(confirm.callback_data);
  assert.equal(storage.listOpenPositions('paper').length, 1);
  assert.match(await say('/positions'), /MOCKGOOD .*uPnL/);
  await say(`/sell ${GOOD.address} 50`);
  assert.match(await say('/pnl'), /Realized/);
  assert.match(await say('/pnl'), /Costs paid: fees \$[\d.]+ · token taxes \$[\d.]+ · price impact \$[\d.]+ · bot fee \$0/);
  assert.match(await say('/settings size_usd 30'), /size_usd = 30/);
  assert.match(await say('/settings'), /size_usd = 30 \(override\)/);
  assert.match(await say('/mode live'), /DRY_RUN=true/);
  assert.match(await say('/pause'), /Paused/);
  assert.match(await say('/unwatch ' + GOOD.address), /Removed/);
  assert.match(await say('/buy nope'), /Usage/);
  assert.match(await say('hello'), /Send a token contract address/);
  storage.close();
});

test('bot: pasted address -> HTML card + expandable blockquote + copy_text and chart buttons', async () => {
  const { storage, say, sent, buttons } = setup();
  const out = await say(GOOD.address);
  const msg = sent.find((s) => s.method === 'sendMessage');
  assert.equal(msg.payload.parse_mode, 'HTML');
  assert.match(out, /^<b>GREEN · No known red flags \(not a guarantee\)<\/b>/);
  assert.match(out, /<blockquote expandable>/);
  const card = out.split('<blockquote expandable>')[0];
  assert.ok(card.length <= 900, `card ${card.length} chars`);
  const b = buttons();
  assert.ok(b.some((x) => x.copy_text?.text === GOOD.address), 'copy_text button');
  assert.ok(b.some((x) => x.url?.startsWith('https://dexscreener.com/solana/')), 'chart button');
  assert.ok(b.some((x) => x.callback_data === `pb:${GOOD.address}` && x.style === 'success'), 'practice button with style');
  storage.close();
});

test('bot: Practice-buy button opens a paper position even in live mode', async () => {
  const { engine, storage, tap } = setup();
  engine.setMode('live');
  await tap(`pb:${GOOD.address}`);
  assert.equal(storage.listOpenPositions('paper').length, 1);
  assert.equal(storage.listOpenPositions('paper')[0].costUsd, 25);
  assert.equal(storage.listOpenPositions('live').length, 0);
  storage.close();
});

test('bot: /buy confirmation executes exactly once; Cancel and expiry execute nothing', async () => {
  const { storage, say, tap, buttons, advance } = setup();
  await say(`/buy ${GOOD.address} 30`);
  const ok = buttons().find((b) => /^Confirm \$30/.test(b.text));
  assert.ok(buttons().some((b) => b.text === 'Cancel'));
  await tap(ok.callback_data);
  assert.match(await tap(ok.callback_data), /expired or was already used/);
  assert.equal(storage.listTrades({ mode: 'paper' }).filter((t) => t.side === 'BUY').length, 1);

  await say(`/buy ${BASE.address} 20`);
  const cancel = buttons().find((b) => b.text === 'Cancel');
  assert.match(await tap(cancel.callback_data), /Nothing was bought/);
  await say(`/buy ${BASE.address} 20`);
  const late = buttons().find((b) => /^Confirm/.test(b.text));
  advance(121_000);
  assert.match(await tap(late.callback_data), /expired/);
  assert.equal(storage.getOpenPosition(BASE.address, 'paper'), null);
  storage.close();
});

test('bot: copycat needs the extra "I know this is not the well-known" button', async () => {
  const { storage, say, tap, buttons } = setup();
  const FAKE = MOCK_TOKENS[4];
  await say(`/buy ${FAKE.address} 20`);
  const ack = buttons().find((b) => /I know this is not the well-known MOCKGOOD/.test(b.text));
  assert.ok(ack, 'clone acknowledgement button');
  assert.ok(!buttons().some((b) => /^Confirm/.test(b.text)), 'no confirm before the acknowledgement');
  await tap(ack.callback_data);
  const confirm = buttons().find((b) => /^Confirm/.test(b.text));
  await tap(confirm.callback_data);
  assert.equal(storage.listOpenPositions('paper').length, 1);
  storage.close();
});

test('bot: /trackrecord shows the caveat; /why explains a skip; /safety and /scoreboard', async () => {
  const { engine, storage, say } = setup();
  assert.match(await say('/trackrecord'), /Only tokens checked with this bot; not a promise of future results/);
  for (const t of MOCK_TOKENS) await engine.watch(t.address, t.chain);
  await engine.tick();
  const skip = storage.decisionsFor(MOCK_TOKENS[3].address, 10).find((d) => d.kind === 'skip');
  assert.match(await say(`/why ${skip.id}`), /Not bought: FEES_EAT_PROFIT/);
  assert.match(await say('/safety'), /DRY_RUN=true[\s\S]*daily budget[\s\S]*Seatbelts:/);
  assert.match(await say('/scoreboard'), /would-be P&L/);
  assert.match(await say('/guardian'), /MOCKRUG \[held\]: no changes since you bought/);
  storage.close();
});

test('bot: guardian "Sell 50%" button halves the position', async () => {
  const { engine, storage, tap } = setup();
  await engine.buy(GOOD.address, 40);
  const before = storage.getOpenPosition(GOOD.address, 'paper').qty;
  const id = storage.insertGuardianEvent({ ts: engine.now(), address: GOOD.address, symbol: 'MOCKGOOD', type: 'DEV_SELLING', severity: 'warn', before: '5%', after: '3%', action: 'alert' });
  await tap(`g:${id}:s50`);
  const after = storage.getOpenPosition(GOOD.address, 'paper').qty;
  assert.ok(Math.abs(after - before / 2) < 1e-9 * before, `${after} vs ${before / 2}`);
  assert.match(await tap(`g:${id}:ign`), /muted for 24 h/);
  storage.close();
});

test('bot: /start tour on a fresh DB with sample token and budget buttons', async () => {
  const { engine, storage, say, tap, buttons } = setup();
  assert.equal(engine.mode, 'paper');
  await say('/start');
  const b = buttons().map((x) => x.text);
  assert.ok(b.includes('Try a sample token'));
  for (const v of ['$20', '$50', '$100', 'Custom']) assert.ok(b.includes(v), v);
  assert.match(await tap('tour:sample'), /Sample token[\s\S]*GREEN/);
  assert.ok(buttons().some((x) => x.callback_data === `pb:${GOOD.address}`), 'practice-buy step');
  assert.match(await tap('budget:50'), /Monthly loss budget set to \$50/);
  assert.equal(engine.cfg.seatbelts.lossBudgetMonthUsd, 50);
  assert.deepEqual(storage.getKv('seatbelts'), { loss_budget: 50 });
  assert.match(await tap('tour:pnl'), /PnL \(practice\)/);
  assert.match(await say('/start'), /\/watch/); // second /start: help
  storage.close();
});

test('bot: /mode live with DRY_RUN=false is refused with the graduation checklist', async () => {
  const { storage, say } = setup({ DRY_RUN: 'false' });
  const out = await say('/mode live I can lose this money');
  assert.match(out, /Refused: live autopilot is locked until graduation/);
  assert.match(out, /Graduation checklist 1\/4 done/);
  assert.match(out, /closed practice trades: 0\/10/);
  assert.match(await say('/mode link'), /you sign in your own wallet/);
  storage.close();
});

test('bot: loosening a seatbelt via /settings is delayed, tightening is instant', async () => {
  const { engine, storage, say } = setup();
  assert.match(await say('/settings max_trade_usd 300'), /max_trade_usd = 300 takes effect at .* UTC/);
  assert.equal(engine.cfg.trading.maxTradeUsd, 200);
  assert.match(await say('/settings max_trade_usd 100'), /^max_trade_usd = 100$/);
  assert.equal(engine.cfg.trading.maxTradeUsd, 100);
  assert.match(await say('/settings cooldown_min 10'), /takes effect at/);
  storage.close();
});

test('bot: /panic stops buying and /resume needs the confirm button', async () => {
  const { engine, storage, say, tap, buttons } = setup();
  engine.setMode('link');
  await say('/panic');
  assert.equal(engine.mode, 'paper');
  assert.match(await say(`/buy ${GOOD.address} 20`), /Refused: panic stop is on/);
  await assert.rejects(engine.buy(GOOD.address, 20), /panic stop is on/);
  await say('/resume');
  const resumeData = buttons().find((b) => b.callback_data.startsWith('panic:resume:'))?.callback_data;
  assert.ok(resumeData, 'the confirm button names this panic and the prompt time');
  assert.match(await tap(resumeData), /Panic cleared/);
  assert.equal(engine.panicOn, false);
  storage.close();
});

test('notifier: a Telegram 400 caused by button style is retried once without style', async () => {
  const calls = [];
  const api = {
    sendMessage: async (chat, text, opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        const err = new Error("Call to 'sendMessage' failed! (400: Bad Request: can't parse inline keyboard button: field \"style\" is unknown)");
        err.error_code = 400;
        err.description = "Bad Request: can't parse inline keyboard button";
        throw err;
      }
      return { message_id: 1 };
    },
  };
  await sendRich(api, 1, '<b>x</b>', [[{ text: 'Practice', data: 'pb:x', style: 'success' }]], { colors: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].reply_markup.inline_keyboard[0][0].style, 'success');
  assert.equal(calls[1].reply_markup.inline_keyboard[0][0].style, undefined);
});
