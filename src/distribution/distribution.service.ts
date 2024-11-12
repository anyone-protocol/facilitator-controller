import { Injectable, Logger } from '@nestjs/common'
import { firstValueFrom, catchError } from 'rxjs'
import { ConfigService } from '@nestjs/config'
import { AxiosError } from 'axios'
import { HttpService } from '@nestjs/axios'

import { DistributionState } from './interfaces/distribution'
import { RewardAllocationData } from './dto/reward-allocation-data'
import { DreDistributionResponse } from './interfaces/dre-relay-registry-response'

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name)

  private isLive?: string

  public static readonly maxDistributionRetries = 6

  private distributionDreUri: string
  private dreState: DistributionState | undefined
  private dreStateStamp: number | undefined
  private dreRefreshDelay: number = 2_500

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      DISTRIBUTION_CONTRACT_TXID: string
      DRE_HOSTNAME: string
      IRYS_NODE: string
      IRYS_NETWORK: string
    }>,
    private readonly httpService: HttpService
  ) {
    this.isLive = config.get<string>('IS_LIVE', { infer: true })

    this.logger.log(
      `Initializing distribution service (IS_LIVE: ${this.isLive})`
    )

    const distributionContractTxId = this.config.get<string>(
      'DISTRIBUTION_CONTRACT_TXID',
      { infer: true }
    )

    if (!distributionContractTxId) {
      throw new Error('Missing DISTRIBUTION_CONTRACT_TXID')
    }

    const dreHostname = this.config.get<string>('DRE_HOSTNAME', { infer: true })

    if (!dreHostname) {
      throw new Error('Missing DRE_HOSTNAME')
    }

    this.distributionDreUri = `${dreHostname}?id=${distributionContractTxId}`

    this.logger.log(
      `Initialized distribution contract: ${this.distributionDreUri}`
    )
  }

  public async getAllocation(
    address: string
  ): Promise<RewardAllocationData | undefined> {
    try {
      await this.refreshDreState()

      if (this.dreState) {
        return {
          address,
          amount: this.dreState?.claimable[address] || '0'
        }
      } else {
        this.logger.error(
          `Failed to fetch distribution state: DRE state missing`
        )

        return undefined
      }
    } catch (error) {
      this.logger.error(`Exception in getAllocation:`, error.stack)

      return undefined
    }
  }

  public async refreshDreState(forced: boolean = false) {
    const now = Date.now()
    if (
      forced ||
      this.dreStateStamp == undefined ||
      now > this.dreStateStamp + this.dreRefreshDelay
    ) {
      try {
        const { status, data } = await firstValueFrom(
          this.httpService
            .get<DreDistributionResponse>(this.distributionDreUri)
            .pipe(
              catchError((error: AxiosError) => {
                this.logger.error(
                  `Fetching dre state of distribution from ` +
                    `${this.distributionDreUri} failed with ` +
                    `${error.response?.status}, ${error}`
                )
                throw 'Failed to fetch distribution contract cache from dre'
              })
            )
        )

        if (status === 200) {
          this.dreState = data.state
          this.dreStateStamp = Date.now()
          this.logger.debug(
            `Refreshed distribution dre state at ${this.dreStateStamp}`
          )
        }
      } catch (e) {
        this.logger.error(
          'Exception when fetching relay registry dre cache',
          e.stack
        )
      }
    } else
      this.logger.debug(
        `DRE cache warm ${now - this.dreStateStamp}, skipping refresh`
      )
  }
}
