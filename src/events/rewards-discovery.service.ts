import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { FlowProducer, Queue } from 'bullmq'
import { ethers } from 'ethers'
import { sortBy, uniqBy } from 'lodash'
import { Model, Types as MongooseTypes } from 'mongoose'
import BigNumber from 'bignumber.js'

import { EventsService } from './events.service'
import { EvmProviderService } from '../evm-provider/evm-provider.service'
import {
  RewardsDiscoveryServiceState
} from './schemas/rewards-discovery-service-state'
import { RewardedEvent } from './schemas/rewarded-event'
import { UpdateRewardsEvent } from './schemas/update-rewards-event'
import { HODLER_EVENTS, hodlerABI } from './abi/hodler'
import {
  DiscoverHodlerEventsQueue
} from './processors/discover-hodler-events-queue'
import { ClusterService } from '../cluster/cluster.service'

@Injectable()
export class RewardsDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RewardsDiscoveryService.name)

  private static readonly removeOnComplete = true
  private static readonly removeOnFail = 8
  public static readonly DEFAULT_DELAY = 1000 * 60 * 5 // 5 minutes
  public static readonly MAX_BLOCK_QUERY_RANGE = 5000

  public static jobOpts = {
    removeOnComplete: RewardsDiscoveryService.removeOnComplete,
    removeOnFail: RewardsDiscoveryService.removeOnFail
  }

  private readonly NOMAD_ALLOC_INDEX: string
  private isLive?: string
  private doClean?: string
  private doDbNuke?: string
  private useHodler?: string
  private hodlerAddress?: string

  private provider: ethers.WebSocketProvider
  private hodlerContract: ethers.Contract
  private hodlerContractDeployedBlock: ethers.BlockTag

  private state: {
    _id?: MongooseTypes.ObjectId
    lastSafeCompleteBlock?: number
  } = {}

  constructor(
    private readonly config: ConfigService<{
      HODLER_CONTRACT_ADDRESS: string
      HODLER_CONTRACT_DEPLOYED_BLOCK: string
      IS_LIVE: string
      DO_CLEAN: string
      DO_DB_NUKE: string
      USE_HODLER: string
      NOMAD_ALLOC_INDEX: string
    }>,
    private readonly evmProviderService: EvmProviderService,
    private readonly eventsService: EventsService,
    @InjectQueue('discover-hodler-events-queue')
    public discoverHodlerEventsQueue: Queue,
    @InjectFlowProducer('discover-hodler-events-flow')
    public discoverHodlerEventsFlow: FlowProducer,
    @InjectModel(RewardsDiscoveryServiceState.name)
    private readonly rewardsDiscoveryServiceStateModel:
      Model<RewardsDiscoveryServiceState>,
    @InjectModel(RewardedEvent.name)
    private readonly rewardedEventModel: Model<RewardedEvent>,
    @InjectModel(UpdateRewardsEvent.name)
    private readonly updateRewardsEventModel: Model<UpdateRewardsEvent>,
    private readonly clusterService: ClusterService
  ) {
    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    this.doDbNuke = this.config.get<string>('DO_DB_NUKE', { infer: true })
    this.useHodler = this.config.get<string>('USE_HODLER', { infer: true })
    this.NOMAD_ALLOC_INDEX = this.config.get<string>(
      'NOMAD_ALLOC_INDEX',
      { infer: true }
    )

    if (this.useHodler == 'true') {
      this.hodlerAddress = this.config.get<string>(
        'HODLER_CONTRACT_ADDRESS',
        { infer: true }
      )
      if (!this.hodlerAddress) {
        throw new Error('HODLER_CONTRACT_ADDRESS is not set!')
      }

      const hodlerContractDeployedBlock = Number.parseInt(
        this.config.get<string>('HODLER_CONTRACT_DEPLOYED_BLOCK', {
          infer: true
        })
      )
      this.hodlerContractDeployedBlock = hodlerContractDeployedBlock
      if (Number.isNaN(hodlerContractDeployedBlock)) {
        throw new Error('HODLER_CONTRACT_DEPLOYED_BLOCK is NaN!')
      }

      this.logger.log(
        `Initializing events service (IS_LIVE: ${this.isLive}, ` +
          `HODLER: ${this.hodlerAddress})`
      )
    } else {
      this.logger.log(
        'Skipping initialization of rewards discovery service (USE_HODLER: false)'
      )
    }
  }

  async onApplicationBootstrap() {
    this.logger.log(
      `Bootstrapping EventsDiscoveryService with ` +
        `NOMAD_ALLOC_INDEX [${this.NOMAD_ALLOC_INDEX}]`
    )

    if (this.useHodler == 'true') {
      this.provider = await this.evmProviderService.getCurrentWebSocketProvider(
        (provider => {
          this.provider = provider
          this.hodlerContract = new ethers.Contract(
            this.hodlerAddress,
            hodlerABI,
            this.provider
          )
        }).bind(this)
      )
      this.hodlerContract = new ethers.Contract(
        this.hodlerAddress,
        hodlerABI,
        this.provider
      )
    } else {
      this.logger.log(
        'Skipping bootstrap of rewards discovery service (USE_HODLER: false)'
      )
    }

    if (this.clusterService.isTheOne()) {
      this.logger.log(
        `I am the leader, checking queue cleanup & immediate queue start`
      )
      if (this.doClean === 'true') {
        this.logger.log(
          'Cleaning up discover hodler events queue because DO_CLEAN is true'
        )
        await this.discoverHodlerEventsQueue.obliterate({ force: true })
      }

      if (this.doDbNuke === 'true') {
        this.logger.log(
          'Nuking DB of update rewards events because DO_DB_NUKE is true'
        )
        await this.updateRewardsEventModel.deleteMany({})
        this.logger.log(
          'Nuked UpdateRewardsEvent collection, not nuking rewarded events'
        )
      }

      const rewardsDiscoveryServiceState =
        await this.rewardsDiscoveryServiceStateModel.findOne()
      if (rewardsDiscoveryServiceState) {
        this.state = rewardsDiscoveryServiceState.toObject()
      } else {
        await this.rewardsDiscoveryServiceStateModel.create(this.state)
      }

      if (
        BigNumber(this.hodlerContractDeployedBlock)
          .gt(this.getLastSafeCompleteBlockNumber())
      ) {
        this.logger.log(
          `Overriding lastSafeCompleteBlockNumber from env deployed block ` +
            `[${this.hodlerContractDeployedBlock}]`
        )
        await this.setLastSafeCompleteBlockNumber(
          BigNumber(this.hodlerContractDeployedBlock).toNumber()
        )
      }

      if (this.useHodler == 'true') {
        this.logger.log('Queueing immediate discovery of hodler events')
        await this.enqueueDiscoverHodlerEventsFlow({ delayJob: 0 })
      } else {
        this.logger.log(
          'Skipping immediate discovery of hodler events (USE_HODLER: false)'
        )
      }
    } else {
      this.logger.log(
        `Not the leader, skipping queue cleanup check, ` +
          `skipping db cleanup check, &` +
          `skipping queueing immediate tasks`
      )
    }
  }

  public async discoverUpdateRewardsEvents(
    from?: ethers.BlockTag,
    to: ethers.BlockTag = 'latest'
  ) {
    const fromBlock = from || this.hodlerContractDeployedBlock
    let toBlock = to === 'latest' ? await this.provider.getBlockNumber() : to
    const blockQueryRange = BigNumber(toBlock).minus(fromBlock)
    if (blockQueryRange.gt(RewardsDiscoveryService.MAX_BLOCK_QUERY_RANGE)) {
      this.logger.warn(
        `Querying too many blocks (${blockQueryRange.toString()})` +
          ` - limiting to ${RewardsDiscoveryService.MAX_BLOCK_QUERY_RANGE}`
      )
      toBlock = BigNumber(fromBlock)
        .plus(RewardsDiscoveryService.MAX_BLOCK_QUERY_RANGE)
        .toNumber()
    }

    this.logger.log(
      `Discovering ${HODLER_EVENTS.UpdateRewards} events` +
        ` from block [${fromBlock.toString()}] to block [${toBlock.toString()}]`
    )

    const filter =
      this.hodlerContract.filters[HODLER_EVENTS.UpdateRewards]()
    const events = (await this.hodlerContract.queryFilter(
      filter,
      fromBlock,
      toBlock
    )) as ethers.EventLog[]

    this.logger.log(
      `Found ${events.length} ${HODLER_EVENTS.UpdateRewards} events` +
        ` between blocks [${fromBlock.toString()}] and [${toBlock.toString()}]`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.updateRewardsEventModel.findOne({
        eventName: HODLER_EVENTS.UpdateRewards,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        try {
          await this.updateRewardsEventModel.create({
            blockNumber: evt.blockNumber,
            blockHash: evt.blockHash,
            transactionHash: evt.transactionHash,
            requestingAddress: evt.args[0],
            gasEstimate: BigNumber(evt.args[1]).toFixed(0),
            redeem: evt.args[2],
            fulfilled: false
          })
          newEvents++
        } catch (err) {
          this.logger.warn(
            `UpdateRewardsEvent creation race condition gracefully avoided`
          )
          knownEvents++
        }
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored [${newEvents}] newly discovered` +
        ` ${HODLER_EVENTS.UpdateRewards} events` +
        ` and skipped storing [${knownEvents}] previously known` +
        ` out of [${events.length}] total`
    )

    return { from: fromBlock, to: toBlock }
  }

  public async discoverRewardedEvents(
    from: ethers.BlockTag,
    to: ethers.BlockTag
  ) {
    if (this.useHodler != 'true') {
      this.logger.log(
        'Skipping discovery of Rewarded events (USE_HODLER: false)'
      )
      return
    }
    const fromBlock = from
    const toBlock = to
    this.logger.log(
      `Discovering ${HODLER_EVENTS.Rewarded} events` +
        ` from block [${fromBlock.toString()}] to block [${toBlock.toString()}]`
    )

    const filter =
      this.hodlerContract.filters[HODLER_EVENTS.Rewarded]()
    const events = (await this.hodlerContract.queryFilter(
      filter,
      fromBlock,
      toBlock
    )) as ethers.EventLog[]

    this.logger.log(
      `Found ${events.length} ${HODLER_EVENTS.Rewarded} events` +
        ` between blocks [${fromBlock.toString()}] and [${toBlock.toString()}]`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.rewardedEventModel.findOne({
        eventName: HODLER_EVENTS.Rewarded,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        try {
          await this.rewardedEventModel.create({
            blockNumber: evt.blockNumber,
            blockHash: evt.blockHash,
            transactionHash: evt.transactionHash,
            requestingAddress: evt.args[0]
          })
          newEvents++
        } catch (err) {
          this.logger.warn(
            `RewardedEvent creation race condition gracefully avoided`
          )
          knownEvents++
        }
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored [${newEvents}] newly discovered` +
        ` ${HODLER_EVENTS.Rewarded} events` +
        ` and skipped storing [${knownEvents}] previously known` +
        ` out of [${events.length}] total`
    )
  }

  public async matchDiscoveredHodlerEvents(to: ethers.BlockTag) {
    if (this.useHodler != 'true') {
      this.logger.log(
        'Matching UpdateRewards to Rewarded events (USE_HODLER: false)'
      )
      return
    }
    this.logger.log('Matching UpdateRewards to Rewarded events')

    const unfulfilledUpdateRewardsEvents =
      await this.updateRewardsEventModel.find({ fulfilled: false })

    if (unfulfilledUpdateRewardsEvents.length < 1) {
      this.logger.log(`No unfulfilled UpdateRewards events to match`)

      return
    }

    this.logger.log(
      `Found [${unfulfilledUpdateRewardsEvents.length}]` +
        ` unfulfilled UpdateRewards events`
    )

    let matchedCount = 0
    const unmatchedEvents: typeof unfulfilledUpdateRewardsEvents = []
    for (const unfulfilledEvent of unfulfilledUpdateRewardsEvents) {
      const subsequentRewardedEventForAddress =
        await this.rewardedEventModel.findOne({
          blockNumber: { $gt: unfulfilledEvent.blockNumber },
          requestingAddress: unfulfilledEvent.requestingAddress
        })

      if (subsequentRewardedEventForAddress) {
        unfulfilledEvent.rewardedEventTransactionHash =
          subsequentRewardedEventForAddress.transactionHash
        unfulfilledEvent.fulfilled = true
        await unfulfilledEvent.save()
        matchedCount++
      } else {
        unmatchedEvents.push(unfulfilledEvent)
      }
    }

    const unmatchedToQueue = sortBy(
      uniqBy(
        unmatchedEvents.map(
          ({ requestingAddress, transactionHash, blockNumber, gasEstimate, redeem }) => ({
            requestingAddress,
            transactionHash,
            blockNumber,
            gasEstimate,
            redeem
          })
        ),
        'requestingAddress'
      ),
      'blockNumber'
    )

    for (const { requestingAddress, transactionHash, gasEstimate, redeem } of unmatchedToQueue) {
      await this.eventsService.enqueueUpdateRewards(requestingAddress, gasEstimate, redeem, transactionHash)
    }

    const duplicateAddresses = unmatchedEvents.length - unmatchedToQueue.length
    const lastSafeCompleteBlock = BigNumber(to).toNumber()

    this.logger.log(
      `Matched [${matchedCount}] UpdateRewards to Rewarded events` +
        ` and enqueued [${unmatchedToQueue.length}]` +
        ` UpdateRewards flows. ([${duplicateAddresses}] duplicate addresses)`
    )

    await this.setLastSafeCompleteBlockNumber(lastSafeCompleteBlock)
  }

  public async enqueueDiscoverHodlerEventsFlow(
    opts: {
      delayJob?: number
      skipActiveCheck?: boolean
    } = {
      delayJob: RewardsDiscoveryService.DEFAULT_DELAY,
      skipActiveCheck: false
    }
  ) {
    this.logger.log(
      `Checking jobs in discover hodler events queue before queueing ` +
      `new discover hodler events flow with delay: ${opts.delayJob}ms`
    )

    let numJobsInQueue = 0
    numJobsInQueue += await this.discoverHodlerEventsQueue.getWaitingCount()
    numJobsInQueue += await this.discoverHodlerEventsQueue.getDelayedCount()
    if (!opts.skipActiveCheck) {
      numJobsInQueue += await this.discoverHodlerEventsQueue.getActiveCount()
    }
    if (numJobsInQueue > 0) {
      this.logger.warn(
        `There are ${numJobsInQueue} jobs in the discover hodler events ` +
        `queue, not queueing new discover hodler events flow`
      )
      return
    }

    let currentBlock = null
    try {
      currentBlock = await this.provider.getBlockNumber()
    } catch (error) {
      this.logger.error(
        'Not queueing new discover hodler events flow: ' +
          'Failed to get current block number',
        error.stack
      )
      return
    }
    this.logger.log(
      `Queueing discover hodler events flow with ` +
        `currentBlock: ${currentBlock} ` +
        `delay: ${opts.delayJob}ms`
    )
    await this.discoverHodlerEventsFlow.add({
      name: DiscoverHodlerEventsQueue.JOB_MATCH_DISCOVERED_HODLER_EVENTS,
      queueName: 'discover-hodler-events-queue',
      opts: RewardsDiscoveryService.jobOpts,
      data: { currentBlock },
      children: [
        {
          name: DiscoverHodlerEventsQueue.JOB_DISCOVER_REWARDED_EVENTS,
          queueName: 'discover-hodler-events-queue',
          opts: RewardsDiscoveryService.jobOpts,
          data: { currentBlock },
          children: [
            {
              name: DiscoverHodlerEventsQueue.JOB_DISCOVER_UPDATE_REWARDS_EVENTS,
              queueName: 'discover-hodler-events-queue',
              opts: {
                delay: opts.delayJob,
                ...RewardsDiscoveryService.jobOpts
              },
              data: { currentBlock }
            }
          ]
        }
      ]
    })

    this.logger.log(
      '[alarm=enqueued-discover-hodler-events] Enqueued discover hodler events flow'
    )
  }

  private async updateServiceState() {
    await this.rewardsDiscoveryServiceStateModel.updateMany({}, this.state)
  }

  private async setLastSafeCompleteBlockNumber(blockNumber: number) {
    this.logger.log(`Setting last safe complete block number ${blockNumber}`)

    this.state.lastSafeCompleteBlock = blockNumber
    await this.updateServiceState()
  }

  public getLastSafeCompleteBlockNumber() {
    return this.state.lastSafeCompleteBlock
  }
}
