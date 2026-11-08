// Local status API and storage, with the scheduled network probe stubbed.
// The production Probe is tested separately with controlled fetch responses.
import { WorkerEntrypoint } from 'cloudflare:workers';
export { default } from '../.status/worker/src/index.js';
export class Probe extends WorkerEntrypoint {
  async run() { return { local: true }; }
}
