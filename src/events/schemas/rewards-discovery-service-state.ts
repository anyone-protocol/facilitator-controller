import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class RewardsDiscoveryServiceState {
  @Prop({ type: Number, required: false })
  lastSafeCompleteBlock?: number
}

export type RewardsDiscoveryServiceStateDocument =
  HydratedDocument<RewardsDiscoveryServiceState>

export const RewardsDiscoveryServiceStateSchema = SchemaFactory.createForClass(
  RewardsDiscoveryServiceState
)
