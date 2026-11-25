# `@neo/ai-sdk`

Official typed TypeScript SDK for **Neo** — the autonomous, sovereign cognitive engine and API Forge for Neos and external applications.

```ts
import { NeoClient } from '@neo/ai-sdk';

const neo = new NeoClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.NEO_API_KEY!,
});

const analysis = await neo.reason({
  query: 'Audit cash runway and ledger balance across Q1 invoices',
  autonomy: 'balanced',
});
console.log(analysis);
```
