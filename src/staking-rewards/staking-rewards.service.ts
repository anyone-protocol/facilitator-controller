import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import _ from 'lodash'

import { EthereumSigner } from '@dha-team/arbundles'
import {
  AoClient,
  AoContractError,
  createAoClient,
  nodeUrlFromEnv
} from '@anyone-protocol/ao-client'
import { Wallet } from 'ethers'
import { ClaimedRewardsData } from 'src/events/dto/claimed-rewards-data'


@Injectable()
export class StakingRewardsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StakingRewardsService.name)

  private isLive?: string

  private readonly stakingRewardsProcessId: string
  private readonly stakingRewardsControllerKey: string
  private readonly hbUrl: string

  private ao!: AoClient

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      STAKING_REWARDS_PROCESS_ID: string
      STAKING_REWARDS_CONTROLLER_KEY: string
      HB_URL: string
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

    // Fail closed, no default. Replaces CU_URL.
    this.hbUrl = nodeUrlFromEnv({
      HB_URL: this.config.get<string>('HB_URL', { infer: true })
    })
  }

  async onApplicationBootstrap() {
    // The key is optional on a non-hodler deploy. Build a read-only client without one
    // rather than refusing to start.
    this.ao = createAoClient({
      url: this.hbUrl,
      ...(this.stakingRewardsControllerKey
        ? { signer: new EthereumSigner(this.stakingRewardsControllerKey) }
        : {}),
      logger: {
        debug: (m, ...meta) => this.logger.debug(m, ...meta),
        warn: (m, ...meta) => this.logger.warn(m, ...meta),
        error: (m, ...meta) => this.logger.error(m, ...meta)
      }
    })

    if (this.stakingRewardsControllerKey) {
      const wallet = new Wallet(this.stakingRewardsControllerKey)
      const address = await wallet.getAddress()
      this.logger.log(`Bootstrapped with signer address ${address} against node ${this.hbUrl}`)
    } else {
      this.logger.log(`Bootstrapped READ-ONLY (no controller key) against node ${this.hbUrl}`)
    }
  }

  public async claimRewards(
    address: string
  ): Promise<ClaimedRewardsData> {
    try {
      // Role-gated, and takes the beneficiary as a tag — the facilitator claims ON BEHALF of
      // an address, so `ctx.from` is us. Claim-Rewards-Timestamp is not read by the contract;
      // kept for the audit trail on the message.
      const { output } = await this.ao.sendMessage({
        processId: this.stakingRewardsProcessId,
        action: 'Claim-Rewards',
        tags: [
          { name: 'address', value: address },
          { name: 'claim-rewards-timestamp', value: Date.now().toString() }
        ]
      })

      // Unlike relay, staking returns the hodler's PER-OPERATOR reward map, which the caller
      // wants as one total. That shape is the contract's, not a client artefact.
      const rewardsPerOperator = JSON.parse(output ?? 'null') ?? {}
      let totalRewards = BigNumber(0)
      for (const operator of Object.keys(rewardsPerOperator)) {
        totalRewards = totalRewards.plus(BigNumber(rewardsPerOperator[operator]))
      }

      const rewarded = totalRewards.toFixed(0)

      if (rewarded === 'NaN') {
        this.logger.warn(`Undefined amount for ${address}: ${output}`)

        return { address, amount: '0', kind: 'staking' }
      }

      this.logger.log(`Got allocation for ${address}: ${rewarded}`)

      return { address, amount: rewarded, kind: 'staking' }
    } catch (error) {
      // "No rewards for <addr>" is the contract's own assert and an expected outcome.
      if (error instanceof AoContractError) {
        if (error.reason.includes('No rewards for ')) {
          this.logger.warn(`No rewards for ${address}: ${error.reason}`)

          return { address, amount: '0', kind: 'staking', noReward: true }
        }

        this.logger.error(`Claim-Rewards rejected for ${address}: ${error.reason}`)
      } else {
        this.logger.error(`Exception claiming rewards for ${address}`, error.stack)
      }

      return { address, amount: '0', kind: 'staking' }
    }
  }
}
