// Paper executor: fills at the current price with configurable slippage and fees.
import { Executor, simulatedFill, slippageOf } from './base.js';

export class PaperExecutor extends Executor {
  name = 'paper';

  /** @param {{slippageBps: number, feeBps: number}} trading .env values; a request's slippageBps wins (/settings). */
  constructor(trading) {
    super();
    this.trading = trading;
  }

  async buy({ usd, price, costs = null, slippageBps }) {
    return simulatedFill('BUY', { usd, price, costs }, { ...this.trading, slippageBps: slippageOf({ slippageBps }, this.trading) }, 'paper', false);
  }

  async sell({ qty, price, costs = null, slippageBps }) {
    return simulatedFill('SELL', { qty, price, costs }, { ...this.trading, slippageBps: slippageOf({ slippageBps }, this.trading) }, 'paper', false);
  }
}
