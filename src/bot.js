// Telegram bot (grammY). All commands and buttons are restricted to ADMIN_IDS.
import { Bot } from 'grammy';
import { formatAnalysis } from './analyzer.js';
import { extractAddress, normalizeChain } from './chains.js';
import { TradeRefused } from './engine.js';
import { ConfigError } from './config.js';
import { chunkText, escapeHtml, money } from './format.js';
import { formatCard, renderAlert, toKeyboard } from './explain.js';
import { sendRich } from './notifier.js';
import { formatDoctor } from './safety.js';
import { explainMore, llmEnabled } from './llm.js';
import { getLogger } from './log.js';

const log = getLogger('bot');

export const COMMANDS = [
  ['start', 'quick tour: try a sample token in practice'],
  ['analyze', '<address> [chain] - verdict card + full analysis'],
  ['watch', '<address> [chain] - add to watchlist (auto-trading)'],
  ['unwatch', '<address> - remove from watchlist'],
  ['watchlist', 'show watched tokens'],
  ['positions', 'open positions'],
  ['pnl', 'PnL net of fees and the costs you paid'],
  ['buy', '<address> <usd> [override <reason>] - manual buy (asks to confirm)'],
  ['sell', '<address> [pct] - manual sell (default 100%)'],
  ['cost', '<address> [usd] - round-trip cost ladder and max safe size'],
  ['filled', '<address> <usd> [price] - record a buy you signed in your wallet (link mode)'],
  ['mode', 'paper|link|live - practice, sign it yourself, or autopilot (live: /mode live <phrase>)'],
  ['pause', 'stop new entries (exits still enforced)'],
  ['resume', 'resume auto-trading (after /panic: with confirm)'],
  ['panic', 'stop all buying now, cancel pending confirmations, force practice'],
  ['safety', 'mode, every limit, spend today/hour, live-gate status'],
  ['doctor', 'self-check: config, keys, APIs, DB, clock'],
  ['why', '<id> - why the bot did or did not act'],
  ['scoreboard', 'practice results net of fees'],
  ['trackrecord', '[7d|30d|all] - how the bot\'s calls turned out, losers included'],
  ['guardian', 'what changed since you bought'],
  ['digest', 'daily digest now'],
  ['mute', '<address> [hours] - mute alerts for a token'],
  ['preset', 'careful|normal|bold - risk preset (shows a diff, asks to confirm)'],
  ['settings', '[key value] - show or change settings'],
  ['help', 'this help'],
];

const HELP = [
  'Crypto trading bot: it counts what you can lose first, then what you might make.',
  'Paste any token contract address to get a verdict card. Practice mode is the default.',
  '',
  ...COMMANDS.map(([c, d]) => `/${c} ${d}`),
].join('\n');

const args = (ctx) => String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
const chartUrl = (a) => `https://dexscreener.com/${a.chain}/${String(a.market.pairAddress).toLowerCase()}`;

/**
 * @param {{token: string, adminIds: number[], engine: import('./engine.js').Engine, botInfo?: any,
 *   doctor?: () => Promise<any[]>}} opts
 *   botInfo: pass in tests to skip the getMe call. doctor: runs the self-check (index.js wires live probes).
 * @returns {Bot}
 */
