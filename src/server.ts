import { createApp } from './app.js';
import { config } from './config/index.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`LuminaRail Backend running on port ${config.port} (${config.env})`);
});
