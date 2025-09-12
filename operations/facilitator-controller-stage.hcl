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
      max_parallel     = 1
      min_healthy_time = "30s"
      healthy_deadline = "5m"
    }

    network {
      port "http" {
        host_network = "wireguard"
      }
    }

    task "facilitator-controller-stage-service" {
      driver = "docker"
      kill_timeout = "30s"

      config {
        image = "ghcr.io/anyone-protocol/facilitator-controller:[[ .commit_sha ]]"
        network_mode = "host"
      }

      env {
        IS_LIVE="true"
        VERSION="[[ .commit_sha ]]"
        PORT="${NOMAD_PORT_http}"
        REDIS_MODE="sentinel"
        REDIS_MASTER_NAME="facilitator-controller-stage-redis-master"
        DO_CLEAN="true"
        # FACILITY_CONTRACT_DEPLOYED_BLOCK="5674945"
        FACILITY_CONTRACT_DEPLOYED_BLOCK="9000000"
        CU_URL="https://cu.anyone.permaweb.services"
        USE_HODLER="true"
        USE_FACILITY="false"
        HODLER_CONTRACT_DEPLOYED_BLOCK="9170000"
        IS_LOCAL_LEADER="true"
        CPU_COUNT="1"
        CONSUL_HOST="${NOMAD_IP_http}"
        CONSUL_PORT="8500"
        CONSUL_SERVICE_NAME="facilitator-controller-stage"
      }

      vault {
        role = "any1-nomad-workloads-controller"
      }

      consul {}

      template {
        data = <<-EOH
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}
        {{ with secret "kv/stage-protocol/facilitator-controller-stage"}}
        FACILITY_OPERATOR_KEY="{{ .Data.data.FACILITY_OPERATOR_KEY_DEPRECATED }}"
        EVM_NETWORK="{{ .Data.data.EVM_NETWORK }}"
        EVM_INFURA_API_KEY="{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
        EVM_JSONRPC="https://sepolia.infura.io/v3/{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
        EVM_PRIMARY_WSS="wss://sepolia.infura.io/ws/v3/{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
        EVM_SECONDARY_WSS="wss://eth-sepolia.g.alchemy.com/v2/{{ index .Data.data (print `ALCHEMY_SEPOLIA_API_KEY_` $allocIndex) }}"

        HODLER_OPERATOR_KEY="{{.Data.data.HODLER_OPERATOR_KEY}}"
        REWARDS_POOL_KEY="{{.Data.data.REWARDS_POOL_KEY}}"
        STAKING_REWARDS_CONTROLLER_KEY="{{.Data.data.STAKING_REWARDS_CONTROLLER_KEY}}"

        RELAY_REWARDS_CONTROLLER_KEY="{{.Data.data.RELAY_REWARDS_CONTROLLER_KEY}}"

        CONSUL_TOKEN_CONTROLLER_CLUSTER="{{.Data.data.CONSUL_TOKEN_CONTROLLER_CLUSTER}}"
        {{ end }}
        EOH
        destination = "secrets/keys.env"
        env         = true
      }

      template {
        data = <<-EOH
        VERSION="[[ .commit_sha ]]"
        RELAY_REWARDS_PROCESS_ID="{{ key "smart-contracts/stage/relay-rewards-address" }}"
        STAKING_REWARDS_PROCESS_ID="{{ key "smart-contracts/stage/staking-rewards-address" }}"
        FACILITY_CONTRACT_ADDRESS="{{ key "facilitator/sepolia/stage/address" }}"
        TOKEN_CONTRACT_ADDRESS="{{ key "ator-token/sepolia/stage/address" }}"
        HODLER_CONTRACT_ADDRESS="{{ key "hodler/sepolia/stage/address" }}"
        {{- range service "validator-stage-mongo" }}
        MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/facilitator-controller-stage2"
        {{- end }}
        {{- range service "facilitator-controller-stage-redis-master" }}
        REDIS_MASTER_NAME="{{ .Name }}"
        {{- end }}
        {{- range service "facilitator-controller-stage-sentinel-1" }}
        REDIS_SENTINEL_1_HOST={{ .Address }}
        REDIS_SENTINEL_1_PORT={{ .Port }}
        {{- end }}
        {{- range service "facilitator-controller-stage-sentinel-2" }}
        REDIS_SENTINEL_2_HOST={{ .Address }}
        REDIS_SENTINEL_2_PORT={{ .Port }}
        {{- end }}
        {{- range service "facilitator-controller-stage-sentinel-3" }}
        REDIS_SENTINEL_3_HOST={{ .Address }}
        REDIS_SENTINEL_3_PORT={{ .Port }}
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
      }
      
      resources {
        cpu    = 2048
        memory = 4096
      }

      service {
        name = "facilitator-controller-stage"
        port = "http"
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