export function createBot({ token, adminIds, engine, botInfo, doctor = null }) {
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  const admins = new Set(adminIds);
  const colors = () => engine.cfg.ui.buttonColors;
  let liveConfirmAt = 0;

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !admins.has(id)) {
      log.warn(`ignored update from non-admin ${id ?? '?'}`);
      if (ctx.chat?.type === 'private') await ctx.reply('Access denied.').catch(() => {});
      return;
    }
    await next();
  });

  const chatId = (ctx) => ctx.chat?.id ?? ctx.from.id;
  const reply = async (ctx, text) => {
    for (const part of chunkText(text)) await ctx.api.sendMessage(chatId(ctx), part, { link_preview_options: { is_disabled: true } });
  };
  const replyRich = (ctx, html, buttons = []) => sendRich(ctx.api, chatId(ctx), html, buttons, { colors: colors() });
  const replyAlert = (ctx, alert) => {
    const r = renderAlert(alert);
    return replyRich(ctx, r.html, r.buttons);
  };

  /** Wrap a handler: user-facing errors for refusals/config, logged errors otherwise. */
  const h = (fn) => async (ctx) => {
    try {
      await fn(ctx);
    } catch (err) {
      if (err instanceof TradeRefused || err instanceof ConfigError) return reply(ctx, `Refused: ${err.message}`);
      log.error(err);
      return reply(ctx, `Error: ${err.message}`);
    } finally {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    }
  };

  /** Card first, the full report in an expandable blockquote (or a second plain message when long). */
  const analysisReply = async (ctx, a, prefix = '') => {
    const card = formatCard(a, { now: engine.now() });
    if (!a.market) return replyRich(ctx, `${prefix}${card}\n<blockquote expandable>${escapeHtml(formatAnalysis(a))}</blockquote>`);
    const full = formatAnalysis(a);
    const long = full.length > 3500;
    const html = `${prefix}${card}${long ? '' : `\n<blockquote expandable>${escapeHtml(full)}</blockquote>`}`;
    const row1 = [{ text: 'Watch', data: `w:${a.address}` }];
    if (a.light.color === 'RED') row1.push({ text: "Don't buy (mute 24h)", data: `mute:${a.address}`, style: 'danger' });
    else row1.push({ text: `Practice-buy ${money(engine.cfg.ui.practiceBuyUsd)}`, data: `pb:${a.address}`, style: 'success' });
    const buttons = [row1, [{ text: 'Copy address', copy: a.address }, { text: 'Chart', url: chartUrl(a) }]];
    await replyRich(ctx, html, buttons);
    if (long) await reply(ctx, full);
  };

  const analyzeAndReply = async (ctx, address, chain) => {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const a = await engine.analyze(address, chain);
    await analysisReply(ctx, a);
  };

  // ---------------------------------------------------------------- start / help
  bot.command('start', h(async (ctx) => {
    if (engine.storage.getKv('onboarded', false)) return reply(ctx, HELP);
    engine.storage.setKv('onboarded', true);
    const t = engine.tourIntro();
    await replyRich(ctx, t.text, t.buttons);
  }));
  bot.command('help', h((ctx) => reply(ctx, HELP)));

  // ---------------------------------------------------------------- analysis / watchlist
  bot.command('analyze', h(async (ctx) => {
    const [addr, chain] = args(ctx);
    const address = extractAddress(addr);
    if (!address) return reply(ctx, 'Usage: /analyze <address> [chain]');
    await analyzeAndReply(ctx, address, normalizeChain(chain));
  }));

  bot.command('watch', h(async (ctx) => {
    const [addr, chain] = args(ctx);
    const address = extractAddress(addr);
    if (!address) return reply(ctx, 'Usage: /watch <address> [chain]');
    const a = await engine.watch(address, normalizeChain(chain));
    const w = engine.storage.getWatch(a.address);
    await analysisReply(ctx, a, `Watching ${escapeHtml(a.market.token.symbol)} (${escapeHtml(a.chain)}), every ${engine.cfg.trading.watchIntervalSec}s. Auto-buy rule: ${w?.state ?? 'live'}.\n\n`);
  }));

  bot.command('unwatch', h(async (ctx) => {
    const address = extractAddress(args(ctx)[0]);
    if (!address) return reply(ctx, 'Usage: /unwatch <address>');
    await reply(ctx, engine.unwatch(address) ? 'Removed from watchlist.' : 'Not in watchlist.');
  }));

  bot.command('watchlist', h((ctx) => reply(ctx, engine.watchlistText())));
  bot.command('positions', h(async (ctx) => reply(ctx, await engine.positionsText())));
  bot.command('pnl', h(async (ctx) => reply(ctx, await engine.pnlText())));
  bot.command('cost', h(async (ctx) => {
    const [addr, usdRaw] = args(ctx);
    const address = extractAddress(addr);
    if (!address) return reply(ctx, 'Usage: /cost <address> [usd]');
    const usd = usdRaw ? Number(usdRaw) : null;
    await reply(ctx, await engine.costText(address, usd > 0 ? usd : null));
  }));

  // ---------------------------------------------------------------- trading
  bot.command('buy', h(async (ctx) => {
    const [addr, usdRaw, ...rest] = args(ctx);
    const address = extractAddress(addr);
    const usd = Number(usdRaw);
    if (!address || !(usd > 0)) return reply(ctx, 'Usage: /buy <address> <usd> [override <reason>]');
    if (engine.panicOn) throw new TradeRefused('panic stop is on: all buying is stopped (/resume to undo)');
    if (engine.paused) throw new TradeRefused('trading is paused: no new entries until it is resumed (/resume; exits keep running)');
    const override = rest[0] === 'override' ? rest.slice(1).join(' ') || 'no reason given' : null;
    const chain = rest[0] && rest[0] !== 'override' ? normalizeChain(rest[0]) : null;
    if (!engine.cfg.ui.buyConfirm) {
      const r = await engine.buy(address, usd, { reason: 'manual /buy', chain, override });
      if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, r.message);
      return;
    }
    const a = await engine.analyze(address, chain, { allowQuote: true });
    if (!a.market) throw new TradeRefused(`no DEX pair found for ${address}`);
    if (a.risk.hardAvoid) throw new TradeRefused(`refused (hard avoid): ${a.risk.hardReasons.join('; ')}`);
    const id = engine.createPendingBuy({ a, usd, reason: override ? `manual /buy (override: ${override})` : 'manual /buy', override });
    await replyAlert(ctx, engine.confirmCard(id));
  }));

  bot.command('sell', h(async (ctx) => {
    const [addr, pctRaw] = args(ctx);
    const address = extractAddress(addr);
    const pct = pctRaw === undefined ? 100 : Number(pctRaw.replace('%', ''));
    if (!address || !(pct > 0 && pct <= 100)) return reply(ctx, 'Usage: /sell <address> [pct 1-100]');
    const r = await engine.sell(address, pct, 'manual /sell');
    if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, r.message);
  }));

  bot.command('filled', h(async (ctx) => {
    const [addr, usdRaw, priceRaw] = args(ctx);
    const address = extractAddress(addr);
    const usd = Number(usdRaw);
    const price = priceRaw ? Number(priceRaw) : null;
    if (!address || !(usd > 0) || (price !== null && !(price > 0))) return reply(ctx, 'Usage: /filled <address> <usd> [price]');
    const r = await engine.recordLinkFill(address, usd, price, { reason: 'link: /filled' });
    await reply(ctx, r.message);
  }));

  bot.command('mode', h(async (ctx) => {
    const [mode, ...rest] = args(ctx);
    if (!mode) return reply(ctx, `Mode: ${engine.mode} - ${engine.modeLabel()} (DRY_RUN=${engine.cfg.dryRun}). Usage: /mode paper|link|live`);
    const m = mode.toLowerCase();
    if (m === 'live') {
      const phrase = rest.join(' ');
      const r = engine.requestLiveMode({ phrase });
      if (r.needConfirm) {
        liveConfirmAt = engine.now();
        return replyRich(ctx, escapeHtml(r.text), [[{ text: 'Confirm LIVE (real funds)', data: 'mode:live', style: 'danger' }, { text: 'Cancel', data: 'mode:cancel' }]]);
      }
      return reply(ctx, r.text);
    }
    const set = engine.setMode(m);
    if (set === 'link') return reply(ctx, 'Mode set to link: the bot sends swap links (Phantom, Jupiter, Uniswap) and you sign in your own wallet. No private key is used.');
    return reply(ctx, `Mode set to ${set === 'paper' ? 'practice (paper)' : set}.`);
  }));

  bot.command('pause', h(async (ctx) => {
    engine.setPaused(true, 'manual /pause');
    await reply(ctx, 'Paused: no new entries or signal exits. Stop-loss / take-profit / trailing / guardian still active.');
  }));

  bot.command('resume', h(async (ctx) => {
    if (engine.panicOn) {
      // The button names this panic and this prompt: it cannot clear a later panic, and it expires after 120 s.
      const data = `panic:resume:${engine.panicId()}:${Math.floor(engine.now() / 1000).toString(36)}`;
      return replyRich(ctx, 'Panic stop is on. Resume buying? Mode stays practice. This confirmation expires in 120 s.', [[{ text: 'Confirm resume', data }, { text: 'Stay stopped', data: 'panic:stay' }]]);
    }
    engine.setPaused(false, 'manual /resume');
    await reply(ctx, 'Resumed.');
  }));

  bot.command('panic', h(async (ctx) => {
    const text = await engine.panic('manual /panic');
    if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, text);
  }));

  // ---------------------------------------------------------------- shared reports
  bot.command('safety', h((ctx) => reply(ctx, engine.safetyText())));
  bot.command('doctor', h(async (ctx) => {
    if (!doctor) return reply(ctx, 'Doctor is not wired in this process.');
    await reply(ctx, formatDoctor(await doctor()));
  }));
  bot.command('scoreboard', h((ctx) => reply(ctx, engine.scoreboardText())));
  bot.command('trackrecord', h((ctx) => {
    const w = (args(ctx)[0] ?? 'all').toLowerCase();
    return reply(ctx, engine.trackRecordText(['7d', '30d', 'all'].includes(w) ? w : 'all'));
  }));
  bot.command('guardian', h((ctx) => reply(ctx, engine.guardianText())));
  bot.command('digest', h(async (ctx) => {
    const d = engine.digest();
    await replyRich(ctx, escapeHtml(d.text), d.buttons);
  }));
  bot.command('why', h(async (ctx) => {
    let id = args(ctx)[0];
    if (!id && ctx.message?.reply_to_message?.text) id = /decision #(\d+)/.exec(ctx.message.reply_to_message.text)?.[1];
    if (!id) return reply(ctx, 'Usage: /why <id> (or reply /why to an alert)');
    const text = engine.whyText(id);
    if (llmEnabled(engine.cfg) && /^\d+$/.test(String(id))) return replyRich(ctx, escapeHtml(text), [[{ text: 'Explain more', data: `xm:${id}` }]]);
    await reply(ctx, text);
  }));
  bot.command('mute', h(async (ctx) => {
    const [addr, hoursRaw] = args(ctx);
    const address = extractAddress(addr);
    const hours = hoursRaw ? Number(hoursRaw) : 24;
    if (!address || !(hours > 0)) return reply(ctx, 'Usage: /mute <address> [hours]');
    const until = engine.mute(address, hours);
    await reply(ctx, `Muted ${address} until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC. It is still evaluated and logged (reason MUTED); critical guardian alerts still come through.`);
  }));
  bot.command('preset', h(async (ctx) => {
    const name = (args(ctx)[0] ?? '').toLowerCase();
    if (!['careful', 'normal', 'bold'].includes(name)) return reply(ctx, 'Usage: /preset careful|normal|bold');
    const p = engine.presetPreview(name);
    if (!p.diffs.length) return reply(ctx, p.text);
    await replyRich(ctx, escapeHtml(p.text), [[{ text: `Apply ${name}`, data: `preset:${name}` }, { text: 'Cancel', data: 'preset:cancel' }]]);
  }));

  bot.command('settings', h(async (ctx) => {
    const [key, value] = args(ctx);
    if (key && value !== undefined) {
      const r = engine.changeSetting(key, value);
      if (r.effectiveAt) {
        return reply(ctx, `${key} = ${r.value} takes effect at ${new Date(r.effectiveAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (loosening a limit or seatbelt waits ${engine.cfg.seatbelts.loosenDelayHours} h; tightening is instant).`);
      }
      return reply(ctx, `${key} = ${r.value}`);
    }
    await reply(ctx, engine.settingsText());
  }));

  // ---------------------------------------------------------------- buttons
  bot.on('callback_query:data', h(async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [kind, a1, a2, a3] = data.split(':');
    switch (kind) {
      case 'cb': {
        const r = await engine.resolvePending(a1, a2);
        if (r.card) {
          const rr = renderAlert(r.card);
          await ctx.editMessageText(rr.html, { parse_mode: 'HTML', reply_markup: toKeyboard(rr.buttons) }).catch(() => replyRich(ctx, rr.html, rr.buttons));
          return;
        }
        if (r.cancelled) return reply(ctx, r.message);
        if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, r.message);
        return;
      }
      case 'pb': {
        const r = await engine.practiceBuy(a1);
        if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, r.message);
        return replyRich(ctx, `Practice position opened (${money(r.fill.usd)}). Next:`, [[{ text: 'See my P&L', data: 'tour:pnl' }]]);
      }
      case 'w': {
        const a = await engine.watch(a1);
        return reply(ctx, `Watching ${a.market.token.symbol} (${a.chain}), every ${engine.cfg.trading.watchIntervalSec}s.`);
      }
      case 'mute': {
        engine.mute(a1, 24);
        return reply(ctx, 'Muted for 24 h. It is still evaluated and logged (reason MUTED).');
      }
      case 'why':
        return reply(ctx, engine.whyText(a1));
      case 'xm': {
        const d = engine.storage.getDecision(Number(a1));
        const ev = d?.event_id ? engine.events.read({}).find((e) => e.id === d.event_id) : null;
        const text = await explainMore(ev ?? { kind: d?.kind, subject: { ref: d?.address, title: d?.symbol }, reasons: JSON.parse(d?.codes ?? '[]') }, { apiKey: engine.cfg.llm.apiKey, model: engine.cfg.llm.model });
        return reply(ctx, text ?? 'Explain more is off (no ANTHROPIC_API_KEY).');
      }
      case 'g':
        return reply(ctx, await engine.guardianAction(a1, a2));
      case 's': {
        const r = await engine.sell(a1, Number(a2) || 100, 'Sell button');
        if (!engine.notifier.adminIds?.includes(ctx.from.id)) await reply(ctx, r.message);
        return;
      }
      case 'lb':
        return reply(ctx, (await engine.confirmLinkBuy(a1)).message);
      case 'lx':
        engine.cancelLinkBuy(a1);
        return reply(ctx, 'Cancelled. Nothing was recorded.');
      case 'ls':
        return reply(ctx, (await engine.confirmLinkSell(a1)).message);
      case 'sh': {
        const r = engine.shadowAction(a1, a2, a3);
        return typeof r === 'string' ? reply(ctx, r) : replyRich(ctx, escapeHtml(r.text), r.buttons);
      }
      case 'tour': {
        if (a1 === 'pnl') return reply(ctx, await engine.pnlText());
        const s = engine.cfg.sampleTokens[0];
        if (!s) return reply(ctx, 'No SAMPLE_TOKENS configured.');
        const a = await engine.analyze(s.address, s.chain);
        return analysisReply(ctx, a, 'Sample token. Read the card, then try a practice buy:\n\n');
      }
      case 'budget': {
        if (a1 === 'custom') return reply(ctx, 'Send /settings loss_budget <usd>, e.g. /settings loss_budget 75');
        const r = engine.changeSetting('loss_budget', a1);
        return reply(ctx, r.effectiveAt
          ? `Monthly loss budget ${money(r.value)} takes effect at ${new Date(r.effectiveAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (raising a budget is delayed).`
          : `Monthly loss budget set to ${money(r.value)}. The bot pauses new buys when it is used up.`);
      }
      case 'panic': {
        if (a1 !== 'resume') return reply(ctx, 'Staying stopped.');
        const promptAt = parseInt(a3 ?? '', 36) * 1000;
        return reply(ctx, engine.resumeFromPanic({ panicId: a2 ?? '', promptAt: Number.isFinite(promptAt) ? promptAt : 0 }));
      }
      case 'resume':
        // a1 = the pause id: an old AUTO-PAUSE card cannot end a newer pause (BALANCE_DROP included).
        return reply(ctx, engine.resumeFromButton(a1 || null));
      case 'mode': {
        if (a1 !== 'live') return reply(ctx, 'Staying in the current mode.');
        if (engine.now() - liveConfirmAt > 120_000) return reply(ctx, 'This confirmation expired. Run /mode live again.');
        liveConfirmAt = 0;
        return reply(ctx, engine.requestLiveMode({ phrase: engine.cfg.graduation.phrase, confirmed: true }).text);
      }
      case 'preset': {
        if (a1 === 'cancel') return reply(ctx, 'No changes.');
        const res = engine.applyPreset(a1);
        return reply(ctx, res.map((r) => `${r.key} = ${r.value}${r.effectiveAt ? ` (takes effect at ${new Date(r.effectiveAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}`).join('\n') || 'No changes.');
      }
      case 'tune': {
        if (a1 === 'keep') return reply(ctx, 'Kept.');
        return replyRich(ctx, `Change ${escapeHtml(a1)} to ${escapeHtml(a2)}?`, [[{ text: 'Yes, change it', data: `tuneok:${a1}:${a2}` }, { text: 'Keep', data: 'tune:keep' }]]);
      }
      case 'tuneok': {
        const r = engine.changeSetting(a1, a2);
        return reply(ctx, r.effectiveAt ? `${a1} = ${r.value} takes effect at ${new Date(r.effectiveAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : `${a1} = ${r.value}`);
      }
      default:
        return reply(ctx, 'Unknown button.');
    }
  }));

  bot.on('message:text', h(async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return reply(ctx, 'Unknown command. /help');
    const address = extractAddress(text);
    const phrase = engine.cfg.graduation.phrase;
    if (!address && text.trim().toLowerCase() === phrase.trim().toLowerCase()) {
      return reply(ctx, `To go live, send the phrase together with the command, in one message: /mode live ${phrase}`);
    }
    if (!address) return reply(ctx, 'Send a token contract address (EVM 0x... or Solana mint), or /help.');
    const chainWord = text.replace(address, ' ').trim().split(/\s+/)[0];
    const chain = chainWord && /^[a-z_-]{2,20}$/i.test(chainWord) ? normalizeChain(chainWord) : null;
    await analyzeAndReply(ctx, address, chain);
  }));

  bot.catch((err) => log.error(`bot error: ${err.error?.message ?? err.message}`));
  return bot;
}
