import { createApp } from './app.js';
import { loadConfig } from './lib/config.js';

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);

createApp({ config }).listen(port, () => {
  process.stdout.write(`baby-model portal listening on http://localhost:${port}\n`);
});
