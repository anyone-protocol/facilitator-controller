import { Logger, Module } from '@nestjs/common'
import { StakingRewardsService } from './staking-rewards.service'
import { ConfigModule } from '@nestjs/config'
import { HttpModule } from '@nestjs/axios'

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [StakingRewardsService, Logger],
  exports: [StakingRewardsService],
})
export class StakingRewardsModule {}
