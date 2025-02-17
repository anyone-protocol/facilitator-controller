import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import _ from 'lodash'

import { sendAosDryRun } from '../util/send-aos-message'

@Injectable()
export class RelayRewardsService {
  private readonly logger = new Logger(RelayRewardsService.name)

  private isLive?: string

  private readonly relayRewardsProcessId: string

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      RELAY_REWARDS_PROCESS_ID: string
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

    const amount = BigNumber(result.Messages[0].Data).toString()

    return { address, amount }
  }
}
