/**
 * Signals module exports
 * Mean reversion strategy + Premium shorting
 */

export {
  MeanReversionSignalGenerator,
  getMeanReversionSignalGenerator,
} from './meanReversionSignal';

export {
  evaluatePremiumSignal,
  checkShortExit,
  getOpenShortPositions,
  getClosedShortPositions,
  saveShortPosition,
  getPremiumThresholds,
  getPremiumWatchlist,
  updatePremiumWatchlist,
  setShortEntryCooldown,
  type PremiumShortSignal,
  type ShortPosition,
  type PremiumWatchlistItem,
} from './premiumShortSignal';
