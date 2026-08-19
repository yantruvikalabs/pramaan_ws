/**
 * Which host is this process running on, stated by the host itself.
 *
 * Only one thing needs this so far: the rate limiter has to know whether it
 * may believe `x-nf-client-connection-ip`. Netlify's edge sets that header and
 * overwrites whatever the caller sent, so on Netlify it is trustworthy —
 * anywhere else nothing strips it, and a caller could send a fresh value on
 * every request to walk past the limit.
 *
 * The obvious test, `process.env.NETLIFY === 'true'`, is WRONG: Netlify
 * documents that as a BUILD variable, and only a short list (URL, SITE_NAME)
 * is guaranteed to reach the functions runtime. A guard that reads it would
 * look correct, pass review, and quietly never engage in production.
 *
 * So the entry point declares it instead. netlify/functions/api.js calls
 * trustNetlifyClientIp() and is the only file that does — it is also the only
 * file Netlify ever executes, which makes the claim self-evidently true there
 * and impossible to make accidentally anywhere else.
 */

let netlifyClientIpTrusted = false;

/** Called by the Netlify function entry point, and by nothing else. */
export function trustNetlifyClientIp() {
  netlifyClientIpTrusted = true;
}

/**
 * Read this per request, never at module load: the entry point cannot run
 * before the modules it imports have been evaluated, so a value captured at
 * import time would always be false.
 */
export function isNetlifyClientIpTrusted() {
  return netlifyClientIpTrusted;
}
