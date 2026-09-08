import { createApp } from './app.js';

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DB_PATH || './data/ass-score.db';

const app = createApp({ dbPath });
app.listen(port, host, () => {
  console.log(`A.S.S. Score listening on http://${host}:${port}`);
});
