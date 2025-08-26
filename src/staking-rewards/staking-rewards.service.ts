import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import _ from 'lodash'

import {
  AosSigningFunction,
  sendAosDryRun,
  sendAosMessage
} from '../util/send-aos-message'
import { createEthereumDataItemSigner } from '../util/create-ethereum-data-item-signer'
import { EthereumSigner } from '../util/arbundles-lite'
import { Wallet } from 'ethers'
import { ClaimedRewardsData } from 'src/events/dto/claimed-rewards-data'


@Injectable()
export class StakingRewardsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StakingRewardsService.name)

  private isLive?: string

  private readonly stakingRewardsProcessId: string
  private readonly stakingRewardsControllerKey: string

  private signer!: AosSigningFunction

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      STAKING_REWARDS_PROCESS_ID: string
      STAKING_REWARDS_CONTROLLER_KEY: string
    }>
  ) {
    this.isLive = config.get<string>('IS_LIVE', { infer: true })

    this.logger.log(`Initializing staking rewards service (IS_LIVE: ${this.isLive})`)

    const stakingRewardsPid = this.config.get<string>('STAKING_REWARDS_PROCESS_ID', {
      infer: true,
    })
    if (stakingRewardsPid != undefined) {
      this.stakingRewardsProcessId = stakingRewardsPid
    } else this.logger.error('Missing STAKING_REWARDS_PROCESS_ID')

    this.stakingRewardsControllerKey = this.config.get<string>(
      'STAKING_REWARDS_CONTROLLER_KEY',
      { infer: true }
    )
    if (this.stakingRewardsControllerKey == undefined) {
      this.logger.warn('Missing STAKING_REWARDS_CONTROLLER_KEY. This is ok only if this is non-hodler deploy')
    }
  }

  async onApplicationBootstrap() {
    if (this.stakingRewardsControllerKey) {
      this.signer = await createEthereumDataItemSigner(
        new EthereumSigner(this.stakingRewardsControllerKey)
      )
      const wallet = new Wallet(this.stakingRewardsControllerKey)
      const address = await wallet.getAddress()
      this.logger.log(`Bootstrapped with signer address ${address}`)
    }
  }

  public async claimRewards(
    address: string
  ): Promise<ClaimedRewardsData> {
    const { result } = await sendAosMessage({
      processId: this.stakingRewardsProcessId,
      signer: this.signer as any,
      tags: [
        { name: 'Action', value: 'Claim-Rewards' },
        { name: 'Address', value: address },
        { name: 'Timestamp', value: new Date().toISOString() }
      ]
    })

    this.logger.log(`Get-Rewards response from AO for ${address}: ${result.Messages[0].Data}`)

    if (result.Messages.length == 0) {
      this.logger.warn(`No messages in Claim-Rewards response from AO for ${address}, Response: ${JSON.stringify(result)}`)
      return { address, amount: '0', kind: 'staking' }
    } else {
      var totalRewards = BigNumber(0)
      const rewardsPerOperator = JSON.parse(result.Messages[0].Data)
      for (const operator of Object.keys(rewardsPerOperator)) {
        const amount = BigNumber(rewardsPerOperator[operator])
        totalRewards = totalRewards.plus(amount)
      }

      const rewarded = totalRewards.toFixed(0)

      if (rewarded === 'NaN') {
        this.logger.warn(
          `Undefined amount for ${address}: ${result.Messages[0].Data}`
        )

        return { address, amount: '0', kind: 'staking' }
      }

      this.logger.log(`Got allocation for ${address}: ${rewarded}`)

      return { address, amount: rewarded, kind: 'staking' }
    }
  }
}
