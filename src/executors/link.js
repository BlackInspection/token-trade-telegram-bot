// Link executor ("sign it yourself"): never signs, never fills. It only prepares swap links for the user's wallet.
// Positions in link mode are recorded when the user taps [I bought] / [I sold] (or /filled).
import { Executor, ExecutionError } from './base.js';
import { buyLinks, sellLinks } from '../links.js';

export class LinkExecutor extends Executor {
  name = 'link';

  prepareBuy({ token, usd }) {
    return { links: buyLinks({ chain: token.chain, token: token.address, usd }) };
  }

  prepareSell({ token }) {
    return { links: sellLinks({ chain: token.chain, token: token.address }) };
  }

  async buy() {
    throw new ExecutionError('link mode never signs: use the swap link and tap [I bought]');
  }

  async sell() {
    throw new ExecutionError('link mode never signs: use the swap link and tap [I sold]');
  }
}
