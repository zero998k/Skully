// Outside services SolBoy reads market data from. Read when used, so they can be pointed elsewhere (for testing).
export const dexApi = () => process.env.DEXSCREENER_API_URL || 'https://api.dexscreener.com';
