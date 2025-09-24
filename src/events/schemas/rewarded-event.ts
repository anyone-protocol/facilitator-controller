import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class RewardedEvent {
  @Prop({ type: String, required: true, default: 'Rewarded' })
  eventName: 'Rewarded'

  @Prop({ type: Number, required: true })
  blockNumber: number

  @Prop({ type: String, required: true })
  blockHash: string

  @Prop({ type: String, required: true })
  transactionHash: string

  @Prop({ type: String, required: true })
  requestingAddress: string

  @Prop({ type: Boolean, required: false, default: false })
  redeem: boolean
}

export type RewardedEventDocument =
  HydratedDocument<RewardedEvent>

export const RewardedEventSchema = SchemaFactory.createForClass(
  RewardedEvent
).index({ transactionHash: 1, requestingAddress: 1 }, { unique: true })
