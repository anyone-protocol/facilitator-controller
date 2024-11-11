import { Test, TestingModule } from '@nestjs/testing'
import { DistributionService } from './distribution.service'
import { ConfigModule } from '@nestjs/config'
import { HttpModule } from '@nestjs/axios'
import { Logger } from '@nestjs/common'

describe('DistributionService', () => {
  let service: DistributionService
  let module: TestingModule

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), HttpModule],
      providers: [DistributionService]
    })
      .setLogger(new Logger())
      .compile()

    service = module.get<DistributionService>(DistributionService)
  })

  afterEach(async () => {
    if (module) {
      await module.close()
    }
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('should fetch distribution state from dre', async () => {
    await service.refreshDreState()
  })

  it('should get allocation from distribution state', async () => {
    const address = '0x692cE30c014D7d8EFdb7cd73c4b4835b84EE8365'
    const allocation = await service.getAllocation(address)

    expect(allocation).toBeDefined()
  })
})
