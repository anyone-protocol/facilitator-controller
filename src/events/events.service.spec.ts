import { Test, TestingModule } from '@nestjs/testing'
import { BullModule } from '@nestjs/bullmq'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import { ethers } from 'ethers'

import { EventsService } from './events.service'
import { FacilitatorUpdatesQueue } from './processors/facilitator-updates-queue'
import { ClusterModule } from '../cluster/cluster.module'
import {
  RequestingUpdateEvent,
  RequestingUpdateEventSchema
} from './schemas/requesting-update-event'
import { EvmProviderModule } from '../evm-provider/evm-provider.module'
import { EvmProviderService } from '../evm-provider/evm-provider.service'
import {
  EventsServiceState,
  EventsServiceStateSchema
} from './schemas/events-service-state'
import { RelayRewardsModule } from '../relay-rewards/relay-rewards.module'
import { StakingRewardsModule } from '../staking-rewards/staking-rewards.module'
import { hodlerABI } from './abi/hodler'

describe('EventsService', () => {
  let module: TestingModule
  let service: EventsService
  let evmProviderService: EvmProviderService
  let configService: ConfigService

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClusterModule,
        EvmProviderModule,
        RelayRewardsModule,
        StakingRewardsModule,
        BullModule.registerQueue({
          name: 'facilitator-updates-queue'
        }),
        BullModule.registerFlowProducer({
          name: 'facilitator-updates-flow'
        }),
        BullModule.registerQueue({
          name: 'hodler-updates-queue'
        }),
        BullModule.registerFlowProducer({
          name: 'hodler-updates-flow'
        }),
        MongooseModule.forRoot(
          'mongodb://localhost/facilitator-controller-events-service-tests'
        ),
        MongooseModule.forFeature([
          {
            name: RequestingUpdateEvent.name,
            schema: RequestingUpdateEventSchema
          },
          {
            name: EventsServiceState.name,
            schema: EventsServiceStateSchema
          }
        ])
      ],
      providers: [EventsService, FacilitatorUpdatesQueue],
      exports: [EventsService]
    }).compile()

    service = module.get<EventsService>(EventsService)
    evmProviderService = module.get<EvmProviderService>(EvmProviderService)
    configService = module.get<ConfigService>(ConfigService)
    await evmProviderService.onApplicationBootstrap()
    await service.onApplicationBootstrap()
  })

  afterEach(async () => {
    // await evmProviderService.onApplicationShutdown()
    // await module.close()
  }, 30_000)

  it.skip('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('should get hodlers from contract', async () => {
    const jsonrpcurl = configService.get<string>('EVM_JSONRPC', { infer: true })
    const provider = new ethers.JsonRpcProvider(jsonrpcurl)
    const hodlerContract = new ethers.Contract(
      '0xB2B365DC481E9527366b29dE9394663A05743Aa9',
      hodlerABI,
      provider
    )
    expect(hodlerContract).toBeDefined()
    const hodlerData = await hodlerContract.hodlers('0xf72a247Dc4546b0291dbbf57648D45a752537802')
    expect(hodlerData).toBeDefined()
    console.log('Hodler data:', hodlerData)
  })
})
