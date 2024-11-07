import { HttpModule } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'

import { DistributionService } from './distribution.service'

@Module({
  imports: [
    ConfigModule,
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<{
          DRE_REQUEST_TIMEOUT: number
          DRE_REQUEST_MAX_REDIRECTS: number
        }>
      ) => ({
        timeout: config.get<number>('DRE_REQUEST_TIMEOUT', {
          infer: true
        }),
        maxRedirects: config.get<number>('DRE_REQUEST_MAX_REDIRECTS', {
          infer: true
        })
      })
    })
  ],
  providers: [DistributionService],
  exports: [DistributionService]
})
export class DistributionModule {}
