# Claim processing

How the Hodler flow claims rewards and settles them on chain.

## Leader-only workers

Every job in the hodler updates queue ends in transactions signed by the rewards pool and the
hodler operator. Writes from one wallet are serial: a second process signing from the same
wallet collides on nonces and can overwrite the allowance that an `approve` and `reward` pair
depends on. The service therefore runs one active worker and a standby.

- A worker that must run on one instance extends `LeaderOnlyWorker` and is declared with
  `@Processor(name, { autorun: false })`.
- `LeaderOnlyWorkersService` finds every such worker, starts it on the leader, and pauses it
  everywhere else.
- `ClusterService` emits `change` whenever leadership flips. It does not emit for the initial
  state, which is read with `isTheOne()`.
- Pausing lets the job in flight finish, so an `approve` and `reward` pair is not abandoned
  halfway.
- When a leader crashes, its active job stalls and the new leader runs it again.

`LeaderOnlyWorkersService` is registered in the root module. Nest bootstraps the root module
last, so every service a worker calls has finished its own bootstrap by the time the workers
start.

## Queue cleanup

With `DO_CLEAN=true` the queues are emptied on start, by the leader only. A standby that comes
up does not touch the leader's work.

- Every job in the hodler updates queue is rebuilt from MongoDB and the chain by the next
  discovery cycle, so emptying the queue is safe.
- Leader-only workers start after cleanup, so they never see a flow left by an earlier
  deployment.
- A discovery flow carries the block it was enqueued with. Cleanup keeps an old flow from
  moving the discovery checkpoint back.

Job ids in the hodler updates queue are prefixed with the requesting address, so the queue
holds one update attempt per address and transaction.

## Chain writes

A claim makes two chain writes. Each is bounded:

| Step | Setting | Default |
| --- | --- | --- |
| Sending a transaction | `TX_SEND_TIMEOUT_MS` | 60 seconds |
| Waiting for its receipt | `TX_WAIT_TIMEOUT_MS` | 300 seconds |

A timeout counts as a failure and is retried by the recovery path. Every retry recomputes the
amount against what the chain reports as already claimed, so a transaction that lands late is
seen as paid on the next attempt.

### Priority fee floor

A node can suggest a priority fee of zero on a quiet network. Transaction pools refuse or
ignore a zero tip, so Hodler transactions floor the priority fee at `MIN_PRIORITY_FEE_GWEI`.
The fee cap rises by the same amount, so it still covers twice the base fee plus the tip.

### Gas cost

The receipt's `gasPrice` is the effective price paid, and gas accounting uses it.

## Reading rewards

| Process | View | Response |
| --- | --- | --- |
| Relay rewards | `rewards` | `{ address, reward }`. `reward` is absent for an address with none |
| Staking rewards | `rewards` | A map of reward per operator, which the service sums |

## Claiming

`Claim-Rewards` is role-gated and takes the beneficiary as a tag, because the facilitator
claims on behalf of an address. The handler returns the claimed total as a JSON-encoded
string. The message also carries a `Claim-Rewards-Timestamp` tag, which the contract does not
read.

A contract rejection arrives as `AoContractError`, not as an HTTP failure.

## Requests with no reward

An `UpdateRewards` request for an address with nothing to claim never produces a `Rewarded`
event on chain, so discovery would find it unfulfilled on every cycle. Such a request is marked
fulfilled in MongoDB.

- `noReward` is set only when the rewards process reports no rewards for the address. The
  contract's `No rewards for <address>` rejection is that report.
- A zero amount caused by a process error, a malformed response, or an exception leaves
  `noReward` unset.
- A request is retired only when every reward read reported no rewards. Anything else is left
  for the next discovery cycle.
