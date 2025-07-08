import BigNumber from "bignumber.js"
import { ClaimedRewardsData } from "./claimed-rewards-data"

export class RecoverRewardsData {
  retries: number
  gas: string
  redeem: boolean
  rewards: ClaimedRewardsData[]
}
