import BigNumber from "bignumber.js"

export class ClaimedConfigData {
  gas: string
  redeem: boolean
  // transactionHash of the originating UpdateRewards event, used to mark it
  // fulfilled when processing finds no claimable reward.
  transactionHash?: string
}
