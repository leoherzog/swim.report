// test/helpers/cron.js
// Drives the Worker's scheduled() handler for a single cron trigger and awaits
// every promise it hands to ctx.waitUntil, mirroring the runtime's behavior.
import worker from "../../src/index.js";

export async function runScheduledCron(env, cronString) {
  const waits = [];
  const ctx = {
    waitUntil: function (promise) {
      waits.push(promise);
    }
  };
  worker.scheduled({ cron: cronString }, env, ctx);
  await Promise.all(waits);
}
