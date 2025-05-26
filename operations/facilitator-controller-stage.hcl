job "facilitator-controller-stage" {
  datacenters = ["ator-fin"]
  type = "service"
  namespace = "stage-protocol"

  constraint {
    attribute = "${meta.pool}"
    value = "stage"
  }

  group "facilitator-controller-stage-group" { 
    count = 2

    update {
      stagger      = "30s"
      max_parallel = 1
      canary       = 1
      auto_revert  = true
      auto_promote = true
    }

    network {
      mode = "bridge"
      port "facilitator-controller-port" {
        to = 3000
        host_network = "wireguard"
      }
      port "redis" {
        host_network = "wireguard"
      }
    }

    task "facilitator-controller-stage-service" {
      driver = "docker"
      config {
        image = "ghcr.io/anyone-protocol/facilitator-controller:[[.commit_sha]]"
        force_pull = true
      }

      vault {
        role = "any1-nomad-workloads-controller"
      }

      identity {
        name = "vault_default"
        aud  = ["any1-infra"]
        ttl  = "1h"
      }

      template {
        data = <<-EOH
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}
        {{ with secret "kv/stage-protocol/facilitator-controller-stage"}}
          FACILITY_OPERATOR_KEY="{{ .Data.data.FACILITY_OPERATOR_KEY_DEPRECATED }}"
          EVM_NETWORK="{{ .Data.data.EVM_NETWORK }}"

          EVM_PRIMARY_WSS="wss://sepolia.infura.io/ws/v3/{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
          EVM_SECONDARY_WSS="wss://eth-sepolia.g.alchemy.com/v2/{{ index .Data.data (print `ALCHEMY_SEPOLIA_API_KEY_` $allocIndex) }}"

          HODLER_OPERATOR_KEY="{{.Data.data.HODLER_OPERATOR_KEY}}"
          REWARDS_POOL_KEY="{{.Data.data.REWARDS_POOL_KEY}}"

          STAKING_REWARDS_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"
          BUNDLER_NETWORK="{{.Data.data.BUNDLER_NETWORK}}"
          BUNDLER_CONTROLLER_KEY="{{.Data.data.BUNDLER_CONTROLLER_KEY}}"

          RELAY_REWARDS_CONTROLLER_KEY="{{.Data.data.RELAY_REWARDS_CONTROLLER_KEY}}"
        {{ end }}
        EOH
        destination = "secrets/keys.env"
        env         = true
      }

      template {
        data = <<-EOH
        RELAY_REWARDS_PROCESS_ID="[[ consulKey "smart-contracts/stage/relay-rewards-address" ]]"
        FACILITY_CONTRACT_ADDRESS="[[ consulKey "facilitator/sepolia/stage/address" ]]"

        {{- range service "validator-stage-mongo" }}
          MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/facilitator-controller-stage"
        {{- end }}
        {{- range service "facilitator-controller-redis-stage" }}
          REDIS_HOSTNAME="{{ .Address }}"
          REDIS_PORT="{{ .Port }}"
        {{- end }}
        
        TOKEN_CONTRACT_ADDRESS="[[ consulKey "ator-token/sepolia/stage/address" ]]"
        HODLER_CONTRACT_ADDRESS="[[ consulKey "hodler/sepolia/stage/address" ]]"
        EOH
        destination = "local/config.env"
        env         = true
      }

      env {
        BUMP="redeploy-rewards-4"
        IS_LIVE="true"
        VERSION="[[.commit_sha]]"
        CPU_COUNT="1"
        DO_CLEAN="true"
        FACILITY_CONTRACT_DEPLOYED_BLOCK="5674945"
        IS_LOCAL_LEADER="true"
        CU_URL="https://cu.anyone.permaweb.services"
        USE_HODLER="true"
        USE_FACILITY="false"
        HODLER_CONTRACT_DEPLOYED_BLOCK="8190110"
      }
      
      resources {
        cpu    = 2048
        memory = 4096
      }

      service {
        name = "facilitator-controller-stage"
        port = "facilitator-controller-port"
        tags = ["logging"]
        
        check {
          name     = "Stage facilitator-controller health check"
          type     = "http"
          path     = "/health"
          interval = "5s"
          timeout  = "10s"
          check_restart {
            limit = 180
            grace = "15s"
          }
        }
      }
    }
  }
}
