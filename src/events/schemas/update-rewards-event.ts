import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class UpdateRewardsEvent {
  @Prop({ type: String, required: true, default: 'UpdateRewards' })
  eventName: 'UpdateRewards'

  @Prop({ type: Number, required: true })
  blockNumber: number

  @Prop({ type: String, required: true })
  blockHash: string

  @Prop({ type: String, required: true })
  transactionHash: string

  @Prop({ type: String, required: true })
  requestingAddress: string

  @Prop({ type: String, required: true })
  gasEstimate: string

  @Prop({ type: Boolean, required: false, default: false })
  redeem: boolean

  @Prop({ type: Boolean, required: true, default: false })
  fulfilled: boolean

  @Prop({ type: String, required: false })
  rewardedEventTransactionHash?: string
}

export type UpdateRewardsEventDocument =
  HydratedDocument<UpdateRewardsEvent>

export const UpdateRewardsEventSchema = SchemaFactory.createForClass(
  UpdateRewardsEvent
).index({ transactionHash: 1, requestingAddress: 1 }, { unique: true })
