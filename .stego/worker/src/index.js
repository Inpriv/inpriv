// Inpriv Stego — static asset worker.
// The tool is 100% client-side; this worker only serves files and never
// touches user data (there is no API by design).
export default {
  async fetch(request, env, ctx) {
    return env.ASSETS.fetch(request);
  },
};
