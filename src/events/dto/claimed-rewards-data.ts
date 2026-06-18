export class ClaimedRewardsData {
  kind: 'staking' | 'relay'
  address: string
  amount: string
  // True only when the rewards process authoritatively reported no rewards for
  // the address. Left unset for zero amounts caused by AO/process errors,
  // malformed (NaN) responses, or exceptions, so those are not treated as a
  // definitive "no reward".
  noReward?: boolean
}
