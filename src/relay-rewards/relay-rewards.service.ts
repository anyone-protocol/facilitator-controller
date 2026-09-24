import { Injectable, Logger } from '@nestjs/common'
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
export class RelayRewardsService {
  private readonly logger = new Logger(RelayRewardsService.name)

  private isLive?: string

  private readonly relayRewardsProcessId: string
  private readonly relayRewardsControllerKey: string
  private readonly hbUrl: string

  private ao!: AoClient

  private resolveReady!: () => void
  /** Resolves once bootstrap is done: the AO client exists. */
  public readonly ready: Promise<void> = new Promise((resolve) => {
    this.resolveReady = resolve
  })

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      RELAY_REWARDS_PROCESS_ID: string
      RELAY_REWARDS_CONTROLLER_KEY: string
      HB_URL: string
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

    // Fail closed, no default. Replaces CU_URL.
    this.hbUrl = nodeUrlFromEnv({
      HB_URL: this.config.get<string>('HB_URL', { infer: true })
    })
  }

  async onApplicationBootstrap() {
    try {
      await this.bootstrap()
    } finally {
      this.resolveReady()
    }
  }

  private async bootstrap() {
    // The key is optional on a non-hodler deploy, and getAllocation is a read. Build a
    // read-only client when there is no key rather than refusing to start.
    this.ao = createAoClient({
      url: this.hbUrl,
      ...(this.relayRewardsControllerKey
        ? { signer: new EthereumSigner(this.relayRewardsControllerKey) }
        : {}),
      logger: {
        debug: (m, ...meta) => this.logger.debug(m, ...meta),
        warn: (m, ...meta) => this.logger.warn(m, ...meta),
        error: (m, ...meta) => this.logger.error(m, ...meta)
      }
    })

    if (this.relayRewardsControllerKey) {
      const wallet = new Wallet(this.relayRewardsControllerKey)
      const address = await wallet.getAddress()
      this.logger.log(`Bootstrapped with signer address ${address} against node ${this.hbUrl}`)
    } else {
      this.logger.log(`Bootstrapped READ-ONLY (no controller key) against node ${this.hbUrl}`)
    }
  }

  /**
   * Cumulative reward owed to an address.
   *
   * Was a `Get-Rewards` dryrun whose response body WAS the bare amount. The native contract
   * serves this as the `rewards` view, which returns `{ address, reward }` — so the amount is
   * a field, not the whole body. An address with no rewards yields no `reward` key at all.
   */
  public async getAllocation(
    address: string
  ): Promise<{ address: string, amount: string }> {
    const result = await this.ao.readView<{ address: string, reward?: string }>(
      this.relayRewardsProcessId,
      'rewards',
      { address }
    )

    const amount = BigNumber(result?.reward).toFixed(0)

    if (amount === 'NaN') {
      this.logger.warn(
        `Undefined amount for ${address}: ${JSON.stringify(result)} -> ${amount}`
      )

      return undefined
    }

    this.logger.log(`Got allocation for ${address}: ${amount}`)

    return { address, amount }
  }

  public async claimRewards(
    address: string
  ): Promise<ClaimedRewardsData> {
    try {
      // `Claim-Rewards` is role-gated and takes the beneficiary as a tag — the facilitator
      // claims ON BEHALF of an address, so `ctx.from` is us, not them. Claim-Rewards-Timestamp
      // is not read by the contract; kept for the audit trail on the message.
      const { output } = await this.ao.sendMessage({
        processId: this.relayRewardsProcessId,
        action: 'Claim-Rewards',
        tags: [
          { name: 'address', value: address },
          { name: 'claim-rewards-timestamp', value: Date.now().toString() }
        ]
      })

      // The handler returns the claimed total as a JSON-encoded string.
      const amount = BigNumber(JSON.parse(output ?? 'null')).toFixed(0)

      if (amount === 'NaN') {
        this.logger.warn(`Undefined amount for ${address}: ${output} -> ${amount}`)

        return { address, amount: '0', kind: 'relay' }
      }

      this.logger.log(`Claimed rewards for ${address}: ${amount}`)

      return { address, amount, kind: 'relay' }
    } catch (error) {
      // "No rewards for <addr>" is the contract's own assert and an expected outcome, not a
      // fault — it is what `noReward` has always meant here. Anything else is a real failure.
      if (error instanceof AoContractError) {
        if (error.reason.includes('No rewards for ')) {
          this.logger.warn(`No rewards for ${address}: ${error.reason}`)

          return { address, amount: '0', kind: 'relay', noReward: true }
        }

        this.logger.error(`Claim-Rewards rejected for ${address}: ${error.reason}`)
      } else {
        this.logger.error(`Exception claiming rewards for ${address}`, error.stack)
      }

      return { address, amount: '0', kind: 'relay' }
    }
  }
}
