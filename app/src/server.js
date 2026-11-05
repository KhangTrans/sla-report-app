import { createApp } from "./app.js";
import { DataStore } from "./store.js";
import { HelpdeskClient } from "./helpdesk.js";
import { SyncEngine } from "./sync.js";

const port = Number(process.env.PORT || 8080);

const store = new DataStore();
const client = new HelpdeskClient({
  baseUrl: process.env.HELPDESK_URL,
  token: process.env.HELPDESK_TOKEN,
});
const syncEngine = new SyncEngine({ client, store });

const app = createApp({ store, syncEngine });

// Start background synchronization immediately
syncEngine.start();

app.listen(port, "0.0.0.0", () => {
  console.log(`sla-report-app listening on http://0.0.0.0:${port}`);
});
