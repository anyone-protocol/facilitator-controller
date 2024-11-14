import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import {
  InjectQueue,
  InjectFlowProducer,
  QueueEventsHost,
  QueueEventsListener,
  OnQueueEvent
} from '@nestjs/bullmq'
import { Queue, FlowProducer, Job } from 'bullmq'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import { ethers, AddressLike, ContractEventPayload } from 'ethers'

import { RecoverUpdateAllocationData } from './dto/recover-update-allocation-data'
import { RewardAllocationData } from './dto/reward-allocation-data'
import { ClusterService } from '../cluster/cluster.service'
import { facilitatorABI } from './abi/facilitator'
import { EvmProviderService } from '../evm-provider/evm-provider.service'

@Injectable()
@QueueEventsListener('facilitator-updates-queue')
export class EventsService
  extends QueueEventsHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(EventsService.name)

  private isLive?: string
  private doClean?: string

  private static readonly maxUpdateAllocationRetries = 6

  private static readonly removeOnComplete = true
  private static readonly removeOnFail = 8

  public static jobOpts = {
    removeOnComplete: EventsService.removeOnComplete,
    removeOnFail: EventsService.removeOnFail
  }

  private provider: ethers.WebSocketProvider
  private facilitatorAddress: string | undefined
  private facilityOperatorKey: string | undefined
  private facilitatorOperator: ethers.Wallet
  private facilitatorContract: ethers.Contract
  private facilitySignerContract: any

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_OPERATOR_KEY: string
      IS_LIVE: string
      DO_CLEAN: string
    }>,
    private readonly evmProviderService: EvmProviderService,
    private readonly cluster: ClusterService,
    @InjectQueue('facilitator-updates-queue')
    public facilitatorUpdatesQueue: Queue,
    @InjectFlowProducer('facilitator-updates-flow')
    public facilitatorUpdatesFlow: FlowProducer
  ) {
    super()

    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })

    this.facilitatorAddress = this.config.get<string>(
      'FACILITY_CONTRACT_ADDRESS',
      { infer: true }
    )

    if (!this.facilitatorAddress) {
      throw new Error('FACILITY_CONTRACT_ADDRESS is not set!')
    }

    this.facilityOperatorKey = this.config.get<string>(
      'FACILITY_OPERATOR_KEY',
      { infer: true }
    )

    if (!this.facilityOperatorKey) {
      throw new Error('FACILITY_OPERATOR_KEY is not set!')
    }

    this.logger.log(
      `Initializing events service (IS_LIVE: ${this.isLive}, ` +
        `FACILITATOR: ${this.facilitatorAddress})`
    )
  }

  async onApplicationBootstrap(): Promise<void> {
    this.provider = await this.evmProviderService.getCurrentWebSocketProvider(
      async (provider) => {
        this.provider = provider
        await this.subscribeToFacilitator()
      }
    )

    if (this.cluster.isTheOne()) {
      if (this.doClean != 'true') {
        this.logger.log('Skipped cleaning up old jobs')
      } else {
        this.logger.log('Cleaning up old (24hrs+) jobs')
        await this.facilitatorUpdatesQueue.clean(24 * 60 * 60 * 1000, -1)
      }

      if (this.isLive != 'true') {
        await this.facilitatorUpdatesQueue.obliterate({ force: true })
      }

      if (this.facilitatorAddress != undefined) {
        this.subscribeToFacilitator().catch((error) =>
          this.logger.error('Failed subscribing to facilitator events:', error)
        )
      } else {
        this.logger.warn(
          'Missing FACILITY_CONTRACT_ADDRESS, ' +
            'not subscribing to Facilitator EVM events'
        )
      }
    } else {
      this.logger.debug('Not the one, so skipping event subscriptions')
    }
  }

  @OnQueueEvent('duplicated')
  onDuplicatedJob({ jobId }: { jobId: string }) {
    this.logger.warn(`Did not queue duplicate job id [${jobId}]`)
  }

  public async recoverUpdateAllocation(rewardData: RewardAllocationData) {
    const recoverData: RecoverUpdateAllocationData = {
      ...rewardData,
      retries: EventsService.maxUpdateAllocationRetries
    }
    this.logger.log(
      `Attempting to recover updateAllocation job with ${recoverData.retries} ` +
        `retries for ${recoverData.address}`
    )
    this.facilitatorUpdatesQueue.add(
      'recover-update-allocation',
      recoverData,
      EventsService.jobOpts
    )
  }

  public async retryUpdateAllocation(recoverData: RecoverUpdateAllocationData) {
    const retryData: RecoverUpdateAllocationData = {
      ...recoverData,
      retries: recoverData.retries - 1
    }
    this.logger.log(
      `Retry updateAllocation job with ${recoverData.retries} retries for ` +
        `${recoverData.address}`
    )
    this.facilitatorUpdatesQueue.add(
      'recover-update-allocation',
      retryData,
      EventsService.jobOpts
    )
  }

  public async trackFailedUpdateAllocation(
    recoverData: RecoverUpdateAllocationData
  ) {
    this.logger.error(
      `Failed recovering the update of allocation for ${recoverData.address} ` +
        `with amount ${recoverData.amount}`
    )
  }

  private checkIfPassableReason(reason: string): boolean {
    switch (reason) {
      case 'Facility: no tokens allocated for sender':
        return true
      case 'Facility: no tokens available to claim':
        return true
      default:
        return false
    }
  }

  private checkForInternalWarnings(reason: string): boolean {
    switch (reason) {
      case 'Facility: not enough tokens to claim':
        return true
      case 'Facility: transfer of claimable tokens failed':
        return true
      default:
        return false
    }
  }

  public async updateAllocation(data: RewardAllocationData): Promise<boolean> {
    if (this.isLive === 'true') {
      if (this.facilitySignerContract == undefined) {
        this.logger.error(
          'Facility signer contract not initialized, skipping allocation update'
        )
      } else {
        try {
          await this.facilitySignerContract.updateAllocation(
            data.address,
            BigNumber(data.amount).toFixed(0),
            true
          )
          return true
        } catch (updateError) {
          if (updateError.reason) {
            const isWarning = this.checkForInternalWarnings(updateError.reason)
            if (isWarning) {
              this.logger.error(
                `UpdateAllocation needs manual intervention: ` +
                  `${updateError.reason}`
              )
              return false
            }

            const isPassable = this.checkIfPassableReason(updateError.reason)
            if (isPassable) {
              this.logger.warn(
                `UpdateAllocation tx rejected: ${updateError.reason}`
              )
            } else {
              this.logger.error(
                `UpdateAllocation transaction failed: ${updateError.reason}`
              )
            }
            return isPassable
          } else {
            this.logger.error(
              `Error while calling updateAllocation for ${data.address}:`,
              updateError.stack
            )
          }
        }
      }
      return false
    } else {
      this.logger.warn(
        `NOT LIVE: Not storing updating allocation of ${
          data.address
        } of ${BigNumber(data.amount).toFixed(0).toString()} atomic tokens`
      )

      return true
    }
  }

  public async enqueueUpdateAllocation(account: string) {
    // NB: To ensure the queue only contains unique update allocation attempts
    //     the jobId is prefixed with the requesting address
    const prefix = `${account}`

    await this.facilitatorUpdatesFlow.add({
      name: 'update-allocation',
      queueName: 'facilitator-updates-queue',
      opts: {
        ...EventsService.jobOpts,
        jobId: `${prefix}-update-allocation`
      },
      children: [
        {
          name: 'get-current-rewards',
          queueName: 'facilitator-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-current-rewards`
          },
          data: account
        }
      ]
    })
  }

  private async onRequestingUpdateEvent(account: AddressLike) {
    if (this.cluster.isTheOne()) {
      let accountString: string
      if (account instanceof Promise) {
        accountString = await account
      } else if (ethers.isAddressable(account)) {
        accountString = await account.getAddress()
      } else {
        accountString = account
      }

      if (accountString != undefined) {
        this.logger.log(`Queueing rewards update for ${accountString}`)
        await this.enqueueUpdateAllocation(accountString)
      } else {
        this.logger.error(
          'Trying to request facility update but missing ' + 'address in data'
        )
      }
    } else {
      this.logger.debug(
        'Not the one, skipping starting rewards update... ' +
          'should be started somewhere else'
      )
    }
  }

  public async subscribeToFacilitator() {
    if (this.facilityOperatorKey == undefined) {
      this.logger.error(
        'Missing FACILITY_OPERATOR_KEY. Skipping facilitator subscription'
      )
    } else {
      this.facilitatorOperator = new ethers.Wallet(
        this.facilityOperatorKey,
        this.provider
      )
      if (this.facilitatorAddress == undefined) {
        this.logger.error(
          'Missing FACILITY_CONTRACT_ADDRESS. ' +
            'Skipping facilitator subscription'
        )
      } else {
        this.logger.log(
          `Subscribing to the Facilitator contract ` +
            `${this.facilitatorAddress} with ` +
            `${this.facilitatorOperator.address}...`
        )

        if (this.facilitatorContract) {
          this.facilitatorContract.off('RequestingUpdate')
        }

        this.facilitatorContract = new ethers.Contract(
          this.facilitatorAddress,
          facilitatorABI,
          this.provider
        )
        this.facilitySignerContract = this.facilitatorContract.connect(
          this.facilitatorOperator
        )
        this.facilitatorContract.on(
          'RequestingUpdate',
          this.onRequestingUpdateEvent.bind(this)
        )
      }
    }
  }
}
