job "facilitator-controller-stage" {
  datacenters = ["ator-fin"]
  type = "service"

  constraint {
    attribute = "${node.unique.id}"
    value = "89b957c9-560a-126e-1ae8-13277258fcf1" # anon-hel-arweave-1
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
        policies = [
          "valid-ator-stage",
          "jsonrpc-stage-facilitator-controller-eth"
        ]
      }

      template {
        data = <<-EOH
        RELAY_REWARDS_PROCESS_ID="[[ consulKey "smart-contracts/stage/relay-rewards-address" ]]"
        FACILITY_CONTRACT_ADDRESS="[[ consulKey "facilitator/sepolia/stage/address" ]]"

        {{- range service "validator-stage-mongo" }}
          MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/facilitator-controller-stage"
        {{- end }}
        {{- range service "facilitator-controller-stage-redis" }}
          REDIS_HOSTNAME="{{ .Address }}"
          REDIS_PORT="{{ .Port }}"
        {{- end }}

        {{ $apiKeyPrefix := "api_key_" }}
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}

        {{ with secret "kv/valid-ator/stage" }}
          FACILITY_OPERATOR_KEY="{{ .Data.data.FACILITY_OPERATOR_KEY }}"
          EVM_NETWORK="{{ .Data.data.INFURA_NETWORK }}"
        {{ end }}
        {{ with secret "kv/jsonrpc/stage/facilitator-controller/infura/eth" }}
          EVM_PRIMARY_WSS="wss://sepolia.infura.io/ws/v3/{{ index .Data.data (print $apiKeyPrefix $allocIndex) }}"
        {{ end }}
        {{ with secret "kv/jsonrpc/stage/facilitator-controller/alchemy/eth" }}
          EVM_SECONDARY_WSS="wss://eth-sepolia.g.alchemy.com/v2/{{ index .Data.data (print $apiKeyPrefix $allocIndex) }}"
        {{ end }}
        EOH
        destination = "secrets/file.env"
        env         = true
      }

      env {
        BUMP="redeploy-rewards-4"
        IS_LIVE="true"
        VERSION="[[.commit_sha]]"
        CPU_COUNT="1"
        DO_CLEAN="false"
        FACILITY_CONTRACT_DEPLOYED_BLOCK="5674945"
        IS_LOCAL_LEADER="true"
        CU_URL="https://cu.anyone.permaweb.services"
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
