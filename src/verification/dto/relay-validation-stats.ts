export class RelayVerificationResultsDto {
  readonly failed: number
  readonly unclaimed: number
  readonly verified: number
  readonly running: number
}

export class ValidationStatsDto {
  readonly consensus_weight: number
  readonly observed_bandwidth: number
  readonly consensus_weight_fraction: number
}

export class RelayValidationStatsDto {
  readonly consensus_weight: number
  readonly consensus_weight_fraction: number
  readonly observed_bandwidth: number
  readonly verification: RelayVerificationResultsDto
  readonly verified_and_running: ValidationStatsDto
}
