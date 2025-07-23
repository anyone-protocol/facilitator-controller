import { Module } from '@nestjs/common'
import { HttpModule } from '@nestjs/axios'

import { EvmProviderService } from './evm-provider.service'

@Module({
  imports: [HttpModule],
  providers: [EvmProviderService],
  exports: [EvmProviderService]
})
export class EvmProviderModule {}
