// Notifications to ADMIN_IDS via the Telegram bot API, or stdout when no bot is attached.
// Alerts arrive pre-rendered by explain.renderAlert: {html, buttons}; stdout gets the same lines as plain text.
import { chunkText } from './format.js';
import { toKeyboard } from './explain.js';
import { getLogger } from './log.js';

const log = getLogger('notify');

/** True when Telegram rejected a message because of the Bot API 9.4 button 'style' field. */
export const isStyleError = (err) => (err?.error_code === 400 || /\b400\b/.test(String(err?.message ?? ''))) && /style|button|reply markup|keyboard/i.test(String(err?.description ?? err?.message ?? ''));

/**
 * Send HTML with an inline keyboard; with UI_BUTTON_COLORS the 'style' field is added, and a Telegram 400
 * caused by it is retried once without style.
 */
export async function sendRich(api, chatId, html, buttons, { colors = false, extra = {} } = {}) {
  const base = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
  const markup = buttons?.length ? { reply_markup: toKeyboard(buttons, { colors }) } : {};
  try {
    return await api.sendMessage(chatId, html, { ...base, ...markup });
  } catch (err) {
    const hasStyle = colors && buttons?.flat().some((b) => b.style);
    if (!hasStyle || (err?.error_code !== 400 && !/400/.test(String(err?.message)))) throw err;
    log.warn(`Telegram rejected button style (${err.description ?? err.message}); retrying without style`);
    return api.sendMessage(chatId, html, { ...base, ...(buttons?.length ? { reply_markup: toKeyboard(buttons, { colors: false }) } : {}) });
  }
}

export class Notifier {
  /** @param {{adminIds: number[], colors?: boolean}} opts */
  constructor({ adminIds = [], colors = false } = {}) {
    this.adminIds = adminIds;
    this.colors = colors;
    /** @type {import('grammy').Api|null} */
    this.api = null;
  }

  /** @param {import('grammy').Api} api */
  attach(api) {
    this.api = api;
  }

  /**
   * @param {string} text plain text (stdout, and Telegram when no html is given)
   * @param {{html?: string, buttons?: any[][]}} [opts]
   */
  async send(text, opts = {}) {
    if (!this.api || !this.adminIds.length) {
      console.log(`[notify] ${String(text).replace(/\n/g, '\n         ')}`);
      return;
    }
    for (const id of this.adminIds) {
      try {
        if (opts.html) {
          await sendRich(this.api, id, opts.html, opts.buttons, { colors: this.colors });
          continue;
        }
        for (const part of chunkText(text)) await this.api.sendMessage(id, part, { link_preview_options: { is_disabled: true } });
      } catch (err) {
        log.warn(`send to ${id} failed: ${err.message}`);
      }
    }
  }
}
