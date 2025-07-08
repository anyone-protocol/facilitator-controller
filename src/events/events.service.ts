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
import { ethers, AddressLike, BigNumberish } from 'ethers'

import { RecoverUpdateAllocationData } from './dto/recover-update-allocation-data'
import { RewardAllocationData } from './dto/reward-allocation-data'
import { facilitatorABI } from './abi/facilitator'
import { EvmProviderService } from '../evm-provider/evm-provider.service'
import { HODLER_EVENTS, hodlerABI } from './abi/hodler'
import { ClaimedRewardsData } from './dto/claimed-rewards-data'
import { ClaimedConfigData } from './dto/claimed-config-data'
import { RecoverRewardsData } from './dto/recover-rewards-data'

@Injectable()
@QueueEventsListener('facilitator-updates-queue')
@QueueEventsListener('hodler-updates-queue')
export class EventsService
  extends QueueEventsHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(EventsService.name)

  private isLive?: string
  private doClean?: string

  private useHodler?: string
  private useFacility?: string

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

  private hodlerAddress: string | undefined
  private hodlerContract: ethers.Contract
  private hodlerOperatorKey: string | undefined
  private hodlerOperator: ethers.Wallet
  private hodlerSignerContract: any

  private rewardsPoolKey: string | undefined
  private rewardsPool: ethers.Wallet

  private tokenContract: ethers.Contract
  private tokenAddress: string | undefined

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_OPERATOR_KEY: string
      IS_LIVE: string
      DO_CLEAN: string
      USE_HODLER: string
      USE_FACILITY: string
      HODLER_CONTRACT_ADDRESS: string
      HODLER_OPERATOR_KEY: string
      REWARDS_POOL_KEY: string
      TOKEN_CONTRACT_ADDRESS: string
    }>,
    private readonly evmProviderService: EvmProviderService,
    @InjectQueue('facilitator-updates-queue')
    public facilitatorUpdatesQueue: Queue,
    @InjectFlowProducer('facilitator-updates-flow')
    public facilitatorUpdatesFlow: FlowProducer,
    @InjectQueue('hodler-updates-queue')
    public hodlerUpdatesQueue: Queue,
    @InjectFlowProducer('hodler-updates-flow')
    public hodlerUpdatesFlow: FlowProducer
  ) {
    super()

    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    this.useHodler = this.config.get<string>('USE_HODLER', { infer: true })
    this.useFacility = this.config.get<string>('USE_FACILITY', { infer: true })

    if (this.useFacility == 'true') {
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
    }

    if (this.useHodler == 'true') {
      this.hodlerAddress = this.config.get<string>(
        'HODLER_CONTRACT_ADDRESS',
        { infer: true }
      )

      if (!this.hodlerAddress) {
        throw new Error('HODLER_CONTRACT_ADDRESS is not set!')
      }

      this.hodlerOperatorKey = this.config.get<string>(
        'HODLER_OPERATOR_KEY',
        { infer: true }
      )

      if (!this.hodlerOperatorKey) {
        throw new Error('HODLER_OPERATOR_KEY is not set!')
      }

      this.rewardsPoolKey = this.config.get<string>(
        'REWARDS_POOL_KEY',
        { infer: true }
      )
      if (!this.rewardsPoolKey) {
        throw new Error('REWARDS_POOL_KEY is not set!')
      }

      this.tokenAddress = this.config.get<string>(
        'TOKEN_CONTRACT_ADDRESS',
        { infer: true }
      )
      if (!this.tokenAddress) {
        throw new Error('TOKEN_CONTRACT_ADDRESS is not set!')
      }
    }

    this.logger.log(
      `Initializing events service (IS_LIVE: ${this.isLive}, ` +
        `FACILITATOR: ${this.facilitatorAddress} HODLER: ${this.hodlerAddress})`
    )
  }

  async onApplicationBootstrap(): Promise<void> {
    this.provider = await this.evmProviderService.getCurrentWebSocketProvider(
      (async (provider) => {
        this.provider = provider
        if (this.useHodler == 'true') {
          this.tokenContract = new ethers.Contract(
            this.tokenAddress,
            ['function approve(address spender, uint256 amount)'],
            this.provider
          )

          await this.subscribeToHodler()
        }

        if (this.useFacility == 'true') {
          await this.subscribeToFacilitator()
        }
        
      }).bind(this)
    )

    if (this.doClean != 'true') {
      this.logger.log('Skipped cleaning up old jobs')
    } else {
      this.logger.log('Cleaning up old (24hrs+) jobs')
      await this.facilitatorUpdatesQueue.clean(24 * 60 * 60 * 1000, -1)
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

    if (this.hodlerAddress != undefined) {
      this.tokenContract = new ethers.Contract(
        this.tokenAddress,
        ['function approve(address spender, uint256 amount)'],
        this.provider
      )

      this.subscribeToHodler().catch((error) =>
        this.logger.error('Failed subscribing to hodler events:', error)
      )
    } else {
      this.logger.warn(
        'Missing HODLER_CONTRACT_ADDRESS, ' +
          'not subscribing to Hodler EVM events'
      )
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
  
  public async trackFailedReward(
    recoverData: RecoverRewardsData
  ) {
    this.logger.error(
      `Failed recovering the update of allocation for ${recoverData.rewards[0].address} ` +
        `with rewards ${JSON.stringify(recoverData.rewards)}`
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
          this.logger.log(
            `Updating allocation for [${data.address}] for amount [${data.amount}]`
          )
          const receipt = await this.facilitySignerContract.updateAllocation(
            data.address,
            BigNumber(data.amount).toFixed(0),
            true
          )
          const tx = await receipt.wait()
          this.logger.log(
            `UpdateAllocation for [${data.address}] tx: [${tx.hash}]`
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

      this.logger.warn(
        `[alarm=update-allocation-failed] UpdateAllocation failed for: [${JSON.stringify(data)}]`
      )

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

  public async enqueueUpdateAllocation(
    account: string,
    transactionHash?: string
  ) {
    // NB: To ensure the queue only contains unique update allocation attempts
    //     the jobId is prefixed with the requesting address
    const now = Date.now().toString()
    const prefix = `${account}-${transactionHash || now}`

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

  private async onRequestingUpdateEvent(
    account: AddressLike,
    { log }: { log: ethers.EventLog }
  ) {
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
      await this.enqueueUpdateAllocation(
        accountString,
        log.transactionHash
      )
    } else {
      this.logger.error(
        'Trying to request facility update but missing ' + 'address in data'
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

  public async subscribeToHodler() {
    if (this.hodlerOperatorKey == undefined) {
      this.logger.error(
        'Missing HODLER_OPERATOR_KEY. Skipping hodler subscription'
      )
    } else {
      this.hodlerOperator = new ethers.Wallet(
        this.hodlerOperatorKey,
        this.provider
      )
      this.rewardsPool = new ethers.Wallet(
        this.rewardsPoolKey,
        this.provider
      )

      if (this.hodlerAddress == undefined) {
        this.logger.error(
          'Missing HODLER_CONTRACT_ADDRESS. ' +
            'Skipping Hodler subscription'
        )
      } else {
        this.logger.log(
          `Subscribing to the Hodler contract ` +
            `${this.hodlerAddress} with ` +
            `${this.hodlerOperator.address}...`
        )

        if (this.hodlerContract) {
          this.hodlerContract.off(HODLER_EVENTS.UpdateRewards)
        }

        this.hodlerContract = new ethers.Contract(
          this.hodlerAddress,
          hodlerABI,
          this.provider
        )
        this.hodlerSignerContract = this.hodlerContract.connect(
          this.hodlerOperator
        )
        this.hodlerContract.on(
          HODLER_EVENTS.UpdateRewards,
          this.onHodlerUpdateRewards.bind(this)
        )
      }
    }
  }

  private async onHodlerUpdateRewards(
    account: AddressLike,
    gasEstimate: BigNumberish,
    redeem: boolean,
    { log }: { log: ethers.EventLog }
  ) {
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
      await this.enqueueUpdateRewards(
        accountString,
        gasEstimate.toString(),
        redeem,
        log.transactionHash
      )
    } else {
      this.logger.error(
        'Trying to request facility update but missing ' + 'address in data'
      )
    }
  }

  public async enqueueUpdateRewards(
    account: string,
    gasEstimate: string,
    requestedRedeem: boolean,
    transactionHash?: string
  ) {
    // NB: To ensure the queue only contains unique update allocation attempts
    //     the jobId is prefixed with the requesting address
    const now = Date.now().toString()
    const prefix = `${account}-${transactionHash || now}`

    await this.hodlerUpdatesFlow.add({
      name: 'update-rewards',
      queueName: 'hodler-updates-queue',
      data: {
        gas: gasEstimate,
        redeem: requestedRedeem
      },
      opts: {
        ...EventsService.jobOpts,
        jobId: `${prefix}-update-rewards`
      },
      children: [
        {
          name: 'get-relay-rewards',
          queueName: 'hodler-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-relay-rewards`
          },
          data: account
        },
        {
          name: 'get-staking-rewards',
          queueName: 'hodler-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-staking-rewards`
          },
          data: account
        },
      ]
    })
  }
  
  private isRewardPassable(reason: string): boolean {
    switch (reason) {
      case 'Insufficient gas budget for hodler account':
        return true
      case 'No rewards to claim':
        return true
      default:
        return false
    }
  }

  private isRewardWarning(reason: string): boolean {
    switch (reason) {
      case 'Transfer of reward tokens failed':
        return true
      case 'Withdrawal of reward tokens failed':
        return true
      default:
        return false
    }
  }

  public async updateClaimedRewards(data: ClaimedRewardsData[], gasEstimate: string, requestedRedeem: boolean): Promise<boolean> {
    if (data.length === 0) {
      this.logger.warn('No rewards to update')
      return true
    }
    const hodlerAddress = data[0].address

    var stakingReward = BigNumber(0)
    var relayReward = BigNumber(0)
    for (const reward of data) {
      if (reward.address != hodlerAddress) {
        this.logger.warn(
          `Hodler address mismatch: ${hodlerAddress} != ${reward.address} in ${JSON.stringify(data)}`
        )
      } else {
        switch (reward.kind) {
          case 'relay': relayReward = relayReward.plus(reward.amount); break
          case 'staking': stakingReward = stakingReward.plus(reward.amount); break
        }
      }
    }

    if (this.isLive === 'true') {
      if (this.hodlerSignerContract == undefined) {
        this.logger.error(
          'Hodler signer contract not initialized, skipping claimed rewards update'
        )
      } else {
        try {
          const totalReward = stakingReward.plus(relayReward)
          this.logger.log(`Preapproving hodler for total ${totalReward.toFixed(0)} = ` +
            `staking [${stakingReward.toFixed(0)}] + relay [${relayReward.toFixed(0)}]...`
          )

          // @ts-ignore
          const approveReceipt = await this.tokenContract.connect(this.rewardsPool).approve(
            this.hodlerOperator.address,
            totalReward.toFixed(0)
          )
          const approveTx = await approveReceipt.wait()
          this.logger.log(
            `Preapproved controller for total ${totalReward.toFixed(0)} tx: [${approveTx.hash}]`
          )

          this.logger.log(
            `Rewarding [${hodlerAddress}] for ` +
              `staking [${stakingReward.toFixed(0)}] relay [${relayReward.toFixed(0)}]...`
          )
          const receipt = await this.hodlerSignerContract.reward(
            hodlerAddress,
            relayReward.toFixed(0),
            stakingReward.toFixed(0),
            BigNumber(gasEstimate).toFixed(0),
            requestedRedeem
          )
          const tx = await receipt.wait()
          this.logger.log(
            `Rewarded [${hodlerAddress}] tx: [${tx.hash}]`
          )

          return true
        } catch (updateError) {
          if (updateError.reason) {
            const isWarning = this.isRewardWarning(updateError.reason)
            if (isWarning) {
              this.logger.error(
                `Reward needs manual intervention: ` +
                  `${updateError.reason}`
              )
              return false
            }

            const isPassable = this.isRewardPassable(updateError.reason)
            if (isPassable) {
              this.logger.warn(
                `Reward tx rejected: ${updateError.reason}`
              )
            } else {
              this.logger.error(
                `Reward transaction failed: ${updateError.reason}`
              )
            }
            return isPassable
          } else {
            this.logger.error(
              `Error while calling reward on hodler for ${hodlerAddress}:`,
              updateError.stack
            )
          }
        }
      }

      this.logger.warn(
        `[alarm=update-allocation-failed] Reward failed for: [${JSON.stringify(data)}]`
      )

      return false
    } else {
      this.logger.warn(
        `NOT LIVE: Not storing update of claimed rewards of ${
          hodlerAddress
        } of ${stakingReward.toFixed(0)} and ${relayReward.toFixed(0)} atomic tokens`
      )

      return true
    }
  }

  public async recoverReward(cfg: ClaimedConfigData, rewards: ClaimedRewardsData[]) {

    const recoverData: RecoverRewardsData = {
      retries: EventsService.maxUpdateAllocationRetries,
      gas: cfg.gas,
      redeem: cfg.redeem,
      rewards: rewards
    }
    this.logger.log(
      `Attempting to recover reward job with ${recoverData.retries} ` +
        `retries for ${rewards[0].address}`
    )
    this.hodlerUpdatesQueue.add(
      'recover-update-rewards',
      recoverData,
      EventsService.jobOpts
    )
  }

  public async retryReward(recoverData: RecoverRewardsData) {
    const retryData: RecoverRewardsData = {
      ...recoverData,
      retries: recoverData.retries - 1
    }
    this.logger.log(
      `Retry recover-reward job with ${recoverData.retries} retries for ` +
        `${recoverData.rewards[0].address}`
    )
    this.hodlerUpdatesQueue.add(
      'recover-update-rewards',
      retryData,
      EventsService.jobOpts
    )
  }

}
