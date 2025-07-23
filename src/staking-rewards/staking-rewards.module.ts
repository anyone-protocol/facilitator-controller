import { Logger, Module } from '@nestjs/common'
import { StakingRewardsService } from './staking-rewards.service'
import { ConfigModule } from '@nestjs/config'

@Module({
  imports: [ConfigModule],
  providers: [StakingRewardsService, Logger],
  exports: [StakingRewardsService],
})
export class StakingRewardsModule {}
