import { ethers } from 'ethers'

export interface EventDiscoveryQueryRangeDto {
  from: ethers.BlockTag,
  to: ethers.BlockTag
}