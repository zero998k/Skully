// Outside services SolBoy reads market data from. Read when used, so they can be pointed elsewhere (for testing).
export const dexApi = () => process.env.DEXSCREENER_API_URL || 'https://api.dexscreener.com';
export const pumpApi = () => process.env.PUMP_API_URL || 'https://frontend-api-v3.pump.fun';
export const tweetApi = () => process.env.TWEET_API_URL || 'https://cdn.syndication.twimg.com';
