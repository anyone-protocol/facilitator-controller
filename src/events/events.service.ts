import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { InjectQueue, InjectFlowProducer } from '@nestjs/bullmq'
import { Queue, FlowProducer } from 'bullmq'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import { ethers, AddressLike } from 'ethers'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import {
  RecoverUpdateAllocationData
} from './dto/recover-update-allocation-data'
import { RewardAllocationData } from './dto/reward-allocation-data'
import { ClusterService } from '../cluster/cluster.service'
import { facilitatorABI } from './abi/facilitator'
import { RequestingUpdateEvent } from './schemas/requesting-update-event'

@Injectable()
export class EventsService implements OnApplicationBootstrap {
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

  private jsonRpc: string | undefined
  private infuraNetwork: string | undefined
  private infuraWsUrl: string | undefined

  private facilitatorAddress: string | undefined
  private facilityOperatorKey: string | undefined
  private facilitatorOperator: ethers.Wallet
  private facilitatorContract: ethers.Contract
  private facilitySignerContract: any

  private provider: ethers.WebSocketProvider

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_OPERATOR_KEY: string
      FACILITY_CONTRACT_DEPLOYED_BLOCK: string
      JSON_RPC: string
      IS_LIVE: string
      INFURA_NETWORK: string
      INFURA_WS_URL: string
    }>,
    private readonly cluster: ClusterService,
    @InjectQueue('facilitator-updates-queue')
    public facilitatorUpdatesQueue: Queue,
    @InjectFlowProducer('facilitator-updates-flow')
    public facilitatorUpdatesFlow: FlowProducer
  ) {
    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    this.jsonRpc = this.config.get<string>('JSON_RPC', { infer: true })
    this.infuraNetwork = this.config.get<string>('INFURA_NETWORK', {
      infer: true
    })
    this.infuraWsUrl = this.config.get<string>('INFURA_WS_URL', { infer: true })

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

    this.provider = new ethers.WebSocketProvider(
      this.infuraWsUrl!,
      this.infuraNetwork
    )

    this.logger.log(
      `Initializing events service (IS_LIVE: ${this.isLive}, `
        + `FACILITATOR: ${this.facilitatorAddress})`
    )
  }

  async onApplicationBootstrap(): Promise<void> {
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
          'Missing FACILITY_CONTRACT_ADDRESS, '
            + 'not subscribing to Facilitator EVM events'
        )
      }
    } else {
      this.logger.debug('Not the one, so skipping event subscriptions')
    }
  }

  public async recoverUpdateAllocation(rewardData: RewardAllocationData) {
    const recoverData: RecoverUpdateAllocationData = {
      ...rewardData,
      retries: EventsService.maxUpdateAllocationRetries
    }
    this.logger.log(
      `Attempting to recover updateAllocation job with ${recoverData.retries} `
        + `retries for ${recoverData.address}`
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
      `Retry updateAllocation job with ${recoverData.retries} retries for `
        + `${recoverData.address}`
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
      `Failed recovering the update of allocation for ${recoverData.address} `
        + `with amount ${recoverData.amount}`
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
                `UpdateAllocation needs manual intervention: `
                  + `${updateError.reason}`
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
        } to ${BigNumber(data.amount).toFixed(0).toString()} relay(s) `
      )

      return true
    }
  }

  public async enqueueUpdateAllocation(account: string) {
    await this.facilitatorUpdatesFlow.add({
      name: 'update-allocation',
      queueName: 'facilitator-updates-queue',
      opts: EventsService.jobOpts,
      children: [
        {
          name: 'get-current-rewards',
          queueName: 'facilitator-updates-queue',
          opts: EventsService.jobOpts,
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
        this.logger.log(
          `Starting rewards update for ${accountString}`
        )
        await this.enqueueUpdateAllocation(accountString)
      } else {
        this.logger.error(
          'Trying to request facility update but missing '
            + 'address in data'
        )
      }
    } else {
      this.logger.debug(
        'Not the one, skipping starting rewards update... '
          + 'should be started somewhere else'
      )
    }
  }

  public async subscribeToFacilitator() {
    if (this.jsonRpc == undefined) {
      this.logger.error('Missing JSON_RPC. Skipping facilitator subscription')
    } else {
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
            'Missing FACILITY_CONTRACT_ADDRESS. '
              + 'Skipping facilitator subscription'
          )
        } else {
          this.logger.log(
            `Subscribing to the Facilitator contract `
              + `${this.facilitatorAddress} with `
              + `${this.facilitatorOperator.address}...`
          )

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
}
