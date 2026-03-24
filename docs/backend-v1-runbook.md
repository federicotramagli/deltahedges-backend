# DeltaHedge Backend v1 Runbook

## Cosa c'è nel repo
- `apps/api`
  REST API, webhook Stripe e gateway WebSocket.
- `apps/worker`
  Scheduler BullMQ, runtime jobs, forced close e orchestrazione slot.
- `packages/shared`
  Tipi, formule strategia, scheduler e schema input condivisi.
- `supabase/migrations/20260324_deltahedge_v1.sql`
  Schema Postgres multi-tenant per utenti, seats, slot, runtime, trade e log.

## Limiti del v1 attuale
- Il frontend Vite è ancora principalmente guidato da stato locale.
- Le formule e il dominio strategico sono condivisi col backend, ma la UI non legge ancora snapshot ed eventi realtime dall'API.
- `MetaApi` è già incapsulato in un service server-side, ma il provisioning reale è lasciato volutamente dietro `METAAPI_ACCESS_TOKEN`; senza token valido usa id mock deterministic.
- La parte `proxy pool` usa il DB e l'assegnazione per paese, ma richiede che la tabella `proxy_pool` sia popolata.

## Setup rapido
1. Copia:
   - `apps/api/.env.example` -> `apps/api/.env`
   - `apps/worker/.env.example` -> `apps/worker/.env`
2. Applica la migration `supabase/migrations/20260324_deltahedge_v1.sql` al tuo Postgres/Supabase.
3. Popola almeno:
   - `proxy_pool`
   - un utente Supabase Auth reale oppure `DEV_USER_ID` per sviluppo locale
4. Avvia Redis.

## Comandi utili
```bash
npm run dev:web
npm run dev:api
npm run dev:worker
```

```bash
npm run typecheck:server
npm run test:server
npm run build
npm run build:api
npm run build:worker
```

## Contratti backend già pronti
- `POST /slots`
- `GET /slots`
- `GET /slots/:slotId`
- `POST /slots/:slotId/accounts`
- `POST /slots/:slotId/parameters`
- `POST /slots/:slotId/activate`
- `POST /slots/:slotId/pause`
- `GET /slots/:slotId/trades`
- `GET /performance`
- `POST /stripe/create-checkout-session`
- `POST /stripe/webhook`

## Realtime
Il gateway WebSocket espone `ws://host/ws?userId=...` in sviluppo.

Eventi runtime già pubblicati:
- `slot.updated`
- `slot.runtime.updated`
- `trade_pair.opened`
- `trade_pair.closed`
- `risk.event`
- `billing.paused`

## Formula strategica condivisa
- Fase 1:
  - `baseTarget = fee challenge + net target iniziale`
  - `phase1PassLoss = baseTarget * 0.8`
- Fase 2:
  - `phase2RecoveryTarget = (phase1PassLoss + challengeFee) * 1.2`
  - `phase2PassLoss = phase2RecoveryTarget * 0.5`
- Funded:
  - `1.00 prop = 0.40 broker`
  - `fundedGrossPayout = brokerBalanceEnteringFunded / 0.4`
  - `brokerAfterPayout = 0`

## Prossimo step consigliato
Collegare il frontend a:
- `GET /slots`
- `GET /slots/:slotId`
- `POST /slots/:slotId/accounts`
- `POST /slots/:slotId/parameters`
- `POST /slots/:slotId/activate`
- WebSocket `/ws`

Così la UI smette di calcolare localmente `MetaApi pronta`, proiezioni e stati runtime.
