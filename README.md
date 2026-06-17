# Facilitator Controller

A [NestJS](https://nestjs.com/) oracle/bridge service for the
[ANYONE Protocol](https://anyone.io). It connects the protocol's reward
distribution logic, which runs as [AO](https://ao.arweave.net/) processes on
Arweave, to the protocol's smart contracts on Ethereum.

In short: it watches Ethereum for reward requests, asks the AO reward processes
how much each account has earned, and writes the resulting reward/allocation
amounts back to Ethereum.

## How it works

When a user requests their rewards on-chain, the relevant Ethereum contract
emits an event. The controller reacts to that event by:

1. **Listening** for the request event over a WebSocket connection to Ethereum.
2. **Claiming** the account's current rewards from the AO reward processes
   (relay rewards and staking rewards) via signed AO messages.
3. **Settling** the rewards back on Ethereum by sending a transaction from an
   operator wallet.

Because WebSocket subscriptions can miss events (disconnects, restarts, RPC
hiccups), the controller also runs a **discovery** loop that periodically scans
historical blocks over JSON-RPC, persists every request/fulfillment event to
MongoDB, and re-queues any request that was never fulfilled. This makes event
processing eventually-consistent rather than relying solely on the live socket.

### Two operating modes

The service supports two reward flows, toggled independently with the
`USE_HODLER` and `USE_FACILITY` environment variables:

| Mode | Status | Contract | Trigger event | Settlement |
| --- | --- | --- | --- | --- |
| **Hodler** | **Current / production** | Hodler | `UpdateRewards` | Claims relay + staking rewards from AO, `approve()`s the token transfer from the rewards pool, then calls `reward()` on the Hodler contract (with gas accounting). |
| **Facility** | Legacy | Facility | `RequestingUpdate` | Fetches the relay allocation from AO and calls `updateAllocation()` on the Facility contract. |

The current production deployment runs **Hodler mode only**
(`USE_HODLER=true`, `USE_FACILITY=false`). The Facility path is retained for
backwards compatibility.

### Gas accounting (Hodler mode)

When settling Hodler rewards the controller pays gas for two transactions (the
ERC-20 `approve` and the `reward` call). It measures the actual gas spent
against the user-supplied gas estimate and accumulates the running balance in
the `EventsServiceState` document in MongoDB, logging when it over- or
under-charges.

## Architecture

```
        Ethereum (Hodler / Facility contracts)
          │  ▲
   events │  │ reward() / updateAllocation()
          ▼  │
   ┌─────────────────────────────────────────────────┐
   │            facilitator-controller               │
   │                                                 │
   │  EvmProviderService   ── resilient WS (Infura   │
   │   (live events)          primary / Alchemy      │
   │                          secondary) + JSON-RPC  │
   │                                                 │
   │  EventsService        ── reacts to live events  │
   │  *DiscoveryService    ── backfills via JSON-RPC │
   │                                                 │
   │  BullMQ flows (Redis) ── queues the work        │
   │  Relay/StakingRewards ── claim rewards from AO  │
   │  ClusterService       ── Consul leader election │
   └─────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
     AO processes (Arweave)      MongoDB (event state,
   relay-rewards / staking-      recovery, gas balance)
   rewards distribution
```

Key building blocks:

- **EvmProviderService** — manages a resilient pair of WebSocket providers
  (Infura primary, Alchemy secondary) with automatic failover, plus a JSON-RPC
  provider used for historical event queries.
- **EventsService** — subscribes to live contract events and orchestrates the
  reward settlement transactions.
- **EventsDiscoveryService / RewardsDiscoveryService** — periodically scan
  historical blocks (in ≤5000-block ranges, every hour by default), store
  discovered events in MongoDB, match request events to their fulfillment
  events, and re-queue anything unfulfilled.
- **RelayRewardsService / StakingRewardsService** — talk to the AO reward
  processes using [`@permaweb/aoconnect`](https://www.npmjs.com/package/@permaweb/aoconnect),
  signing messages with an Ethereum-keyed data-item signer.
- **BullMQ flows** — all work runs through Redis-backed job flows, giving
  retries, deduplication (by `address`+`txHash` job IDs), and recovery jobs.
- **ClusterService** — uses [Consul](https://www.consul.io/) KV-based leader
  election so that, across multiple running instances, only the elected leader
  acts on events. Combined with the per-host "local leader" flag
  (`IS_LOCAL_LEADER`), exactly one process is "the one" that performs each
  one-time action.

### Persistence & infrastructure

- **MongoDB** — stores discovered events, discovery checkpoints
  (`lastSafeCompleteBlock`), and gas-balance accounting state.
- **Redis** — backs the BullMQ job queues. Supports both `standalone` and
  `sentinel` modes (production uses Sentinel).
- **Consul** — leader election and service discovery.
- **Vault / Nomad** — secret injection and deployment (see `operations/`).

## Configuration

Configuration is entirely environment-variable driven (via `@nestjs/config`).
The most important variables:

### General

| Variable | Description |
| --- | --- |
| `IS_LIVE` | `true` enables real transactions and Consul clustering. When not `true`, the service runs single-node and skips/marks all on-chain writes as "NOT LIVE". |
| `PORT` | HTTP port for the health endpoint (default `3000`). |
| `VERSION` | Build/version string, logged at startup. |
| `DO_CLEAN` | `true` obliterates BullMQ queues on boot. |
| `DO_DB_NUKE` | `true` clears stored request/update event collections on boot. |
| `USE_HODLER` | `true` enables the Hodler reward flow. |
| `USE_FACILITY` | `true` enables the legacy Facility flow. |

### Ethereum / EVM

| Variable | Description |
| --- | --- |
| `EVM_NETWORK` | Network name passed to ethers. |
| `EVM_JSONRPC` | JSON-RPC URL used for historical event discovery. |
| `EVM_PRIMARY_WSS` | Primary WebSocket URL (Infura). |
| `EVM_SECONDARY_WSS` | Secondary/failover WebSocket URL (Alchemy). |

### Hodler mode

| Variable | Description |
| --- | --- |
| `HODLER_CONTRACT_ADDRESS` | Hodler contract address. |
| `HODLER_CONTRACT_DEPLOYED_BLOCK` | Block to start historical discovery from. |
| `HODLER_OPERATOR_KEY` | Private key of the operator wallet that calls `reward()`. |
| `REWARDS_POOL_KEY` | Private key of the wallet that approves the token transfer. |
| `TOKEN_CONTRACT_ADDRESS` | ERC-20 reward token address. |

### Facility mode (legacy)

| Variable | Description |
| --- | --- |
| `FACILITY_CONTRACT_ADDRESS` | Facility contract address. |
| `FACILITY_CONTRACT_DEPLOYED_BLOCK` | Block to start historical discovery from. |
| `FACILITY_OPERATOR_KEY` | Private key of the operator wallet that calls `updateAllocation()`. |

### AO reward processes

| Variable | Description |
| --- | --- |
| `RELAY_REWARDS_PROCESS_ID` | AO process ID for relay rewards. |
| `RELAY_REWARDS_CONTROLLER_KEY` | Signing key for relay-rewards AO messages. |
| `STAKING_REWARDS_PROCESS_ID` | AO process ID for staking rewards. |
| `STAKING_REWARDS_CONTROLLER_KEY` | Signing key for staking-rewards AO messages. |
| `CU_URL` | AO Compute Unit URL used by aoconnect. |

### MongoDB & Redis

| Variable | Description |
| --- | --- |
| `MONGO_URI` | MongoDB connection string. |
| `REDIS_MODE` | `standalone` (default) or `sentinel`. |
| `REDIS_HOSTNAME` / `REDIS_PORT` | Used in `standalone` mode. |
| `REDIS_MASTER_NAME`, `REDIS_SENTINEL_{1,2,3}_HOST/PORT` | Used in `sentinel` mode. |

### Clustering (Consul)

| Variable | Description |
| --- | --- |
| `CONSUL_HOST` / `CONSUL_PORT` | Consul agent address. |
| `CONSUL_SERVICE_NAME` | Service name used for the leader-election key. |
| `CONSUL_TOKEN_CONTROLLER_CLUSTER` | Consul ACL token. |
| `IS_LOCAL_LEADER` | Marks a process as eligible to act / participate in election. |
| `CPU_COUNT` | Number of worker threads when running multi-process. |

> Note: when `IS_LIVE` is not `true`, or when Consul host/port are unset, the
> service bootstraps in single-node mode and treats itself as the leader.

## Project setup

```bash
npm install
```

## Running

```bash
# development
npm run start

# watch mode
npm run start:dev

# production build + run
npm run build
npm run start:prod
```

The service exposes a health check at `GET /health` (and `/`), which returns
`OK`.

### Local development

`docker-compose.yml` provides local Redis and MongoDB:

```bash
docker compose up redis mongo
```

Running the controller against real reward flows requires Ethereum RPC
credentials, contract addresses, operator keys, and AO process IDs (see
[Configuration](#configuration)). Leave `IS_LIVE` unset (or not `true`) to run
single-node and avoid broadcasting real transactions. In production these values are injected from Vault/Consul (see
`operations/`).

## Tests

```bash
npm run test       # unit tests
npm run test:e2e   # e2e tests
npm run test:cov   # coverage
```

## Deployment

The service is containerized (`Dockerfile`) and deployed to
[Nomad](https://www.nomadproject.io/). Job specs live in `operations/`:

- `facilitator-controller-live.hcl` / `facilitator-controller-stage.hcl` — the
  service jobs (run with `count = 2` for redundancy; Consul elects the leader).
- `facilitator-controller-redis-sentinel-*.hcl` — the Redis Sentinel cluster.

Secrets are sourced from Vault and runtime configuration (contract addresses,
process IDs, Mongo/Redis endpoints) from Consul KV and service discovery.

## License

[AGPL-3.0-only](./LICENSE)
