import './golden/_helpers/force-json-provider';
// Run before .env or services load. Tests use their own JSON file and must
// never inherit real search/email credentials or reach external providers.
process.env.AUTH_MODE = 'demo';
for (const key of ['PLATFORM_SERPAPI_API_KEY', 'SERPAPI_API_KEY', 'SERP_API_KEY', 'RESEND_API_KEY', 'GOOGLE_MAPS_API_KEY', 'PLATFORM_GOOGLE_MAPS_API_KEY']) process.env[key] = '';
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Offline smoke blocks external network calls');
  return fetchOriginal(input, init);
};
