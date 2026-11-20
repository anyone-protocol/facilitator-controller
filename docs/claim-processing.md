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

Job ids in the hodler updates queue are prefixed with the requesting address and the request
transaction, so the queue holds one update attempt per request at a time. A completed job is
removed from the queue, so its id does not stop the request from running again. The request's
record in MongoDB does, as described under [One payout per request](#one-payout-per-request).

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

## One payout per request

An address is paid only in answer to an `UpdateRewards` request, and a payout settles everything
owed to it at that point. Every request is stored in MongoDB and is answered by at most one
payout.

- A request that arrives on the live subscription is stored before its claim job is queued.
  Discovery finds it already stored and skips it.
- A claim job whose request is already fulfilled does not pay.
- When a `reward` transaction confirms, its `Rewarded` event is stored, and every open request
  from that address in an earlier block is marked fulfilled by it. A request that discovery
  stores later is matched to that stored event.
- Requests sent before a payout, such as a claim pressed twice, are all answered by that one
  payout. A request mined after the payout block is a new claim.
- Because every payout is stored as it confirms, a restart with the discovery checkpoint behind
  the chain head does not pay a request again. A payout whose record fails to store raises
  `[alarm=record-reward-failed]` and is stored when discovery reaches its block.

## Requests with no reward

A request that ends without a payout never produces a `Rewarded` event on chain, so discovery
would find it unfulfilled on every cycle. Such a request is marked fulfilled in MongoDB, with
`noReward` set, when:

- every reward read reported no rewards for the address. The contract's
  `No rewards for <address>` rejection is that report.
- every reward read succeeded and nothing is owed beyond what the chain already records as
  claimed.
- the Hodler refuses the reward with `No rewards to claim` or
  `Insufficient gas budget for hodler account`. The gas budget grows only with a new request,
  which is queued as a claim of its own.

A zero amount caused by a process error, a malformed response, or an exception does not count
as a successful read. A request with such a read is left for the next discovery cycle.
