import { Injectable, Logger } from '@nestjs/common'
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
export class RelayRewardsService {
  private readonly logger = new Logger(RelayRewardsService.name)

  private isLive?: string

  private readonly relayRewardsProcessId: string
  private readonly relayRewardsControllerKey: string

  private signer!: AosSigningFunction


  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      RELAY_REWARDS_PROCESS_ID: string
      RELAY_REWARDS_CONTROLLER_KEY: string
    }>
  ) {
    this.isLive = config.get<string>('IS_LIVE', { infer: true })

    this.logger.log(`Initializing relay rewards service (IS_LIVE: ${this.isLive})`)

    const relayRewardsPid = this.config.get<string>('RELAY_REWARDS_PROCESS_ID', {
      infer: true,
    })
    if (relayRewardsPid != undefined) {
      this.relayRewardsProcessId = relayRewardsPid
    } else this.logger.error('Missing relay rewards process id')

    this.relayRewardsControllerKey = this.config.get<string>(
      'RELAY_REWARDS_CONTROLLER_KEY',
      { infer: true }
    )
    if (this.relayRewardsControllerKey == undefined) {
      this.logger.warn('Missing RELAY_REWARDS_CONTROLLER_KEY. This is ok only if this is non-hodler deploy')
    }
  }

  async onApplicationBootstrap() {
    if (this.relayRewardsControllerKey) {
      this.signer = await createEthereumDataItemSigner(
        new EthereumSigner(this.relayRewardsControllerKey)
      )
      const wallet = new Wallet(this.relayRewardsControllerKey)
      const address = await wallet.getAddress()
      this.logger.log(`Bootstrapped with signer address ${address}`)
    }
  }

  public async getAllocation(
    address: string
  ): Promise<{ address: string, amount: string }> {
    const { result } = await sendAosDryRun({
      processId: this.relayRewardsProcessId,
      tags: [
        { name: 'Action', value: 'Get-Rewards' },
        { name: 'Address', value: address }
      ]
    })

    this.logger.log(`Get-Rewards response from AO for ${address}: ${result.Messages[0].Data}`)

    const amount = BigNumber(JSON.parse(result.Messages[0].Data)).toFixed(0)

    if (amount === 'NaN') {
      this.logger.warn(
        `Undefined amount for ${address}: ${result.Messages[0].Data} -> ${amount}`
      )

      return undefined
    }

    this.logger.log(`Got allocation for ${address}: ${amount}`)

    return { address, amount }
  }
  
  public async claimRewards(
    address: string
  ): Promise<ClaimedRewardsData> {
    const { result } = await sendAosMessage({
      processId: this.relayRewardsProcessId,
      signer: this.signer as any,
      tags: [
        { name: 'Action', value: 'Claim-Rewards' },
        { name: 'Address', value: address },
        { name: 'Timestamp', value: new Date().toISOString() }
      ]
    })

    this.logger.log(`Claim-Rewards response from AO for ${address}: ${result.Messages[0].Data}`)

    const amount = BigNumber(JSON.parse(result.Messages[0].Data)).toFixed(0)

    if (amount === 'NaN') {
      this.logger.warn(
        `Undefined amount for ${address}: ${result.Messages[0].Data} -> ${amount}`
      )

      return { address, amount: '0', kind: 'relay' }
    }

    this.logger.log(`Claimed rewards for ${address}: ${amount}`)

    return { address, amount, kind: 'relay' }
  }
}
