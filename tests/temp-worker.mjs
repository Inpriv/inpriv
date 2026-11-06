// Local test entrypoint only; production keeps .temp/worker/src/index.js.
import temp from '../.temp/worker/src/index.js';
export * from '../.temp/worker/src/index.js';

export default {
  ...temp,
  scheduled(event, env, ctx) {
    // Wrangler 4.83's /__scheduled always uses Date.now(). The cleanup tests
    // request an hourly tick, which must fall in Temp's :00 cleanup window.
    const time = new Date(event.scheduledTime);
    if (event.cron === '0 * * * *') time.setUTCMinutes(0, 0, 0);
    return temp.scheduled({ scheduledTime: +time, cron: event.cron, noRetry: () => event.noRetry() }, env, ctx);
  },
};
